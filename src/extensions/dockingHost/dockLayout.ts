// One-dimensional layout for the dock: edge tabs down a rail, chips along a
// row. Pure functions, so the rules can be read (and tested) on their own.

export interface ISpreadItem {
  /** Where the item would like to start along the line. */
  want: number;
  size: number;
  /** Tie-break when two items want the same start. */
  seq: number;
}

/**
 * Starts for items along a line of `length` so that none overlap (at least
 * `gap` apart) and none run off either end, each as close as it can be to
 * where it wants to be. Neighbours that would overlap are merged into a
 * block placed at the average of their wishes, so two items dropped on one
 * spot share it evenly (pool adjacent violators: least squared movement).
 * Returns the starts in input order. Assumes the items fit (see fitSizes).
 */
export function spreadAlong(items: ISpreadItem[], length: number, gap: number): number[] {
  interface IBlock { members: ISpreadItem[]; size: number; sum: number; start: number }
  const clamp = (start: number, size: number): number => Math.max(0, Math.min(length - size, start));
  const sorted = items.slice().sort((a, b) => a.want - b.want || a.seq - b.seq);
  const blocks: IBlock[] = [];
  sorted.forEach((it) => {
    let cur: IBlock = { members: [it], size: it.size, sum: it.want, start: clamp(it.want, it.size) };
    while (blocks.length > 0) {
      const prev = blocks[blocks.length - 1];
      if (prev.start + prev.size + gap <= cur.start) { break; }
      blocks.pop();
      // `sum` holds each member's wish less its offset within the block.
      const shift = prev.size + gap;
      const n = prev.members.length + cur.members.length;
      const sum = prev.sum + cur.sum - shift * cur.members.length;
      const size = prev.size + gap + cur.size;
      cur = { members: prev.members.concat(cur.members), size, sum, start: clamp(sum / n, size) };
    }
    blocks.push(cur);
  });
  const starts = new Map<ISpreadItem, number>();
  blocks.forEach((b) => {
    let at = b.start;
    b.members.forEach((m) => { starts.set(m, at); at += m.size + gap; });
  });
  return items.map((it) => starts.get(it) || 0);
}

/**
 * Sizes that fit `length` with `gap` between them: unchanged when they fit,
 * otherwise each shrinks towards `min` in proportion to what it has above it.
 */
export function fitSizes(natural: number[], length: number, gap: number, min: number): number[] {
  const gaps = gap * Math.max(0, natural.length - 1);
  const total = natural.reduce((s, n) => s + n, 0);
  if (total + gaps <= length) { return natural.slice(); }
  const spare = natural.reduce((s, n) => s + Math.max(0, n - min), 0);
  const factor = spare > 0 ? Math.max(0, Math.min(1, (length - gaps - natural.length * min) / spare)) : 0;
  return natural.map((n) => (n > min ? min + (n - min) * factor : n));
}

export interface ISpan {
  l: number;
  r: number;
}

/**
 * The free stretches of a line of `width` around `blocks` (obstacles, already
 * padded), and the widest one entirely left and entirely right of `split`.
 * Used for the top row: the gaps in SharePoint's suite bar either side of
 * its search box.
 */
export function widestGaps(blocks: ISpan[], width: number, split: number): { left?: ISpan; right?: ISpan } {
  const gaps: ISpan[] = [];
  let at = 0;
  blocks.slice().sort((a, b) => a.l - b.l).forEach((b) => {
    if (b.l > at) { gaps.push({ l: at, r: b.l }); }
    at = Math.max(at, b.r);
  });
  if (at < width) { gaps.push({ l: at, r: width }); }
  const widest = (side: 'left' | 'right'): ISpan | undefined => gaps
    .filter((g) => (side === 'left' ? g.r <= split : g.l >= split))
    .sort((a, b) => (b.r - b.l) - (a.r - a.l))[0];
  return { left: widest('left'), right: widest('right') };
}
