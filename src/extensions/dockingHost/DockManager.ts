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
/** At or below this width edge tabs fold into the bottom row (see _narrowQuery). */
const NARROW_PX = 1024;
/** Readers' zone picks for 'user-choice' utilities (contract v1.3), tenant-wide. */
const PLACE_KEY = 'ikm-dock:place';
/** How far a dragged chip gives when pulled across its zone, out onto the page. */
const DRAG_OFF_AXIS_PX = 16;
/** Space between neighbouring edge tabs. */
const EDGE_GAP_PX = 8;
/**
 * Shortest an edge tab may get (its label truncates) when an edge is
 * crowded. Once even this does not fit, the least important tabs fold into
 * the bottom row instead (see _computeOverflow).
 */
const EDGE_TAB_MIN_PX = 40;
/**
 * One motion duration for every participant (contract v1.2 host-owned
 * motion). 240ms with a decelerate curve: the old 180ms ease-in packed most
 * of the travel into the last three frames, which read as stutter.
 */
const DOCK_MOTION_MS = 240;
const DOCK_MOTION_EASING: [number, number, number, number] = [0.2, 0, 0, 1]; // cubic-bezier, decelerate

/**
 * A CSS cubic-bezier timing function as a JS function of progress 0..1
 * (Newton steps on x, falling back to bisection).
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bx = (u: number): number => 3 * x1 * u * (1 - u) * (1 - u) + 3 * x2 * u * u * (1 - u) + u * u * u;
  const by = (u: number): number => 3 * y1 * u * (1 - u) * (1 - u) + 3 * y2 * u * u * (1 - u) + u * u * u;
  const dx = (u: number): number => 3 * x1 * (1 - u) * (1 - u) + 6 * (x2 - x1) * u * (1 - u) + 3 * (1 - x2) * u * u;
  return (t: number): number => {
    if (t <= 0) { return 0; }
    if (t >= 1) { return 1; }
    let u = t;
    for (let i = 0; i < 6; i++) {
      const d = dx(u);
      if (Math.abs(d) < 1e-6) { break; }
      const next = u - (bx(u) - t) / d;
      if (next < 0 || next > 1) { break; }
      u = next;
    }
    if (Math.abs(bx(u) - t) > 1e-4) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 30; i++) {
        u = (lo + hi) / 2;
        if (bx(u) < t) { lo = u; } else { hi = u; }
      }
    }
    return by(u);
  };
}

interface IRegistered {
  descriptor: IDockDescriptor;
  element: HTMLElement | undefined;
}

/** Where a utility docks: a zone plus the side/cluster within it. */
interface IPlacement {
  target: DockZone;
  bottomSide: 'left' | 'right';
  edgeAlign: 'top' | 'middle' | 'bottom';
  /**
   * A reader's own spot on an edge: where the tab's centre sits, as a
   * fraction of the edge's length (0 top, 1 bottom), so it scales with the
   * window. Unset = the admin's cluster (edgeAlign).
   */
  edgePos?: number;
}

/** The areas a reader can drop a movable chip on. */
type DropKey = 'bottom-left' | 'bottom-right' | 'edge-left' | 'edge-right';

interface IDropTarget {
  key: DropKey;
  el: HTMLElement;
  /** What is drawn: the strip a chip or tab occupies there. */
  rect: IDockRect;
  /** Where a drop counts: wider than the outline, so it stays easy to hit. */
  hit: IDockRect;
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
  private _minimising: Map<string, number> = new Map<string, number>();

  // Last ghost clone per utility, kept from the minimise flight so the
  // RESTORE flight can fly the same image back out (the real UI doesn't
  // exist yet at restore time — it mounts when the proxy lands — so there
  // is nothing live to clone in that direction). Never restored-from-dock
  // this page load → slab fallback.
  private _ghostCache: Map<string, HTMLElement> = new Map();

  private _bottomHost: HTMLElement | undefined;

  // One rail per screen edge, holding that edge's three clusters (top,
  // middle, bottom). Its tabs are positioned by _placeTabs, one pass per
  // edge, so they can never overlap whoever put them there.
  private _rails: { [side: string]: HTMLElement } = {};

  // Edge utilities folded into the bottom row because their edge is full.
  private _overflow: Set<string> = new Set();
  private _layingOut = false;
  private _railHeights: { [side: string]: number } = {};

  // Drop targets on screen while a movable chip is being dragged.
  private _drops: IDropTarget[] = [];

