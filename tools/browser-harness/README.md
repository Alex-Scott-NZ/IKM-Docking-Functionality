# Browser Test Harness (Chrome DevTools Protocol)

Drive a real, signed-in Chrome against live SharePoint pages — no Puppeteer,
no Playwright, no extensions. `cdp.mjs` speaks the raw DevTools protocol over
WebSocket; Node 22+ only (built-in WebSocket), zero npm dependencies.

Copy this folder into any SPFx project (or keep one copy anywhere — it has no
ties to this repo).

## 1. Launch Chrome with the debug port

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir=$env:LOCALAPPDATA\spfx-test-chrome `
  --no-first-run --no-default-browser-check `
  "https://<tenant>.sharepoint.com/sites/<site>/SitePages/<page>.aspx?debugManifestsFile=https%3A%2F%2Flocalhost%3A4321%2Ftemp%2Fbuild%2Fmanifests.js&debug=true&noredir=true"
```

Notes:
- A separate `--user-data-dir` is required (Chrome blocks debugging on the
  default profile). Sign in to SharePoint once — the profile persists, so
  subsequent launches stay signed in.
- Click "Load debug scripts" when prompted (consent is per browser session,
  stored in sessionStorage).
- **Debug bundles only substitute when the local package.json version exactly
  matches the version deployed in the app catalog.** If the page loads the
  app-catalog bundle instead of localhost, set package.json to the deployed
  version temporarily (don't commit) and restart the dev server. See
  `~/.claude/notes/spfx-debug-manifests-version-match.md` for the full
  debugging checklist.

## 2. Drive the page

The script targets the first tab whose URL contains `sharepoint.com`.

```bash
node cdp.mjs targets                    # list controllable tabs
node cdp.mjs eval "document.title"      # run any JS, print JSON result
node cdp.mjs shot page.png              # screenshot the viewport
node cdp.mjs logs 10                    # stream console messages for 10s
node cdp.mjs key KeyJ alt               # dispatch a keydown (e.g. Alt+J)
node cdp.mjs reload                     # hard reload (cache + cert bypass)
node cdp.mjs capture-reload             # reload with a console hook injected
                                        # BEFORE load — catches startup logs
                                        # with full object payloads
```

## Recipes

Which bundle is actually loaded (localhost vs app catalog)?
```bash
node cdp.mjs eval "performance.getEntriesByType('resource').filter(function(r){return /web-part/.test(r.name);}).map(function(r){return r.name;})"
```

What does the SPFx loader have registered for a component?
```bash
node cdp.mjs eval "window._spComponentLoader.getManifests().filter(function(m){return m.id==='<component-guid>';}).map(function(m){return {version:m.version, urls:m.loaderConfig.internalModuleBaseUrls};})"
```

Click something by its visible text:
```bash
node cdp.mjs eval "Array.from(document.querySelectorAll('button')).find(function(b){return b.innerText.trim()==='Load debug scripts';}).click()"
```

Gotchas:
- Prefer `function(){}` over arrow functions in `eval` one-liners — shell
  quoting mangles `=>` less predictably than you'd hope.
- The dev server binds IPv6: `curl https://localhost:4321` can fail while the
  browser succeeds. Use `curl -g "https://[::1]:4321/..."`.
- `Security.setIgnoreCertificateErrors` (used by `reload`) only lasts while
  the CDP session is attached — the script stays connected through the load.
