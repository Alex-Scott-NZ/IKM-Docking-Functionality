# Docking layout test plan

A repeatable list of checks for the dock: utilities minimised to the bottom
row or to the left/right edges. The tests describe **outcomes, not
mechanics**, so they stay valid when the animations change.

**The one rule every test checks.** Once everything has stopped moving:

1. every docked utility has exactly one chip/tab, and it is fully on screen;
2. each chip sits in its slot: one standard gap (8px) from its neighbour,
   lined up with the rest of its zone, no overlaps;
3. the zone is anchored where it belongs: bottom row on the bottom edge,
   right-hand zones just clear of the scrollbar;
4. the order is the reader's saved order (after a drag), otherwise the
   configured priority order;
5. nothing is left half-way: no faded, shrunken, offset or invisible chip,
   no leftover flight image;
6. an open utility keeps its chip/tab in its slot, marked open (darker, with
   a white bar on the side facing the screen edge); a closed one is not
   marked open (contract v1.4, 2026-10-28).

The automated runner (`tools/dock-layout-tests/`) checks all six after every
step and screenshots any failure. A manual tester checks the same things by
eye.

## Where to test

Dev page: `https://5pbdxb.sharepoint.com/sites/kc-sandpit/SitePages/Docking-Playground.aspx`.
The host's config on kc-sandpit (site-collection Tenant Wide Extensions list,
item 1) includes test-only utilities `zt-<zone>-<letter>` so every zone can
be filled with three items. They never appear unless the runner registers
them. The real participants are feedback (right edge) and the table of
contents (right edge, once scrolled past the inline TOC).

Run every zone: **bottom-left, bottom-right, left edge, right edge (middle and
bottom clusters)**, each with three items docked.

## The tests

### Basic moves
| # | Do | Expect |
|---|----|--------|
| B1 | Minimise three utilities one after another | Each lands in its own slot, in priority order |
| B2 | Restore each one, then minimise it again | It returns to the same slot; the others close the gap and reopen it without drifting |
| B3 | With three docked, restore the middle one and dock it again | The other two close up, then make room again |
| B4 | Drag the last chip to the first position, and the first to the last | Neighbours slide aside; the dropped chip settles in its new slot |
| B5 | After a reorder, open and close each utility | Each comes back to its reordered slot, not its default one |
| B6 | Reload the page after a reorder | The order is kept |
| B7 | Open each utility from its tab, then click the tab again | The tab stays in its slot, marked open, while the utility is showing; clicking it again minimises the utility and the mark goes |
| B8 | Open the contents panel and the feedback form with both docked on the right edge, then expand the contents list | Neither panel covers a right-edge tab |

### Trying to break it
| # | Do | Expect |
|---|----|--------|
| X1 | Minimise all three at once | Three chips, three slots, no stacking |
| X2 | Restore a chip and minimise it again before the animation ends | One chip or none, never two; no ghost left on screen |
| X3 | Double-click a chip | Same as one click, or a clean open-and-close |
| X4 | Minimise one utility while another is restoring | Both end in the right state |
| X5 | Drag a chip while another is still flying in | Final order and slots are correct |
| X6 | Resize the window while docked, mid-restore and mid-minimise | Zones re-anchor to the new edges |
| X7 | Zoom the browser in and out (Ctrl + / Ctrl -) while docked | Same as X6 |
| X8 | Scroll the page during a flight | Chips end in their slots |
| X9 | Switch to another tab mid-animation, then come back | Nothing frozen half-way |
| X10 | Grab a docked tab and pull it straight out onto the page, quickly (a flick) and slowly, and let go out there. Then move the mouse back over the tab without pressing | While held it only gives a little; on letting go it springs back to its slot; it never follows the mouse with no button down; one click still opens it |

### Readers moving a utility (Reader's choice)
Utilities set to Reader's choice can be dragged to another zone. On kc-sandpit
`zt-uc-a` (starts bottom left), `zt-uc-b` (starts on the left edge), feedback
and the contents (both start on the right edge) are set up this way.

