import {
  DOCK_API_VERSION,
  DOCK_READY_EVENT,
  DOCK_Z_INDEX,
  RESERVED_PRIORITIES,
  DockZone,
  IDockDescriptor,
  IDockableUtilitySettings,
  IDockingHostProperties,
  IIkmDock
} from './contract';

const STYLE_ID = 'ikm-dock-styles';
const ROOT_ID = 'ikm-dock-host';
/** Rendered by the footer extension when present; the bottom zone portals in (later phase). */
const FOOTER_SLOT_ID = 'ikm-dock-bottom-slot';
/**
 * Show the built-in back-to-top after this much scroll. Capped in pixels:
 * a threshold expressed purely in viewport heights can exceed a page's
 * maximum scrollable distance on large windows (content height minus one
 * viewport), making the chip unreachable.
 */
const BACK_TO_TOP_MIN_SCROLL_PX = 400;
const FALLBACK_PRIMARY = '#085a64';

interface IRegistered {
  descriptor: IDockDescriptor;
  element: HTMLElement | undefined;
}

/**
 * Owns the dock zones, renders all minimised UI from descriptors, arbitrates
 * priorities/capabilities, and exposes window.ikmDock. Vanilla DOM on purpose:
 * participants span React 16/17 — nothing framework-specific crosses the boundary.
 */
export class DockManager {
  private _props: IDockingHostProperties;
  private _themePrimary: string;
  private _root: HTMLElement | undefined;
  private _zones: { [key: string]: HTMLElement } = {};
  private _registered: Map<string, IRegistered> = new Map();
  private _scrollRegion: HTMLElement | Window | undefined;
  private _scrollRaf = 0;
  private _pastScrollThreshold = false;
  private _disposed = false;

  private _onScrollCapture = (e: Event): void => this._handleScroll(e);

  private _bottomHost: HTMLElement | undefined;

  public constructor(props: IDockingHostProperties, themePrimary?: string, bottomHost?: HTMLElement) {
    this._props = props;
    this._themePrimary = themePrimary || FALLBACK_PRIMARY;
    this._bottomHost = bottomHost;
  }

  public start(): void {
    this._injectStyles();
    this._buildZones();
    this._publishApi();
    this._registerBuiltInBackToTop();
    // Capture phase: modern SP scrolls a nested region, not the window,
    // and scroll events don't bubble — capture is the only reliable hook.
    document.addEventListener('scroll', this._onScrollCapture, true);
    // The feedback button mounts async (dynamic import) — re-measure the
    // bottom row a few times after start, then keep it fresh on scroll ticks.
    [500, 1500, 4000].forEach((ms) => window.setTimeout(() => this._updateBottomRowOffset(), ms));
    this._log('started');
  }

  public dispose(): void {
    this._disposed = true;
    document.removeEventListener('scroll', this._onScrollCapture, true);
    if (window.cancelAnimationFrame && this._scrollRaf) {
      window.cancelAnimationFrame(this._scrollRaf);
    }
    if ((window as unknown as { ikmDock?: IIkmDock }).ikmDock) {
      delete (window as unknown as { ikmDock?: IIkmDock }).ikmDock;
    }
    Object.keys(this._zones).forEach((z) => this._zones[z]?.remove());
    this._root?.remove();
    document.getElementById(STYLE_ID)?.remove();
    this._registered.clear();
    this._log('disposed');
  }

  /** Re-evaluate visibility (edit mode toggles, SPA navigation). */
  public setHidden(hidden: boolean): void {
    if (this._root) {
      this._root.hidden = hidden;
    }
    // Bottom zones may live in the placeholder, outside _root.
    ['bottom-left', 'bottom-right'].forEach((z) => {
      if (this._zones[z]) { this._zones[z].hidden = hidden; }
    });
  }

  // ---------------------------------------------------------------- API

