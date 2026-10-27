# IKM Docking Contract (draft, v1)

The cross-repo contract between the **Docking Host** application customizer
(`IKM-Docking-Host-Extension`, to be scaffolded) and participating components.
This is the step-1 deliverable from APPROACH.md — agree on this before writing
host or participant code, because every consumer repo depends on it.

## Parties

- **Host** — tenant-wide application customizer. Owns all dock zones, renders
  all minimised UI (chips/tabs), resolves collisions, applies responsive rules,
  holds the configuration, defines the z-index scale.
- **Participants** — Feedback button, Floating TOC, and future components.
  Back-to-top is a *built-in participant inside the host* (it is ~50 lines of
  behaviour; not worth a standalone project). Participants render their own
  *expanded* UI only; they never render docked UI.
- **The footer bar** is not a participant — it is a dock *surface*. When the
  footer is on the page, the host renders its bottom zone into the footer's
  mount slot; otherwise the host renders its own slim bottom strip.

## Zones

| Zone id | Rendering | Region |
|---|---|---|
| `edge-left` / `edge-right` | Slim vertical tab (Copilot-style) | Upper edge region (docs-TOC convention; bottom corners stay FAB territory) |
| `bottom` | Chip (icon + visible micro-label) in the bottom bar, `left` or `right` slot | Footer bar when present, host's own strip otherwise |

## API

Hybrid: a global object for direct calls plus a readiness event for late
binding (SPFx components mount async in any order — neither side may assume
the other is up).

```ts
// window.ikmDock (present once the host has initialised)
interface IIkmDock {
  apiVersion: 1;
  register(d: IDockDescriptor): void;
  unregister(id: string): void;
  update(id: string, patch: Partial<IDockDescriptor>): void;
  // returns the effective settings for a utility, or undefined if docking
  // is disabled for it / the host is disabled on this site
  getSettings(id: string): IDockableUtilitySettings | undefined;
}

interface IDockDescriptor {
  id: string;                    // 'feedback' | 'toc' | future ids
  label: string;                 // visible micro-label, e.g. "Contents"
  icon: string;                  // Fluent UI icon name (host renders it)
  priority?: number;             // lower = closer to the corner; defaults below
  provides?: string[];           // capabilities, e.g. ['back-to-top'] — see arbitration
  onActivate: () => void;        // user clicked the chip/tab → participant restores itself
}
```

**Binding sequence (mandatory for participants):**
1. If `window.ikmDock` exists, use it immediately.
2. Otherwise listen for `document`-level `CustomEvent('ikm-dock:ready')`
   (detail: `{ apiVersion }`) and bind then.
3. If neither ever happens, **degrade to current behaviour** — the host being
   absent (not deployed, disabled for the site, error) must leave every
   participant working exactly as it does today. This is the hard requirement
   that makes rollout safe.

Descriptors are plain data + one callback — no React elements cross the
boundary (participants span React 16/17 and several SPFx versions).

## Arbitration rules (owned by the host)

- **Priorities:** lower number sits closer to the corner / first in the slot.
  Reserved defaults: back-to-top 10, feedback 20, toc 30. Future components
  pick 40+ unless deliberately re-ordered via config.
- **One back-to-top per page:** while a registered participant declares
  `provides: ['back-to-top']` *and is currently visible/expanded* (the floating
  TOC), the host hides its built-in back-to-top chip. This replaces the TOC's
  hashed-class CSS hide hack (`[class*="spfxScrolltotopBtn"]`), which is
  retired when the community extension is retired.
- **Responsive:** at 1024px wide and below, edge-docked utilities fold into
  the bottom row instead of hiding (changed 2026-10-27: hiding them left a
  docked utility unreachable, and a 1920px screen at 200% browser zoom is
  only 960px wide). Participants don't implement their own responsive dock
  rules; a docked utility always has a reachable chip outside edit mode.
- **Edit mode:** all docking UI hidden (SharePoint remounts the canvas and
  editing chrome out-stacks everything).
- **z-index scale:** defined by the host in one place; the footer (13) and
  TOC (999999) migrate onto it as they integrate.

## Configuration (host's tenant-wide properties row)

Lives in the host's `Tenant Wide Extensions` entry — SPFx injects it at
`onInit`, so nobody fetches config at runtime. Participants get their
effective settings from `getSettings(id)`; there is **no** shared config file
(the `docking-config.json` idea from APPROACH v1 is superseded).

```ts
interface IDockingHostProperties {
  enabled: boolean;
  allowedSiteIds?: string[];     // optional gating, same pattern as feedback
  utilities: Record<string, IDockableUtilitySettings>;
  debug?: boolean;
}

interface IDockableUtilitySettings {
  enabled: boolean;
  minimiseTarget: 'bottom' | 'edge-left' | 'edge-right' | 'user-choice';
  defaultTarget?: 'bottom' | 'edge-left' | 'edge-right'; // v1.3: start of a user-choice utility
  bottomSide: 'left' | 'right';  // slot when target (or defaultTarget) is bottom
  defaultState: 'expanded' | 'minimised';
  priority?: number;             // overrides the reserved default
}
```

