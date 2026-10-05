// Smallest checks that fail if the math or the plumbing breaks. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rng } from '../src/random.mjs';
import { pull, disclosure, pullsToRarity } from '../src/odds.mjs';
import { validate } from '../src/validate.mjs';
import { simulate } from '../src/sim.mjs';
import { normalCdf, normalQuantile, chiSquareSf } from '../src/stats.mjs';
import { verify, parseTable } from '../src/verify.mjs';
import { pullLog } from '../examples/make-pulls.mjs';

// 1. Exact pity math agrees with brute-force pulls.
const box = {
  id: 'b',
  pool: [
    { grant: { collectible: 'c' }, weight: 90, rarity: 'common' },
    { grant: { collectible: 'r' }, weight: 9, rarity: 'rare' },
    { grant: { collectible: 'l' }, weight: 1, rarity: 'legendary' },
  ],
  pity: { rarity: 'legendary', hard: 60, soft: { from: 40, addWeightPerPull: 3 } },
};
const exact = disclosure(box);
assert.ok(Math.abs(exact.rows.reduce((s, x) => s + x.effective, 0) - 1) < 1e-9);
const r = rng(1), st = { count: 0 }, seen = {};
const N = 400_000;
for (let i = 0; i < N; i++) {
  const e = pull(box, st, 1, r);
  seen[e.rarity] = (seen[e.rarity] ?? 0) + 1;
}
for (const row of exact.rows) assert.ok(Math.abs(seen[row.rarity] / N - row.effective) < 0.002, `${row.rarity} rate`);

const firstHit = (rarity) => {
  const s = { count: 0 };
  for (let n = 1; ; n++) if (pull(box, s, 1, r).rarity === rarity) return n;
};
for (const rarity of ['legendary', 'rare']) {
  const xs = Array.from({ length: 20_000 }, () => firstHit(rarity)).sort((a, b) => a - b);
  assert.ok(Math.abs(xs[10_000] - pullsToRarity(box, rarity, 0.5)) <= 1, `${rarity} median pulls`);
  assert.ok(Math.abs(xs[18_000] - pullsToRarity(box, rarity, 0.9)) <= 2, `${rarity} p90 pulls`);
}

// 2. The example is valid; a broken reference is caught.
const cfg = JSON.parse(readFileSync(new URL('../examples/pet_sim.econ.json', import.meta.url), 'utf8'));
assert.deepEqual(validate(cfg), []);
const broken = structuredClone(cfg);
broken.items[1].unlock = { owns: 'nope' };
assert.ok(validate(broken).some((e) => e.includes('"nope"')));

// 3. Same seed, same report; simulated retention follows the assumption.
const small = { ...cfg, sim: { ...cfg.sim, players: 3000, runs: 2 } };
const a = simulate(small);
assert.deepEqual(a, simulate(small));
assert.ok(Math.abs(a.retention.simulated.d1 - a.retention.assumed.d1) < 0.03, 'D1');
assert.ok(Math.abs(a.retention.simulated.d7 - a.retention.assumed.d7) < 0.03, 'D7');

// 4. Statistics helpers hit textbook values.
assert.ok(Math.abs(normalCdf(1.959964) - 0.975) < 1e-6);
assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 1e-5);
assert.ok(Math.abs(chiSquareSf(3.841459, 1) - 0.05) < 1e-5);
assert.ok(Math.abs(chiSquareSf(5.991465, 2) - 0.05) < 1e-5);
assert.ok(Math.abs(chiSquareSf(18.307038, 10) - 0.05) < 1e-5);

// 5. Verification: faithful server passes the log checks, the buggy one fails, disclosure rules hold.
const ex = (f) => parseTable(readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8'));
const robux = (res) => res.boxes.find((b) => b.id === 'egg_robux');
const good = robux(verify(cfg, { logs: ex('pulls_ok.csv'), disclosed: ex('disclosed.csv') }));
assert.equal(good.verdict, 'warn');
assert.deepEqual(good.reasons.map((r) => r.code).sort(), ['disclosure_base', 'luck_not_logged']);
assert.equal(good.log.pity.violations, 0);
const bad = robux(verify(cfg, { logs: ex('pulls_bug.csv') }));
assert.equal(bad.verdict, 'fail');
assert.ok(bad.log.pity.violations > 0 && bad.reasons.some((r) => r.code === 'item_rejected'));

const egg = cfg.lootboxes.find((b) => b.id === 'egg_robux');
const table = (f) => disclosure(egg).rows.map((r) => ({ box: 'egg_robux', item: r.grant, probability: f(r) }));
assert.deepEqual(robux(verify(cfg, { disclosed: table((r) => `${(r.effective * 100).toFixed(3)}%`) })).disclosure.reasons, []);
assert.ok(robux(verify(cfg, { disclosed: table((r) => (r.rarity === 'mythic' ? '3%' : `${r.base * 100}%`)) })).reasons.some((r) => r.code === 'disclosure_mismatch'));
assert.ok(robux(verify(cfg, { disclosed: [{ box: 'egg_basic', item: 'dog', probability: '70%' }] })).reasons.some((r) => r.code === 'disclosure_absent'));

// False alarms on a faithful server stay near alpha (item tests + goodness of fit).
let falseFails = 0;
for (let seed = 100; seed < 200; seed++) {
  if (robux(verify(cfg, { logs: parseTable(pullLog(egg, seed, 400)) })).verdict === 'fail') falseFails++;
}
assert.ok(falseFails <= 12, `false fail rate ${falseFails}%`);

console.log('ok');
