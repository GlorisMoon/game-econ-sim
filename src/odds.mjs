// Lootbox math shared by the simulator and the odds disclosure.
// The disclosure is computed exactly (pity cycle), not sampled.

const total = (w) => w.reduce((s, x) => s + x, 0);

// Weights for the k-th pull since the last pity-rarity hit (k starts at 1).
export function weightsAt(box, k, luck = 1) {
  const lucky = new Set(box.luck?.rarities ?? []);
  const p = box.pity;
  const w = box.pool.map((e) => e.weight * (lucky.has(e.rarity) ? luck : 1));
  if (!p) return w;
  const isPity = box.pool.map((e) => e.rarity === p.rarity);
  if (k >= p.hard) return w.map((x, i) => (isPity[i] ? x : 0));
  const extra = p.soft && k >= p.soft.from ? p.soft.addWeightPerPull * (k - p.soft.from + 1) : 0;
  if (!extra) return w;
  const pw = total(w.filter((_, i) => isPity[i]));
  return w.map((x, i) => (isPity[i] ? x + (extra * x) / pw : x));
}

export function pull(box, state, luck, r) {
  const w = weightsAt(box, state.count + 1, luck);
  let x = r() * total(w), i = 0;
  for (; i < w.length; i++) if ((x -= w[i]) < 0) break;
  if (i === w.length) i = w.findLastIndex((v) => v > 0);
  const e = box.pool[i];
  state.count = box.pity && e.rarity === box.pity.rarity ? 0 : state.count + 1;
  return e;
}

const label = (g) =>
  g.collectible ?? Object.entries(g).map(([k, v]) => `${typeof v === 'number' ? v : '~'} ${k}`).join(' + ');

// Long-run share of each pool entry. With pity: expected count per pity cycle / expected cycle length.
export function disclosure(box, luck = 1) {
  const w1 = weightsAt(box, 1, luck), W1 = total(w1);
  const rows = box.pool.map((e, i) => ({ grant: label(e.grant), rarity: e.rarity, base: w1[i] / W1, effective: w1[i] / W1 }));
  const p = box.pity;
  if (!p) return { rows };
  const per = new Array(rows.length).fill(0);
  let S = 1, E = 0, reachHard = 0;
  for (let k = 1; k <= p.hard; k++) {
    const w = weightsAt(box, k, luck), W = total(w);
    if (k === p.hard) reachHard = S;
    E += S;
    let hit = 0;
    w.forEach((x, i) => {
      per[i] += (S * x) / W;
      if (box.pool[i].rarity === p.rarity) hit += x / W;
    });
    S *= 1 - hit;
  }
  rows.forEach((row, i) => (row.effective = per[i] / E));
  return { rows, pity: { rarity: p.rarity, hard: p.hard, expectedPulls: E, reachHardRate: reachHard } };
}

// Pulls from a fresh pity counter until `rarity` has appeared with probability >= q.
export function pullsToRarity(box, rarity, q, luck = 1) {
  const p = box.pity, cache = new Map();
  const probs = (k) => {
    if (!cache.has(k)) {
      const w = weightsAt(box, k, luck), W = total(w);
      let t = 0, h = 0;
      w.forEach((x, i) => {
        const rr = box.pool[i].rarity;
        if (rr === rarity) t += x / W;
        else if (p && rr === p.rarity) h += x / W;
      });
      cache.set(k, [t, h]);
    }
    return cache.get(k);
  };
  let dist = new Map([[0, 1]]), got = 0;
  for (let n = 1; n <= 1e7; n++) {
    const next = new Map();
    const put = (c, m) => next.set(c, (next.get(c) ?? 0) + m);
    for (const [c, m] of dist) {
      const [t, h] = probs(p ? c + 1 : 1);
      got += m * t;
      if (h) put(0, m * h);
      if (1 - t - h > 0) put(p ? c + 1 : 0, m * (1 - t - h));
    }
    if (got >= q - 1e-12) return n;
    dist = next;
  }
  return Infinity;
}
