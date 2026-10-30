// Easing for the host's frame-by-frame flights (DockManager._animate).

/**
 * A CSS cubic-bezier timing function as a JS function of progress 0..1
 * (Newton steps on x, falling back to bisection).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
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
