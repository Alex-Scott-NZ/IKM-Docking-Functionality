# SharePoint "Docking" Functionality — Approach (NWR-39932)

**Goal:** replicate the Copilot FAB "dock" pattern for our common page utilities — the
feedback button, back-to-top button, table of contents, and the footer bar itself — so
they can be minimised out of the way and restored, with behaviour controlled centrally
from the Extension Manager Admin webpart.

---

## 1. Where everything is today (survey, 2026-08-27)

| Utility | Project | Placement today | Minimise today | Configured via |
|---|---|---|---|---|
| **Feedback button** | `IKM-Feedback-Extension` (tenant-wide app customizer; SPFx 1.20, React 17) | `position: fixed` pill, `bottom: 0; right: 45px`, in the Bottom placeholder | X button → `sessionStorage['feedbackButtonHidden']` — gone for the session, **no restore affordance** | Tenant Wide Extensions list properties; already has a section in Extension Manager Admin |
| **Back to top** | Deployed one is the **community ScrollToTop customizer** (Laurent Sittler, gitlab.lsonline.fr — SPFx 1.11, ~330 lines; now cloned to `IKM-Back-To-Top-Extension` as reference). The TOC CSS-hides it (`[class*="spfxScrolltotopBtn"]`) and provides its own "Top"/"Back to top" buttons in the floating widget | Bottom-right, Bottom placeholder | n/a | **Not in the admin webpart at all** |
| **Footer bar** | `IKM-Footer-Extension` (per-site `UserCustomAction`, component id `7537f274-…`; SPFx ~1.18 mixed, React 16, gulp) | **In-flow** bar appended inside `div[role="main"]` — scrolls away with content, `z-index: 13` | None | Its own edit-pencil Panel **and** Extension Manager Admin (both MERGE the same custom action) |
| **Table of contents** | `IKM-Table-Of-Contents-WebPart` (SPFx 1.23, heft; v1.0.2.42) | In-canvas section + floating pinned widget top-right (drag, resize, collapse-to-pill), `z-index: 999999` | Collapse to pill; prefs in `localStorage['ikm-toc-float-prefs']` (global, `{v, pos, width, height, expanded}`) | Native property pane only |

**Admin webpart:** `IKM-Extension-Manager-Admin-WebPart` (SPFx 1.22.1, Fluent 8, React 17).
One dropdown (`breadcrumbs | gtm | footer | feedback`) → one `_render*Editor()` per
extension in `ExtensionManagerAdmin.tsx` (~4,900 lines). Two persistence patterns already
established: tenant-wide (`Tenant Wide Extensions` list, `TenantWideExtensionComponentProperties`
JSON, `Title eq '<Name>'`) and per-site (`UserCustomAction.ClientSideComponentProperties` MERGE).
It also already writes JSON files to `{appCatalogUrl}/SiteAssets/feedback-forms` (the
feedback form designer) — the precedent for central config files readable by all users.

---

## 2. The concept

Two docking surfaces, phased:

1. **Page-edge tabs (first):** a minimised utility becomes a slim vertical tab on the
   left or right page edge — Copilot's docked state in Word. A utility renders its own
   tab (the TOC already portals to `document.body`); no shared host needed.
2. **The footer bar as a dock (later):** the footer becomes viewport-persistent
   (`position: sticky; bottom: 0` — it is injected *inside* SharePoint's nested scroll
   region, so sticky gives status-bar behaviour for free) and hosts a tray with
   left/right slots. Minimised utilities appear there as **chips**: icon + short visible
   text label ("Top", "Feedback", "Contents" — icon-only affordances are ambiguous per
   NN/g). Until the tray ships, a `footer`-targeted utility falls back to a chip pinned
   at the configured bottom corner, styled identically.

What the minimise button *does* is driven by central admin configuration — including a
`user-choice` mode where the button opens a small menu (mirroring Copilot's right-click
menu): **Dock left / Dock right / Minimise to footer**.

Everything stays keyboard-accessible, hides in edit mode (TOC precedent — editing chrome
out-stacks and remounts the canvas), and respects `prefers-reduced-motion`.

### Settings schema (per utility)

```ts
interface IDockableUtilitySettings {
  enabled: boolean;
  minimiseTarget: 'footer' | 'edge-left' | 'edge-right' | 'user-choice';
  footerSide: 'left' | 'right';        // tray slot / corner when target is footer
  defaultState: 'expanded' | 'minimised';
}
```

