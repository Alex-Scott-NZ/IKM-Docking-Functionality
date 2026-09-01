# SharePoint "Docking" Functionality — Approach (NWR-39932)

**Goal:** replicate the Copilot FAB "dock" pattern for our common page utilities — the
feedback button, back-to-top button, and table of contents — so they can be minimised
out of the way and restored, with behaviour controlled centrally from the Extension
Manager Admin webpart.

**Adopted architecture (v2, 2026-09-01):** the centralised **Docking Host** model from
[APPROACH-2.md](APPROACH-2.md) — a single tenant-wide application customizer that owns
all dock zones, renders all minimised UI, resolves collisions, applies responsive rules,
and exposes a registration API that participants bind to. The full cross-repo contract
is drafted in [DOCKING-CONTRACT.md](DOCKING-CONTRACT.md). This supersedes the v1 model
(footer-owned tray + per-utility fallback chips + `docking-config.json`).

---

## 1. Where everything is today (survey, 2026-08-27)

| Utility | Project | Placement today | Minimise today | Configured via |
|---|---|---|---|---|
| **Feedback button** | `IKM-Feedback-Extension` (tenant-wide app customizer; SPFx 1.20, React 17) | `position: fixed` pill, `bottom: 0; right: 45px`, in the Bottom placeholder | X button → `sessionStorage['feedbackButtonHidden']` — gone for the session, **no restore affordance** | Tenant Wide Extensions list properties; already has a section in Extension Manager Admin |
| **Back to top** | Deployed one is the **community ScrollToTop customizer** (Laurent Sittler, gitlab.lsonline.fr — SPFx 1.11, ~330 lines; cloned to `IKM-Back-To-Top-Extension` as reference). The TOC CSS-hides it (`[class*="spfxScrolltotopBtn"]`) and provides its own "Top"/"Back to top" buttons in the floating widget | Bottom-right, Bottom placeholder | n/a | **Not in the admin webpart at all** |
| **Footer bar** | `IKM-Footer-Extension` (per-site `UserCustomAction`, component id `7537f274-…`; SPFx ~1.18 mixed, React 16, gulp) | **In-flow** bar appended inside `div[role="main"]` — scrolls away with content, `z-index: 13` | None | Its own edit-pencil Panel **and** Extension Manager Admin (both MERGE the same custom action) |
| **Table of contents** | `IKM-Table-Of-Contents-WebPart` (SPFx 1.23, heft; v1.0.2.42) | In-canvas section + floating pinned widget top-right (drag, resize, collapse-to-pill), `z-index: 999999` | Collapse to pill; prefs in `localStorage['ikm-toc-float-prefs']` | Native property pane only |

**Admin webpart:** `IKM-Extension-Manager-Admin-WebPart` (SPFx 1.22.1, Fluent 8, React 17).
One dropdown → one `_render*Editor()` per extension in `ExtensionManagerAdmin.tsx`, with
an established `_fetch`/`_save` recipe against the app catalog's `Tenant Wide Extensions`
list (`TenantWideExtensionComponentProperties` JSON, `Title eq '<Name>'`).

---

## 2. The architecture

```
Docking Host Application Customizer  (IKM-Docking-Host-Extension, tenant-wide)
├── reads docking configuration       ← its own Tenant Wide Extensions row (injected, no fetches)
├── owns all docking zones            ← edge-left / edge-right tabs, bottom bar chips
├── renders all minimised UI          ← from plain registration descriptors (no React interop)
├── resolves collisions               ← priorities; one-back-to-top-per-page via `provides`
├── applies responsive rules          ← mobile hide, edit-mode hide, sticky-coverage audit
├── defines the z-index scale         ← footer (13) and TOC (999999) migrate onto it
├── ships back-to-top built in        ← ~50 lines of behaviour; no standalone fork project
└── exposes registration API          ← window.ikmDock + 'ikm-dock:ready' CustomEvent

Participating components (render their own EXPANDED UI only)
├── Feedback         — X becomes minimise-to-dock (fixes the unrecoverable-dismiss hole)
├── Floating ToC     — minimise button; declares provides:['back-to-top']
└── future components — just register
```

Key wins over the v1 model:

