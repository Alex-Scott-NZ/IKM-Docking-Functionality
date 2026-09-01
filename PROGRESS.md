# Docking Functionality — Progress (NWR-39932)

*Status as at 2026-09-02 (afternoon update below).*

## Update — first two utilities live on the dev tenant

- **Docking Host deployed tenant-wide** (`IKM-Docking-Host-Extension`
  v0.1.0.3): registration API (`window.ikmDock`), dock bottom row in the
  SPFx Bottom placeholder, built-in **back-to-top** as the familiar square
  button reserving the row's rightmost slot (clear of the scrollbar), legacy
  feedback pill nudged into line, edit-mode/mobile hiding, theme-aware.
- **Feedback minimise-to-dock shipped** (`IKM-Feedback-Extension` v0.0.0.15):
  the old unrecoverable session-kill X is now a minimise — pill docks to a
  "Feedback" chip beside back-to-top, chip click restores; per-user choice in
  localStorage; legacy behaviour preserved where the host is absent.
- **Community ScrollToTop disabled** on the tenant (Tenant Wide Extensions
  item 21, `TenantWideExtensionDisabled=true` — flip back to restore). The
  host defers to it wherever it's still enabled.
- **Docking-Playground.aspx** (dpex-testing) is the live test page; verified
  end-to-end with the CDP browser harness.
- Still to come: admin "Docking & Utilities" section (edits the host's
  tenant-wide row — currently running on built-in defaults), TOC minimise +
  `provides` registration, edge-tab targets, footer sticky/slot phase.

## What this is

Word/PowerPoint let the Copilot floating button be **docked** — moved to the
window edge or into the status bar via a small menu. We're bringing that
pattern to the intranet's floating utilities: the **feedback button**, the
**back-to-top button**, and the **floating table of contents**, with the
**footer bar** as a docking surface.

## Architecture (decided)

One new tenant-wide extension — the **Docking Host** (`IKM-Docking-Host-Extension`) —
owns everything:

- All dock zones: bottom-left/right corner chips, left/right edge tabs
  (Copilot-style vertical tabs).
- Renders every minimised chip/tab itself from a small registration descriptor
  (id, label, icon, priority) — so the visual language is identical across
  components built years apart on different React versions.
- Resolves collisions (priorities; "one back-to-top per page" enforced in one
  place, replacing today's CSS-hack where the TOC hides the community button).
- Applies responsive rules: hidden in edit mode and on small screens.
- Ships **back-to-top built in** — no separate back-to-top extension needed.
- Configured centrally from the **Extension Manager Admin** webpart, including
  per-utility placement and a "user's choice" mode where the minimise button
  offers a menu: *Dock left / Dock right / Minimise to footer*.

Participants (feedback, TOC) register with the host when minimised and restore
on click. **Hard rule:** if the host isn't on a site, every utility behaves
exactly as it does today — rollout is safe site by site.

Full details: [APPROACH.md](APPROACH.md) (plan + phases) and
[DOCKING-CONTRACT.md](DOCKING-CONTRACT.md) (the cross-repo API contract).

## Done so far

- ✅ **Survey** of all four affected products (feedback, footer, TOC, community
  back-to-top) + the Extension Manager Admin webpart — placements, config
  storage, versions, coordination hacks all mapped.
- ✅ **Architecture adopted** (centralised host, from APPROACH-2) and the
  **cross-repo contract drafted** — zones, registration API, arbitration,
  config schema, versioning.
- ✅ **Community ScrollToTop source recovered** (gitlab.lsonline.fr, SPFx 1.11)
  and cloned as reference; its behaviour is being absorbed into the host.
- ✅ **Dev-tenant automation restored** (app registration cert re-uploaded,
  labelled so rehearsals stop deleting it).
- ✅ **Live test page built:** `Docking-Playground.aspx` on dpex-testing —
  long-scroll content with headings + the TOC web part, authored via scripted
  PnP. This is the standing target for `npm run start` debug sessions.
- ✅ **Docking Host scaffolded** (SPFx 1.23, heft, Node 22) with the core
  implemented: zone containers, `window.ikmDock` registration API + ready
  event, priority-ordered rendering, edit-mode/mobile hiding, theme-aware
  styling, and a working built-in back-to-top (appears after ~1.5 screens of
  scroll, scrolls SharePoint's nested scroll region correctly).

## Next

1. Verify the host live on Docking-Playground (`npm run start`), iterate.
2. "Docking & Utilities" section in Extension Manager Admin (edits the host's
   tenant-wide config row).
3. TOC integration: minimise/dock button honouring config, `provides:
   ['back-to-top']`, retire the CSS hide hack alongside the community extension.
4. Feedback integration: the unrecoverable session-dismiss X becomes
   minimise-to-dock.
5. Footer: modernise, sticky-bottom mode, host the bottom zone inside the bar.