- Admin config supplies the defaults; a user's explicit choice (via the `user-choice`
  menu, or just minimising/expanding) is remembered in `localStorage` per utility
  (`ikm-dock:<utility>`, versioned schema like the TOC's, global not per-page).

### Where config lives (the read-path problem)

- **Extensions (feedback, back-to-top, footer):** docking settings ride each one's
  existing properties — SPFx injects them at `onInit`, zero extra fetches. Feedback and
  back-to-top in their Tenant Wide Extensions rows; footer in its custom-action
  properties.
- **TOC (the odd one out):** it is a webpart with no injected-properties channel and
  currently makes no config reads. It reads a central
  `{appCatalogUrl}/SiteAssets/docking-config.json` written by the admin webpart —
  exactly the feedback-forms file pattern already proven to be readable by all users.
  One small GET per page load (same cost the feedback extension already pays for form
  definitions); app catalog URL via `_api/SP_TenantSettings_Current`.
- The admin webpart writes the same settings to *both* places on save (per-extension
  properties + the JSON) so every consumer has a cheap, natural read path and there is
  one source-of-truth editor.

### Later: the dock tray contract (cross-repo, loose coupling)

Consistent with our existing DOM contracts (`#siteWideBannerContainer`,
`#dpex-breadcrumbs-mount-point`): the footer renders `#ikm-dock-tray` with
left/right slot containers and announces `CustomEvent('ikm-dock:ready')`; a utility
docks by portalling its own chip into a slot; the tray owns layout only. If the tray is
absent (footer is per-site, feedback/back-to-top are tenant-wide), the utility renders
the same chip standalone at the matching bottom corner.

---

## 3. Phases

### Phase 1 — Admin webpart: "Docking & Utilities" section

Follow the existing recipe in `ExtensionManagerAdmin.tsx`: add to the `ExtensionType`
union + `extensionOptions`, an `IDockingSettings` interface, a `_fetch`/`_save` pair,
and a `_renderDockingEditor()`.

- Per-utility editors (TOC, feedback, back-to-top, footer): enabled, minimise target
  (footer / edge-left / edge-right / user's choice), footer side, default state.
- Persistence: per-extension properties + `docking-config.json` as above.
- Back-to-top row: settings target the **new IKM extension's** tenant-wide entry (see
  Phase 3) — the section can ship first with the row present but marked not-yet-active.
- **Fix while here:** the admin's `IFooterSettings` is a subset of `ITMFooterProperties`
  — a non-spread save drops the extension-only fields (`enableSetPreAllocatedTopHeight`,
  `disableSiteAdminUI`, `canEdit*`). Check `_saveFooterSettings` (~line 1104).

### Phase 2 — Table of contents respects the config

- Fetch `docking-config.json`; no config → current behaviour (safe rollout).
- Add a **minimise button** to the floating widget (pill + panel header). Its action
  follows `minimiseTarget`; `user-choice` opens the Dock left / Dock right / Minimise
  to footer menu. Fluent `ChromeMinimize` glyph — not a chevron; chevrons stay reserved
  for expand/collapse (KB: `ux-disclosure-and-anchor-widgets`).
- Docked rendering (all self-contained in the TOC): edge = slim vertical tab at the
  configured edge; footer = corner chip fallback until the tray exists. Expanding
  restores prior position/size. Extend `ikm-toc-float-prefs` with the docked state
  (bump schema version).
- Motion cue: brief scale/translate toward the dock target on minimise (the "genie"
  cue); instant under `prefers-reduced-motion`.

### Phase 3 — Back-to-top becomes ours and respects the config

- Source obtained: `https://gitlab.lsonline.fr/SharePoint/sp-dev-fx-webparts/scrollToTop`
  cloned 2026-08-27 to `D:\Code\Work\IKM-Back-To-Top-Extension`. It is SPFx **1.11** and
  ~330 lines: keep the clone as reference, **re-scaffold on SPFx 1.22/1.23 and port the
  logic** (customizer 209 lines + component 44 + SCSS 58) rather than upgrading the
  ancient toolchain. Tenant-wide-deployable, admin-managed, renders per config
  (labelled "Top" chip/tab).
- Coordination cleanup: the TOC currently hides the community button by hashed-class
  substring (a requirement, though disliked). Once back-to-top is ours, replace the CSS
  hack with a proper one-back-to-top-per-page negotiation. Renaming the
  `spfxScrolltotopBtn` class breaks the TOC's existing hide selector — sequence the two
  changes together.

### Phase 4 — Feedback minimise-to-dock

Replace the session-kill X with minimise per config — fixing today's UX hole (dismissed
= unrecoverable). Honour side settings (currently hardcoded `right: 45px`).

### Phase 5 — Footer: sticky mode + the real dock tray

Modernise `IKM-Footer-Extension` first (oldest project in the suite — SPFx 1.15/1.18
mix, React 16, gulp). Then sticky-bottom mode, the `#ikm-dock-tray` slots, a shared
z-index scale (footer is 13 today vs TOC's 999999), and migrate `footer`-targeted
chips from the corner fallback into the tray.

---

## 4. Build order

1. ~~Obtain the community ScrollToTop source~~ — **done**, cloned to `IKM-Back-To-Top-Extension`.
2. Admin "Docking & Utilities" section + config storage (+ footer-save subset fix).
3. TOC minimise/dock button driven by the config (edge tabs + corner-chip fallback + user-choice menu).
4. Back-to-top re-scaffold on current SPFx; wire to config; retire the hashed-class hide hack.
5. Feedback minimise-to-dock.
6. Footer modernisation + sticky + tray; chips migrate in.
7. *(later, schema-ready)* anything further — e.g. per-site overrides.

## 5. Risks & open points

- **TOC config fetch:** one extra GET per page load — acceptable (feedback already does
  this for forms), but decide caching policy deliberately (feedback removed its
  sessionStorage cache on purpose; a short-TTL cache is probably right for config).
- **Dual-write config:** per-extension properties + JSON must not drift — the admin
  webpart is the only writer, so keep one save routine that writes both.
- **Footer toolchain age:** upgrade before building on it, or accept doing the work twice.
- **Edge tabs vs floating TOC territory:** docked tabs should sit in the upper edge
  region (TOC convention) and never in the bottom-right FAB pile-up; audit total sticky
  coverage on mobile (NN/g ~30% rule). TOC already hides floating UI on mobile.
- **Edit mode:** all docking UI hidden (canvas remount + editing chrome stacking).
- **Concurrent writers:** the footer's in-page panel and the admin webpart both MERGE the
  same custom action — last writer wins; both UIs should read fresh before saving.
- **Requirements screenshot is cut off** after the "Table of contents" bullet — check
  NWR-39932 for further acceptance criteria below the fold.