  private _publishApi(): void {
    const api: IIkmDock = {
      apiVersion: DOCK_API_VERSION,
      register: (d) => this._register(d),
      unregister: (id) => this._unregister(id),
      update: (id, patch) => this._update(id, patch),
      getSettings: (id) => this._getSettings(id)
    };
    (window as unknown as { ikmDock?: IIkmDock }).ikmDock = api;
    document.dispatchEvent(new CustomEvent(DOCK_READY_EVENT, { detail: { apiVersion: DOCK_API_VERSION } }));
  }

  private _register(d: IDockDescriptor): void {
    if (this._disposed) { return; }
    if (!d || !d.id || !d.label || typeof d.onActivate !== 'function') {
      this._log(`register rejected — malformed descriptor: ${JSON.stringify(d && d.id)}`);
      return;
    }
    const settings = this._getSettings(d.id);
    if (settings && !settings.enabled) {
      this._log(`register ignored — '${d.id}' disabled by config`);
      return;
    }
    this._unregister(d.id); // idempotent re-register
    const entry: IRegistered = { descriptor: d, element: undefined };
    this._registered.set(d.id, entry);
    this._renderEntry(entry);
    this._applyArbitration();
    this._log(`registered '${d.id}'`);
  }

  private _unregister(id: string): void {
    const entry = this._registered.get(id);
    if (!entry) { return; }
    entry.element?.remove();
    this._registered.delete(id);
    this._applyArbitration();
    this._log(`unregistered '${id}'`);
  }

  private _update(id: string, patch: Partial<IDockDescriptor>): void {
    const entry = this._registered.get(id);
    if (!entry) { return; }
    entry.descriptor = { ...entry.descriptor, ...patch, id };
    entry.element?.remove();
    entry.element = undefined;
    this._renderEntry(entry);
    this._applyArbitration();
  }

  private _getSettings(id: string): IDockableUtilitySettings | undefined {
    const configured = this._props.utilities && this._props.utilities[id];
    if (configured) { return configured; }
    // Sensible default so unconfigured participants still work in dev.
    return {
      enabled: true,
      minimiseTarget: 'bottom',
      bottomSide: 'right',
      defaultState: 'expanded',
      priority: RESERVED_PRIORITIES[id]
    };
  }

  // ---------------------------------------------------------------- rendering

  private _buildZones(): void {
    const root = document.createElement('div');
    root.id = ROOT_ID;
    const mk = (cls: string, parent: HTMLElement): HTMLElement => {
      const el = document.createElement('div');
      el.className = cls;
      parent.appendChild(el);
      return el;
    };
    // Bottom zones render inside the SPFx Bottom placeholder when available
    // (the reserved bottom-of-page slot the other extensions use); the CSS is
    // position: fixed either way, so visuals don't depend on the parent.
    const bottomParent = this._bottomHost || root;
    if (this._bottomHost) { this._bottomHost.classList.add('ikm-dock-bottom-host'); }
    this._zones['bottom-left'] = mk('ikm-dock-zone-bottom ikm-dock-left', bottomParent);
    this._zones['bottom-right'] = mk('ikm-dock-zone-bottom ikm-dock-right', bottomParent);
    this._zones['edge-left'] = mk('ikm-dock-zone-edge ikm-dock-left', root);
    this._zones['edge-right'] = mk('ikm-dock-zone-edge ikm-dock-right', root);
    document.body.appendChild(root);
    this._root = root;
  }

  private _zoneFor(id: string): HTMLElement {
    const s = this._getSettings(id);
    const target = s ? s.minimiseTarget : 'bottom';
    if (target === 'edge-left' || target === 'edge-right') {
      return this._zones[target];
    }
    // 'bottom' and (for now) 'user-choice' land in a bottom slot.
    const side = s && s.bottomSide === 'left' ? 'bottom-left' : 'bottom-right';
    return this._zones[side];
  }

  private _priorityOf(entry: IRegistered): number {
    const s = this._getSettings(entry.descriptor.id);
    if (s && typeof s.priority === 'number') { return s.priority; }
    if (typeof entry.descriptor.priority === 'number') { return entry.descriptor.priority; }
    return RESERVED_PRIORITIES[entry.descriptor.id] !== undefined ? RESERVED_PRIORITIES[entry.descriptor.id] : 100;
  }