- **Tenant-wide host ⇒ a dock exists on every page.** No per-utility standalone-chip
  fallbacks needed (the footer is per-site; the host isn't).
- **Config rides the host's own properties row ⇒ nobody fetches config.** Participants
  call `getSettings(id)`; the TOC's read-path problem (it's a webpart, nothing injects
  properties into it) disappears, and so does the `docking-config.json` dual-write.
- **Arbitration has an owner.** The TOC's hashed-class CSS hide hack, the z-index
  anarchy, and the `right: 45px` magic number are all symptoms of nobody owning
  collision resolution; the host's priority + `provides` rules replace them.
- **Descriptor-based rendering ⇒ one visual language for free.** Participants span
  React 16/17 and several SPFx versions; chips/tabs rendered by the host from
  `{id, label, icon, priority, onActivate}` keep them consistent and thin.

**Hard requirement:** a participant that never sees the host (not deployed, disabled,
error) behaves exactly as it does today. That makes rollout safe site by site.

**The footer bar** is a dock *surface*, not a participant: when present it renders
`#ikm-dock-bottom-slot` and the host portals its bottom zone in; absent, the host
renders its own slim strip. `user-choice` mode gives the participant's minimise button
a Copilot-style menu (*Dock left / Dock right / Minimise to footer*); user picks persist
in `localStorage` (`ikm-dock:<id>`) over admin defaults.

Full schemas, events, binding sequence, priorities and versioning:
[DOCKING-CONTRACT.md](DOCKING-CONTRACT.md).

---

## 3. Order of work

1. **Finalise the contract** ([DOCKING-CONTRACT.md](DOCKING-CONTRACT.md)) — it's
   cross-repo; agree before code.
2. **Scaffold `IKM-Docking-Host-Extension`** (SPFx 1.23, heft, tenant-wide): zones,
   buffered registration, arbitration, responsive/edit-mode rules, z-index scale,
   built-in back-to-top. Shippable and visibly useful alone (replaces the community
   ScrollToTop — retire that per-site as the host rolls out; its clone stays as
   reference).
3. **Admin webpart:** "Docking & Utilities" section editing the host's tenant-wide row
   (standard recipe: `ExtensionType` union + `extensionOptions` + `_fetch`/`_save` +
   `_renderDockingEditor`). Per-utility: enabled, minimise target, bottom side, default
   state, priority. **Fix while there:** the admin's `IFooterSettings` is a subset of
   `ITMFooterProperties` — a non-spread save drops the extension-only fields (check
   `_saveFooterSettings`, ~line 1104).
4. **TOC integration:** minimise button on the floating widget (Fluent `ChromeMinimize`
   glyph — not a chevron; chevrons stay reserved for expand/collapse), action per
   `getSettings('toc')` incl. the user-choice menu; register on minimise / restore on
   activate; declare `provides: ['back-to-top']`; retire the CSS hide hack in the same
   release the community extension is retired. Extend `ikm-toc-float-prefs` with the
   docked state (schema version bump). Motion cue toward the dock target on minimise;
   instant under `prefers-reduced-motion`.
5. **Feedback integration:** X → minimise-to-dock per `getSettings('feedback')`;
   remove the hardcoded `right: 45px`.
6. **Footer:** modernise (oldest toolchain in the suite — SPFx 1.15/1.18 mix, React 16,
   gulp), sticky-bottom mode (`position: sticky; bottom: 0` works because it's injected
   inside SharePoint's nested scroll region), render `#ikm-dock-bottom-slot`, adopt the
   host z-index scale. Last — nothing else depends on it.

## 4. Risks & open points

- **Host as single point of failure:** mitigated by the mandatory degrade-to-today rule;
  test every participant with the host absent.
- **Registration timing:** async mount order is guaranteed-random; the
  `window.ikmDock`-or-`ikm-dock:ready` binding sequence in the contract is mandatory,
  and the host buffers nothing (participants re-register on `ready`).
- **Community ScrollToTop retirement** must be sequenced with the TOC hide-hack removal —
  the hack keys on that extension's class name.
- **Mobile:** host hides docked UI below the mobile breakpoint (TOC precedent); keep
  total sticky coverage well under ~30% of viewport (NN/g).
- **Concurrent writers on the footer row:** its in-page panel and the admin webpart both
  MERGE the same custom action — read fresh before saving.
- **Requirements screenshot is cut off** after the "Table of contents" bullet — check
  NWR-39932 for further acceptance criteria below the fold.
