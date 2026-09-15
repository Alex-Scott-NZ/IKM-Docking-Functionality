import {
  DOCK_API_VERSION,
  DOCK_READY_EVENT,
  DOCK_Z_INDEX,
  RESERVED_PRIORITIES,
  DockZone,
  IDockDescriptor,
  IDockRect,
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
/**
 * One motion duration for every participant (contract v1.2 host-owned
 * motion). 240ms with a decelerate curve: the old 180ms ease-in packed most
 * of the travel into the last three frames, which read as stutter.
 */
const DOCK_MOTION_MS = 240;
const DOCK_MOTION_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

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

  // Utilities whose minimise proxy is currently in flight: their chip stays
  // invisible (layout kept) until the proxy lands, then pops in — a proper
  // hand-off instead of two things moving at once.
  private _minimising: Set<string> = new Set<string>();

  // Last ghost clone per utility, kept from the minimise flight so the
  // RESTORE flight can fly the same image back out (the real UI doesn't
  // exist yet at restore time — it mounts when the proxy lands — so there
  // is nothing live to clone in that direction). Never restored-from-dock
  // this page load → slab fallback.
  private _ghostCache: Map<string, HTMLElement> = new Map();

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
    this._ghostCache.clear();
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
      getSettings: (id) => this._getSettings(id),
      animateMinimise: (id, from, done, source) => {
        if (source) {
          try { this._ghostCache.set(id, source.cloneNode(true) as HTMLElement); } catch { /* slab restores */ }
        }
        this._minimising.add(id);
        this._setChipPreflight(id, true);
        this._animate(id, from, this._dockTargetRect(id), () => {
          this._minimising.delete(id);
          this._revealChipAfterFlight(id);
          if (done) { done(); }
        }, source);
      },
      animateRestore: (id, to, done, options) => {
        const handOff = !!(options && options.chipHandOff);
        if (handOff) {
          // The chip departs WITH the flight (it will unregister when the
          // restore completes) — hide it the instant the proxy launches.
          this._setChipPreflight(id, true);
        }
        this._animate(id, this._dockTargetRect(id), to, () => {
          if (done) { done(); }
          if (handOff) {
            // Grace period for the participant's unregister to land; if the
            // chip somehow survives, un-hide it rather than leave it stuck.
            window.setTimeout(() => this._setChipPreflight(id, false), 80);
          }
        }, this._ghostCache.get(id), 'to');
      }
    };
    (window as unknown as { ikmDock?: IIkmDock }).ikmDock = api;
    document.dispatchEvent(new CustomEvent(DOCK_READY_EVENT, { detail: { apiVersion: DOCK_API_VERSION } }));
  }

  // ------------------------------------------------------- motion (v1.2)

  /**
   * Where a utility's minimised UI lives right now: its chip/tab if
   * rendered, else its destination zone (registration usually happens
   * AFTER the minimise motion, so the zone anchor is the normal case).
   */
  private _dockTargetRect(id: string): IDockRect {
    const entry = this._registered.get(id);
    const el = (entry && entry.element) || this._zoneFor(id);
    const r = el.getBoundingClientRect();
    if (r.left !== 0 || r.top !== 0 || r.width !== 0 || r.height !== 0) {
      // An empty zone has a real anchor but zero size — give the proxy
      // something chip-sized to land on.
      return { left: r.left, top: r.top, width: Math.max(r.width, 32), height: Math.max(r.height, 32) };
    }
    // Nonsense geometry (zone hidden mid-layout): bottom-right corner.
    return { left: window.innerWidth - 64, top: window.innerHeight - 44, width: 32, height: 32 };
  }

  /** Chip visibility during a flight: invisible but keeping its layout slot. */
  private _setChipPreflight(id: string, preflight: boolean): void {
    const el = this._registered.get(id)?.element;
    if (!el) { return; }
    el.classList.toggle('ikm-dock-preflight', preflight);
  }

  /** Proxy landed: reveal the chip with a small pop (the hand-off moment). */
  private _revealChipAfterFlight(id: string): void {
    const el = this._registered.get(id)?.element;
    if (!el) { return; }
    el.classList.remove('ikm-dock-preflight');
    void el.offsetWidth; // restart the landing animation cleanly
    el.classList.add('ikm-dock-land');
    window.setTimeout(() => el.classList.remove('ikm-dock-land'), 300);
  }

  /**
   * Fly a lightweight proxy between two rects (contract v1.2 — the host
   * owns all minimise/restore motion so it can aim at wherever config put
   * the dock). The participant hides/shows its real UI around this; `done`
   * fires when the proxy lands, immediately under reduced motion. When the
   * participant hands over its `source` element (minimise), the proxy is a
   * GHOST — a clone of the element — instead of a flat theme-coloured slab,
   * so the thing the reader was looking at is what appears to fly.
   */
  private _animate(id: string, from: IDockRect, to: IDockRect, done?: () => void, source?: Element, layoutAt: 'from' | 'to' = 'from'): void {
    const finish = (): void => { if (done) { done(); } };
    const reduced = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this._disposed || reduced || !from || !to || from.width <= 0 || from.height <= 0) {
      finish();
      return;
    }
    // FLIP: the proxy is ALWAYS laid out at the rect where the ghost is
    // full-size (minimise: the source; restore: the destination), and the
    // transform does the shrinking/growing. Laying it out small and scaling
    // UP renders the clone's text into a tiny box first — huge deformed
    // glyphs (seen on restore before this).
    const layoutRect = layoutAt === 'to' ? to : from;
    const proxy = document.createElement('div');
    proxy.className = 'ikm-dock-motion-proxy';
    proxy.setAttribute('aria-hidden', 'true');
    proxy.style.left = `${layoutRect.left}px`;
    proxy.style.top = `${layoutRect.top}px`;
    proxy.style.width = `${layoutRect.width}px`;
    proxy.style.height = `${layoutRect.height}px`;
    proxy.style.background = this._themePrimary;
    let startOpacity = 0.55;
    if (source) {
      // Ghost mode: clone the element the reader was just looking at. Same
      // page, same stylesheets, so hashed CSS-module classes still apply.
      try {
        const clone = source.cloneNode(true) as HTMLElement;
        clone.removeAttribute('id');
        clone.style.position = 'static';
        clone.style.margin = '0';
        clone.style.left = 'auto';
        clone.style.top = 'auto';
        clone.style.right = 'auto';
        clone.style.bottom = 'auto';
        clone.style.width = '100%';
        clone.style.height = '100%';
        clone.style.maxHeight = 'none';
        clone.style.transform = 'none';
        proxy.style.background = 'transparent';
        proxy.style.overflow = 'hidden';
        proxy.appendChild(clone);
        startOpacity = 0.9;
      } catch {
        // Clone failed (exotic content) — the slab fallback still flies.
        proxy.style.background = this._themePrimary;
      }
    }
    if (proxy.childElementCount === 0) {
      // No ghost available (typically: the page LOADED already docked, so
      // nothing was ever cloned this page load). Dress the slab as a card
      // carrying the utility's own icon and label — a flight should never
      // look like an empty box.
      const desc = this._registered.get(id)?.descriptor;
      if (desc) {
        const card = document.createElement('div');
        card.className = 'ikm-dock-proxy-card';
        const icon = document.createElement('i');
        icon.className = `ms-Icon ms-Icon--${desc.icon}`;
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = desc.label;
        card.appendChild(icon);
        card.appendChild(label);
        proxy.appendChild(card);
      }
    }
    document.body.appendChild(proxy);
    // Keyframes relative to the layout rect: 'from'-anchored flights go
    // identity → shrunk-at-destination; 'to'-anchored (restore) START
    // pre-shrunk at the origin and grow to identity.
    let startTransform: string;
    let endTransform: string;
    if (layoutAt === 'to') {
      const sx0 = Math.max(from.width / to.width, 0.01);
      const sy0 = Math.max(from.height / to.height, 0.01);
      const tx0 = (from.left + from.width / 2) - (to.left + to.width / 2);
      const ty0 = (from.top + from.height / 2) - (to.top + to.height / 2);
      startTransform = `translate(${tx0}px, ${ty0}px) scale(${sx0}, ${sy0})`;
      endTransform = 'translate(0px, 0px) scale(1, 1)';
    } else {
      const sx = Math.max(to.width / from.width, 0.01);
      const sy = Math.max(to.height / from.height, 0.01);
      const tx = (to.left + to.width / 2) - (from.left + from.width / 2);
      const ty = (to.top + to.height / 2) - (from.top + from.height / 2);
      startTransform = 'translate(0px, 0px) scale(1, 1)';
      endTransform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
    }
    let ended = false;
    const end = (): void => {
      if (ended) { return; }
      ended = true;
      proxy.remove();
      finish();
    };
    // Web Animations API rather than a CSS transition: it starts on a
    // deterministic first frame (no create-reflow-then-transition race that
    // could eat the opening frames on a busy page) and reports completion
    // directly.
    if (typeof proxy.animate === 'function') {
      // Minimise: fade away as it departs. Restore: gain presence as it
      // arrives (the real UI takes over the moment it lands).
      const opacities = layoutAt === 'to'
        ? { start: 0.35, end: Math.max(startOpacity, 0.9) }
        : { start: startOpacity, end: 0.15 };
      const anim = proxy.animate(
        [
          { transform: startTransform, opacity: opacities.start },
          { transform: endTransform, opacity: opacities.end }
        ],
        { duration: DOCK_MOTION_MS, easing: DOCK_MOTION_EASING, fill: 'forwards' }
      );
      anim.onfinish = end;
    } else {
      // Ancient engine without WAAPI: no flight, just the state change.
      end();
      return;
    }
    window.setTimeout(end, DOCK_MOTION_MS + 150); // safety net
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
    // The row just changed width — re-nudge the legacy feedback bar NOW.
    // The nudge otherwise runs only on scroll ticks, so a chip appearing
    // mid-read (e.g. the reader minimising the TOC) overlapped the bar
    // until the next scroll.
    this._updateBottomRowOffset();
    this._log(`registered '${d.id}'`);
  }

  private _unregister(id: string): void {
    const entry = this._registered.get(id);
    if (!entry) { return; }
    entry.element?.remove();
    this._registered.delete(id);
    this._applyArbitration();
    this._updateBottomRowOffset(); // row narrowed — see _register
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
    // Zone keys on the elements — the reader's drag-reorder store is keyed
    // by these (see _persistZoneOrder / _applyReaderOrder).
    ['bottom-left', 'bottom-right', 'edge-left', 'edge-right'].forEach((k) =>
      this._zones[k].setAttribute('data-ikm-zone', k)
    );
    document.body.appendChild(root);
    this._root = root;
  }

  private _zoneFor(id: string): HTMLElement {
    const s = this._getSettings(id);
    const target = s ? s.minimiseTarget : 'bottom';
    if (target === 'edge-left' || target === 'edge-right') {
      return this._edgeZone(target, (s && s.edgeAlign) || 'middle');
    }
    // 'bottom' and (for now) 'user-choice' land in a bottom slot.
    const side = s && s.bottomSide === 'left' ? 'bottom-left' : 'bottom-right';
    return this._zones[side];
  }

  /**
   * Edge zones come in three vertical clusters (contract v1.1 edgeAlign:
   * top/middle/bottom). The middle cluster is the base zone built up front;
   * top/bottom variants are created lazily, styled by the align class.
   */
  private _edgeZone(target: 'edge-left' | 'edge-right', align: 'top' | 'middle' | 'bottom'): HTMLElement {
    if (align === 'middle') { return this._zones[target]; }
    const key = `${target}:${align}`;
    if (!this._zones[key]) {
      const base = this._zones[target];
      const el = document.createElement('div');
      const side = target === 'edge-left' ? 'ikm-dock-left' : 'ikm-dock-right';
      el.className = `ikm-dock-zone-edge ${side} ikm-dock-edge-${align}`;
      el.setAttribute('data-ikm-zone', key);
      (base.parentElement || document.body).appendChild(el);
      this._zones[key] = el;
    }
    return this._zones[key];
  }

  private _priorityOf(entry: IRegistered): number {
    const s = this._getSettings(entry.descriptor.id);
    if (s && typeof s.priority === 'number') { return s.priority; }
    if (typeof entry.descriptor.priority === 'number') { return entry.descriptor.priority; }
    return RESERVED_PRIORITIES[entry.descriptor.id] !== undefined ? RESERVED_PRIORITIES[entry.descriptor.id] : 100;
  }

  // ------------------------------------------- reader chip order (drag)

  /**
   * Per-reader, PER-PAGE chip order (user decision 2026-09-15): dragging a
   * chip/tab within its zone records the order for this page, like the
   * TOC's per-page docked state. Admin priorities remain the fallback for
   * anything not in the saved list. Back-to-top is pinned to the corner and
   * takes no part in reordering.
   */
  private _orderKey(): string {
    return `ikm-dock:order:${window.location.pathname.toLowerCase()}`;
  }

  private _readOrder(): { [zoneKey: string]: string[] } {
    try {
      const raw = localStorage.getItem(this._orderKey());
      if (!raw) { return {}; }
      const parsed = JSON.parse(raw) as { v: number; zones: { [k: string]: string[] } };
      return parsed && parsed.v === 1 && parsed.zones ? parsed.zones : {};
    } catch { return {}; }
  }

  private _persistZoneOrder(zone: HTMLElement): void {
    const key = zone.getAttribute('data-ikm-zone');
    if (!key) { return; }
    const ids = (Array.prototype.slice.call(zone.children) as HTMLElement[])
      .map((c) => c.getAttribute('data-ikm-dock-id') || '')
      .filter((id) => id && id !== 'back-to-top');
    try {
      const zones = this._readOrder();
      zones[key] = ids;
      localStorage.setItem(this._orderKey(), JSON.stringify({ v: 1, zones }));
    } catch { /* storage unavailable — order just won't persist */ }
    this._log(`reader order for ${key}: ${ids.join(',')}`);
  }

  /** Re-sort a zone's children to the saved reader order (if any). */
  private _applyReaderOrder(zone: HTMLElement): void {
    const key = zone.getAttribute('data-ikm-zone');
    if (!key) { return; }
    const saved = this._readOrder()[key];
    if (!saved || saved.length === 0) { return; }
    const children = Array.prototype.slice.call(zone.children) as HTMLElement[];
    const rank = (el: HTMLElement): number => {
      const id = el.getAttribute('data-ikm-dock-id') || '';
      if (id === 'back-to-top') { return -1; } // pinned to the corner (DOM-first)
      const i = saved.indexOf(id);
      return i === -1 ? 1000 + children.indexOf(el) : i; // unsaved keep priority order, after saved
    };
    children
      .slice()
      .sort((a, b) => rank(a) - rank(b))
      .forEach((c) => zone.appendChild(c));
  }

  /** Set when a drag just finished, so the trailing click doesn't activate. */
  private _dragEndedAt = 0;

  private _makeDraggable(el: HTMLElement): void {
    let tracking = false;
    let dragging = false;
    let sx = 0;
    let sy = 0;
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) { return; }
      tracking = true;
      dragging = false;
      sx = e.clientX;
      sy = e.clientY;
    });
    el.addEventListener('pointermove', (e: PointerEvent) => {
      if (!tracking) { return; }
      if (!dragging) {
        if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 6) { return; }
        dragging = true;
        try { el.setPointerCapture(e.pointerId); } catch { /* stale pointer */ }
        el.classList.add('ikm-dock-dragging');
      }
      const zone = el.parentElement;
      if (!zone) { return; }
      const isColumn = zone.className.indexOf('ikm-dock-zone-edge') !== -1;
      // Visual order is what the reader sees; DOM order equals it EXCEPT in
      // the row-reverse bottom-right zone. Work entirely in visual space,
      // then write the DOM in whichever direction the zone flows.
      const reversed = window.getComputedStyle(zone).flexDirection.indexOf('reverse') !== -1;
      const pointerPos = isColumn ? e.clientY : e.clientX;
      const movable = (Array.prototype.slice.call(zone.children) as HTMLElement[])
        .filter((c) => c !== el && c.getAttribute('data-ikm-dock-id') !== 'back-to-top');
      const pinned = (Array.prototype.slice.call(zone.children) as HTMLElement[])
        .filter((c) => c.getAttribute('data-ikm-dock-id') === 'back-to-top');
      const visual = movable
        .map((s) => {
          const r = s.getBoundingClientRect();
          return { s, mid: isColumn ? r.top + r.height / 2 : r.left + r.width / 2 };
        })
        .sort((a, b) => a.mid - b.mid)
        .map((x) => x.s);
      let insertAt = visual.length;
      for (let i = 0; i < visual.length; i++) {
        const r = visual[i].getBoundingClientRect();
        const mid = isColumn ? r.top + r.height / 2 : r.left + r.width / 2;
        if (pointerPos < mid) { insertAt = i; break; }
      }
      visual.splice(insertAt, 0, el);
      const domOrder = reversed ? visual.slice().reverse() : visual;
      // Pinned (back-to-top) re-appended first = stays DOM-first = keeps the
      // corner in the row-reverse zone.
      const desired = pinned.concat(domOrder);
      const currentIds = (Array.prototype.slice.call(zone.children) as HTMLElement[])
        .map((c) => c.getAttribute('data-ikm-dock-id')).join('|');
      const desiredIds = desired.map((c) => c.getAttribute('data-ikm-dock-id')).join('|');
      if (currentIds !== desiredIds) {
        desired.forEach((n) => zone.appendChild(n));
      }
    });
    const finish = (e: PointerEvent): void => {
      if (!tracking) { return; }
      tracking = false;
      if (dragging) {
        dragging = false;
        el.classList.remove('ikm-dock-dragging');
        try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        const zone = el.parentElement;
        if (zone) { this._persistZoneOrder(zone); }
        this._dragEndedAt = Date.now();
      }
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  }

  private _renderEntry(entry: IRegistered): void {
    const zone = this._zoneFor(entry.descriptor.id);
    const isEdge = zone.className.indexOf('ikm-dock-zone-edge') !== -1;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = isEdge ? 'ikm-dock-tab' : 'ikm-dock-chip';
    if (this._minimising.has(entry.descriptor.id)) {
      // Registered while its minimise proxy is still flying: keep the slot
      // but stay invisible until the proxy lands (hand-off choreography).
      el.classList.add('ikm-dock-preflight');
    }
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
      if (Date.now() - this._dragEndedAt < 300) { return; } // that was a drag, not a click
      try { entry.descriptor.onActivate(); } catch (e) { this._log(`onActivate('${entry.descriptor.id}') threw: ${e}`); }
    });
    if (entry.descriptor.id !== 'back-to-top') {
      this._makeDraggable(el); // reader can reorder within the zone
    }

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
    // Reader's saved drag-order for this page wins over priority placement.
    this._applyReaderOrder(zone);
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
    if (region instanceof Window || !region) {
      const sb = window.innerWidth - document.documentElement.clientWidth;
      return (sb > 0 ? sb : 16) + 4;
    }
    // The region's right edge is not the window's right edge — SharePoint
    // leaves a sliver of page chrome outside it — so clear the point where
    // the scrollbar actually starts, not just the scrollbar's own width.
    const rect = region.getBoundingClientRect();
    const scrollbarLeft = rect.left + region.clientLeft + region.clientWidth;
    const clearance = Math.ceil(window.innerWidth - scrollbarLeft) + 4;
    // Nonsense geometry (region hidden or mid-layout) → safe static offset.
    if (clearance < 4 || clearance > 80) { return 20; }
    return clearance;
  }

  private _updateBottomRowOffset(): void {
    const zone = this._zones['bottom-right'];
    if (!zone) { return; }
    const rightPx = `${this._scrollbarClearancePx()}px`;
    if (zone.style.right !== rightPx) { zone.style.right = rightPx; }
    // All right-edge zones (base + lazily created top/bottom clusters).
    Object.keys(this._zones).forEach((k) => {
      if (k.indexOf('edge-right') !== 0) { return; }
      const z = this._zones[k];
      if (z && z.style.right !== rightPx) { z.style.right = rightPx; }
    });
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
.ikm-dock-zone-edge.ikm-dock-edge-top { top: 10%; }
.ikm-dock-zone-edge.ikm-dock-edge-bottom { top: auto; bottom: 10%; }
.ikm-dock-motion-proxy { position: fixed; z-index: ${DOCK_Z_INDEX + 1}; pointer-events: none; border-radius: 6px; opacity: 0.55; transform-origin: center; will-change: transform, opacity; }
.ikm-dock-preflight { visibility: hidden !important; }
.ikm-dock-proxy-card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 100%; color: #fff; font-size: 15px; font-weight: 600; }
.ikm-dock-proxy-card .ms-Icon { font-size: 28px; }
.ikm-dock-chip, .ikm-dock-tab { touch-action: none; }
.ikm-dock-dragging { opacity: 0.65; transform: scale(1.08); cursor: grabbing; }
.ikm-dock-land { animation: ikmDockLand 160ms ease-out; }
@keyframes ikmDockLand { from { transform: scale(0.6); opacity: 0.4; } to { transform: scale(1); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .ikm-dock-land { animation: none; } }
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