  private _renderEntry(entry: IRegistered): void {
    const zone = this._zoneFor(entry.descriptor.id);
    const isEdge = zone.className.indexOf('ikm-dock-zone-edge') !== -1;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = isEdge ? 'ikm-dock-tab' : 'ikm-dock-chip';
    if (entry.descriptor.id === 'back-to-top' && !isEdge) {
      // Visual continuity with the community ScrollToTop button users know:
      // same 40x30 theme-primary square, icon-only (label stays for AT).
      el.classList.add('ikm-dock-backtotop');
      el.setAttribute('title', 'Back to top');
    }
    el.setAttribute('data-ikm-dock-id', entry.descriptor.id);
    el.setAttribute('aria-label', entry.descriptor.label);

    const icon = document.createElement('span');
    icon.className = 'ikm-dock-icon';
    if (entry.descriptor.icon) {
      // Fluent icon font ships on modern pages; fall back to a letter if the glyph is empty.
      icon.classList.add('ms-Icon', `ms-Icon--${entry.descriptor.icon}`);
      icon.setAttribute('aria-hidden', 'true');
    } else {
      icon.textContent = entry.descriptor.label.charAt(0);
    }
    const label = document.createElement('span');
    label.className = 'ikm-dock-label';
    label.textContent = entry.descriptor.label;

    el.appendChild(icon);
    el.appendChild(label);
    el.addEventListener('click', () => {
      try { entry.descriptor.onActivate(); } catch (e) { this._log(`onActivate('${entry.descriptor.id}') threw: ${e}`); }
    });

    // Insert in priority order (lower = closer to the corner = later in left-to-right
    // flow for right slots, earlier for left slots; keep it simple: sort ascending).
    const myPriority = this._priorityOf(entry);
    const siblings = Array.prototype.slice.call(zone.children) as HTMLElement[];
    const next = siblings.find((sib) => {
      const sibId = sib.getAttribute('data-ikm-dock-id');
      const sibEntry = sibId ? this._registered.get(sibId) : undefined;
      return sibEntry ? this._priorityOf(sibEntry) > myPriority : false;
    });
    zone.insertBefore(el, next || null);
    // Entrance motion: start shrunken/low, release next frame (the shared
    // transition rule animates it in; reduced-motion kills transitions).
    el.classList.add('ikm-dock-enter');
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => el.classList.remove('ikm-dock-enter'))
    );
    entry.element = el;
  }

  /** Capability rules — currently just: one back-to-top per page. */
  private _applyArbitration(): void {
    let externalBackToTop = false;
    this._registered.forEach((entry) => {
      if (entry.descriptor.id !== 'back-to-top' &&
          entry.descriptor.provides &&
          entry.descriptor.provides.indexOf('back-to-top') !== -1) {
        externalBackToTop = true;
      }
    });
    // Transitional deference: while the legacy community ScrollToTop
    // customizer is on the page, it IS the page's back-to-top — the host's
    // built-in only takes over once that extension is retired per-site.
    // (Hashed SCSS-module class, matched by substring.)
    if (!externalBackToTop && document.querySelector('[class*="spfxScrolltotopBtn"]')) {
      externalBackToTop = true;
    }
    const builtIn = this._registered.get('back-to-top');
    if (builtIn && builtIn.element) {
      builtIn.element.classList.toggle('ikm-dock-suppressed', externalBackToTop);
      this._updateBackToTopVisibility();
    }
  }

  // ---------------------------------------------------------------- built-in back-to-top

  private _registerBuiltInBackToTop(): void {
    const settings = this._getSettings('back-to-top');
    if (settings && !settings.enabled) { return; }
    this._register({
      id: 'back-to-top',
      label: 'Top',
      icon: 'Up',
      priority: RESERVED_PRIORITIES['back-to-top'],
      onActivate: () => this._scrollToTop()
    });
    // Hidden until the reader has scrolled a meaningful distance.
    this._setBackToTopScrolled(false);
  }

  private _handleScroll(e: Event): void {
    const target = e.target;
    if (target instanceof HTMLElement && target.scrollHeight > target.clientHeight + 4) {
      this._scrollRegion = target;
    } else if (target === document) {
      this._scrollRegion = window;
    } else {
      return;
    }
    if (this._scrollRaf) { return; }
    this._scrollRaf = window.requestAnimationFrame(() => {
      this._scrollRaf = 0;
      const top = this._scrollRegion instanceof Window
        ? window.scrollY
        : (this._scrollRegion ? this._scrollRegion.scrollTop : 0);
      this._setBackToTopScrolled(top > Math.min(window.innerHeight * 0.75, BACK_TO_TOP_MIN_SCROLL_PX));
      this._updateBottomRowOffset();
    });
  }

  /**
   * The host RESERVES the rightmost slot of the bottom row (just clear of
   * the scrollbar) — back-to-top's priority-10 spot. The legacy feedback
   * pill positions itself at right:45px, which would overlap the reserved
   * slot, so as corner arbiter the host nudges it left to sit beside the
   * zone. Re-applied every tick: the pill mounts async and React re-renders
   * can wipe the inline style. Goes away once feedback registers properly.
   */
  /**
   * Measure the scroll region's actual scrollbar width so right-side zones
   * sit just clear of it instead of guessing. Before the region is known
   * (no scroll yet), try SharePoint's content region by its automation id,
   * else assume a classic 16px bar.
   */
  private _scrollbarClearancePx(): number {
    let region = this._scrollRegion;
    if (!region) {
      const seed = document.querySelector('div[data-automation-id="contentScrollRegion"]');
      if (seed instanceof HTMLElement) { this._scrollRegion = region = seed; }
    }
    let sb = 0;
    if (region instanceof Window) {
      sb = window.innerWidth - document.documentElement.clientWidth;
    } else if (region) {
      sb = region.offsetWidth - region.clientWidth;
    }
    if (!sb || sb < 0) { sb = 16; }
    return sb + 4;
  }

  private _updateBottomRowOffset(): void {
    const zone = this._zones['bottom-right'];
    if (!zone) { return; }
    const rightPx = `${this._scrollbarClearancePx()}px`;
    if (zone.style.right !== rightPx) { zone.style.right = rightPx; }
    const edgeRight = this._zones['edge-right'];
    if (edgeRight && edgeRight.style.right !== rightPx) { edgeRight.style.right = rightPx; }
    const zRect = zone.getBoundingClientRect();
    if (zRect.width === 0) { return; }
    const clearRight = Math.round(window.innerWidth - zRect.left + 8);
    const candidates = document.querySelectorAll('[class*="eedback"]');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i] as HTMLElement;
      if (window.getComputedStyle(el).position !== 'fixed') { continue; }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom < window.innerHeight - 60) { continue; }
      const px = `${clearRight}px`;
      if (el.style.right !== px) { el.style.right = px; }
    }
  }

  private _setBackToTopScrolled(past: boolean): void {
    if (past === this._pastScrollThreshold && this._registered.has('back-to-top')) {
      // still update on first call
    }
    this._pastScrollThreshold = past;
    this._updateBackToTopVisibility();
  }

  private _updateBackToTopVisibility(): void {
    const entry = this._registered.get('back-to-top');
    if (!entry || !entry.element) { return; }
    // Re-check the legacy button on every tick: extensions mount in any
    // order, so it may appear well after the host registered its chip.
    const legacyPresent = !!document.querySelector('[class*="spfxScrolltotopBtn"]');
    const suppressed = entry.element.classList.contains('ikm-dock-suppressed') || legacyPresent;
    entry.element.classList.toggle('ikm-dock-offstage', !this._pastScrollThreshold || suppressed);
  }

  private _scrollToTop(): void {
    const region = this._scrollRegion;
    const scrollIt = (behavior: ScrollBehavior): void => {
      if (region instanceof Window || !region) {
        window.scrollTo({ top: 0, behavior });
      } else {
        region.scrollTo({ top: 0, behavior });
      }
    };
    scrollIt('smooth');
    // Smooth scrolls get abandoned mid-flight in the nested region on some
    // machines — verify and snap (same pattern the TOC uses).
    window.setTimeout(() => {
      const top = region instanceof Window || !region ? window.scrollY : region.scrollTop;
      if (top > 4) { scrollIt('auto'); }
    }, 700);
  }

  // ---------------------------------------------------------------- styles

  private _injectStyles(): void {
    if (document.getElementById(STYLE_ID)) { return; }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#${ROOT_ID}, .ikm-dock-bottom-host { --ikm-dock-primary: ${this._themePrimary}; }
#${ROOT_ID}[hidden], .ikm-dock-zone-bottom[hidden], .ikm-dock-zone-edge[hidden] { display: none !important; }
/* The dock's bottom row: chips line up along the very bottom of the page in
   the same strip as the feedback pill. The right zone's offset is adjusted at
   runtime to sit just left of the feedback pill (its width varies with the
   label) and never under the scroll region's scrollbar. */
.ikm-dock-zone-bottom { position: fixed; bottom: 2px; z-index: ${DOCK_Z_INDEX}; display: flex; gap: 8px; align-items: center; }
.ikm-dock-zone-bottom.ikm-dock-left { left: 20px; }
.ikm-dock-zone-bottom.ikm-dock-right { right: 20px; flex-direction: row-reverse; }
.ikm-dock-zone-edge { position: fixed; top: 25%; z-index: ${DOCK_Z_INDEX}; display: flex; flex-direction: column; gap: 8px; }
.ikm-dock-zone-edge.ikm-dock-left { left: 0; }
.ikm-dock-zone-edge.ikm-dock-right { right: 0; }
.ikm-dock-chip, .ikm-dock-tab {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--ikm-dock-primary); color: #fff;
  border: 0; cursor: pointer;
  font-family: "Segoe UI", system-ui, sans-serif; font-size: 12px; font-weight: 600;
  transition: transform 120ms ease, opacity 120ms ease;
}
.ikm-dock-chip { border-radius: 0; padding: 0 12px; height: 30px; }
.ikm-dock-chip.ikm-dock-backtotop {
  width: 40px; height: 30px; padding: 0; border-radius: 0; border: 0;
  justify-content: center; box-shadow: none;
}
.ikm-dock-chip.ikm-dock-backtotop .ikm-dock-label { display: none; }
.ikm-dock-chip.ikm-dock-backtotop .ikm-dock-icon { font-size: 16px; }
.ikm-dock-tab { writing-mode: vertical-rl; padding: 12px 6px; letter-spacing: 0.06em; }
.ikm-dock-zone-edge.ikm-dock-left .ikm-dock-tab { border-radius: 0 6px 6px 0; }
.ikm-dock-zone-edge.ikm-dock-right .ikm-dock-tab { border-radius: 6px 0 0 6px; }
.ikm-dock-chip:hover, .ikm-dock-tab:hover { transform: translateY(-1px); filter: brightness(1.1); }
.ikm-dock-chip:focus-visible, .ikm-dock-tab:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.ikm-dock-icon { font-size: 12px; line-height: 1; }
.ikm-dock-offstage, .ikm-dock-suppressed { opacity: 0; pointer-events: none; transform: translateY(6px); }
.ikm-dock-enter { opacity: 0; transform: scale(0.5) translateY(16px); }
@media (max-width: 1024px) { #${ROOT_ID} { display: none !important; } }
@media (prefers-reduced-motion: reduce) {
  .ikm-dock-chip, .ikm-dock-tab { transition: none; }
}
`;
    document.head.appendChild(style);
  }

  private _log(msg: string): void {
    if (this._props.debug) {
      console.log(`[ikm-dock] ${msg}`);
    }
  }
}
