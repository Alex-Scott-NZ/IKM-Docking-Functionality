// Docking layout test runner. One CDP session for the whole run (viewport
// emulation lasts only as long as the session). Usage:
//   SPFX_TEST_PAGE_MATCH=kc-sandpit/SitePages/Docking node dock-run.mjs [scenarioFilter] [viewportFilter]
// Writes results.json and a screenshot per failing case beside this script.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LIB = readFileSync(join(here, 'dock-lib.js'), 'utf8');
const match = process.env.SPFX_TEST_PAGE_MATCH || 'Docking-Playground';
const [scFilter, vpFilter] = process.argv.slice(2);
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find((x) => x.type === 'page' && x.url.includes(match));
if (!t) throw new Error('no tab matching ' + match);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, (d) => (d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- page actions
const inject = () => ev(LIB + ';true');
async function waitHost() {
  for (let i = 0; i < 100; i++) {
    if (await ev('!!(window.ikmDock && document.querySelector("#ikm-dock-host"))').catch(() => false)) return;
    await sleep(200);
  }
  throw new Error('docking host never appeared');
}
async function viewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
}
async function mouse(type, x, y, buttons = 0) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? (buttons ? 'left' : 'none') : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
}
async function center(id) {
  const c = await ev(`__dt.center(${JSON.stringify(id)})`);
  if (!c) throw new Error('no visible chip for ' + id);
  return c;
}
async function click(id) {
  const c = await center(id);
  await mouse('mouseMoved', c.x, c.y);
  await mouse('mousePressed', c.x, c.y, 1);
  await mouse('mouseReleased', c.x, c.y);
  await mouse('mouseMoved', 5, 5); // move off so :hover lift doesn't count
}
// Drag chip `id` onto chip `onto` (or past it with `past`), in small steps like a hand.
async function drag(id, onto, past = 0) {
  const a = await center(id);
  const b = await center(onto);
  const isColumn = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
  const dx = isColumn ? 0 : Math.sign(b.x - a.x) * past;
  const dy = isColumn ? Math.sign(b.y - a.y) * past : 0;
  await mouse('mouseMoved', a.x, a.y);
  await mouse('mousePressed', a.x, a.y, 1);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', a.x + ((b.x + dx - a.x) * i) / steps, a.y + ((b.y + dy - a.y) * i) / steps, 1);
    await sleep(16);
  }
  await mouse('mouseReleased', b.x + dx, b.y + dy);
  await mouse('mouseMoved', 5, 5);
}
async function clickSel(sel) {
  const c = await ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.getBoundingClientRect().width > 0); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (!c) throw new Error('nothing visible matches ' + sel);
  await mouse('mouseMoved', c.x, c.y);
  await mouse('mousePressed', c.x, c.y, 1);
  await mouse('mouseReleased', c.x, c.y);
  await mouse('mouseMoved', 5, 5);
}
async function scrollTo(y) {
  await ev(`(document.querySelector('div[data-automation-id="contentScrollRegion"]')||document.scrollingElement).scrollTop=${y};true`);
}
async function settle(maxMs = 3000) {
  const t0 = Date.now();
  await sleep(60);
  let last = '';
  while (Date.now() - t0 < maxMs) {
    last = await ev('__dt.busy()');
    if (!last) { await sleep(80); if (!(await ev('__dt.busy()'))) return ''; }
    await sleep(50);
  }
  return 'NEVER-SETTLED: still ' + last + ' after ' + maxMs + 'ms';
}

// ---------------------------------------------------------------- scenarios
// Each runs on a freshly reloaded page. `ids` are synthetic utilities whose
// zone comes from the host's config (zt-<zone>-<letter>).
const ZONES = {
  'bottom-left': ['zt-bl-a', 'zt-bl-b', 'zt-bl-c'],
  'bottom-right': ['zt-br-a', 'zt-br-b'],
  'edge-left': ['zt-el-a', 'zt-el-b', 'zt-el-c'],
  'edge-right': ['zt-er-a', 'feedback?'],
  'edge-right-bottom': ['zt-erb-a', 'zt-erb-b', 'zt-erb-c']
};
const z3 = (zone) => ZONES[zone].filter((x) => !x.endsWith('?'));

const S = [];
// minWidth: the floating contents panel (and so its minimise button) only exists above 1024px.
const sc = (name, desc, fn, minWidth = 0) => S.push({ name, desc, fn, minWidth });

