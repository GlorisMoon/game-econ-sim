// Monte Carlo player simulation and the report built from it.
import { rng, sample, sampleSum, moments, curve } from './random.mjs';
import { pull, disclosure, pullsToRarity } from './odds.mjs';

export const VERSION = '0.1.0';

// Defaults only; override with "platform": {"id": ..., "unit": ..., "fee": ...}.
const PLATFORMS = {
  roblox: { unit: 'Robux', fee: 0.3 },
  google_play: { unit: 'USD', fee: 0.15 },
  app_store: { unit: 'USD', fee: 0.15 },
  web: { unit: 'USD', fee: 0.03 },
};
const OFFER_TYPE = { gamePass: 'permanent', devProduct: 'consumable' };
const CHUNK = 5; // ponytail: purchase decisions every 5 play-minutes; go finer only if results prove sensitive
const SAVE_RATIO = 0.1; // ponytail: while saving for an unlock, only upgrades costing <= 10% of it get bought
const PULLS_PER_DECISION = 200;

export function platformOf(cfg) {
  const p = typeof cfg.platform === 'string' ? { id: cfg.platform } : { id: 'roblox', ...cfg.platform };
  return { ...(PLATFORMS[p.id] ?? { unit: 'USD', fee: 0 }), ...p };
}

// Day-n retention through (1,d1), (7,d7), (30,d30), straight in log-log space, extended past 30 with the last slope.
export function survival(ret, days) {
  const S = [1];
  for (let d = 1; d <= days; d++) {
    const [a, b] = d <= 7 ? [[1, ret.d1], [7, ret.d7]] : [[7, ret.d7], [30, ret.d30]];
    const t = (Math.log(d) - Math.log(a[0])) / (Math.log(b[0]) - Math.log(a[0]));
    S.push(Math.exp(Math.log(a[1]) + t * (Math.log(b[1]) - Math.log(a[1]))));
  }
  return S;
}

function tag(x, where) {
  const a = x.analytics ?? {};
  const def =
    where === 'activity' ? (x.onboarding ? 'Onboarding' : x.kind === 'repeatable' ? 'Gameplay' : 'TimedReward')
    : where === 'paid' ? (x.window ? 'ContextualPurchase' : 'IAP')
    : 'Shop';
  return [a.transactionType ?? def, a.itemSku ?? x.id];
}

function makeIndex(cfg) {
  const by = (a) => new Map((a ?? []).map((x) => [x.id, x]));
  const acts = (k) => cfg.activities.filter((a) => a.kind === k);
  const items = cfg.items ?? [];
  const firstCost = (it) => Object.values(it.cost ?? {}).reduce((s, v) => s + curve(v, 1), 0);
  const ix = {
    cur: by(cfg.currencies), items: by(items), boxes: by(cfg.lootboxes), col: by(cfg.collectibles),
    offers: by(cfg.offers), events: by(cfg.events),
    repeat: acts('repeatable'), cooldown: acts('cooldown'), daily: acts('daily'), offline: acts('offline'),
    upgrades: items.filter((i) => i.kind === 'upgrade'),
    unlocks: items.filter((i) => i.kind === 'unlock' || i.kind === 'exchange').sort((a, b) => firstCost(a) - firstCost(b)),
    coinBoxes: (cfg.lootboxes ?? []).filter((b) => b.cost),
  };
  ix.lbCur = new Set(ix.coinBoxes.map((b) => Object.keys(b.cost)[0]));
  return ix;
}

const costAt = (cost, n) => Object.entries(cost ?? {}).map(([c, v]) => [c, Math.round(curve(v, n))]);

