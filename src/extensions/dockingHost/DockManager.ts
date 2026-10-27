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
/** How far a dragged chip gives when pulled across its zone, out onto the page. */
const DRAG_OFF_AXIS_PX = 16;
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
  // middle, bottom) in a single column so they can never overlap.
  private _rails: { [side: string]: HTMLElement } = {};

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
    // Each edge is one rail: top cluster, flexible gap, middle cluster,
    // flexible gap, bottom cluster. The gaps give way first when space runs
    // short, then the tabs shrink (labels truncate), so the clusters can't
    // overlap the way independently positioned ones did on short windows.
    ['left', 'right'].forEach((side) => {
      const rail = mk(`ikm-dock-rail ikm-dock-${side}`, root);
      this._rails[side] = rail;
      this._zones[`edge-${side}:top`] = mk(`ikm-dock-zone-edge ikm-dock-${side} ikm-dock-edge-top`, rail);
      mk('ikm-dock-rail-gap ikm-dock-rail-gap-upper', rail);
      this._zones[`edge-${side}`] = mk(`ikm-dock-zone-edge ikm-dock-${side}`, rail);
      mk('ikm-dock-rail-gap ikm-dock-rail-gap-lower', rail);
      this._zones[`edge-${side}:bottom`] = mk(`ikm-dock-zone-edge ikm-dock-${side} ikm-dock-edge-bottom`, rail);
    });
    // Zone keys on the elements — the reader's drag-reorder store is keyed
    // by these (see _persistZoneOrder / _applyReaderOrder).
    Object.keys(this._zones).forEach((k) => this._zones[k].setAttribute('data-ikm-zone', k));
    document.body.appendChild(root);
    this._root = root;
  }

  private _zoneFor(id: string): HTMLElement {
    const s = this._getSettings(id);
    const target = s ? s.minimiseTarget : 'bottom';
    if ((target === 'edge-left' || target === 'edge-right') && !this._isNarrow()) {
      return this._edgeZone(target, (s && s.edgeAlign) || 'middle');
    }
    // 'bottom' and (for now) 'user-choice' land in a bottom slot.
    const side = s && s.bottomSide === 'left' ? 'bottom-left' : 'bottom-right';
    return this._zones[side];
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
    let tracking = false;
    let dragging = false;
    let pointerId = -1;
    let sx = 0;
    let sy = 0;
    let startLeft = 0;
    let startTop = 0;
    let tx = 0; // transform currently applied to the held chip
    let ty = 0;
    let detach: (() => void) | undefined; // removes the window listeners of the open drag

    // The held chip follows the pointer 1:1 ALONG its zone. Across the zone
    // (out onto the page) it only gives a little, rubber-band style: a drag
    // reorders within the zone, so the chip must never look pulled out of
    // the dock. Because its DOM slot changes mid-drag (reorders), the
    // transform is recomputed against its CURRENT layout position:
    // desired screen pos = start rect + pointer travel.
    const followPointer = (e: PointerEvent, isColumn: boolean): void => {
      const band = (d: number): number => Math.sign(d) * DRAG_OFF_AXIS_PX * (1 - Math.exp(-Math.abs(d) / DRAG_OFF_AXIS_PX));
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
      if (dragging) {
        dragging = false;
        el.classList.remove('ikm-dock-dragging');
        // Settle: animate the held offset away into the final slot.
        const settleTx = tx;
        const settleTy = ty;
        el.style.transform = '';
        tx = 0;
        ty = 0;
        if ((settleTx || settleTy) && typeof el.animate === 'function') {
          el.animate(
            [{ transform: `translate(${settleTx}px, ${settleTy}px) scale(1.05)` }, { transform: 'none' }],
            { duration: 150, easing: 'ease-out' }
          );
        }
        const zone = el.parentElement;
        if (zone) { this._persistZoneOrder(zone); }
        this._dragEndedAt = Date.now();
      }
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
        // FLIP the displaced siblings: capture where they were, reorder the
        // DOM, then let each one visibly slide from old slot to new.
        const others = movable.concat(pinned);
        const before = others.map((o) => ({ o, r: o.getBoundingClientRect() }));
        desired.forEach((n) => zone.appendChild(n));
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
      followPointer(e, isColumn);
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId === pointerId) { end(); }
    };
    const onBlur = (): void => end();
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) { return; }
      end(); // a press while a stale drag is open starts afresh
      tracking = true;
      dragging = false;
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
      detach = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        window.removeEventListener('blur', onBlur);
      };
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
    // Not for a chip whose minimise flight is still coming: it stays hidden
    // and pops in on landing, and the flight aims at its rect, which must be
    // its real slot rather than a shrunken, lowered one.
    if (!el.classList.contains('ikm-dock-preflight')) {
      el.classList.add('ikm-dock-enter');
      const release = (): void => el.classList.remove('ikm-dock-enter');
      window.requestAnimationFrame(() => window.requestAnimationFrame(release));
      window.setTimeout(release, 300); // rAF stalls in background tabs
    }
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
.ikm-dock-rail { position: fixed; top: 10%; bottom: 10%; z-index: ${DOCK_Z_INDEX}; display: flex; flex-direction: column; pointer-events: none; }
.ikm-dock-rail.ikm-dock-left { left: 0; align-items: flex-start; }
.ikm-dock-rail.ikm-dock-right { right: 0; align-items: flex-end; }
.ikm-dock-rail-gap { flex: 1 1 0; min-height: 0; }
/* The middle cluster sits about a quarter of the way down, as it always has. */
.ikm-dock-rail-gap-lower { flex-grow: 3; }
.ikm-dock-zone-edge { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 0 1 auto; pointer-events: auto; }
.ikm-dock-zone-edge:empty { display: none; }
.ikm-dock-zone-edge .ikm-dock-tab { flex: 0 1 auto; min-height: 40px; overflow: hidden; }
.ikm-dock-zone-edge .ikm-dock-label { min-height: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ikm-dock-motion-proxy { position: fixed; z-index: ${DOCK_Z_INDEX + 1}; pointer-events: none; border-radius: 6px; opacity: 0.55; transform-origin: center; will-change: transform, opacity; }
.ikm-dock-preflight { visibility: hidden !important; }
.ikm-dock-proxy-card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 100%; color: #fff; font-size: 15px; font-weight: 600; }
.ikm-dock-proxy-card .ms-Icon { font-size: 28px; }
.ikm-dock-chip, .ikm-dock-tab { touch-action: none; }
.ikm-dock-dragging { opacity: 0.8; cursor: grabbing; z-index: 5; position: relative; transition: none !important; }
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
