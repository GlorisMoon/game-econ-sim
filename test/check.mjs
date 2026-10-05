// Smallest checks that fail if the math or the plumbing breaks. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rng } from '../src/random.mjs';
import { pull, disclosure, pullsToRarity } from '../src/odds.mjs';
import { validate } from '../src/validate.mjs';
import { simulate } from '../src/sim.mjs';

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

console.log('ok');
