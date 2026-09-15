# Docking initiative — backlog & feedback intake

Future work and things to get back to, in one visible place. Add new items at
the top of the relevant section with a date; strike or move items when done.
(PROGRESS.md says where we ARE; this file says what's still OWED.)

## Stakeholder feedback intake — 2026-09-15

Source: DPEX (Engineers) – IKM (KM) Fortnightly Catch-Up Teams channel.
Michael Wright + Megan Andrews themed the Change Champions' feedback on the
floating table of contents:

| # | Theme | Root causes (as themed) | Recommended action (as themed) |
|---|-------|--------------------------|--------------------------------|
| 1 | Strong user value on long pages | Floating ToC makes long pages easier to navigate, helps reach information faster | None — validation |
| 2 | Inconsistent availability across page types | Manual ToCs, missing web parts, Guided Help, or page structures prevent the floating ToC appearing consistently | Standardise ToC implementation across pages; ensure Guided Help supports ToC (ToC currently misses GH web part headings) |
| 3 | Expandable sections affect detection | Headings inside collapsed/expandable sections not always detected; behaviour inconsistent across pages | Authoring guidance for expandable sections; assess storing ToC entries rather than generating by live scan |
| 4 | Floating behaviour needs refinement | Panel can disappear at top of page, jump while scrolling, obscure content, take too much space on small screens | Refine docking, default positioning, responsive sizing, collapsible behaviour while preserving user control |
| 5 | Readability | Users want clearer separation between links, esp. long pages with many headings | Review visual styling: spacing, separation, presenting a subset of headings on very long pages |
| 6 | User awareness | Some users don't know the panel can be moved/resized | Comms / promotion via Change Champions |

Thread comments worth acting on:

- **MW:** "the docked approach, implemented as a standard thing across our
  tenancy (i.e. not dependent on the web part), would solve a lot of these
  issues" — endorsement of the Docking Host direction; keep him in the loop.
- **MW re #4:** should the floating panel show **by default on page load**,
  not only after scrolling past the inline ToC? "It kind of breaks up the
  experience… it isn't available until you scroll far enough." → design
  decision to make; today's behaviour is deliberate (pin-on-scroll) but this
  is a real counter-argument. Candidate: a web part setting.
- **MW re #4:** replicate/capture video of the "disappears at top of page"
  report.
- **MW re #5:** "a job for a designer" — align to new page templates &
  standard sections, H2+H3 defaults, SP-native styling; hub navigation menu
  text size/spacing as benchmark.
- **MW re #2 (canvas ToC testing):** wants an example page for testing the
  Alt+J/Alt+M canvas-vs-DOM comparison.
- **Own note (AS, 3:32pm):** on prod, docking configured via
  `Breadcrumbs-Admin.aspx` → Docking & Utilities dropdown; "animations look
  wrong some times" (being addressed in the motion-polish rounds,
  v0.1.0.9–14) and "docking positions could be better placed (especially for
  left and right edges)" — revisit edge-zone default positions/alignments.

## Engineering backlog (standing items)

- **Chip context menu (user-choice phase):** un-dock/restore for feedback +
  "Dock left / Dock right" reader choice — the deferred un-dock affordance.
- **Mobile feedback gap:** dock chrome hides < 1024px, so a first-touch
  reader on a phone has no feedback entry point when feedback starts
  minimised. Decide: show the bar on narrow screens regardless, or accept
  desktop-only feedback.
- **Footer phase:** modernise IKM-Footer-Extension, sticky-bottom option,
  host portals bottom zone into `#ikm-dock-bottom-slot`.
- **Community ScrollToTop retirement:** package still in catalogs (disabled
  via TWE row); retire fully once the host's back-to-top is accepted.
- **Sandpit → tenant-wide rollout runbook:** when docking goes tenant-wide,
  remove the SC-catalog host + sandpit's shadowing TOC copy so sites rejoin
  tenant versions; write the promotion steps down before they're needed.
- **TOC canvas source:** finish canvas-vs-DOM parity (some web part
  properties need extra API calls); switch `tocSource` default when clean.
