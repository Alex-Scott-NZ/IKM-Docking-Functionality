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
  /** User clicked the chip/tab — participant restores itself (and should then unregister). */
  onActivate: () => void;
}

export interface IDockableUtilitySettings {
  enabled: boolean;
  minimiseTarget: MinimiseTarget;
  /** Slot when target is 'bottom'. */
  bottomSide: 'left' | 'right';
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

/** window.ikmDock */
export interface IIkmDock {
  apiVersion: typeof DOCK_API_VERSION;
  register(descriptor: IDockDescriptor): void;
  unregister(id: string): void;
  update(id: string, patch: Partial<IDockDescriptor>): void;
  getSettings(id: string): IDockableUtilitySettings | undefined;
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