| # | Do | Expect |
|---|----|--------|
| M1 | Start dragging a Reader's-choice tab | Every area it can go to lights up, its starting area marked "(default)": four areas on a wide screen, the two bottom ones at 1024px wide or less. Each area is the size and shape of what lands there: a 30px square-cornered strip along the bottom, a tab-wide strip flush with each edge |
| M2 | Drag it over each area in turn | Only the area under the pointer goes solid |
| M3 | Drop it on each area, then open and close it after each move | It lands in that area where it was dropped, the others close up and make room, and closing it later brings it back to the new area |
| M4 | Reload, and visit another page | It is still where the reader put it |
| M5 | Drop it back on its starting area | It goes back, and the saved choice is cleared |
| M6 | Let go on the page away from every area, or flick it out quickly | It springs back to where it was |
| M7 | Drag a utility that is NOT Reader's choice | No areas light up; it only reorders within its own zone |
| M8 | Move a tab to an edge, then narrow the window below 1024px and widen it again | It folds into the bottom row, then returns to the edge |

### Screens and zoom
Run B1, B4, X6, X10 and M1-M3 at each size. These are the CSS pixels the page actually
gets; browser zoom and Windows scaling both shrink them.

| Name | Page size | Real-world setup |
|------|-----------|------------------|
| office-100 | 1920 × 950 | Office monitor, 100% |
| office-125 | 1536 × 750 | Office monitor, Windows 125% |
| office-150 | 1280 × 620 | Office monitor, 150% or browser zoom 150% |
| zoom-200 | 960 × 470 | Browser zoomed to 200% (the "disappeared" report) |
| laptop | 1366 × 650 | Small laptop, short window |
| 4k-150 | 2560 × 1300 | 4K monitor at 150% |

Extra checks at these sizes:
- **S1** Every zone filled at once: no zone overlaps another.
- **S2** A short window with tabs in the middle and bottom clusters of one edge: they must not overlap or run off the bottom.
- **S3** Below the width where the dock hides: a docked utility must still be reachable somehow.

## Running it automatically

```bash
cd tools/dock-layout-tests
SPFX_TEST_PAGE_MATCH=kc-sandpit/SitePages/Docking node dock-run.mjs [scenario] [viewports]
# e.g.  node dock-run.mjs reorder office-100,zoom-200
```

Needs the CDP test browser on port 9222, signed in to the dev tenant, with the
playground page open (see the `spfx-live-test` skill). Results go to
`out/results.json`, with a screenshot per failure.

## Results log

| Date | Host | Result | Notes |
|------|------|--------|-------|
| 2026-10-27 | 0.1.0.18 (baseline) | Fails | Two hosts on kc-sandpit (tenant + site registrations both ran), two overlapping back-to-top buttons; edge clusters overlap on short windows; left tabs cover SharePoint's app bar; right-edge flights land 22-48px off the tab; at 960px wide every edge-docked utility unreachable (feedback vanished). |
| 2026-10-27 | 0.1.0.21 | 29/29 at office-100; 93/95 across the other five sizes, the 2 being contents tests that cannot run below 1024px (now marked n/a) | Second registration joins the running host; one rail per edge; flights home on the real slot; neighbours slide on add/remove; edge tabs fold into the bottom row at 1024px and below. |
| 2026-10-27 | 0.1.0.24 | X10 (pull-out) passes in every zone at every size; full suite 191/202 on the first run, all 11 failures intermittent | Fixed: a quick pull of a tab out onto the page left it "held", following the mouse with no button down, and a click then only put it back (did not open it). Tabs now only give 16px when pulled off the dock. The intermittent failures are FLIGHT-MISS after an interrupted animation (rapid restore/minimise, scroll or resize mid-flight, three docked at once after a reload). An A/B with the old drag code (deployed as 0.1.0.23) failed the same cases at the same rate, so they were already there: the earlier clean 29/29 was a lucky run. "Restore then minimise mid-flight" is a race only the runner can create (a reader cannot press minimise before the restored panel is on screen). |
| 2026-10-28 | 0.1.0.26 | Full suite 226/230 at all six sizes; every Reader's-choice test (M1-M8) passes | Reader's choice: drag a tab to another zone, areas light up while dragging, choice kept across pages and reloads. The 4 failures are the known intermittent FLIGHT-MISS kinds (3 the runner-only restore-then-minimise race, 1 three docking at once after a reload at 200%). |
