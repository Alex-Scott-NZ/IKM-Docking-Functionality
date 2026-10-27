# Dock layout tests

Automated version of [TEST-PLAN.md](../../TEST-PLAN.md). It drives the real
docking host on a live page through the CDP test browser (port 9222), waits
for all motion to stop after each step, and checks the layout rules. It also
records every flight and checks that it LANDED on the chip or panel it was
heading for.

```bash
SPFX_TEST_PAGE_MATCH=kc-sandpit/SitePages/Docking node dock-run.mjs [scenarios] [viewports]
# scenarios: comma-separated name fragments, e.g. "basic,real"; empty = all
# viewports: office-100, office-125, office-150, zoom-200, laptop, 4k-150 (comma-separated)
```

- `dock-lib.js` is injected into the page. It registers test-only utilities
  (`zt-<zone>-<letter>`) through `window.ikmDock` exactly as real participants
  do, and holds the checker.
- `add-test-utilities.ps1` adds those test utilities to the kc-sandpit host
  config (site-collection Tenant Wide Extensions item 1) and saves the
  original properties beside it. Already applied on the dev tenant 2026-10-27.
- Results: `out/results.json` plus a screenshot per failure (`out/` is not committed).

Failure codes: `SLOT-GAP`, `SLOT-ALIGN`, `ZONE-ANCHOR`, `ORDER`, `OFF-SCREEN`,
`OVERLAP`, `COVERS-SP`, `STUCK-*`, `PROXY-LEFT`, `CHIP-COUNT`, `UNREACHABLE`,
`LINGERING`, `LOST-PANEL`, `DOUBLE`, `FLIGHT-MISS`, `NEVER-SETTLED`.