- `user-choice` (contract v1.3, host 0.1.0.25+): readers move the utility
  themselves by **dragging its chip/tab to another zone**. While they drag,
  every zone it can go to lights up (bottom bar left, bottom bar right, left
  edge, right edge; only the two bottom areas on screens 1024px wide or less,
  where edges fold into the bottom row) and the one under the pointer goes
  solid; letting go anywhere else springs it back. It starts at
  `defaultTarget` (+ `bottomSide` / `edgeAlign`) until the reader moves it.
  The pick is stored by the HOST in `localStorage['ikm-dock:place']`
  (`{v: 1, places: {<id>: {target, bottomSide, edgeAlign}}}`), which is per
  origin, so it applies on every site in the tenant; dragging it back to its
  starting zone deletes the entry. Participants need no code for this: they
  never read `minimiseTarget`. (Superseded: the earlier idea of a menu on the
  participant's minimise control.)
- Utilities with a fixed `minimiseTarget` can still be reordered within their
  zone (per page) but cannot leave it: dragged across the zone they give
  about 16px and spring back.
- Edited only by the Extension Manager Admin webpart's "Docking & Utilities"
  section (standard `_fetch`/`_save` pair against the host's row).

## Footer mount slot

When present, the footer renders `<div id="ikm-dock-bottom-slot" data-side-left
data-side-right>` inside the bar and the host portals its bottom zone there;
the host watches for the slot appearing/disappearing (SPA navigation). Absent
slot → host renders its own strip. Known-ID contract, same style as
`#siteWideBannerContainer` / `#dpex-breadcrumbs-mount-point`.

## Versioning

`apiVersion: 1`. Additive changes (new descriptor fields, new zones) don't bump
it; anything breaking ships as v2 alongside v1 for a deprecation window. The
host logs (under `debug`) any registration with an unknown shape rather than
throwing.

## v1.1 additions (2026-09-15)

`IDockableUtilitySettings.edgeAlign?: 'top' | 'middle' | 'bottom'` — vertical
cluster when `minimiseTarget` is an edge (default `middle`). Additive;
`apiVersion` stays 1.

## v1.2 additions (2026-09-15): host-owned motion + reading surfaces

**Motion.** The HOST owns all minimise/restore animation, because only the
host knows where a utility's chip/tab actually is (config can put it in
either bottom corner or on an edge). Two optional methods on `window.ikmDock`
(feature-detect; `apiVersion` stays 1):

```ts
interface IDockRect { left: number; top: number; width: number; height: number; }
animateMinimise?(id: string, from: IDockRect, done?: () => void): void;
animateRestore?(id: string, to: IDockRect, done?: () => void): void;
```

The participant hides (minimise) or shows (restore, in `done`) its real UI
immediately; the host flies a lightweight theme-coloured proxy between the
given rect and the utility's chip — or its destination zone when the chip
doesn't exist yet, since registration normally happens after the minimise.
One duration (180 ms), one easing, one `prefers-reduced-motion` policy for
every participant; participants ship NO animation code of their own. Against
a pre-1.2 host the fallback is an instant transition — the usual degrade
shape.

**Reading surfaces.** Dock chrome is a reading aid: the host renders only on
modern site pages (an item in a Site Pages library). On list and library
views, forms and system pages — edge-to-edge content, no reading journey —
the host withdraws entirely (same mechanism as the edit-mode withdrawal,
re-evaluated on SPA navigation). Decided 2026-09-15 after the feedback edge
tab covered the Site Pages library's columns.

## v1.4 additions (2026-10-28): open utilities keep their tab

Decided 2026-10-28: every utility behaves the same way when opened, like a
window and its taskbar button. Before this, feedback's tab stayed in the dock
while its form was open, but the contents tab left with the flight and came
back on minimise, so tabs appeared and disappeared depending on which
utility it was.

```ts
interface IDockDescriptor {
  // ...
  open?: boolean;   // the utility's UI is on screen
}
```

- **A participant stays registered while its UI is open.** On restore it
  calls `animateRestore` WITHOUT `chipHandOff`, shows its UI in `done`, and
  reports `update(id, { open: true })`. On minimise it reports
  `update(id, { open: false })` alongside `animateMinimise`.
- **The host keeps the tab in its slot, marked open:** a shade darker with a
  white bar on the side facing the screen edge, and `aria-expanded="true"`.
  An update that changes only `open` restyles the tab in place (no
  re-render, no entrance motion).
- **Clicking an open utility's tab minimises it** (`onActivate` toggles).
- Participants that never send `open` get no open/closed styling and no
  `aria-expanded`, since the host cannot know. `chipHandOff` still works for
  pre-1.4 participants that unregister on restore.
- A participant may still unregister when its UI has no reason to be in the
  dock at all, e.g. the contents tab while the inline table of contents is
  on screen.

**Drop areas** (Reader's choice, v1.3) are drawn the same size and shape as
what lands there: a 30px strip along the bottom with square corners like the
chips, and a tab-wide strip flush with each edge, rounded on the inner side
like the tabs. The area that accepts the drop is wider than the outline
(about 44px further in), so the thinner outline does not make the drop
harder to hit.
