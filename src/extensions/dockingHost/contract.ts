/**
 * The IKM docking contract, v1.
 * Canonical definition: DOCKING-CONTRACT.md in the IKM-Docking-Functionality repo.
 * Participants copy these types (they span SPFx/React versions — no shared package).
 */

export const DOCK_API_VERSION = 1 as const;

/** Where minimised UI can live. */
export type DockZone = 'bottom' | 'edge-left' | 'edge-right';

export type MinimiseTarget = DockZone | 'user-choice';

/** Reserved priorities: back-to-top 10, feedback 20, toc 30. Lower sits closer to the corner. */
export interface IDockDescriptor {
  id: string;
  label: string;
  /** Fluent UI icon name (host renders it); falls back to the first letter of the label. */
  icon: string;
  priority?: number;
  /** Capabilities, e.g. ['back-to-top'] — the host suppresses its built-in equivalent while registered. */
  provides?: string[];
  /**
   * Contract v1.4: the utility's UI is open on screen. A participant stays
   * registered while open and reports it here (`update(id, { open })`); the
   * host keeps the chip/tab in its slot, marked as open, like a taskbar
   * button. Omitted = the host shows no open/closed state.
   */
  open?: boolean;
  /**
   * User clicked the chip/tab. Closed: open the utility. Open (v1.4): minimise
   * it again. Pre-1.4 participants restore and unregister instead.
   */
  onActivate: () => void;
}

export interface IDockableUtilitySettings {
  enabled: boolean;
  /**
   * Where it docks. 'user-choice' (contract v1.3): readers can drag its
   * chip/tab to another zone and the browser remembers their pick; until
   * they do, it docks at `defaultTarget`.
   */
  minimiseTarget: MinimiseTarget;
  /** Starting zone when minimiseTarget is 'user-choice' (contract v1.3). Default 'bottom'. */
  defaultTarget?: DockZone;
  /** Slot when target (or defaultTarget) is 'bottom'. */
  bottomSide: 'left' | 'right';
  /** Vertical cluster when target (or defaultTarget) is an edge (contract v1.1). Default 'middle'. */
  edgeAlign?: 'top' | 'middle' | 'bottom';
  defaultState: 'expanded' | 'minimised';
  priority?: number;
}

/** The host's ClientSideComponentProperties / Tenant Wide Extensions row. */
export interface IDockingHostProperties {
  enabled?: boolean;
  allowedSiteIds?: string[];
  utilities?: { [id: string]: IDockableUtilitySettings };
  debug?: boolean;
}

/** A viewport-relative rectangle (contract v1.2 motion API). */
export interface IDockRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** window.ikmDock */
export interface IIkmDock {
  apiVersion: typeof DOCK_API_VERSION;
  register(descriptor: IDockDescriptor): void;
  unregister(id: string): void;
  update(id: string, patch: Partial<IDockDescriptor>): void;
  getSettings(id: string): IDockableUtilitySettings | undefined;
  /**
   * Contract v1.2 (additive — feature-detect; apiVersion stays 1): the HOST
   * owns minimise/restore motion, because only the host knows where the
   * chip/tab actually is. The participant hides (or shows) itself
   * IMMEDIATELY and hands over its rectangle; the host flies a lightweight
   * proxy between that rect and the utility's dock target — one duration,
   * one easing, one reduced-motion policy for every participant.
   * `animateRestore`'s `done` fires when the proxy lands (or at once under
   * reduced motion) — show the restored UI in it.
   */
  animateMinimise?(id: string, from: IDockRect, done?: () => void, source?: Element): void;
  /**
   * `chipHandOff`: the chip departs WITH the flight (hidden at launch) —
   * for pre-1.4 utilities that unregister on restore. A v1.4 participant
   * stays registered while open (see `open`) and omits it.
   */
  animateRestore?(id: string, to: IDockRect, done?: () => void, options?: { chipHandOff?: boolean }): void;
}

export const DOCK_READY_EVENT = 'ikm-dock:ready';

/**
 * One z-index scale for all IKM floating chrome. Edit-mode chrome out-stacks
 * everything anyway (we hide there); this only needs to clear page content
 * and the footer (z-index 13). The TOC's 999999 migrates down here when it
 * integrates.
 */
export const DOCK_Z_INDEX = 100000;

export const RESERVED_PRIORITIES: { [id: string]: number } = {
  'back-to-top': 10,
  feedback: 20,
  toc: 30
};