function runOnce(cfg, ix, surv, nPlayers, seed) {
  const r = rng(seed);
  const D = cfg.sim.days;
  const acc = { dau: new Array(D).fill(0), rev: new Array(D).fill(0), revBy: {}, flow: {}, wallet: {} };
  for (const c of cfg.currencies) acc.wallet[c.id] = Array.from({ length: D }, () => []);
  const players = [];

  const flow = (cur, dir, [tt, sku], amt) => {
    const k = `${cur}|${dir}|${tt}|${sku}`;
    acc.flow[k] = (acc.flow[k] ?? 0) + amt;
  };
  const has = (p, id) => (p.owned.get(id) ?? 0) > 0 || (p.lv[id] ?? 0) > 0;
  const own = (p, id, t) => { p.ownDay[id] ??= t; };
  const isOpen = (x, p, d, jd) => {
    if (x.during) {
      const e = ix.events.get(x.during);
      if (d < e.startDay || d >= e.endDay) return false;
    }
    const u = x.unlock;
    if (!u) return true;
    if (u.owns != null && ![].concat(u.owns).every((id) => has(p, id))) return false;
    if (u.rebirths != null && p.rebirths < u.rebirths) return false;
    if (u.level != null && p.level < u.level) return false;
    if (u.joinDay && (jd < (u.joinDay.min ?? 0) || jd > (u.joinDay.max ?? Infinity))) return false;
    return true;
  };
  const limitHit = (p, it) => (it.kind === 'unlock' ? has(p, it.id) : it.limit != null && (p.owned.get(it.id) ?? 0) >= it.limit);

  const born = (join) => {
    let u = r(), i = 0;
    for (; i < cfg.segments.length - 1; i++) if ((u -= cfg.segments[i].share) < 0) break;
    const seg = cfg.segments[i], S = surv.get(seg.id), sp = seg.spend ?? {};
    const v = r();
    let L = 0;
    while (L + 1 < S.length && S[L + 1] >= v) L++;
    const p = {
      seg, join, last: join + L, wallet: {}, lb: {}, owned: new Map(), lv: {}, rebirths: 0, temp: [], clock: 0,
      xp: 0, level: 1, pity: {}, pulls: {}, spent: {}, hit: {}, ownDay: {}, rebirthDay: [], expired: new Set(),
      payer: r() < (sp.payerRate ?? 0), fpd: sp.firstPurchaseDay != null ? sample(sp.firstPurchaseDay, r) : 0,
      budget: sp.budget != null ? sample(sp.budget, r) : 0, paid: 0, firstPay: null, days: 0,
      dirty: true, st: null, addT: null,
    };
    for (const c of cfg.currencies) p.wallet[c.id] = c.start ?? 0;
    players.push(p);
  };

  // Final stat = (base + Σadd) × Πmul. Collectibles: best N by their effect on collection.equipBy.
  const stats = (p) => {
    if (p.temp.some((t) => t.until <= p.clock)) {
      p.temp = p.temp.filter((t) => t.until > p.clock);
      p.dirty = true;
    }
    if (!p.dirty) return p.st;
    const add = {}, mul = {};
    for (const s of cfg.stats) { add[s.id] = s.base; mul[s.id] = 1; }
    const apply = (effs, n = 1) => {
      for (const e of effs ?? []) {
        if (e.durationMinutes != null) continue;
        if (e.add != null) add[e.stat] += e.add * n;
        else mul[e.stat] *= e.mul ** n;
      }
    };
    for (const [id, n] of Object.entries(p.lv)) apply(ix.items.get(id).effects, n);
    for (const [id, n] of p.owned) {
      const x = ix.offers.get(id) ?? (ix.items.get(id)?.kind === 'unlock' ? ix.items.get(id) : null);
      if (x) apply(x.effects, n);
    }
    if (cfg.rebirth) apply(cfg.rebirth.effects, p.rebirths);
    for (const t of p.temp) {
      if (t.add != null) add[t.stat] += t.add;
      else mul[t.stat] *= t.mul;
    }
    const col = cfg.collection ?? {};
    const copies = (n) => (col.duplicates?.convertTo ? 1 : n);
    const val = (c) => (col.equipBy ? c.effects.filter((e) => e.stat === col.equipBy).reduce((s, e) => s + (e.add ?? e.mul - 1), 0) : 0);
    const mine = [...p.owned].filter(([id]) => ix.col.has(id)).map(([id, n]) => [ix.col.get(id), copies(n)]);
    if (mine.length) {
      mine.sort((a, b) => val(b[0]) - val(a[0]));
      let left = col.equipLimitStat ? Math.floor(add[col.equipLimitStat] * mul[col.equipLimitStat]) : Infinity;
      for (const [c, n] of mine) {
        const k = Math.min(n, left);
        if (k <= 0) break;
        apply(c.effects, k);
        left -= k;
      }
    }
    p.st = {};
    for (const s of cfg.stats) p.st[s.id] = add[s.id] * mul[s.id];
    p.addT = add;
    p.dirty = false;
    return p.st;
  };

  const earn = (p, cur, amt, tg) => {
    const cap = ix.cur.get(cur).cap;
    if (cap != null) amt = Math.min(amt, cap - p.wallet[cur]);
    if (!(amt > 0)) return;
    p.wallet[cur] += amt;
    if (ix.lbCur.has(cur)) p.lb[cur] = (p.lb[cur] ?? 0) + amt * (p.seg.policy?.lootboxShare ?? 0.5);
    flow(cur, 'Source', tg, amt);
  };
  const levelUp = (p) => {
    const pr = cfg.progression;
    while (p.level < (pr.maxLevel ?? Infinity) && p.xp >= curve(pr.xpPerLevel, p.level)) {
      p.xp -= curve(pr.xpPerLevel, p.level);
      p.level++;
    }
  };
  const give = (p, rewards, times, tg, st) => {
    for (const rw of rewards ?? []) {
      if (rw.xp != null) { p.xp += sampleSum(rw.xp, times, r); levelUp(p); continue; }
      let amt = sampleSum(rw.amount, times, r);
      for (const s of rw.scaledBy ?? []) amt *= st[s];
      earn(p, rw.currency, amt, tg);
    }
  };
  const avail = (p, c, fromLb) => (fromLb ? p.lb[c] ?? 0 : p.wallet[c] - (p.lb[c] ?? 0));
  const canPay = (p, cost, fromLb = false) => cost.every(([c, a]) => avail(p, c, fromLb) >= a);
  const pay = (p, cost, tg, fromLb = false) => {
    for (const [c, a] of cost) {
      p.wallet[c] -= a;
      if (fromLb) p.lb[c] -= a;
      else if (p.lb[c] != null) p.lb[c] = Math.min(p.lb[c], p.wallet[c]);
      flow(c, 'Sink', tg, a);
    }
  };
  const grant = (p, g, tg, t) => {
    for (const [k, v] of Object.entries(g ?? {})) {
      if (k !== 'collectible') { earn(p, k, sample(v, r), tg); continue; }
      const n = p.owned.get(v) ?? 0, conv = cfg.collection?.duplicates?.convertTo;
      if (n && conv) grant(p, conv, ['Gameplay', 'duplicate'], t);
      else { p.owned.set(v, n + 1); own(p, v, t); p.dirty = true; }
    }
  };
  const doPull = (p, box, t, paid) => {
    const luck = box.luck ? stats(p)[box.luck.stat] : 1;
    const e = pull(box, (p.pity[box.id] ??= { count: 0 }), luck, r);
    p.pulls[box.id] = (p.pulls[box.id] ?? 0) + 1;
    p.spent[box.id] = (p.spent[box.id] ?? 0) + paid;
    p.hit[`${box.id}|${e.rarity}`] ??= { pulls: p.pulls[box.id], spent: p.spent[box.id], t };
    grant(p, e.grant, tag(box, paid ? 'paid' : 'shop'), t);
  };

  const buyOffers = (p, d, jd, t) => {
    for (const id of p.seg.spend?.priority ?? []) {
      const o = ix.offers.get(id), box = o ? null : ix.boxes.get(id), x = o ?? box;
      if (!x || !isOpen(x, p, d, jd) || p.budget - p.paid < x.price) continue;
      if (o) {
        const n = p.owned.get(id) ?? 0, type = OFFER_TYPE[o.type] ?? o.type;
        if (o.window && (jd < (o.window.fromJoinDay ?? 0) || jd > (o.window.toJoinDay ?? Infinity))) continue;
        if ((type === 'permanent' && n) || (o.limit != null && n >= o.limit)) continue;
        p.owned.set(id, n + 1);
        own(p, id, t);
        p.dirty = true;
        grant(p, o.grants, tag(o, 'paid'), t);
        for (const e of o.effects ?? []) if (e.durationMinutes != null) p.temp.push({ ...e, until: p.clock + e.durationMinutes });
      } else doPull(p, box, t, x.price);
      p.paid += x.price;
      acc.rev[d] += x.price;
      acc.revBy[id] = (acc.revBy[id] ?? 0) + x.price;
      p.firstPay ??= jd;
    }
  };

  const savingFor = (p, cur, d, jd) => {
    let goal = null;
    for (const it of ix.unlocks) {
      if (limitHit(p, it) || !isOpen(it, p, d, jd)) continue;
      const cost = costAt(it.cost, 1);
      if (cost.length === 1 && cost[0][0] === cur && !canPay(p, cost)) goal = goal == null ? cost[0][1] : Math.min(goal, cost[0][1]);
    }
    return goal;
  };
  const gain = (p, effs) => (effs ?? []).reduce((s, e) => s + (e.add != null ? e.add / Math.max(1e-9, p.addT[e.stat]) : e.mul - 1), 0);

  const rebirth = (p, cost, t) => {
    for (const [c, a] of cost) { p.wallet[c] -= a; flow(c, 'Sink', ['Gameplay', 'rebirth'], a); }
    for (const id of cfg.rebirth.resets ?? []) {
      if (ix.cur.has(id)) {
        const start = ix.cur.get(id).start ?? 0, lost = p.wallet[id] - start;
        if (lost > 0) flow(id, 'Sink', ['Gameplay', 'rebirth'], lost);
        p.wallet[id] = Math.min(p.wallet[id], start);
        p.lb[id] = 0;
      } else { p.owned.delete(id); delete p.lv[id]; }
    }
    for (const c of Object.keys(p.lb)) p.lb[c] = Math.min(p.lb[c], p.wallet[c]);
    p.rebirths++;
    p.rebirthDay.push(t);
    p.dirty = true;
  };

  // Buying rules: rebirth when affordable, unlocks as soon as affordable, upgrades by gain per cost,
  // lootboxes from their own pocket (policy.lootboxShare of income), saving for the priciest open box.
  const spend = (p, d, jd, t) => {
    const rb = cfg.rebirth, pol = p.seg.policy?.rebirth ?? 'asap';
    if (rb && pol !== 'never' && !(typeof pol === 'object' && jd < pol.afterDays) && isOpen(rb, p, d, jd)) {
      const cost = costAt(rb.cost, p.rebirths + 1);
      if (cost.every(([c, a]) => p.wallet[c] >= a)) rebirth(p, cost, t);
    }
    for (let again = true; again; ) {
      again = false;
      for (const it of ix.unlocks) {
        if (limitHit(p, it) || !isOpen(it, p, d, jd)) continue;
        const cost = costAt(it.cost, 1);
        if (!canPay(p, cost)) continue;
        pay(p, cost, tag(it, 'shop'));
        p.owned.set(it.id, (p.owned.get(it.id) ?? 0) + 1);
        own(p, it.id, t);
        p.dirty = true;
        grant(p, it.grants, tag(it, 'shop'), t);
        again = true;
      }
    }
    for (let k = 0; k < 200; k++) {
      stats(p);
      let best = null, bestV = 0, bestCost = null;
      for (const it of ix.upgrades) {
        const lv = p.lv[it.id] ?? 0;
        if (lv >= it.maxLevel || !isOpen(it, p, d, jd)) continue;
        const cost = costAt(it.cost, lv + 1);
        if (!cost.length || !canPay(p, cost)) continue;
        const goal = savingFor(p, cost[0][0], d, jd);
        if (goal != null && cost[0][1] > SAVE_RATIO * goal) continue;
        const v = gain(p, it.effects) / Math.max(1, cost[0][1]);
        if (v > bestV) { best = it; bestV = v; bestCost = cost; }
      }
      if (!best) break;
      pay(p, bestCost, tag(best, 'shop'));
      p.lv[best.id] = (p.lv[best.id] ?? 0) + 1;
      own(p, best.id, t);
      p.dirty = true;
    }
    for (const cur of ix.lbCur) {
      let box = null, price = 0;
      for (const b of ix.coinBoxes) {
        if (b.cost[cur] == null || !isOpen(b, p, d, jd)) continue;
        const c = Math.round(curve(b.cost[cur], 1));
        if (c > price) { box = b; price = c; }
      }
      for (let k = 0; box && k < PULLS_PER_DECISION && avail(p, cur, true) >= price && p.wallet[cur] >= price; k++) {
        pay(p, [[cur, price]], tag(box, 'shop'), true);
        doPull(p, box, t, 0);
      }
    }
  };

  // Currencies worth grinding: something open still spends them.
  const useful = (p, cur, d, jd) =>
    ix.unlocks.some((i) => i.cost?.[cur] != null && !limitHit(p, i) && isOpen(i, p, d, jd)) ||
    ix.upgrades.some((i) => i.cost?.[cur] != null && (p.lv[i.id] ?? 0) < i.maxLevel && isOpen(i, p, d, jd)) ||
    ix.coinBoxes.some((b) => b.cost[cur] != null && isOpen(b, p, d, jd)) ||
    cfg.rebirth?.cost?.[cur] != null ||
    (p.seg.policy?.consumables ?? []).some((id) => ix.items.get(id).cost?.[cur] != null);

  // Best repeatable per currency (by its first reward); play time is split evenly across useful currencies.
  const grind = (p, d, jd, st) => {
    const best = new Map();
    for (const a of ix.repeat) {
      const rw = a.rewards?.[0];
      if (!rw || !isOpen(a, p, d, jd)) continue;
      const key = rw.xp != null ? 'xp' : rw.currency;
      let rate = moments(rw.xp ?? rw.amount)[0] / a.minutes;
      for (const s of rw.scaledBy ?? []) rate *= st[s];
      if (!best.has(key) || rate > best.get(key).rate) best.set(key, { a, rate });
    }
    const out = [...best].filter(([cur]) => cur === 'xp' || useful(p, cur, d, jd)).map(([, v]) => v.a);
    return out.length ? out : [...best.values()].slice(0, 1).map((v) => v.a);
  };

  const playDay = (p, d) => {
    const jd = d - p.join, seg = p.seg;
    p.days++;
    acc.dau[d]++;
    for (const ev of cfg.events ?? []) {
      if (d < ev.endDay || p.expired.has(ev.id)) continue;
      p.expired.add(ev.id);
      for (const c of ev.expires ?? []) {
        if (p.wallet[c] > 0) flow(c, 'Sink', ['Gameplay', 'expired'], p.wallet[c]);
        p.wallet[c] = 0;
        p.lb[c] = 0;
      }
    }
    if (p.payer && jd >= Math.floor(p.fpd)) buyOffers(p, d, jd, jd);
    const n = Math.max(1, Math.round(sample(seg.sessionsPerDay, r)));
    for (let s = 0; s < n; s++) {
      const total = Math.max(1, sample(seg.sessionMinutes, r));
      let left = total;
      const at = () => jd + (s + (total - left) / total) / n;
      let st = stats(p);
      for (const a of ix.offline) if (isOpen(a, p, d, jd)) give(p, a.rewards, Math.min(a.capHours, 24 / n), tag(a, 'activity'), st);
      for (const a of ix.cooldown) if (isOpen(a, p, d, jd)) give(p, a.rewards, 1 + Math.floor(total / a.cooldownMinutes), tag(a, 'activity'), st);
      if (s === 0)
        for (const a of ix.daily) {
          if (!isOpen(a, p, d, jd)) continue;
          if (a.rewardsByDay) give(p, a.rewardsByDay[(p.days - 1) % a.rewardsByDay.length], 1, tag(a, 'activity'), st);
          else
            for (let k = 0; k < (a.limitPerDay ?? 1) && left >= (a.minutes ?? 0); k++) {
              left -= a.minutes ?? 0;
              give(p, a.rewards, 1, tag(a, 'activity'), st);
            }
        }
      for (const id of seg.policy?.consumables ?? []) {
        const it = ix.items.get(id), cost = costAt(it.cost, 1);
        if (!isOpen(it, p, d, jd) || p.temp.some((x) => x.src === id) || !canPay(p, cost)) continue;
        pay(p, cost, tag(it, 'shop'));
        for (const e of it.effects) p.temp.push({ ...e, src: id, until: p.clock + e.durationMinutes });
        p.dirty = true;
      }
      spend(p, d, jd, at());
      for (let k = 0; left > 0; k++) {
        const c = Math.min(CHUNK, left);
        st = stats(p);
        const options = grind(p, d, jd, st);
        if (options.length) {
          const a = options[k % options.length];
          give(p, a.rewards, c / a.minutes, tag(a, 'activity'), st);
        }
        left -= c;
        p.clock += c;
        spend(p, d, jd, at());
      }
    }
    for (const c of cfg.currencies) acc.wallet[c.id][d].push(p.wallet[c.id]);
  };

  for (let d = 0; d < D; d++) {
    if (cfg.sim.installsPerDay) for (let i = 0; i < cfg.sim.installsPerDay; i++) born(d);
    else if (d === 0) for (let i = 0; i < nPlayers; i++) born(0);
    for (const p of players) if (p.join <= d && d <= p.last) playDay(p, d);
  }

  const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : 0);
  const walletMedian = Object.fromEntries(Object.entries(acc.wallet).map(([c, days]) => [c, days.map(median)]));
  const recs = players.map((p) => ({
    seg: p.seg.id, join: p.join, last: p.last, ownDay: p.ownDay, rebirthDay: p.rebirthDay,
    firstPay: p.firstPay, paid: p.paid, hit: p.hit,
  }));
  return { acc, walletMedian, recs };
}

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export function simulate(cfg, opt = {}) {
  const runs = opt.runs ?? cfg.sim.runs ?? 10;
  const seed = opt.seed ?? cfg.sim.seed ?? 1;
  const nPlayers = opt.players ?? cfg.sim.players;
  const D = cfg.sim.days;
  const ix = makeIndex(cfg), plat = platformOf(cfg);
  const surv = new Map(cfg.segments.map((s) => [s.id, survival(s.retention, D)]));

  const dau = new Array(D).fill(0), rev = new Array(D).fill(0), revBy = {}, flow = {}, wallet = {};
  let recs = [];
  for (let run = 0; run < runs; run++) {
    const out = runOnce(cfg, ix, surv, nPlayers, seed + run * 7919);
    out.acc.dau.forEach((v, d) => (dau[d] += v / runs));
    out.acc.rev.forEach((v, d) => (rev[d] += v / runs));
    for (const [k, v] of Object.entries(out.acc.revBy)) revBy[k] = (revBy[k] ?? 0) + v / runs;
    for (const [k, v] of Object.entries(out.acc.flow)) flow[k] = (flow[k] ?? 0) + v / runs;
    for (const [c, m] of Object.entries(out.walletMedian)) {
      wallet[c] ??= new Array(D).fill(0);
      m.forEach((v, d) => (wallet[c][d] += v / runs));
    }
    recs = recs.concat(out.recs);
  }
  return buildReport(cfg, { plat, runs, nPlayers, D, ix, dau, rev, revBy, flow, wallet, recs });
}

