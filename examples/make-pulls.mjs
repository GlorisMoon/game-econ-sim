// Writes the synthetic pull logs used by the verify example: one server that follows the config,
// one with two bugs (hard pity at 40 instead of 30, mythic weight 3 instead of 4).
// Run: node examples/make-pulls.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { rng } from '../src/random.mjs';
import { pull } from '../src/odds.mjs';

const cfg = JSON.parse(readFileSync(new URL('./pet_sim.econ.json', import.meta.url), 'utf8'));
const box = cfg.lootboxes.find((b) => b.id === 'egg_robux');
const buggy = { ...box, pity: { ...box.pity, hard: 40 }, pool: box.pool.map((e) => (e.rarity === 'mythic' ? { ...e, weight: 3 } : e)) };

export function pullLog(b, seed, rows = 2000) {
  const r = rng(seed), out = ['player,box,item,time'];
  let t = Date.UTC(2026, 8, 1);
  for (let p = 1; out.length <= rows; p++) {
    const state = { count: 0 }, n = 1 + Math.floor(-Math.log(1 - r()) * 25);
    for (let i = 0; i < n && out.length <= rows; i++) {
      t += 1000 + Math.floor(r() * 600_000);
      out.push(`p${String(p).padStart(4, '0')},${box.id},${pull(b, state, 1, r).grant.collectible},${new Date(t).toISOString().slice(0, 19)}Z`);
    }
  }
  return out.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(new URL('./pulls_ok.csv', import.meta.url), pullLog(box, 11));
  writeFileSync(new URL('./pulls_bug.csv', import.meta.url), pullLog(buggy, 11));
  console.log('wrote examples/pulls_ok.csv, examples/pulls_bug.csv');
}