for (const zone of ['bottom-left', 'bottom-right', 'edge-left', 'edge-right-bottom']) {
  const [a, b, c] = z3(zone);
  sc(`basic-${zone}`, 'Minimise each in turn, then restore each in turn', async (T) => {
    for (const id of z3(zone)) { await T.do(`minimise ${id}`, `__dt.minimise('${id}')`); await T.check(`after minimising ${id}`); }
    for (const id of z3(zone)) { await T.click(id); await T.check(`after restoring ${id}`); }
  });
  if (c) sc(`restore-middle-${zone}`, 'Dock three, restore the middle one, dock it again', async (T) => {
    for (const id of [a, b, c]) await T.do(`minimise ${id}`, `__dt.minimise('${id}')`);
    await T.check('three docked');
    await T.click(b); await T.check(`restored ${b}`);
    await T.do(`minimise ${b}`, `__dt.minimise('${b}')`); await T.check(`re-docked ${b}`);
  });
  if (c) sc(`reorder-${zone}`, 'Reorder by dragging, then open/close each', async (T) => {
    for (const id of [a, b, c]) await T.do(`minimise ${id}`, `__dt.minimise('${id}')`);
    await T.check('three docked');
    await T.drag(c, a, 14); await T.check(`dragged ${c} past ${a}`);
    await T.drag(a, c, 14); await T.check(`dragged ${a} past ${c}`);
    for (const id of [a, b, c]) { await T.click(id); await T.check(`restored ${id}`); await T.do(`minimise ${id}`, `__dt.minimise('${id}')`); await T.check(`re-docked ${id} into saved order`); }
    await T.reload(); await T.do('re-dock all after reload', `['${a}','${b}','${c}'].forEach(i=>__dt.minimise(i))`); await T.check('order survives reload');
  });
  if (c) sc(`rapid-${zone}`, 'Click faster than the animation', async (T) => {
    await T.do('minimise all three in one go', `['${a}','${b}','${c}'].forEach(i=>__dt.minimise(i))`, 0);
    await T.check('three at once');
    await T.click(a, 0); await T.wait(60); await T.do(`re-minimise ${a} mid-flight`, `__dt.minimise('${a}')`, 0); await T.check('restore then minimise mid-flight');
    await T.click(b, 0); await T.wait(30); await T.clickIfThere(b); await T.check('double click a chip');
    if (await T.has(b)) await T.click(b);
    await T.do(`minimise ${b}`, `__dt.minimise('${b}')`, 0); await T.wait(80); await T.click(c, 0); await T.check('minimise one while restoring another');
  });
  if (c) sc(`reorder-midflight-${zone}`, 'Drag while another utility is flying in', async (T) => {
    for (const id of [a, b]) await T.do(`minimise ${id}`, `__dt.minimise('${id}')`);
    await T.do(`minimise ${c} (no wait)`, `__dt.minimise('${c}')`, 0);
    await T.drag(b, a, 14); await T.check('dragged during a flight');
  });
  sc(`resize-${zone}`, 'Resize and zoom while docked and mid-flight', async (T) => {
    for (const id of z3(zone)) await T.do(`minimise ${id}`, `__dt.minimise('${id}')`);
    await T.viewport(1280, 720); await T.check('narrowed to 1280x720');
    await T.viewport(1920, 1040); await T.check('back to 1920x1040');
    await T.click(z3(zone)[0], 0); await T.viewport(1536, 760, 0); await T.check('resized mid-restore');
    await T.do('minimise mid-resize', `__dt.minimise('${z3(zone)[0]}')`, 0); await T.viewport(1920, 1040, 0); await T.check('resized mid-minimise');
  });
  sc(`scroll-${zone}`, 'Scroll while docked and mid-flight', async (T) => {
    await T.scroll(1200);
    for (const id of z3(zone)) await T.do(`minimise ${id}`, `__dt.minimise('${id}')`, 0);
    await T.scroll(200); await T.scroll(2400); await T.check('scrolled during flights');
  });
}
sc('mixed-all-zones', 'Utilities in every zone at once, then open/close across zones', async (T) => {
  const ids = ['zt-bl-a', 'zt-bl-b', 'zt-br-a', 'zt-el-a', 'zt-el-b', 'zt-er-a', 'zt-erb-a', 'zt-erb-b', 'zt-elt-a'];
  for (const id of ids) await T.do(`minimise ${id}`, `__dt.minimise('${id}')`, 0);
  await T.check('everything docked');
  for (const id of ['zt-bl-a', 'zt-er-a', 'zt-erb-a']) { await T.click(id); await T.check(`restored ${id}`); }
});
sc('crowded-edge', 'More tabs than fit the edge on a short window', async (T) => {
  await T.viewport(1366, 650);
  for (const id of ['zt-er-a', 'zt-erb-a', 'zt-erb-b', 'zt-erb-c']) await T.do(`minimise ${id}`, `__dt.minimise('${id}')`);
  await T.check('middle and bottom clusters on a short right edge');
  for (const id of ['zt-el-a', 'zt-el-b', 'zt-el-c', 'zt-elt-a', 'zt-elt-b']) await T.do(`minimise ${id}`, `__dt.minimise('${id}')`);
  await T.check('top and middle clusters on a short left edge');
});