function buildReport(cfg, m) {
  const { plat, D, recs } = m;
  const segIds = cfg.segments.map((s) => s.id);
  const of = (seg) => (seg ? recs.filter((x) => x.seg === seg) : recs);
  const observable = (n) => recs.filter((x) => x.join + n < D);
  const frac = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : null);

  const w = (k) => cfg.segments.reduce((s, x) => s + x.share * x.retention[k], 0);
  const retention = {
    assumed: { d1: w('d1'), d7: w('d7'), d30: w('d30') },
    simulated: Object.fromEntries([1, 7, 30].filter((n) => n < D).map((n) => [`d${n}`, frac(observable(n), (x) => x.last - x.join >= n)])),
  };

  const reach = (xs, pick) => {
    const v = xs.map(pick).filter((x) => x != null);
    return { reach: xs.length ? v.length / xs.length : 0, p50: quantile(v, 0.5), p90: quantile(v, 0.9) };
  };
  const tracked = [
    ...(cfg.items ?? []).filter((i) => i.kind === 'unlock' || i.kind === 'exchange').map((i) => i.id),
    ...(cfg.collectibles ?? []).map((c) => c.id),
  ];
  const progression = tracked.map((id) => ({
    id, segments: Object.fromEntries(segIds.map((s) => [s, reach(of(s), (x) => x.ownDay[id])])),
  }));
  if (cfg.rebirth)
    for (let k = 1; k <= 3; k++)
      progression.push({ id: `rebirth #${k}`, segments: Object.fromEntries(segIds.map((s) => [s, reach(of(s), (x) => x.rebirthDay[k - 1])])) });

  const economy = {};
  for (const c of cfg.currencies) {
    const flows = Object.entries(m.flow)
      .map(([k, amount]) => { const [cur, flow, transactionType, itemSku] = k.split('|'); return { cur, flow, transactionType, itemSku, amount }; })
      .filter((f) => f.cur === c.id)
      .sort((a, b) => b.amount - a.amount)
      .map(({ cur, ...f }) => f);
    const source = flows.filter((f) => f.flow === 'Source').reduce((s, f) => s + f.amount, 0);
    const sink = flows.filter((f) => f.flow === 'Sink').reduce((s, f) => s + f.amount, 0);
    economy[c.id] = { source, sink, coverage: source ? sink / source : null, walletMedian: m.wallet[c.id], flows };
  }
  const growth = (cur, from) => {
    const s = m.wallet[cur], to = D - 1;
    return s[from] > 0 && s[to] > 0 && to > from ? (s[to] / s[from]) ** (1 / (to - from)) - 1 : null;
  };

  const lootboxes = {};
  for (const b of cfg.lootboxes ?? []) {
    const rarities = [...new Set(b.pool.map((e) => e.rarity))];
    const curKind = b.cost ? m.ix.cur.get(Object.keys(b.cost)[0]).kind : null;
    lootboxes[b.id] = {
      price: b.price ?? null,
      cost: b.cost ? Object.fromEntries(costAt(b.cost, 1)) : null,
      paidRandom: b.price != null,
      paidCurrency: curKind === 'hard',
      odds: disclosure(b),
      toRarity: Object.fromEntries(rarities.map((ra) => {
        const p50 = pullsToRarity(b, ra, 0.5), p90 = pullsToRarity(b, ra, 0.9);
        return [ra, { pullsP50: p50, pullsP90: p90, ...(b.price != null && { priceP50: p50 * b.price, priceP90: p90 * b.price }) }];
      })),
    };
  }

  const gross = m.rev.reduce((s, x) => s + x, 0), dauSum = m.dau.reduce((s, x) => s + x, 0);
  const payers = recs.filter((x) => x.firstPay != null).length / m.runs;
  const conversion = (n) => frac(recs.filter((x) => x.join + n <= D), (x) => x.firstPay != null && x.firstPay < n);
  const revenue = {
    unit: plat.unit, fee: plat.fee, gross, net: gross * (1 - plat.fee),
    arpdau: dauSum ? gross / dauSum : 0, arppu: payers ? gross / payers : 0, payers,
    conversion: Object.fromEntries([1, 7, 30].filter((n) => n <= D).map((n) => [`d${n}`, conversion(n)])),
    byOffer: Object.entries(m.revBy).map(([id, g]) => ({ id, gross: g, share: gross ? g / gross : 0 })).sort((a, b) => b.gross - a.gross),
    dau: m.dau, daily: m.rev,
  };

  const targets = (cfg.targets ?? []).map((t) => {
    const q = (t.percentile ?? 50) / 100;
    const box = (cfg.lootboxes ?? []).find((b) => b.id === t.lootbox);
    let value = null;
    switch (t.check) {
      case 'daysToOwn': value = quantile(of(t.segment).map((x) => x.ownDay[t.item]).filter((v) => v != null), q); break;
      case 'daysToRebirth': value = quantile(of(t.segment).map((x) => x.rebirthDay[t.count - 1]).filter((v) => v != null), q); break;
      case 'walletGrowthPerDay': value = growth(t.currency, t.fromDay ?? 0); break;
      case 'sinkCoverage': value = economy[t.currency].coverage; break;
      case 'pullsToRarity': value = pullsToRarity(box, t.rarity, q); break;
      case 'priceToRarity': value = pullsToRarity(box, t.rarity, q) * box.price; break;
      case 'payerConversion': value = conversion(t.day); break;
      case 'arpdau': {
        const from = t.fromDay ?? 0, to = Math.min(t.toDay ?? D - 1, D - 1);
        const g = m.rev.slice(from, to + 1).reduce((s, x) => s + x, 0), u = m.dau.slice(from, to + 1).reduce((s, x) => s + x, 0);
        value = u ? g / u : null;
        break;
      }
      case 'offerRevenueShare': value = gross ? (m.revBy[t.offer] ?? 0) / gross : 0; break;
    }
    const [lo, hi] = t.between ?? [t.min ?? -Infinity, t.max ?? Infinity];
    return { id: t.id, check: t.check, value, min: lo, max: hi, pass: value != null && value >= lo && value <= hi };
  });

  return {
    engine: VERSION, game: cfg.game?.name ?? null, platform: plat, days: D,
    players: cfg.sim.installsPerDay ? cfg.sim.installsPerDay * D : m.nPlayers, runs: m.runs,
    targets, retention, progression, economy, lootboxes, revenue,
  };
}