  // Below this width there is no room for edge tabs beside the content, so
  // edge-docked utilities fold into the bottom row (they used to vanish,
  // leaving a docked utility unreachable: a 1920px screen at 200% zoom is
  // 960px wide). Hidden entirely only in edit mode.
  private _narrowQuery: MediaQueryList | undefined;
  private _onNarrowChange = (): void => this._rezone();
  private _onResize = (): void => {
    if (this._resizeRaf) { return; }
    this._resizeRaf = window.requestAnimationFrame(() => {
      this._resizeRaf = 0;
      this._updateBottomRowOffset();
    });
  };
  private _resizeRaf = 0;

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
    window.addEventListener('resize', this._onResize);
    if (typeof window.matchMedia === 'function') {
      this._narrowQuery = window.matchMedia(`(max-width: ${NARROW_PX}px)`);
      if (this._narrowQuery.addEventListener) {
        this._narrowQuery.addEventListener('change', this._onNarrowChange);
      }
    }
    // The feedback button mounts async (dynamic import) — re-measure the
    // bottom row a few times after start, then keep it fresh on scroll ticks.
    [500, 1500, 4000].forEach((ms) => window.setTimeout(() => this._updateBottomRowOffset(), ms));
    this._log('started');
  }

  public dispose(): void {
    this._disposed = true;
    document.removeEventListener('scroll', this._onScrollCapture, true);
    window.removeEventListener('resize', this._onResize);
    if (this._narrowQuery && this._narrowQuery.removeEventListener) {
      this._narrowQuery.removeEventListener('change', this._onNarrowChange);
    }
    if (window.cancelAnimationFrame && this._scrollRaf) {
      window.cancelAnimationFrame(this._scrollRaf);
    }
    if (window.cancelAnimationFrame && this._resizeRaf) {
      window.cancelAnimationFrame(this._resizeRaf);
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

  /** False once disposed: a later registration must start its own host. */
  public isLive(): boolean {
    return !this._disposed;
  }

  /**
   * A second registration of the host on the same page (tenant row plus a
   * site collection row) contributes its settings here instead of starting
   * a second manager. Per utility, a configured entry beats none; where both
   * configure the same utility the running host's entry stands.
   */
  public mergeProps(props: IDockingHostProperties): void {
    const incoming = props.utilities || {};
    const utilities = { ...(this._props.utilities || {}) };
    let changed = false;
    Object.keys(incoming).forEach((id) => {
      if (utilities[id]) {
        this._log(`mergeProps: '${id}' configured twice, keeping the running host's settings`);
        return;
      }
      utilities[id] = incoming[id];
      changed = true;
    });
    this._props = { ...this._props, utilities, debug: !!(this._props.debug || props.debug) };
    if (!changed) { return; }
    // Chips that registered before these settings arrived may sit in the
    // default zone.
    this._rezone();
    this._log('mergeProps: settings merged from a second host registration');
  }

  /** Move every chip whose zone has changed (settings merged, screen narrowed or widened). */
  private _rezone(): void {
    this._registered.forEach((entry, id) => {
      const el = entry.element;
      if (el && el.parentElement !== this._zoneFor(id)) { this._update(id, {}); }
    });
    this._updateBottomRowOffset();
    this._layoutRails();
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
        // Hand-off applies only to chips BORN during this flight (they
        // render preflight-hidden and pop in at landing). A chip that
        // already existed — feedback re-minimising from its open form —
        // stays visible throughout and just pulses when the flight lands:
        // hiding a button the reader could already see reads as a glitch.
        const chipExisted = !!this._registered.get(id)?.element;
        this._minimising.set(id, (this._minimising.get(id) || 0) + 1);
        const launch = (): void => {
          this._animate(id, from, () => this._dockTargetRect(id), () => {
            const left = (this._minimising.get(id) || 1) - 1;
            if (left > 0) {
              this._minimising.set(id, left);
              return; // a later minimise of the same utility is still flying
            }
            this._minimising.delete(id);
            if (chipExisted) {
              this._pulseChip(id);
            } else {
              this._revealChipAfterFlight(id);
            }
            if (done) { done(); }
          }, source);
        };
        if (chipExisted) {
          launch();
        } else {
          // The participant registers in the same turn it calls us, so a
          // frame later its chip exists (invisible) in its REAL slot. Aim at
          // that instead of predicting it: a prediction had to guess the new
          // chip's size from its neighbour, and a tall tab above (feedback)
          // sent the flight 20-50px past where the tab then appeared.
          let launched = false;
          const once = (): void => { if (!launched) { launched = true; launch(); } };
          window.requestAnimationFrame(once);
          window.setTimeout(once, 50); // rAF stalls in background tabs
        }
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

  /** Priority for an id that may not be registered yet (pre-flight). */
  private _priorityOfId(id: string): number {
    const entry = this._registered.get(id);
    if (entry) { return this._priorityOf(entry); }
    const s = this._getSettings(id);
    if (s && typeof s.priority === 'number') { return s.priority; }
    return RESERVED_PRIORITIES[id] !== undefined ? RESERVED_PRIORITIES[id] : 100;
  }

  /**
   * Where a utility's minimised UI lives right now — or WILL live. Its
   * chip/tab if rendered; otherwise the flight must aim at the SLOT the
   * chip is about to take among its future siblings (registration happens
   * after the minimise lands). Aiming at the bare zone anchor sent every
   * flight to the first chip's position regardless of where the new one
   * would actually join (visible with several tabs stacked on an edge).
   */
  private _dockTargetRect(id: string): IDockRect {
    const entry = this._registered.get(id);
    const chip = entry && entry.element;
    if (chip) {
      const r = chip.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      }
    }
    const zone = this._zoneFor(id);
    const kids = Array.prototype.slice.call(zone.children) as HTMLElement[];
    if (kids.length > 0) {
      // Predict the final DOM index: priority insertion (as _renderEntry
      // does), then the reader's saved order re-sort (as _applyReaderOrder
      // does). Then aim at the chip currently holding that slot — it's the
      // spot our chip inherits as everything after it shifts along.
      const myPriority = this._priorityOfId(id);
      let insertIdx = kids.length;
      for (let i = 0; i < kids.length; i++) {
        const sibId = kids[i].getAttribute('data-ikm-dock-id') || '';
        if (this._priorityOfId(sibId) > myPriority) { insertIdx = i; break; }
      }
      const simulated = kids.map((k) => k.getAttribute('data-ikm-dock-id') || '');
      simulated.splice(insertIdx, 0, id);
      const saved = this._readOrder()[zone.getAttribute('data-ikm-zone') || ''] || [];
      const rank = (x: string, idx: number): number => {
        if (x === 'back-to-top') { return -1; }
        const i = saved.indexOf(x);
        return i === -1 ? 1000 + idx : i;
      };
      const finalOrder = simulated
        .map((x, idx) => ({ x, r: rank(x, idx) }))
        .sort((a, b) => a.r - b.r)
        .map((o) => o.x);
      const followerId = finalOrder[finalOrder.indexOf(id) + 1];
      const follower = followerId
        ? kids.filter((k) => k.getAttribute('data-ikm-dock-id') === followerId)[0]
        : undefined;
      if (follower) {
        const fr = follower.getBoundingClientRect();
        return { left: fr.left, top: fr.top, width: Math.max(fr.width, 32), height: Math.max(fr.height, 32) };
      }
      // Appending after the DOM-last chip: one slot onward, direction-aware.
      const last = kids[kids.length - 1];
      const lr = last.getBoundingClientRect();
      const gap = 8;
      const w = Math.max(lr.width, 32);
      const h = Math.max(lr.height, 32);
      const isColumn = zone.className.indexOf('ikm-dock-zone-edge') !== -1;
      const reversed = window.getComputedStyle(zone).flexDirection.indexOf('reverse') !== -1;
      if (isColumn) { return { left: lr.left, top: lr.bottom + gap, width: w, height: h }; }
      if (reversed) { return { left: lr.left - gap - w, top: lr.top, width: w, height: h }; }
      return { left: lr.right + gap, top: lr.top, width: w, height: h };
    }
    const rail = zone.parentElement;
    if (zone.className.indexOf('ikm-dock-zone-edge') !== -1 && rail) {
      // Empty edge cluster (it has no box of its own): aim at the spot the
      // layout pass would give a lone tab, tab-sized.
      const rr = rail.getBoundingClientRect();
      const p = this._placement(id);
      const at = typeof p.edgePos === 'number' ? p.edgePos
        : p.edgeAlign === 'top' ? 0.05 : p.edgeAlign === 'bottom' ? 0.95 : 0.25;
      const w = 26;
      const h = 100;
      const left = zone.className.indexOf('ikm-dock-right') !== -1 ? rr.right - w : rr.left;
      const top = Math.max(rr.top, Math.min(rr.bottom - h, rr.top + at * rr.height - h / 2));
      return { left, top, width: w, height: h };
    }
    const zr = zone.getBoundingClientRect();
    if (zr.left !== 0 || zr.top !== 0 || zr.width !== 0 || zr.height !== 0) {
      // Empty zone: its anchor, chip-sized.
      return { left: zr.left, top: zr.top, width: Math.max(zr.width, 32), height: Math.max(zr.height, 32) };
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

  /** A flight landed on an ALREADY-VISIBLE chip: acknowledge with a pulse. */
  private _pulseChip(id: string): void {
    const el = this._registered.get(id)?.element;
    if (!el) { return; }
    void el.offsetWidth;
    el.classList.add('ikm-dock-pulse');
    window.setTimeout(() => el.classList.remove('ikm-dock-pulse'), 300);
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
  private _animate(id: string, from: IDockRect, to: IDockRect | (() => IDockRect), done?: () => void, source?: Element, layoutAt: 'from' | 'to' = 'from'): void {
    const finish = (): void => { if (done) { done(); } };
    const reduced = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this._disposed || reduced || !from || !to || from.width <= 0 || from.height <= 0) {
      finish();
      return;
    }
    const toAtLaunch = typeof to === 'function' ? to() : to;
    // FLIP: the proxy is ALWAYS laid out at the rect where the ghost is
    // full-size (minimise: the source; restore: the destination), and the
    // transform does the shrinking/growing. Laying it out small and scaling
    // UP renders the clone's text into a tiny box first — huge deformed
    // glyphs (seen on restore before this).
    const layoutRect = layoutAt === 'to' ? toAtLaunch : from;
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
    // Minimise: fade away as it departs. Restore: gain presence as it
    // arrives (the real UI takes over the moment it lands).
    const opacities = layoutAt === 'to'
      ? { start: 0.35, end: Math.max(startOpacity, 0.9) }
      : { start: startOpacity, end: 0.15 };
    const ease = cubicBezier(...DOCK_MOTION_EASING);
    const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
    const cx = (r: IDockRect): number => r.left + r.width / 2;
    const cy = (r: IDockRect): number => r.top + r.height / 2;
    // Driven frame by frame rather than by fixed keyframes so the flight
    // HOMES: the destination is re-read every frame. A slot moves while a
    // flight is in the air whenever something else changes at once (several
    // utilities docking together, a cluster re-centring, a resize or
    // scroll); fixed keyframes landed where the slot WAS and the chip then
    // popped in somewhere else. Transform-only, so still compositor-cheap.
    const frame = (k: number): void => {
      const dest = typeof to === 'function' ? to() : to;
      const e = ease(k);
      let tf: string;
      if (layoutAt === 'to') {
        // Laid out at the destination, starting pre-shrunk at the origin.
        tf = `translate(${lerp(cx(from) - cx(dest), 0, e)}px, ${lerp(cy(from) - cy(dest), 0, e)}px) ` +
          `scale(${lerp(Math.max(from.width / dest.width, 0.01), 1, e)}, ${lerp(Math.max(from.height / dest.height, 0.01), 1, e)})`;
      } else {
        // Laid out at the source, shrinking onto the (live) destination.
        tf = `translate(${lerp(0, cx(dest) - cx(from), e)}px, ${lerp(0, cy(dest) - cy(from), e)}px) ` +
          `scale(${lerp(1, Math.max(dest.width / from.width, 0.01), e)}, ${lerp(1, Math.max(dest.height / from.height, 0.01), e)})`;
      }
      proxy.style.transform = tf;
      proxy.style.opacity = String(lerp(opacities.start, opacities.end, e));
    };
    let ended = false;
    const end = (): void => {
      if (ended) { return; }
      ended = true;
      proxy.remove();
      finish();
    };
    frame(0); // correct from the very first paint
    const t0 = performance.now();
    const tick = (now: number): void => {
      if (ended) { return; }
      const k = Math.min(1, Math.max(0, (now - t0) / DOCK_MOTION_MS));
      frame(k);
      if (k >= 1) { end(); return; }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
    window.setTimeout(end, DOCK_MOTION_MS + 150); // safety net (rAF stalls in background tabs)
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
    const entry: IRegistered = { descriptor: d, element: undefined };
    this._slideNeighbours(() => {
      this._unregister(d.id, true); // idempotent re-register
      this._registered.set(d.id, entry);
      this._renderEntry(entry);
    }, () => entry.element);
    this._applyArbitration();
    // The row just changed width — re-nudge the legacy feedback bar NOW.
    // The nudge otherwise runs only on scroll ticks, so a chip appearing
    // mid-read (e.g. the reader minimising the TOC) overlapped the bar
    // until the next scroll.
    this._updateBottomRowOffset();
    this._log(`registered '${d.id}'`);
  }

  private _unregister(id: string, inPlace?: boolean): void {
    const entry = this._registered.get(id);
    if (!entry) { return; }
    const remove = (): void => {
      entry.element?.remove();
      this._registered.delete(id);
      this._layoutRails();
    };
    if (inPlace) { remove(); } else { this._slideNeighbours(remove); }
    this._applyArbitration();
    this._updateBottomRowOffset(); // row narrowed — see _register
    this._log(`unregistered '${id}'`);
  }

  private _update(id: string, patch: Partial<IDockDescriptor>): void {
    const entry = this._registered.get(id);
    if (!entry) { return; }
    entry.descriptor = { ...entry.descriptor, ...patch, id };
    const keys = Object.keys(patch);
    if (entry.element && keys.length > 0 && keys.every((k) => k === 'open')) {
      // Opening or closing only changes how the chip looks: no re-render, so
      // it does not blink or replay its entrance in the reader's face.
      this._applyOpenState(entry.element, entry.descriptor);
      return;
    }
    entry.element?.remove();
    entry.element = undefined;
    this._renderEntry(entry);
    this._applyArbitration();
  }

  /**
   * Run a change that adds or removes a chip, and let every OTHER chip that
   * moved because of it slide from its old slot to its new one (FLIP), the
   * same way neighbours make room during a drag. Without this the row
   * snapped sideways the instant a chip left, which read as a jump; on an
   * edge rail a cluster growing or shrinking re-centres every tab in it.
   */
  private _slideNeighbours(change: () => void, added?: () => HTMLElement | undefined): void {
    const chips = (): HTMLElement[] =>
      Array.prototype.slice.call(document.querySelectorAll('[data-ikm-dock-id]')) as HTMLElement[];
    const before = new Map<HTMLElement, DOMRect>();
    chips().forEach((c) => before.set(c, c.getBoundingClientRect()));
    change();
    const newcomer = added ? added() : undefined;
    const reduced = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { return; }
    chips().forEach((c) => {
      const was = before.get(c);
      if (!was || c === newcomer || typeof c.animate !== 'function') { return; }
      const now = c.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) { return; }
      c.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
      );
    });
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
    // Each edge is one rail holding its top, middle and bottom clusters.
    // The clusters only group tabs; _placeTabs positions every tab on the
    // edge in one pass, together with tabs a reader put at their own spot,
    // so nothing on an edge can overlap.
    ['left', 'right'].forEach((side) => {
      const rail = mk(`ikm-dock-rail ikm-dock-${side}`, root);
      this._rails[side] = rail;
      this._zones[`edge-${side}:top`] = mk(`ikm-dock-zone-edge ikm-dock-${side} ikm-dock-edge-top`, rail);
      this._zones[`edge-${side}`] = mk(`ikm-dock-zone-edge ikm-dock-${side}`, rail);
      this._zones[`edge-${side}:bottom`] = mk(`ikm-dock-zone-edge ikm-dock-${side} ikm-dock-edge-bottom`, rail);
    });
    // Zone keys on the elements — the reader's drag-reorder store is keyed
    // by these (see _persistZoneOrder / _applyReaderOrder).
    Object.keys(this._zones).forEach((k) => this._zones[k].setAttribute('data-ikm-zone', k));
    document.body.appendChild(root);
    this._root = root;
  }

  private _zoneFor(id: string): HTMLElement {
    const p = this._placement(id);
    if (p.target !== 'bottom' && !this._isNarrow() && !this._overflow.has(id)) {
      // A reader's own spot is positioned by _placeTabs; the middle
      // cluster just holds it.
      return this._edgeZone(p.target, typeof p.edgePos === 'number' ? 'middle' : p.edgeAlign);
    }
    return this._zones[p.bottomSide === 'left' ? 'bottom-left' : 'bottom-right'];
  }

  // ---------------------------------------------------- edge tab layout

  /**
   * Position every tab on both edges. Runs whenever an edge's tabs or size
   * change. First decides which tabs still fit on their edge (the rest fold
   * into the bottom row), then places what is left.
   */
  private _layoutRails(): void {
    if (this._layingOut || !this._root) { return; }
    this._layingOut = true;
    try {
      if (this._computeOverflow()) { this._rezone(); }
      this._placeTabs('left');
      this._placeTabs('right');
    } finally {
      this._layingOut = false;
    }
  }

  /**
   * An edge holds as many tabs as fit at their shortest. When more are
   * docked there, the least important (highest priority number) fold into
   * the bottom row, so every utility stays reachable; they return when the
   * window grows or the edge empties. Returns whether anything moved.
   */
  private _computeOverflow(): boolean {
    const next = new Set<string>();
    if (!this._isNarrow()) {
      ['left', 'right'].forEach((side) => {
        const rail = this._rails[side];
        const railH = rail ? rail.clientHeight : 0;
        if (railH <= 0) { return; }
        const capacity = Math.max(1, Math.floor((railH + EDGE_GAP_PX) / (EDGE_TAB_MIN_PX + EDGE_GAP_PX)));
        const ids: string[] = [];
        this._registered.forEach((_entry, id) => {
          if (id !== 'back-to-top' && this._placement(id).target === `edge-${side}`) { ids.push(id); }
        });
        ids
          .sort((a, b) => this._priorityOfId(a) - this._priorityOfId(b) || (a < b ? -1 : 1))
          .slice(capacity)
          .forEach((id) => next.add(id));
      });
    }
    const changed = next.size !== this._overflow.size || Array.from(next).some((id) => !this._overflow.has(id));
    if (changed) {
      this._overflow = next;
      if (next.size) { this._log(`edge full, folded into the bottom row: ${Array.from(next).join(',')}`); }
    }
    return changed;
  }

  /**
   * Lay out one edge's tabs. Each tab has a spot it wants: a reader's own
   * spot (edgePos), or its admin cluster stacked from the top, around the
   * upper quarter (middle) or from the bottom. Tabs that would overlap are
   * pushed apart evenly from where they want to be: neighbours are merged
   * into a block centred on the average of their wishes, kept on the edge
   * (pool adjacent violators, so nobody moves further than necessary). On a
   * crowded edge the tabs first shrink towards EDGE_TAB_MIN_PX.
   */
  private _placeTabs(side: string): void {
    const rail = this._rails[side];
    if (!rail) { return; }
    const railH = rail.clientHeight;
    this._railHeights[side] = railH;
    const clusters = ['top', 'middle', 'bottom'].map((align) =>
      Array.prototype.slice.call(this._edgeZone(`edge-${side}` as 'edge-left' | 'edge-right', align as 'top' | 'middle' | 'bottom').children) as HTMLElement[]);
    const tabs = clusters[0].concat(clusters[1], clusters[2]);
    if (tabs.length === 0 || railH <= 0) { return; }

    // Natural heights: clear any squeeze first, then read them all at once.
    tabs.forEach((el) => { el.style.height = ''; });
    const natural = new Map<HTMLElement, number>();
    tabs.forEach((el) => natural.set(el, el.offsetHeight));
    const heights = new Map<HTMLElement, number>(natural);
    const gaps = EDGE_GAP_PX * (tabs.length - 1);
    const total = tabs.reduce((s, el) => s + (natural.get(el) || 0), 0);
    if (total + gaps > railH) {
      const spare = tabs.reduce((s, el) => s + Math.max(0, (natural.get(el) || 0) - EDGE_TAB_MIN_PX), 0);
      const factor = spare > 0 ? Math.max(0, Math.min(1, (railH - gaps - tabs.length * EDGE_TAB_MIN_PX) / spare)) : 0;
      tabs.forEach((el) => {
        const h = natural.get(el) || 0;
        heights.set(el, h > EDGE_TAB_MIN_PX ? EDGE_TAB_MIN_PX + (h - EDGE_TAB_MIN_PX) * factor : h);
      });
    }

    // Where each tab wants to be (its top edge).
    const ownSpot = (el: HTMLElement): number | undefined => {
      const id = el.getAttribute('data-ikm-dock-id') || '';
      const p = this._placement(id);
      return typeof p.edgePos === 'number' ? p.edgePos : undefined;
    };
    const stackH = (els: HTMLElement[]): number =>
      els.reduce((s, el) => s + (heights.get(el) || 0), 0) + EDGE_GAP_PX * Math.max(0, els.length - 1);
    const fixed = clusters.map((c) => c.filter((el) => ownSpot(el) === undefined));
    const topH = stackH(fixed[0]);
    const midH = stackH(fixed[1]);
    const botH = stackH(fixed[2]);
    // The middle cluster sits about a quarter of the way down the free space,
    // as it always has.
    const starts = [0, topH + Math.max(0, railH - topH - midH - botH) * 0.25, railH - botH];
    const wants: { el: HTMLElement; want: number; h: number; seq: number }[] = [];
    fixed.forEach((cluster, ci) => {
      let y = starts[ci];
      cluster.forEach((el) => {
        const h = heights.get(el) || 0;
        wants.push({ el, want: y, h, seq: wants.length });
        y += h + EDGE_GAP_PX;
      });
    });
    tabs.forEach((el) => {
      const f = ownSpot(el);
      if (f === undefined) { return; }
      const h = heights.get(el) || 0;
      wants.push({ el, want: f * railH - h / 2, h, seq: wants.length });
    });
    wants.sort((a, b) => a.want - b.want || a.seq - b.seq);

    // Merge overlapping neighbours into blocks centred on their average wish.
    const clamp = (top: number, h: number): number => Math.max(0, Math.min(railH - h, top));
    interface IBlock { items: typeof wants; h: number; sum: number; top: number }
    const blocks: IBlock[] = [];
    wants.forEach((w) => {
      let cur: IBlock = { items: [w], h: w.h, sum: w.want, top: clamp(w.want, w.h) };
      while (blocks.length > 0) {
        const prev = blocks[blocks.length - 1];
        if (prev.top + prev.h + EDGE_GAP_PX <= cur.top) { break; }
        blocks.pop();
        // Each member's wish, less its offset within the merged block.
        const shift = prev.h + EDGE_GAP_PX;
        const n = prev.items.length + cur.items.length;
        const sum = prev.sum + cur.sum - shift * cur.items.length;
        const h = prev.h + EDGE_GAP_PX + cur.h;
        cur = { items: prev.items.concat(cur.items), h, sum, top: clamp(sum / n, h) };
      }
      blocks.push(cur);
    });

    blocks.forEach((b) => {
      let y = b.top;
      b.items.forEach((w) => {
        const top = `${Math.round(y)}px`;
        if (w.el.style.top !== top) { w.el.style.top = top; }
        const squeezed = w.h < (natural.get(w.el) || 0) - 0.5;
        w.el.style.height = squeezed ? `${Math.floor(w.h)}px` : '';
        y += w.h + EDGE_GAP_PX;
      });
    });
  }

  // ------------------------------------------- reader's choice of zone

  /** Readers may drag this utility to another zone (minimiseTarget 'user-choice'). */
  private _isMovable(id: string): boolean {
    if (id === 'back-to-top') { return false; } // pinned to its corner
    const s = this._getSettings(id);
    return !!s && s.minimiseTarget === 'user-choice';
  }

  /** The admin's placement: the configured zone, or the starting zone of a reader's-choice utility. */
  private _defaultPlacement(id: string): IPlacement {
    const s = this._getSettings(id);
    const target: DockZone = !s
      ? 'bottom'
      : s.minimiseTarget === 'user-choice' ? (s.defaultTarget || 'bottom') : s.minimiseTarget;
    return {
      target,
      bottomSide: s && s.bottomSide === 'left' ? 'left' : 'right',
      edgeAlign: (s && s.edgeAlign) || 'middle'
    };
  }

  /** Where the utility docks now: the reader's pick when it may move, otherwise the admin's. */
  private _placement(id: string): IPlacement {
    if (this._isMovable(id)) {
      const saved = this._readPlaces()[id];
      if (saved) { return saved; }
    }
    return this._defaultPlacement(id);
  }

  /**
   * Readers' picks, one store for the whole tenant (localStorage is per
   * origin): moving a utility applies on every page, unlike chip ORDER,
   * which is per page.
   */
  private _readPlaces(): { [id: string]: IPlacement } {
    try {
      const raw = localStorage.getItem(PLACE_KEY);
      if (!raw) { return {}; }
      const parsed = JSON.parse(raw) as { v: number; places: { [id: string]: IPlacement } };
      return parsed && parsed.v === 1 && parsed.places ? parsed.places : {};
    } catch { return {}; }
  }

  private _savePlace(id: string, place: IPlacement | undefined): void {
    try {
      const places = this._readPlaces();
      if (place) { places[id] = place; } else { delete places[id]; }
      localStorage.setItem(PLACE_KEY, JSON.stringify({ v: 1, places }));
    } catch { /* storage unavailable: the move lasts until the page reloads */ }
  }

  /** The drop target a zone belongs to (edge clusters all count as their edge). */
  private _targetKeyOf(zone: HTMLElement | null): DropKey | undefined {
    const k = zone ? zone.getAttribute('data-ikm-zone') || '' : '';
    if (k === 'bottom-left' || k === 'bottom-right') { return k; }
    if (k.indexOf('edge-left') === 0) { return 'edge-left'; }
    if (k.indexOf('edge-right') === 0) { return 'edge-right'; }
    return undefined;
  }

  private _placementKey(p: IPlacement): DropKey {
    return p.target === 'bottom' ? (p.bottomSide === 'left' ? 'bottom-left' : 'bottom-right') : p.target;
  }

  /**
   * While a movable chip is dragged, every zone it can go to lights up
   * (like window snap areas). Narrow screens fold the edges into the bottom
   * row, so only the two bottom areas are offered there.
   */
  private _showDropTargets(id: string): void {
    this._hideDropTargets();
    if (!this._root) { return; }
    const W = window.innerWidth;
    const H = window.innerHeight;
    // Each area is drawn exactly where, and as thick as, a chip or tab sits
    // once dropped there: the bottom row's 30px strip, and a tab-wide strip
    // flush with each edge. Only the CATCH area is generous (`hit`), so the
    // drop stays easy to make while the outline promises no more room than
    // the tab will actually take.
    const chipH = 30;
    const sample = this._root.querySelector('.ikm-dock-tab') as HTMLElement | null;
    const tabW = sample && sample.offsetWidth > 0 ? sample.offsetWidth : 26;
    const reach = 44;
    const bl = this._zones['bottom-left'];
    const leftPad = bl ? parseFloat(window.getComputedStyle(bl).left) || 20 : 20;
    const rightPad = this._scrollbarClearancePx();
    const bottomTop = H - 2 - chipH;
    const rects: { [k in DropKey]?: IDockRect } = {
      'bottom-left': { left: leftPad, top: bottomTop, width: W / 2 - leftPad - 6, height: chipH },
      'bottom-right': { left: W / 2 + 6, top: bottomTop, width: W / 2 - 6 - rightPad, height: chipH }
    };
    const hits: { [k in DropKey]?: IDockRect } = {
      'bottom-left': { left: 0, top: bottomTop - reach, width: W / 2, height: H - bottomTop + reach },
      'bottom-right': { left: W / 2, top: bottomTop - reach, width: W / 2, height: H - bottomTop + reach }
    };
    if (!this._isNarrow()) {
      const rail = (this._rails.left || this._rails.right) as HTMLElement | undefined;
      const rr = rail ? rail.getBoundingClientRect() : undefined;
      const top = rr && rr.height > 0 ? rr.top : H * 0.1;
      const bottom = Math.min(rr && rr.height > 0 ? rr.bottom : H * 0.9, bottomTop - reach - 8);
      const leftX = this._rails.left ? parseFloat(this._rails.left.style.left) || 0 : 0;
      const rightX = W - rightPad - tabW;
      rects['edge-left'] = { left: leftX, top, width: tabW, height: bottom - top };
      rects['edge-right'] = { left: rightX, top, width: tabW, height: bottom - top };
      hits['edge-left'] = { left: 0, top, width: leftX + tabW + reach, height: bottom - top };
      hits['edge-right'] = { left: rightX - reach, top, width: W - rightX + reach, height: bottom - top };
    }
    const names: { [k in DropKey]: string } = {
      'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right', 'edge-left': 'Left edge', 'edge-right': 'Right edge'
    };
    const home = this._placementKey(this._defaultPlacement(id));
    (Object.keys(rects) as DropKey[]).forEach((k) => {
      const r = rects[k] as IDockRect;
      const el = document.createElement('div');
      el.className = k.indexOf('edge') === 0 ? `ikm-dock-drop ikm-dock-drop-edge ikm-dock-drop-${k}` : 'ikm-dock-drop ikm-dock-drop-bottom';
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('data-ikm-drop', k);
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
      const label = document.createElement('span');
      label.className = 'ikm-dock-drop-label';
      label.textContent = k === home ? `${names[k]} (default)` : names[k];
      el.appendChild(label);
      (this._root as HTMLElement).appendChild(el);
      this._drops.push({ key: k, el, rect: r, hit: hits[k] as IDockRect });
    });
    // Next frame, so they fade in rather than pop.
    window.requestAnimationFrame(() => this._drops.forEach((d) => d.el.classList.add('ikm-dock-drop-shown')));
  }

  /** The drop target whose catch area holds the pointer, lit up; the others dimmed. */
  private _hitDropTarget(x: number, y: number): DropKey | undefined {
    let best: IDropTarget | undefined;
    let bestDist = Infinity;
    this._drops.forEach((d) => {
      const h = d.hit;
      if (x < h.left || x > h.left + h.width || y < h.top || y > h.top + h.height) { return; }
      // Inside two catch areas (a corner): the nearer outline wins.
      const dx = Math.max(d.rect.left - x, 0, x - (d.rect.left + d.rect.width));
      const dy = Math.max(d.rect.top - y, 0, y - (d.rect.top + d.rect.height));
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) { best = d; bestDist = dist; }
    });
    this._drops.forEach((d) => d.el.classList.toggle('ikm-dock-drop-active', d === best));
    return best ? best.key : undefined;
  }

  private _hideDropTargets(): void {
    this._drops.forEach((d) => d.el.remove());
    this._drops = [];
  }

  /**
   * A movable chip was dropped on a zone (or anywhere along an edge,
   * including its own): remember the reader's pick, re-render the chip
   * there (on an edge at the height it was let go, in the bottom row at the
   * drop point's place in the order), and let it glide from where it was
   * let go while the neighbours close up and make room.
   */
  private _moveTo(id: string, key: DropKey, x: number, y: number, from: DOMRect): void {
    const current = this._placement(id);
    const rail = this._rails[key === 'edge-left' ? 'left' : 'right'];
    const rr = rail ? rail.getBoundingClientRect() : undefined;
    const place: IPlacement = key.indexOf('bottom') === 0
      ? { target: 'bottom', bottomSide: key === 'bottom-left' ? 'left' : 'right', edgeAlign: current.edgeAlign }
      : {
        target: key as 'edge-left' | 'edge-right',
        bottomSide: current.bottomSide,
        edgeAlign: current.edgeAlign,
        // Its centre where it was let go, along the edge.
        edgePos: rr && rr.height > 0 ? Math.max(0, Math.min(1, (y - rr.top) / rr.height)) : 0.25
      };
    const def = this._defaultPlacement(id);
    // Back home in the bottom row = forget the pick. An edge spot is always
    // the reader's own, so it is kept.
    const isDefault = key.indexOf('bottom') === 0 && this._placementKey(def) === key;
    this._savePlace(id, isDefault ? undefined : place); // back home = forget the pick
    const entry = this._registered.get(id);
    if (!entry) { return; }
    this._slideNeighbours(() => {
      this._update(id, {});
      const el = entry.element;
      const zone = el && el.parentElement;
      if (!el || !zone) { return; }
      el.classList.remove('ikm-dock-enter');
      // On an edge _placeTabs has already put it at the drop point.
      if (zone.className.indexOf('ikm-dock-zone-edge') !== -1) { return; }
      this._reorderToPointer(el, zone, x, false);
      this._persistZoneOrder(zone);
    }, () => entry.element);
    this._updateBottomRowOffset();
    const el = entry.element;
    const reduced = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!el || reduced || typeof el.animate !== 'function') { return; }
    const to = el.getBoundingClientRect();
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(0.9)`, opacity: 0.6 }, { transform: 'none', opacity: 1 }],
      { duration: DOCK_MOTION_MS, easing: `cubic-bezier(${DOCK_MOTION_EASING.join(', ')})` }
    );
    this._log(`reader moved '${id}' to ${key}`);
  }

  private _isNarrow(): boolean {
    return !!(this._narrowQuery && this._narrowQuery.matches);
  }

  /**
   * Edge zones come in three vertical clusters (contract v1.1 edgeAlign:
   * top/middle/bottom). The middle cluster is the base zone built up front;
   * top/bottom variants are created lazily, styled by the align class.
   */
  private _edgeZone(target: 'edge-left' | 'edge-right', align: 'top' | 'middle' | 'bottom'): HTMLElement {
    return this._zones[align === 'middle' ? target : `${target}:${align}`];
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
    const id = el.getAttribute('data-ikm-dock-id') || '';
    let tracking = false;
    let dragging = false;
    let movable = false; // may leave its zone for another (reader's choice)
    let homeKey: DropKey | undefined;
    let overKey: DropKey | undefined; // drop target under the pointer
    let pointerId = -1;
    let sx = 0;
    let sy = 0;
    let lastX = 0;
    let lastY = 0;
    let startLeft = 0;
    let startTop = 0;
    let tx = 0; // transform currently applied to the held chip
    let ty = 0;
    let detach: (() => void) | undefined; // removes the window listeners of the open drag

    // The held chip follows the pointer 1:1 ALONG its zone. A chip that must
    // stay in its zone only gives a little across it (out onto the page),
    // rubber-band style, so it never looks pulled out of the dock; a movable
    // one follows freely towards the drop targets. Because its DOM slot
    // changes mid-drag (reorders), the transform is recomputed against its
    // CURRENT layout position: desired screen pos = start rect + pointer travel.
    const followPointer = (e: PointerEvent, isColumn: boolean): void => {
      const band = (d: number): number => movable
        ? d
        : Math.sign(d) * DRAG_OFF_AXIS_PX * (1 - Math.exp(-Math.abs(d) / DRAG_OFF_AXIS_PX));
      const dx = isColumn ? band(e.clientX - sx) : e.clientX - sx;
      const dy = isColumn ? e.clientY - sy : band(e.clientY - sy);
      const r = el.getBoundingClientRect();
      const layoutLeft = r.left - tx;
      const layoutTop = r.top - ty;
      tx = (startLeft + dx) - layoutLeft;
      ty = (startTop + dy) - layoutTop;
      el.style.transform = `translate(${tx}px, ${ty}px) scale(1.05)`;
    };

    const end = (): void => {
      if (!tracking) { return; }
      tracking = false;
      if (detach) { detach(); detach = undefined; }
      try { el.releasePointerCapture(pointerId); } catch { /* already released */ }
      if (!dragging) { return; }
      dragging = false;
      this._dragEndedAt = Date.now();
      const heldAt = el.getBoundingClientRect();
      const dropKey = overKey;
      this._hideDropTargets();
      el.classList.remove('ikm-dock-dragging');
      el.style.transform = '';
      const settleTx = tx;
      const settleTy = ty;
      tx = 0;
      ty = 0;
      // On an edge a reader's-choice tab goes where it is let go, even on
      // its own edge; in the bottom row its own zone means a reorder.
      if (movable && dropKey && (dropKey !== homeKey || dropKey.indexOf('edge') === 0)) {
        this._moveTo(id, dropKey, lastX, lastY, heldAt);
        return;
      }
      // Settle: animate the held offset away into the final slot.
      if ((settleTx || settleTy) && typeof el.animate === 'function') {
        el.animate(
          [{ transform: `translate(${settleTx}px, ${settleTy}px) scale(1.05)` }, { transform: 'none' }],
          { duration: 150, easing: 'ease-out' }
        );
      }
      const zone = el.parentElement;
      if (zone) { this._persistZoneOrder(zone); }
    };

    // Move/up are heard on the WINDOW, not the chip. Listening on the chip
    // missed a quick pull: the pointer left a 26px edge tab before the drag
    // threshold, the release landed on the page, and the chip stayed
    // "held" until the mouse next crossed it, then followed the mouse with
    // no button down (found 2026-10-27).
    const onMove = (e: PointerEvent): void => {
      if (!tracking || e.pointerId !== pointerId) { return; }
      if ((e.buttons & 1) === 0) { end(); return; } // release was missed (left the window, etc.)
      if (!dragging) {
        if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 6) { return; }
        dragging = true;
        el.classList.add('ikm-dock-dragging');
        movable = this._isMovable(id);
        homeKey = this._targetKeyOf(el.parentElement);
        if (movable) { this._showDropTargets(id); }
      }
      lastX = e.clientX;
      lastY = e.clientY;
      const zone = el.parentElement;
      if (!zone) { return; }
      const isColumn = zone.className.indexOf('ikm-dock-zone-edge') !== -1;
      overKey = movable ? this._hitDropTarget(e.clientX, e.clientY) : homeKey;
      // Reorder only while over its own zone; over another it is moving.
      // A reader's-choice tab on an edge is never reordered: it is placed
      // where it is let go.
      if (overKey === homeKey && !(movable && isColumn)) {
        this._reorderToPointer(el, zone, isColumn ? e.clientY : e.clientX, true);
      }
      followPointer(e, isColumn);
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId === pointerId) { end(); }
    };
    const onBlur = (): void => end();
    // Chrome can start a native drag of whatever lies under the held tab:
    // on the left edge that is SharePoint's nav link, and the link's
    // dragstart cancels our pointer stream (pointercancel), dropping the tab
    // a few pixels from where it was picked up (found 2026-10-30).
    const noNativeDrag = (e: DragEvent): void => e.preventDefault();

    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) { return; }
      end(); // a press while a stale drag is open starts afresh
      tracking = true;
      dragging = false;
      overKey = undefined;
      pointerId = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
      const r = el.getBoundingClientRect();
      startLeft = r.left;
      startTop = r.top;
      tx = 0;
      ty = 0;
      try { el.setPointerCapture(e.pointerId); } catch { /* stale pointer */ }
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      window.addEventListener('blur', onBlur);
      window.addEventListener('dragstart', noNativeDrag, true);
      detach = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('dragstart', noNativeDrag, true);
      };
    });
  }

  /**
   * Put `el` at the pointer's place among its zone's chips (`pointerPos` is
   * clientX in a row, clientY in a column). With `animateOthers`, displaced
   * siblings slide from their old slot to their new one (FLIP).
   */
  private _reorderToPointer(el: HTMLElement, zone: HTMLElement, pointerPos: number, animateOthers: boolean): void {
    const isColumn = zone.className.indexOf('ikm-dock-zone-edge') !== -1;
    // Visual order is what the reader sees; DOM order equals it EXCEPT in
    // the row-reverse bottom-right zone. Work entirely in visual space,
    // then write the DOM in whichever direction the zone flows.
    const reversed = window.getComputedStyle(zone).flexDirection.indexOf('reverse') !== -1;
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
    if (currentIds === desiredIds) { return; }
    // FLIP the displaced siblings: capture where they were, reorder the
    // DOM, then let each one visibly slide from old slot to new.
    const others = movable.concat(pinned);
    const before = others.map((o) => ({ o, r: o.getBoundingClientRect() }));
    desired.forEach((n) => zone.appendChild(n));
    if (isColumn) { this._layoutRails(); }
    if (!animateOthers) { return; }
    before.forEach(({ o, r }) => {
      const a = o.getBoundingClientRect();
      const dx = r.left - a.left;
      const dy = r.top - a.top;
      if ((dx || dy) && typeof o.animate === 'function') {
        o.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
          { duration: 150, easing: 'ease-out' }
        );
      }
    });
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
    this._applyOpenState(el, entry.descriptor);

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
    entry.element = el;
    this._layoutRails();
    // The layout found this edge full and re-rendered the chip in the
    // bottom row: that render owns the entrance.
    if (entry.element !== el) { return; }
    // Entrance motion: start shrunken/low, release next frame (the shared
    // transition rule animates it in; reduced-motion kills transitions).
    // Not for a chip whose minimise flight is still coming: it stays hidden
    // and pops in on landing, and the flight aims at its rect, which must be
    // its real slot rather than a shrunken, lowered one.
    if (!el.classList.contains('ikm-dock-preflight')) {
      el.classList.add('ikm-dock-enter');
      const release = (): void => el.classList.remove('ikm-dock-enter');
      window.requestAnimationFrame(() => window.requestAnimationFrame(release));
      window.setTimeout(release, 300); // rAF stalls in background tabs
    }
  }

  /**
   * Contract v1.4: an open utility keeps its chip, marked like a taskbar
   * button whose window is showing. Only participants that report `open`
   * get aria-expanded; for the rest the host cannot know, so it says nothing.
   */
  private _applyOpenState(el: HTMLElement, d: IDockDescriptor): void {
    el.classList.toggle('ikm-dock-open', !!d.open);
    if (d.open === undefined) {
      el.removeAttribute('aria-expanded');
    } else {
      el.setAttribute('aria-expanded', d.open ? 'true' : 'false');
    }
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
    this._positionRails(rightPx);
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

  /**
   * Edge rails run from just below the suite bar to 10% off the bottom.
   * The left rail starts right of SharePoint's app bar (tabs used to cover
   * its Discover/Publish buttons); the right rail clears the scrollbar.
   */
  private _positionRails(rightPx: string): void {
    const right = this._rails.right;
    const left = this._rails.left;
    if (!right || !left) { return; }
    if (right.style.right !== rightPx) { right.style.right = rightPx; }
    const suite = document.getElementById('SuiteNavWrapper') || document.getElementById('SuiteNavPlaceHolder');
    const suiteBottom = suite ? suite.getBoundingClientRect().bottom : 0;
    const top = `${Math.round(Math.max(window.innerHeight * 0.1, suiteBottom + 8))}px`;
    [left, right].forEach((r) => { if (r.style.top !== top) { r.style.top = top; } });
    const appBar = document.getElementById('sp-appBar');
    const ab = appBar ? appBar.getBoundingClientRect() : undefined;
    const leftPx = `${ab && ab.width > 0 && ab.left < 80 ? Math.round(ab.right) : 0}px`;
    if (left.style.left !== leftPx) { left.style.left = leftPx; }
    if (left.clientHeight !== this._railHeights.left || right.clientHeight !== this._railHeights.right) {
      this._layoutRails();
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
.ikm-dock-rail { position: fixed; top: 10%; bottom: 10%; width: 0; z-index: ${DOCK_Z_INDEX}; pointer-events: none; }
.ikm-dock-rail.ikm-dock-left { left: 0; }
.ikm-dock-rail.ikm-dock-right { right: 0; }
/* The clusters only group tabs (and keep their zone keys); every tab on an
   edge is positioned by the host's layout pass, from the rail's top. Their
   flex-direction stays: code reads it to tell an edge column from a row. */
.ikm-dock-zone-edge { display: contents; flex-direction: column; pointer-events: auto; }
.ikm-dock-zone-edge .ikm-dock-tab { position: absolute; top: 0; box-sizing: border-box; min-height: ${EDGE_TAB_MIN_PX}px; overflow: hidden; }
.ikm-dock-zone-edge.ikm-dock-left .ikm-dock-tab { left: 0; }
.ikm-dock-zone-edge.ikm-dock-right .ikm-dock-tab { right: 0; }
.ikm-dock-zone-edge .ikm-dock-label { min-height: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ikm-dock-motion-proxy { position: fixed; z-index: ${DOCK_Z_INDEX + 1}; pointer-events: none; border-radius: 6px; opacity: 0.55; transform-origin: center; will-change: transform, opacity; }
.ikm-dock-preflight { visibility: hidden !important; }
.ikm-dock-proxy-card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 100%; color: #fff; font-size: 15px; font-weight: 600; }
.ikm-dock-proxy-card .ms-Icon { font-size: 28px; }
.ikm-dock-chip, .ikm-dock-tab { touch-action: none; }
.ikm-dock-dragging { opacity: 0.8; cursor: grabbing; z-index: 5; position: relative; transition: none !important; }
/* Drop targets while a reader's-choice chip is dragged: every zone it can go
   to, faint; the one under the pointer, strong. Under the chips (z - 1). */
.ikm-dock-drop {
  position: fixed; z-index: ${DOCK_Z_INDEX - 1}; box-sizing: border-box; pointer-events: none;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
  border: 2px dashed var(--ikm-dock-primary); border-radius: 0;
  background: color-mix(in srgb, var(--ikm-dock-primary) 12%, rgba(255, 255, 255, 0.35));
  opacity: 0; transition: opacity 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
}
.ikm-dock-drop-shown { opacity: 1; }
.ikm-dock-drop-active {
  border-style: solid;
  background: color-mix(in srgb, var(--ikm-dock-primary) 28%, rgba(255, 255, 255, 0.35));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ikm-dock-primary) 18%, transparent);
}
.ikm-dock-drop-label {
  font-family: "Segoe UI", system-ui, sans-serif; font-size: 12px; font-weight: 600; line-height: 16px;
  color: var(--ikm-dock-primary); background: rgba(255, 255, 255, 0.92);
  padding: 1px 8px; border-radius: 2px; white-space: nowrap;
}
/* The same shapes as what lands there: square chips along the bottom, tabs
   rounded only on the side away from the screen edge. Edge labels run down
   the strip, low, clear of tabs already in the middle cluster. */
.ikm-dock-drop-edge-left { border-radius: 0 6px 6px 0; }
.ikm-dock-drop-edge-right { border-radius: 6px 0 0 6px; }
.ikm-dock-drop-edge { align-items: flex-end; padding-bottom: 12px; }
.ikm-dock-drop-edge .ikm-dock-drop-label { writing-mode: vertical-rl; padding: 8px 1px; }
@media (prefers-reduced-motion: reduce) { .ikm-dock-drop { transition: none; } }
.ikm-dock-land { animation: ikmDockLand 160ms ease-out; }
@keyframes ikmDockLand { from { transform: scale(0.6); opacity: 0.4; } to { transform: scale(1); opacity: 1; } }
.ikm-dock-pulse { animation: ikmDockPulse 220ms ease-out; }
@keyframes ikmDockPulse { 0% { transform: scale(1); } 45% { transform: scale(1.18); } 100% { transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .ikm-dock-land, .ikm-dock-pulse { animation: none; } }
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
/* Open (contract v1.4): the utility is on screen and its chip stays in the
   dock, like a taskbar button: a shade darker, with a white bar on the side
   that faces the screen edge (under a chip, outside a tab). */
.ikm-dock-chip.ikm-dock-open, .ikm-dock-tab.ikm-dock-open { background: color-mix(in srgb, var(--ikm-dock-primary) 78%, #000); }
.ikm-dock-chip.ikm-dock-open { box-shadow: inset 0 -3px 0 #fff; }
.ikm-dock-zone-edge.ikm-dock-left .ikm-dock-tab.ikm-dock-open { box-shadow: inset 3px 0 0 #fff; }
.ikm-dock-zone-edge.ikm-dock-right .ikm-dock-tab.ikm-dock-open { box-shadow: inset -3px 0 0 #fff; }
.ikm-dock-chip:hover, .ikm-dock-tab:hover { transform: translateY(-1px); filter: brightness(1.1); }
.ikm-dock-chip:focus-visible, .ikm-dock-tab:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.ikm-dock-icon { font-size: 12px; line-height: 1; }
.ikm-dock-offstage, .ikm-dock-suppressed { opacity: 0; pointer-events: none; transform: translateY(6px); }
.ikm-dock-enter { opacity: 0; transform: scale(0.5) translateY(16px); }
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
