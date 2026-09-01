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
- **Responsive:** the host hides all docked UI below the mobile breakpoint
  (matching the TOC's `ms-screen-lg-down` behaviour) and audits total sticky
  coverage; participants don't implement their own responsive dock rules.
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
  bottomSide: 'left' | 'right';  // slot when target is bottom
  defaultState: 'expanded' | 'minimised';
  priority?: number;             // overrides the reserved default
}
```

- `user-choice`: the participant's minimise control opens a menu (mirroring
  Copilot's): *Dock left / Dock right / Minimise to footer*. The user's pick is
  stored per utility in `localStorage` (`ikm-dock:<id>`, versioned `{v: 1, ...}`
  schema, global not per-page — the TOC prefs precedent) and wins over the
  configured default thereafter.
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