// Real participants: feedback (docked to the right edge by default) and the
// table of contents (docks once the reader has scrolled past the inline TOC).
const FB_MIN = '[aria-label="Minimise the feedback form to the dock"]';
const TOC_MIN = '[aria-label="Minimise the table of contents to the dock"]';
sc('real-feedback', 'Open the feedback form from its tab and minimise it again, three times', async (T) => {
  await T.check('feedback docked on load', ['feedback']);
  for (let i = 1; i <= 3; i++) {
    await T.click('feedback'); await T.wait(500); await T.check(`form opened (${i})`, ['feedback']);
    await T.clickSel(FB_MIN); await T.check(`form minimised (${i})`, ['feedback']);
  }
});
sc('real-toc', 'Dock the contents panel, scroll it away and back, restore it', async (T) => {
  await T.scroll(1500); await T.wait(800);
  await T.clickSel(TOC_MIN); await T.check('contents docked', ['feedback', 'toc']);
  await T.scroll(0); await T.wait(600); await T.check('scrolled to top (inline contents showing)', ['feedback']);
  await T.scroll(1500); await T.wait(800); await T.check('scrolled back down', ['feedback', 'toc']);
  await T.click('toc'); await T.wait(400); await T.check('contents restored', ['feedback']);
  await T.clickSel(TOC_MIN); await T.check('contents docked again', ['feedback', 'toc']);
}, 1025);
sc('real-zoom-in-docked', 'Dock feedback and contents on a wide screen, then zoom in to 200% and back', async (T) => {
  await T.scroll(1500); await T.wait(800);
  await T.clickSel(TOC_MIN); await T.check('docked at full width', ['feedback', 'toc']);
  await T.viewport(960, 470); await T.wait(600); await T.check('zoomed to 200% (960px)', ['feedback']);
  const tocAtZoom = await T.has('toc');
  await T.viewport(1920, 950); await T.wait(800); await T.check('back to 100%', ['feedback', 'toc']);
  return tocAtZoom;
});
sc('real-three-right', 'Feedback, contents and a third utility on the right edge: reorder, open, close', async (T) => {
  await T.scroll(1500); await T.wait(800);
  await T.clickSel(TOC_MIN);
  await T.do('minimise zt-er-a', "__dt.minimise('zt-er-a')");
  await T.check('three on the right edge', ['feedback', 'toc', 'zt-er-a']);
  await T.drag('zt-er-a', 'feedback', 14); await T.check('dragged the third tab to the top', ['feedback', 'toc', 'zt-er-a']);
  await T.click('feedback'); await T.wait(500); await T.clickSel(FB_MIN); await T.check('feedback opened and minimised', ['feedback', 'toc', 'zt-er-a']);
  await T.click('toc'); await T.wait(400); await T.clickSel(TOC_MIN); await T.check('contents restored and docked', ['feedback', 'toc', 'zt-er-a']);
  await T.click('toc', 0); await T.wait(80); await T.clickIfThere('toc'); await T.wait(700);
  if (!(await T.has('toc'))) await T.clickSel(TOC_MIN);
  await T.check('contents chip double-clicked', ['feedback', 'toc', 'zt-er-a']);
}, 1025);

// Office-screen matrix (CSS pixels the page actually gets).
const VIEWPORTS = {
  'office-100': [1920, 950],
  'office-125': [1536, 750],
  'office-150': [1280, 620],
  'zoom-200': [960, 470],
  'laptop': [1366, 650],
  '4k-150': [2560, 1300]
};

