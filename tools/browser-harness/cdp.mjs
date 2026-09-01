// Minimal Chrome DevTools Protocol driver (no deps — Node 22 WebSocket).
// Usage:
//   node cdp.mjs targets                 — list page targets
//   node cdp.mjs eval "<expression>"     — evaluate JS in the SP page, print result JSON
//   node cdp.mjs shot <file.png>         — screenshot the SP page (viewport)
//   node cdp.mjs logs <seconds>          — capture console messages for N seconds
//   node cdp.mjs key <code> [alt]        — dispatch a keydown to the page document
const PORT = 9222;

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

function pickPage(list) {
  return (
    list.find((t) => t.type === "page" && /sharepoint\.com/.test(t.url)) ||
    list.find((t) => t.type === "page")
  );
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error("ws error " + e.message));
  });
}

let msgId = 0;
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        ws.removeEventListener("message", onMsg);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const [, , cmd, ...args] = process.argv;
const list = await targets();
if (cmd === "targets") {
  console.log(
    list
      .filter((t) => t.type === "page")
      .map((t) => `${t.id}  ${t.url.substring(0, 140)}`)
      .join("\n") || "(no page targets)"
  );
  process.exit(0);
}

const page = pickPage(list);
if (!page) {
  console.error("No page target found");
  process.exit(1);
}
const ws = await connect(page.webSocketDebuggerUrl);

if (cmd === "eval") {
  const r = await send(ws, "Runtime.evaluate", {
    expression: args[0],
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    console.error("EXCEPTION:", JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    process.exit(1);
  }
  console.log(JSON.stringify(r.result.value, null, 2));
} else if (cmd === "shot") {
  const r = await send(ws, "Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args[0], Buffer.from(r.data, "base64"));
  console.log("saved", args[0]);
} else if (cmd === "logs") {
  const seconds = Number(args[0] || 5);
  await send(ws, "Runtime.enable");
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.consoleAPICalled") {
      const text = m.params.args
        .map((a) => a.value ?? a.description ?? JSON.stringify(a.preview?.properties?.map(p => `${p.name}:${p.value}`) ?? a.type))
        .join(" ");
      console.log(`[${m.params.type}]`, text.substring(0, 500));
    }
  });
  await new Promise((r) => setTimeout(r, seconds * 1000));
} else if (cmd === "key") {
  const code = args[0];
  const alt = args.includes("alt");
  const key = code.replace(/^Key/, "").toLowerCase();
  await send(ws, "Runtime.evaluate", {
    expression: `document.dispatchEvent(new KeyboardEvent("keydown", {code: ${JSON.stringify(code)}, key: ${JSON.stringify(key)}, altKey: ${alt}, bubbles: true, cancelable: true}))`,
  });
  console.log("dispatched", code, alt ? "+alt" : "");
} else if (cmd === "reload") {
  await send(ws, "Page.enable");
  // The SPFx dev cert isn't trusted in this scratch profile — without this,
  // the localhost manifest/bundle loads fail silently and SharePoint falls
  // back to the deployed tenant bundle.
  await send(ws, "Security.setIgnoreCertificateErrors", { ignore: true });
  // The ignore flag only lives as long as this debugger session — stay
  // attached until the load completes (+ grace for async web parts).
  const loaded = new Promise((resolve) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Page.loadEventFired") {
        ws.removeEventListener("message", onMsg);
        resolve();
      }
    };
    ws.addEventListener("message", onMsg);
  });
  await send(ws, "Page.reload", { ignoreCache: true });
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 30000))]);
  await new Promise((r) => setTimeout(r, 12000));
  console.log("hard reload done (cert errors ignored through load)");
} else if (cmd === "capture-reload") {
  await send(ws, "Page.enable");
  await send(ws, "Security.setIgnoreCertificateErrors", { ignore: true });
  await send(ws, "Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__capturedLogs = [];
      for (const level of ["log","debug","info","warn","error"]) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
          try {
            window.__capturedLogs.push(level + " :: " + args.map(a => {
              try { return typeof a === "string" ? a : JSON.stringify(a); }
              catch { return String(a); }
            }).join(" "));
          } catch {}
          orig(...args);
        };
      }`,
  });
  const loaded = new Promise((resolve) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Page.loadEventFired") {
        ws.removeEventListener("message", onMsg);
        resolve();
      }
    };
    ws.addEventListener("message", onMsg);
  });
  await send(ws, "Page.reload", { ignoreCache: true });
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 30000))]);
  await new Promise((r) => setTimeout(r, 12000));
  const r = await send(ws, "Runtime.evaluate", {
    expression: `(window.__capturedLogs || []).filter(l => /spfx|debug|manifest/i.test(l)).join("\\n")`,
    returnByValue: true,
  });
  console.log(r.result.value || "(no matching logs captured)");
} else {
  console.error("unknown command");
  process.exit(1);
}
ws.close();
process.exit(0);
