// Page-side test library for the IKM docking host. Injected by dock-run.mjs.
// Exposes window.__dt: synthetic participants (minimise/restore through the
// real window.ikmDock API) and an invariant checker that judges only the
// SETTLED layout, so it stays valid whatever the animations look like.
(() => {
  if (window.__dt) return;
  const GAP = 8;
  const TOL = 1.5;
  const panels = {};
  const docked = new Set();
  const descs = {};
  const permanent = new Set();

  const dock = () => window.ikmDock;

  // Flight recorder: every motion proxy's first and last on-screen rect, so a
  // check can tell whether a flight LANDED where its chip/panel then appears.
  const flights = [];
  // Judge each landing a moment after the proxy goes (the participant shows
  // its UI, or the chip pops in, on landing) - not later, when a form may
  // already have closed again.
  const sample = (f) => {
    if (f.verdict !== undefined || (f.judged && !f.judging)) return;
    if (!f.el.isConnected) {
      if (f.judged) return;
      f.judged = true;
      // A chip is revealed in the same turn its flight ends: judge at once,
      // before any later layout change moves it on. A restored UI may take a
      // frame or two to render: if nothing matches yet, look again shortly.
      const now = judge(f);
      if (!now) { f.verdict = ''; return; }
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => { f.verdict = judge(f); }, 120)));
      return;
    }
    const r = f.el.getBoundingClientRect(); if (!f.first) f.first = r; f.last = r; requestAnimationFrame(() => sample(f));
  };
  new MutationObserver((muts) => muts.forEach((m) => {
    m.removedNodes.forEach((n) => {
      const f = flights.find((x) => x.el === n);
      if (f && f.verdict === undefined && !f.judging) { f.judging = true; sample(f); }
    });
    m.addedNodes.forEach((n) => {
      if (!(n.classList && n.classList.contains('ikm-dock-motion-proxy'))) return;
      const f = { el: n, t: performance.now() }; flights.push(f); sample(f);
      // Hosts that set the transform per frame: read every frame they WRITE,
      // including the final one (set just before the proxy is removed), so
      // the landing is judged exactly rather than from a sampled frame.
      new MutationObserver(() => { const r = fromStyle(n); if (r) f.final = r; }).observe(n, { attributes: true, attributeFilter: ['style'] });
    });
  })).observe(document.body, { childList: true });
  function fromStyle(n) {
    const tf = n.style.transform || '';
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+), ([-\d.e]+)\)/.exec(tf);
    if (!m) return null;
    const L = parseFloat(n.style.left), T = parseFloat(n.style.top), W = parseFloat(n.style.width), H = parseFloat(n.style.height);
    const w = W * parseFloat(m[3]), h = H * parseFloat(m[4]);
    const cx = L + W / 2 + parseFloat(m[1]), cy = T + H / 2 + parseFloat(m[2]);
    return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
  }
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };

  // A stand-in for a participant's expanded UI: a fixed card somewhere on screen.
  function panelFor(id, i) {
    let p = panels[id];
    if (!p) {
      p = document.createElement('div');
      p.setAttribute('data-dt-panel', id);
      p.style.cssText = 'position:fixed;width:260px;height:200px;background:#fff;border:2px solid #085a64;border-radius:6px;font:14px Segoe UI;padding:12px;box-sizing:border-box;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,.2)';
      p.textContent = 'Test utility ' + id;
      panels[id] = p;
    }
    const n = Object.keys(panels).indexOf(id);
    p.style.left = Math.max(10, Math.min(innerWidth - 270, innerWidth / 2 - 400 + n * 140)) + 'px';
    p.style.top = Math.max(10, Math.min(innerHeight - 210, innerHeight / 2 - 150 + n * 30)) + 'px';
    return p;
  }

  function descriptor(id) {
    if (descs[id]) return descs[id];
    descs[id] = {
      id, label: id.replace(/^zt-/, '').toUpperCase(), icon: 'TestBeaker', open: false,
      // Contract v1.4: the tab toggles, like a taskbar button.
      onActivate: () => (panels[id] && panels[id].isConnected ? minimise(id) : restore(id))
    };
    return descs[id];
  }

  function show(id) { const p = panelFor(id); if (!p.isConnected) document.body.appendChild(p); return p; }

  // Minimise the way the real participants do: grab the rect, hide the UI at
  // once, hand the rect + element to the host, register in the same turn
  // (or, already registered because it was open, report it closed).
  function minimise(id) {
    const d = dock(); if (!d) throw new Error('no ikmDock');
    const p = show(id);
    const from = rect(p);
    const already = docked.has(id);
    p.remove();
    docked.add(id);
    descriptor(id).open = false;
    if (d.animateMinimise) d.animateMinimise(id, from, undefined, p);
    if (!already) Promise.resolve().then(() => d.register(descriptor(id)));
    else d.update(id, { open: false });
  }

  // Restore (contract v1.4): the host flies tab -> panel, then the panel
  // shows; the participant stays registered and reports itself open, so its
  // tab stays in the dock, marked open.
  function restore(id) {
    const d = dock();
    const p = panelFor(id);
    const r = p.getBoundingClientRect();
    const to = { left: parseFloat(p.style.left), top: parseFloat(p.style.top), width: 260, height: 200 };
    const done = () => {
      document.body.appendChild(p);
      descriptor(id).open = true;
      d.update(id, { open: true });
    };
    if (d.animateRestore) d.animateRestore(id, to, done);
    else done();
    return r;
  }

  // Things a flight may legitimately land on: chips/tabs and opened UI.
  function landingTargets() {
    const els = [...document.querySelectorAll('[data-ikm-dock-id], [data-dt-panel], [class*="pinnedFloat"], .ms-Dialog-main, [aria-label="Feedback Submission Form"]')];
    return els.map((e) => ({ e, r: e.getBoundingClientRect() })).filter((x) => x.r.width > 0 && getComputedStyle(x.e).visibility !== 'hidden');
  }
  function judge(f) {
    if (f.final) f.last = f.final;
    if (!f.last) return '';
    const targets = landingTargets();
    const cx = f.last.left + f.last.width / 2, cy = f.last.top + f.last.height / 2;
    let best = Infinity, bestName = '';
    targets.forEach((t) => {
      const d = Math.hypot(t.r.left + t.r.width / 2 - cx, t.r.top + t.r.height / 2 - cy);
      if (d < best) { best = d; bestName = t.e.getAttribute('data-ikm-dock-id') || t.e.getAttribute('data-dt-panel') || t.e.getAttribute('aria-label') || String(t.e.className).slice(0, 30); }
    });
    // Allow for the final frame not quite reaching the end of the curve.
    const tol = Math.max(10, Math.min(f.last.width, f.last.height) * 0.25);
    return best > tol ? 'FLIGHT-MISS: a flight landed at ' + Math.round(cx) + ',' + Math.round(cy) + ', ' + Math.round(best) + 'px from the nearest thing it could be heading for (' + bestName + ')' : '';
  }
  function flightMisses() {
    const done = flights.filter((f) => f.verdict !== undefined);
    done.forEach((f) => flights.splice(flights.indexOf(f), 1));
    return done.map((f) => f.verdict).filter(Boolean);
  }

  function reset() {
    const d = dock();
    Object.keys(descs).forEach((id) => { try { d && d.unregister(id); } catch (e) {} });
    Object.values(panels).forEach((p) => p.remove());
    docked.clear();
    try {
      Object.keys(localStorage).filter((k) => /dock/i.test(k)).forEach((k) => localStorage.removeItem(k));
    } catch (e) {}
  }

  const chipOf = (id) => [...document.querySelectorAll('[data-ikm-dock-id="' + id + '"]')];

  function center(id) {
    const els = chipOf(id).filter((e) => e.getBoundingClientRect().width > 0);
    if (!els.length) return null;
    const r = els[els.length - 1].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height };
  }

  // Busy = anything still moving. The checker only runs once this is false.
  function busy() {
    if (document.querySelector('.ikm-dock-motion-proxy')) return 'proxy';
    const chips = document.querySelectorAll('[data-ikm-dock-id]');
    for (const c of chips) {
      if (c.getAnimations && c.getAnimations().some((a) => a.playState === 'running')) return 'anim:' + c.getAttribute('data-ikm-dock-id');
      if (c.classList.contains('ikm-dock-enter') || c.classList.contains('ikm-dock-land') || c.classList.contains('ikm-dock-pulse')) return 'class:' + c.getAttribute('data-ikm-dock-id');
    }
    return '';
  }

  // Where the host means the right-hand zones to sit: just clear of the
  // scroll region's scrollbar (mirrors the host's own rule, measured fresh).
  function expectedRightClearance() {
    const region = document.querySelector('div[data-automation-id="contentScrollRegion"]');
    if (!region) { const sb = innerWidth - document.documentElement.clientWidth; return (sb > 0 ? sb : 16) + 4; }
    const r = region.getBoundingClientRect();
    const c = Math.ceil(innerWidth - (r.left + region.clientLeft + region.clientWidth)) + 4;
    return c < 4 || c > 80 ? 20 : c;
  }

  function savedOrder() {
    try {
      const raw = localStorage.getItem('ikm-dock:order:' + location.pathname.toLowerCase());
      return raw ? (JSON.parse(raw).zones || {}) : {};
    } catch (e) { return {}; }
  }

  // Utilities a reader has put at their own spot on an edge (edgePos).
  function ownSpots() {
    try {
      const places = (JSON.parse(localStorage.getItem('ikm-dock:place') || '{}').places) || {};
      return Object.keys(places).filter((id) => typeof places[id].edgePos === 'number');
    } catch (e) { return []; }
  }

  function check(expectDocked) {
    const v = [];
    const spots = ownSpots();
    const roots = document.querySelectorAll('#ikm-dock-host');
    if (roots.length !== 1) v.push('HOST-COUNT: ' + roots.length + ' docking hosts on the page (expected 1)');
    const W = innerWidth, H = innerHeight;
    const zones = [...document.querySelectorAll('[data-ikm-zone]')];
    const allChips = [];
    const saved = savedOrder();
    const clearance = expectedRightClearance();
    for (const z of zones) {
      const key = z.getAttribute('data-ikm-zone');
      const kids = [...z.children];
      if (!kids.length) continue;
      const zs = getComputedStyle(z);
      const zoneShown = zs.display !== 'none' && z.offsetParent !== null || zs.position === 'fixed' && z.getBoundingClientRect().width > 0;
      const isColumn = zs.flexDirection.indexOf('column') === 0;
      const reversed = zs.flexDirection.indexOf('reverse') !== -1;
      // 1. Nothing left mid-motion.
      for (const k of kids) {
        const id = k.getAttribute('data-ikm-dock-id');
        ['ikm-dock-preflight', 'ikm-dock-enter', 'ikm-dock-land', 'ikm-dock-pulse', 'ikm-dock-dragging'].forEach((c) => {
          if (k.classList.contains(c)) v.push('STUCK-STATE: ' + id + ' still has ' + c);
        });
        if (k.style.transform) v.push('STUCK-TRANSFORM: ' + id + ' inline transform ' + k.style.transform);
        const t = getComputedStyle(k).transform;
        const off = k.classList.contains('ikm-dock-offstage') || k.classList.contains('ikm-dock-suppressed');
        if (!off && t && t !== 'none' && !k.matches(':hover')) v.push('STUCK-TRANSFORM: ' + id + ' computed ' + t);
        const op = parseFloat(getComputedStyle(k).opacity);
        if (!off && op < 0.99) v.push('STUCK-FADED: ' + id + ' opacity ' + op);
      }
      // 2. Slots: consecutive chips exactly one gap apart, aligned on the cross axis.
      // Layout boxes, minus the deliberate 6px drop a hidden back-to-top sits at.
      const laid = kids.map((k) => {
        const r = k.getBoundingClientRect();
        const off = k.classList.contains('ikm-dock-offstage') || k.classList.contains('ikm-dock-suppressed');
        const m = off ? new DOMMatrix(getComputedStyle(k).transform) : null;
        const dy = m ? m.m42 : 0, dx = m ? m.m41 : 0;
        return { id: k.getAttribute('data-ikm-dock-id'), k, r: { left: r.left - dx, right: r.right - dx, top: r.top - dy, bottom: r.bottom - dy, width: r.width, height: r.height } };
      });
      const visual = laid.slice().sort((a, b) => isColumn ? a.r.top - b.r.top : a.r.left - b.r.left);
      for (let i = 1; i < visual.length; i++) {
        const a = visual[i - 1].r, b = visual[i].r;
        const gap = isColumn ? b.top - a.bottom : b.left - a.right;
        // A tab at a reader's own spot sits where it was put, so its gaps
        // vary: the whole-edge check below holds it to "never closer than one gap".
        const free = isColumn && (spots.includes(visual[i - 1].id) || spots.includes(visual[i].id));
        if (!free && Math.abs(gap - GAP) > TOL) v.push('SLOT-GAP: ' + key + ' ' + visual[i - 1].id + '->' + visual[i].id + ' gap ' + gap.toFixed(1) + 'px (expected ' + GAP + ')');
        if (isColumn) {
          const side = key.indexOf('right') !== -1 ? 'right' : 'left';
          if (Math.abs(a[side] - b[side]) > TOL) v.push('SLOT-ALIGN: ' + key + ' ' + visual[i].id + ' ' + side + ' edge ' + b[side].toFixed(1) + ' vs ' + a[side].toFixed(1));
        } else if (Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) > TOL) {
          v.push('SLOT-ALIGN: ' + key + ' ' + visual[i].id + ' off the row');
        }
      }
      // 3. Zone anchored where it belongs.
      const zr = z.getBoundingClientRect();
      if (zr.width > 0) {
        if (key.indexOf('right') !== -1) {
          const want = W - clearance;
          if (Math.abs(zr.right - want) > TOL) v.push('ZONE-ANCHOR: ' + key + ' right edge at ' + zr.right.toFixed(1) + ', expected ' + want.toFixed(1) + ' (scrollbar clearance ' + clearance + ')');
        }
        if (key.indexOf('bottom-') === 0 && Math.abs(zr.bottom - (H - 2)) > TOL) v.push('ZONE-ANCHOR: ' + key + ' bottom at ' + zr.bottom.toFixed(1) + ', expected ' + (H - 2));
      }
      // 4. Order: the reader's saved order, else priority (DOM order = flow order).
      const flowIds = kids.map((k) => k.getAttribute('data-ikm-dock-id')).filter((id) => id !== 'back-to-top');
      const s = saved[key];
      if (s && s.length) {
        const want = flowIds.slice().sort((a, b) => { const ia = s.indexOf(a), ib = s.indexOf(b); return (ia < 0 ? 1000 + flowIds.indexOf(a) : ia) - (ib < 0 ? 1000 + flowIds.indexOf(b) : ib); });
        if (want.join() !== flowIds.join()) v.push('ORDER: ' + key + ' shows ' + flowIds.join(',') + ' but saved order gives ' + want.join(','));
      }
      // 5. Fully on screen.
      for (const L of laid) {
        const off = L.k.classList.contains('ikm-dock-offstage') || L.k.classList.contains('ikm-dock-suppressed');
        if (off) continue;
        const r = L.r;
        if (r.width === 0 || r.height === 0) { if (zoneShown) v.push('INVISIBLE: ' + L.id + ' has zero size'); continue; }
        if (r.left < -TOL || r.top < -TOL || r.right > W + TOL || r.bottom > H + TOL) v.push('OFF-SCREEN: ' + L.id + ' at ' + [r.left, r.top, r.right, r.bottom].map((n) => Math.round(n)).join(',') + ' viewport ' + W + 'x' + H);
        allChips.push(L);
      }
    }
    // 5b. Each edge as a whole: tabs at least one gap apart, inside the edge,
    // and flush with the screen edge (right: just clear of the scrollbar).
    document.querySelectorAll('.ikm-dock-rail').forEach((rail) => {
      const right = rail.classList.contains('ikm-dock-right');
      const rr = rail.getBoundingClientRect();
      const tabs = allChips.filter((L) => rail.contains(L.k)).sort((a, b) => a.r.top - b.r.top);
      for (let i = 1; i < tabs.length; i++) {
        const gap = tabs[i].r.top - tabs[i - 1].r.bottom;
        if (gap < GAP - TOL) v.push('EDGE-GAP: ' + tabs[i - 1].id + '->' + tabs[i].id + ' only ' + gap.toFixed(1) + 'px apart (at least ' + GAP + ')');
      }
      tabs.forEach((L) => {
        if (L.r.top < rr.top - TOL || L.r.bottom > rr.bottom + TOL) v.push('EDGE-BOUNDS: ' + L.id + ' runs past its edge (' + Math.round(L.r.top) + '-' + Math.round(L.r.bottom) + ' vs ' + Math.round(rr.top) + '-' + Math.round(rr.bottom) + ')');
        if (right && Math.abs(L.r.right - (W - clearance)) > TOL) v.push('ZONE-ANCHOR: ' + L.id + ' right edge at ' + L.r.right.toFixed(1) + ', expected ' + (W - clearance).toFixed(1));
      });
    });
    // 6. No two visible chips overlap (across zones and hosts).
    for (let i = 0; i < allChips.length; i++) for (let j = i + 1; j < allChips.length; j++) {
      const a = allChips[i].r, b = allChips[j].r;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) v.push('OVERLAP: ' + allChips[i].id + ' and ' + allChips[j].id);
    }
    // 6b. Never on top of SharePoint's own chrome (suite bar, app bar).
    ['sp-appBar', 'SuiteNavWrapper'].forEach((cid) => {
      const c = document.getElementById(cid); if (!c) return;
      const b = c.getBoundingClientRect(); if (!b.width) return;
      // The bottom row sits in the app bar's empty bottom strip by design;
      // edge tabs must clear its buttons.
      allChips.filter((L) => cid !== 'sp-appBar' || L.k.parentElement.className.indexOf('ikm-dock-zone-edge') !== -1).forEach((L) => {
        const a = L.r;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) v.push('COVERS-SP: ' + L.id + ' covers SharePoint ' + cid);
      });
    });
    // 7. Leftover motion proxies.
    const px = document.querySelectorAll('.ikm-dock-motion-proxy').length;
    if (px) v.push('PROXY-LEFT: ' + px + ' motion proxies still in the page');
    // 8. Each docked utility has exactly one reachable chip; nothing else lingers.
    (expectDocked || [...docked]).forEach((id) => {
      const els = chipOf(id);
      if (els.length !== 1) v.push('CHIP-COUNT: ' + id + ' has ' + els.length + ' chips (expected 1)');
      const vis = els.filter((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden');
      if (!vis.length) v.push('UNREACHABLE: ' + id + ' is docked but has no visible chip (viewport ' + W + 'x' + H + ')');
    });
    Object.keys(descs).forEach((id) => {
      if (!docked.has(id) && chipOf(id).length) v.push('LINGERING: ' + id + ' has a chip but was never docked');
    });
    Object.keys(panels).forEach((id) => {
      if (!docked.has(id) && !panels[id].isConnected) v.push('LOST-PANEL: ' + id + ' neither docked nor shown');
      // 9. Contract v1.4: an open utility keeps its tab, marked open; a closed one is not marked.
      const shown = panels[id].isConnected;
      chipOf(id).forEach((e) => {
        const marked = e.classList.contains('ikm-dock-open') && e.getAttribute('aria-expanded') === 'true';
        if (shown && !marked) v.push('OPEN-STATE: ' + id + ' is open but its tab is not marked open');
        if (!shown && e.classList.contains('ikm-dock-open')) v.push('OPEN-STATE: ' + id + ' is closed but its tab is still marked open');
      });
    });
    // The real participants, by what is on screen: a tab is marked open
    // exactly while its utility's UI is showing.
    const onScreen = (sel) => [...document.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; });
    [['feedback', '.ikm-feedback-form, [aria-label="Feedback Submission Form"]'], ['toc', '[class*="pinnedFloat"]']].forEach(([id, sel]) => {
      chipOf(id).forEach((e) => {
        if (!e.hasAttribute('aria-expanded')) return; // participant predates contract v1.4
        const open = e.getAttribute('aria-expanded') === 'true';
        const shown = onScreen(sel);
        if (shown && !open) v.push('OPEN-STATE: ' + id + ' is showing but its tab is not marked open');
        if (!shown && open) v.push('OPEN-STATE: ' + id + ' is closed but its tab is still marked open');
      });
    });
    return v.concat(flightMisses());
  }

  function layout() {
    return [...document.querySelectorAll('[data-ikm-zone]')].filter((z) => z.children.length).map((z) => z.getAttribute('data-ikm-zone') + ': ' + [...z.children].map((k) => { const r = k.getBoundingClientRect(); return k.getAttribute('data-ikm-dock-id') + '@' + Math.round(r.left) + ',' + Math.round(r.top); }).join(' '));
  }

  window.__dt = { flights, minimise, restore, reset, center, busy, check, layout, docked, permanent, panelFor, show };
})();
