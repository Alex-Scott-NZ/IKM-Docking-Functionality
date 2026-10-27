# IKM-Docking-Host-Extension

The IKM **Docking Host** — a tenant-wide SPFx application customizer that owns
all docking zones for the intranet's floating utilities (feedback, back-to-top,
table of contents). It renders every minimised chip/tab itself from plain
registration descriptors and arbitrates collisions.

- **Canonical contract:** `DOCKING-CONTRACT.md` in the sibling repo
  `IKM-Docking-Functionality` (also holds `APPROACH.md`, the phased plan).
  `src/extensions/dockingHost/contract.ts` mirrors it — change them together.
- **Plan context:** NWR-39932. Participants integrate in later phases
  (TOC → feedback); the built-in back-to-top ships with the host.

## Architecture rules

- **No React.** The host renders vanilla DOM from descriptors on purpose:
  participants span React 16/17 and several SPFx versions; nothing
  framework-specific may cross the `window.ikmDock` boundary.
- Participants must degrade to their pre-docking behaviour when the host is
  absent — never assume the host into a participant's critical path.
- All docking UI hides in edit mode. At 1024px wide and below, edge tabs fold
  into the bottom row (never hide them: a docked utility must stay reachable).
- One host per page: a second registration (tenant row + site catalog row)
  joins the running host via `window.__ikmDockingHost` and merges settings.
- Before changing motion or layout, run TEST-PLAN.md's automated suite
  (`tools/dock-layout-tests`) and compare with the last results.
- z-index comes from `DOCK_Z_INDEX` in `contract.ts` — one scale for all IKM
  floating chrome; don't introduce new magic z-indexes.

## Build / test

- SPFx 1.23, heft, **Node 22** (`nvm use 22` — beware per-shell version skew).
- `npm run start` (heft start) serves the debug bundle; debug manifests URL is
  `https://localhost:4321/temp/build/manifests.js` (SPFx ≥1.19 path).
- Live test page: `https://5pbdxb.sharepoint.com/sites/kc-sandpit/SitePages/Docking-Playground.aspx`
  (long-scroll page with headings + TOC web part; the host is deployed to
  kc-sandpit's site catalog). dpex-testing's copy of the page has no host and
  is the "host absent" check. serve.json still points at dpex-testing.

## Version bumps

Always update BOTH files with the same 4-part `major.minor.patch.build` string:
- `package.json` `version`
- `config/package-solution.json` — `solution.version` AND `features[].version`