// ---------------------------------------------------------------- engine
const results = [];
async function runCase(s, vpName) {
  const [w, h] = VIEWPORTS[vpName];
  if (w < s.minWidth) { console.log(`n/a      ${s.name.padEnd(34)} ${vpName} (needs ${s.minWidth}px)`); return; }
  const rec = { scenario: s.name, desc: s.desc, viewport: vpName, size: `${w}x${h}`, steps: [], failures: [], warnings: [] };
  const T = {
    async do(label, expr, settleMs = 1) { await ev(expr); rec.steps.push(label); if (settleMs) { const ns = await settle(); if (ns) rec.failures.push({ at: label, v: [ns] }); } },
    async wait(ms) { await sleep(ms); },
    async click(id, settleMs = 1) { await click(id); rec.steps.push(`click ${id}`); if (settleMs) { const ns = await settle(); if (ns) rec.failures.push({ at: `click ${id}`, v: [ns] }); } },
    async clickIfThere(id) { if (await ev(`!!__dt.center('${id}')`)) await click(id); rec.steps.push(`click ${id} again`); },
    async has(id) { return !!(await ev(`__dt.center('${id}')`)); },
    async drag(id, onto, past) { await drag(id, onto, past); rec.steps.push(`drag ${id} -> ${onto}`); const ns = await settle(); if (ns) rec.failures.push({ at: `drag ${id}`, v: [ns] }); },
    async viewport(vw, vh, settleMs = 1) { await viewport(vw, vh); rec.steps.push(`viewport ${vw}x${vh}`); if (settleMs) await settle(); },
    async clickSel(sel) { await clickSel(sel); rec.steps.push(`click ${sel}`); const ns = await settle(); if (ns) rec.failures.push({ at: `click ${sel}`, v: [ns] }); },
    async scroll(y) { await scrollTo(y); rec.steps.push(`scroll ${y}`); await sleep(120); },
    async reload() { await send('Page.reload', { ignoreCache: false }); await sleep(1500); await waitHost(); await inject(); await sleep(800); rec.steps.push('reload'); },
    async check(label, expect) {
      const ns = await settle();
      let v = await ev(`__dt.check(${expect ? JSON.stringify(expect) : ''})`);
      if (ns) v.unshift(ns);
      // A duplicate host is an environment fact, not a per-step failure: note it once.
      const hc = v.filter((x) => x.startsWith('HOST-COUNT'));
      if (hc.length && !rec.warnings.includes(hc[0])) rec.warnings.push(hc[0]);
      v = v.filter((x) => !x.startsWith('HOST-COUNT'));
      const layout = await ev('__dt.layout()');
      rec.steps.push(`CHECK ${label}: ${v.length ? 'FAIL' : 'ok'}`);
      if (v.length) {
        const shot = `${s.name}__${vpName}__${rec.failures.length}.png`;
        const img = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(outDir, shot), Buffer.from(img.data, 'base64'));
        rec.failures.push({ at: label, v, layout, shot });
      }
    }
  };
  await viewport(w, h);
  await ev("Object.keys(localStorage).filter(k => /dock/i.test(k)).forEach(k => localStorage.removeItem(k)); true").catch(() => {});
  await send('Page.reload', { ignoreCache: false });
  await sleep(1500);
  await waitHost();
  await inject();
  await ev('__dt.reset();true');
  await sleep(1200); // let late participants (feedback, TOC) mount
  try { await s.fn(T); } catch (e) { rec.failures.push({ at: 'harness', v: ['ERROR: ' + e.message] }); }
  results.push(rec);
  const tag = rec.failures.length ? `FAIL(${rec.failures.length})` : 'pass';
  console.log(`${tag.padEnd(8)} ${s.name.padEnd(34)} ${vpName}`);
  for (const w of rec.warnings) console.log(`           ! ${w}`);
  for (const f of rec.failures) console.log(`           @ ${f.at}: ${f.v.slice(0, 4).join(' | ')}`);
}

await send('Page.enable');
await send('Runtime.enable');
const scs = S.filter((s) => !scFilter || scFilter.split(',').some((f) => s.name.includes(f)));
const vps = Object.keys(VIEWPORTS).filter((v) => !vpFilter || vpFilter.split(',').includes(v));
for (const vp of vps) for (const s of scs) await runCase(s, vp);
await send('Emulation.clearDeviceMetricsOverride');
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.failures.length).length;
console.log(`\n${results.length - failed}/${results.length} cases passed`);
ws.close();
