// Rejects configs the simulator cannot run. Returns a list of messages (empty = ok).

const TT = new Set(['IAP', 'Shop', 'Gameplay', 'ContextualPurchase', 'TimedReward', 'Onboarding']);
const ACTIVITY = new Set(['repeatable', 'cooldown', 'daily', 'offline']);
const ITEM = new Set(['unlock', 'upgrade', 'consumable', 'exchange']);
const OFFER = new Set(['permanent', 'consumable', 'gamePass', 'devProduct']);
const CHECKS = {
  daysToOwn: ['item'], daysToRebirth: ['count'], walletGrowthPerDay: ['currency'], sinkCoverage: ['currency'],
  pullsToRarity: ['lootbox', 'rarity'], priceToRarity: ['lootbox', 'rarity'], payerConversion: ['day'],
  arpdau: [], offerRevenueShare: ['offer'],
};
const BLOCKS = ['currencies', 'stats', 'activities', 'items', 'lootboxes', 'collectibles', 'offers', 'segments', 'events', 'targets'];

export function validate(cfg) {
  const err = [];
  const bad = (m) => err.push(m);
  if (!String(cfg.schema ?? '').startsWith('econ-sim/0.')) bad('schema must be "econ-sim/0.x"');
  for (const b of ['sim', 'currencies', 'stats', 'activities', 'segments']) if (!cfg[b]) bad(`missing block: ${b}`);
  if (err.length) return err;

  const kind = {};
  for (const b of BLOCKS)
    for (const x of cfg[b] ?? []) {
      if (!x.id) bad(`${b}: entry without id`);
      else if (kind[x.id]) bad(`duplicate id: ${x.id}`);
      else kind[x.id] = b;
    }
  const box = (id) => (cfg.lootboxes ?? []).find((b) => b.id === id);
  const ref = (id, where, ...blocks) => {
    if (!blocks.includes(kind[id])) bad(`${where}: unknown ${blocks.join('/')} id "${id}"`);
  };
  const amount = (a, where) => {
    const ok = typeof a === 'number' ? a >= 0 : !!a?.dist;
    if (!ok) bad(`${where}: amount must be a number or {dist: ...}, got ${JSON.stringify(a)}`);
  };
  const cost = (c, where) => {
    for (const [k, v] of Object.entries(c ?? {})) {
      ref(k, `${where}.cost`, 'currencies');
      if (!(typeof v === 'number' ? v >= 0 : !!v?.curve)) bad(`${where}: cost must be a number or {curve: ...}`);
    }
  };
  const grants = (g, where) => {
    for (const [k, v] of Object.entries(g ?? {})) {
      if (k === 'collectible') ref(v, where, 'collectibles');
      else { ref(k, where, 'currencies'); amount(v, where); }
    }
  };
  const effects = (es, where) => {
    for (const e of es ?? []) {
      ref(e.stat, where, 'stats');
      if ((e.add == null) === (e.mul == null)) bad(`${where}: effect needs exactly one of add / mul`);
    }
  };
  const common = (x, where) => {
    for (const id of [].concat(x.unlock?.owns ?? [])) ref(id, `${where}.unlock`, 'items', 'collectibles', 'offers');
    if (x.during) ref(x.during, `${where}.during`, 'events');
    const tt = x.analytics?.transactionType;
    if (tt && !TT.has(tt)) bad(`${where}: transactionType must be one of ${[...TT].join(', ')}`);
  };

  const D = cfg.sim.days;
  if (!(D > 0)) bad('sim.days must be > 0');
  if (!(cfg.sim.players > 0) && !(cfg.sim.installsPerDay > 0)) bad('sim needs players or installsPerDay');

  for (const a of cfg.activities) {
    const w = `activity ${a.id}`;
    common(a, w);
    if (!ACTIVITY.has(a.kind)) bad(`${w}: kind must be ${[...ACTIVITY].join(' | ')}`);
    if (a.kind === 'repeatable' && !(a.minutes > 0)) bad(`${w}: repeatable needs minutes > 0`);
    if (a.kind === 'cooldown' && !(a.cooldownMinutes > 0)) bad(`${w}: cooldown needs cooldownMinutes > 0`);
    if (a.kind === 'offline' && !(a.capHours > 0)) bad(`${w}: offline needs capHours > 0`);
    for (const r of [...(a.rewards ?? []), ...(a.rewardsByDay ?? []).flat()]) {
      if (r.xp != null) {
        amount(r.xp, w);
        if (!cfg.progression) bad(`${w}: xp reward needs a progression block`);
        continue;
      }
      ref(r.currency, w, 'currencies');
      amount(r.amount, w);
      for (const s of r.scaledBy ?? []) ref(s, w, 'stats');
    }
  }
  for (const it of cfg.items ?? []) {
    const w = `item ${it.id}`;
    common(it, w);
    if (!ITEM.has(it.kind)) bad(`${w}: kind must be ${[...ITEM].join(' | ')}`);
    if (it.kind === 'upgrade' && !(it.maxLevel > 0)) bad(`${w}: upgrade needs maxLevel > 0`);
    if (it.kind === 'consumable' && (it.effects ?? []).some((e) => !(e.durationMinutes > 0)))
      bad(`${w}: consumable effects need durationMinutes`);
    cost(it.cost, w);
    grants(it.grants, w);
    effects(it.effects, w);
  }
  for (const b of cfg.lootboxes ?? []) {
    const w = `lootbox ${b.id}`;
    common(b, w);
    if ((b.cost == null) === (b.price == null)) bad(`${w}: needs exactly one of cost (in-game) or price (real money)`);
    if (b.cost && Object.keys(b.cost).length !== 1) bad(`${w}: cost must use one currency`);
    cost(b.cost, w);
    if (!b.pool?.length) bad(`${w}: empty pool`);
    for (const e of b.pool ?? []) {
      if (!(e.weight > 0)) bad(`${w}: weights must be > 0`);
      grants(e.grant, w);
    }
    const rarities = new Set((b.pool ?? []).map((e) => e.rarity));
    if (b.pity) {
      if (!rarities.has(b.pity.rarity)) bad(`${w}: pity rarity "${b.pity.rarity}" is not in the pool`);
      if (!(b.pity.hard >= 1)) bad(`${w}: pity.hard must be >= 1`);
      if (b.pity.soft && !(b.pity.hard >= b.pity.soft.from)) bad(`${w}: pity.hard must be >= pity.soft.from`);
    }
    if (b.luck) ref(b.luck.stat, `${w}.luck`, 'stats');
  }
  for (const c of cfg.collectibles ?? []) effects(c.effects, `collectible ${c.id}`);
  const col = cfg.collection;
  if (col) {
    if (col.equipLimitStat) ref(col.equipLimitStat, 'collection', 'stats');
    if (col.equipBy) ref(col.equipBy, 'collection', 'stats');
    if (col.duplicates && col.duplicates !== 'keep') grants(col.duplicates.convertTo, 'collection.duplicates');
  }
  if (cfg.rebirth) {
    common(cfg.rebirth, 'rebirth');
    cost(cfg.rebirth.cost, 'rebirth');
    for (const id of cfg.rebirth.resets ?? []) ref(id, 'rebirth.resets', 'currencies', 'items');
    effects(cfg.rebirth.effects, 'rebirth');
  }
  for (const o of cfg.offers ?? []) {
    const w = `offer ${o.id}`;
    common(o, w);
    if (!OFFER.has(o.type)) bad(`${w}: type must be ${[...OFFER].join(' | ')}`);
    if (!(o.price > 0)) bad(`${w}: price must be > 0`);
    grants(o.grants, w);
    effects(o.effects, w);
  }

  const share = cfg.segments.reduce((s, x) => s + (x.share ?? 0), 0);
  if (Math.abs(share - 1) > 1e-3) bad(`segments: shares sum to ${share}, must be 1`);
  for (const s of cfg.segments) {
    const w = `segment ${s.id}`, r = s.retention ?? {};
    if (!(1 >= r.d1 && r.d1 >= r.d7 && r.d7 >= r.d30 && r.d30 > 0)) bad(`${w}: retention needs 1 >= d1 >= d7 >= d30 > 0`);
    amount(s.sessionsPerDay, w);
    amount(s.sessionMinutes, w);
    for (const id of s.spend?.priority ?? []) {
      ref(id, `${w}.priority`, 'offers', 'lootboxes');
      if (kind[id] === 'lootboxes' && box(id).price == null) bad(`${w}.priority: lootbox ${id} has no price`);
    }
    for (const id of s.policy?.consumables ?? []) {
      ref(id, `${w}.consumables`, 'items');
      if (kind[id] === 'items' && cfg.items.find((i) => i.id === id).kind !== 'consumable') bad(`${w}.consumables: ${id} is not a consumable`);
    }
  }
  for (const e of cfg.events ?? []) {
    if (!(e.startDay >= 0 && e.startDay < e.endDay && e.endDay <= D)) bad(`event ${e.id}: needs 0 <= startDay < endDay <= sim.days`);
    for (const c of e.expires ?? []) ref(c, `event ${e.id}.expires`, 'currencies');
  }
  for (const t of cfg.targets ?? []) {
    const w = `target ${t.id}`, need = CHECKS[t.check];
    if (!need) { bad(`${w}: unknown check "${t.check}" (${Object.keys(CHECKS).join(', ')})`); continue; }
    for (const f of need) if (t[f] == null) bad(`${w}: ${t.check} needs ${f}`);
    if (t.between == null && t.min == null && t.max == null) bad(`${w}: needs between, min or max`);
    const refs = { item: ['items', 'collectibles', 'offers'], lootbox: ['lootboxes'], offer: ['offers', 'lootboxes'], currency: ['currencies'], segment: ['segments'] };
    for (const [f, blocks] of Object.entries(refs)) if (t[f] != null) ref(t[f], w, ...blocks);
    if (t.rarity && box(t.lootbox) && !box(t.lootbox).pool.some((e) => e.rarity === t.rarity)) bad(`${w}: rarity ${t.rarity} is not in ${t.lootbox}`);
    if (t.check === 'priceToRarity' && box(t.lootbox) && box(t.lootbox).price == null) bad(`${w}: ${t.lootbox} has no price`);
  }
  return err;
}
