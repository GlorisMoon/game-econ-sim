#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { validate } from './validate.mjs';
import { simulate, platformOf, VERSION } from './sim.mjs';
import { disclosure } from './odds.mjs';
import { verify, parseTable, renderReport } from './verify.mjs';

const USAGE = `game-econ-sim ${VERSION}
usage: game-econ-sim <game.econ.json> [--runs N] [--players N] [--seed N] [--json report.json] [--odds]
       game-econ-sim verify <game.econ.json> [--logs pulls.csv] [--disclosed table.csv]
                     [--report report.md] [--json out.json] [--lang en|ko] [--alpha 0.05] [--digits 3]
  --odds   print the lootbox odds disclosure only (no simulation)
  verify   check a disclosed odds table and server pull logs against the config (see VERIFY.md)
exit: 0 pass · 1 invalid input · 2 a target or a box failed`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: 'string' }, players: { type: 'string' }, seed: { type: 'string' },
    json: { type: 'string' }, odds: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    logs: { type: 'string' }, disclosed: { type: 'string' }, report: { type: 'string' },
    lang: { type: 'string' }, alpha: { type: 'string' }, digits: { type: 'string' },
  },
});
const verifying = positionals[0] === 'verify';
if (verifying) positionals.shift();
if (o.help || positionals.length !== 1) {
  console.log(USAGE);
  process.exit(o.help ? 0 : 1);
}

const cfg = JSON.parse(readFileSync(positionals[0], 'utf8'));
const errors = validate(cfg);
if (errors.length) {
  console.error(`invalid config (${errors.length}):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}

const plat = platformOf(cfg);
const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const num = (x, d = 0) => (x == null ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: d }));
const big = (x) => (Math.abs(x) >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : Math.abs(x) >= 1e4 ? `${(x / 1e3).toFixed(1)}k` : num(x));
const pad = (s, n) => String(s).padEnd(n);

if (verifying) {
  const read = (path) => readFileSync(path, 'utf8');
  const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
  const files = [{ role: 'config', name: basename(positionals[0]), sha: sha(read(positionals[0])) }];
  let logs = null, disclosed = null;
  try {
    if (o.logs) { const x = read(o.logs); logs = parseTable(x); files.push({ role: 'logsF', name: basename(o.logs), sha: sha(x) }); }
    if (o.disclosed) { const x = read(o.disclosed); disclosed = parseTable(x); files.push({ role: 'disclosedF', name: basename(o.disclosed), sha: sha(x) }); }
  } catch (e) {
    console.error(`cannot read input: ${e.message}`);
    process.exit(1);
  }
  const alpha = o.alpha ? +o.alpha : 0.05, digits = o.digits ? +o.digits : 3, lang = o.lang === 'ko' ? 'ko' : 'en';
  if (!(alpha > 0 && alpha < 1) || !(digits >= 0 && digits <= 6)) { console.error('--alpha must be in (0,1), --digits in 0..6'); process.exit(1); }
  const res = verify(cfg, { logs, disclosed, alpha });
  const meta = { game: cfg.game?.name, files, generated: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', version: VERSION, unit: plat.unit, digits, boxes: cfg.lootboxes ?? [] };
  const md = renderReport(res, meta, lang);
  if (o.report) writeFileSync(o.report, md);
  if (o.json) writeFileSync(o.json, JSON.stringify({ ...res, meta }, null, 2));
  console.log(`game-econ-sim ${VERSION} verify — ${cfg.game?.name ?? positionals[0]}`);
  for (const b of res.boxes) {
    console.log(`  ${pad(b.id, 14)}${pad(b.verdict.toUpperCase(), 9)}${b.log ? `${num(b.log.pulls)} pulls` : 'no logs'}`);
    for (const r of b.reasons) console.log(`      ${r.severity === 'fail' ? '✗' : '!'} ${r.code}${r.items ? `: ${r.items.join(', ')}` : r.n != null ? `: ${r.n}` : ''}`);
  }
  if (Object.keys(res.unknownBoxes).length) console.log(`  logs for boxes not in config: ${Object.keys(res.unknownBoxes).join(', ')}`);
  if (o.report) console.log(`\nreport: ${o.report}`);
  process.exit(res.boxes.some((b) => b.verdict === 'fail') ? 2 : 0);
}


function printOdds(b, odds) {
  const priced = b.price != null;
  const cost = priced ? `${num(b.price)} ${plat.unit}` : Object.entries(b.cost).map(([c, v]) => `${num(typeof v === 'number' ? v : v.base)} ${c}`).join(' + ');
  const kind = cfg.currencies.find((c) => b.cost && c.id === Object.keys(b.cost)[0])?.kind;
  const flag = priced ? '  PAID RANDOM ITEM: odds must be disclosed' : kind === 'hard' ? '  bought with a purchasable currency: check disclosure rules' : '';
  console.log(`  ${b.id} · ${cost}${flag}`);
  for (const r of odds.rows) console.log(`    ${pad(r.grant, 16)}${pad(r.rarity, 11)}base ${pad(pct(r.base, 3), 9)}effective ${pct(r.effective, 3)}`);
  if (odds.pity) console.log(`    pity: ${odds.pity.rarity} guaranteed by pull ${odds.pity.hard} · expected pulls ${odds.pity.expectedPulls.toFixed(1)} · ${pct(odds.pity.reachHardRate)} of cycles reach the hard pity`);
}

if (o.odds) {
  console.log(`odds disclosure at base luck (pity applied) — ${cfg.game?.name ?? positionals[0]}`);
  for (const b of cfg.lootboxes ?? []) printOdds(b, disclosure(b));
  process.exit(0);
}

const opt = { runs: o.runs && +o.runs, players: o.players && +o.players, seed: o.seed && +o.seed };
const rep = simulate(cfg, Object.fromEntries(Object.entries(opt).filter(([, v]) => v)));
if (o.json) writeFileSync(o.json, JSON.stringify(rep, null, 2));

console.log(`game-econ-sim ${VERSION} — ${rep.game ?? positionals[0]}`);
console.log(`${rep.days} days · ${num(rep.players)} players · ${rep.runs} runs · ${plat.id} (${plat.unit}, platform fee ${pct(plat.fee, 0)})`);

const passed = rep.targets.filter((t) => t.pass).length;
if (rep.targets.length) {
  console.log(`\nTARGETS  ${passed}/${rep.targets.length} pass`);
  for (const t of rep.targets) {
    const bound = t.min > -Infinity && t.max < Infinity ? `in [${num(t.min, 3)}, ${num(t.max, 3)}]` : t.max < Infinity ? `max ${num(t.max, 3)}` : `min ${num(t.min, 3)}`;
    const v = t.value == null ? 'not reached' : num(t.value, 3);
    console.log(`  ${t.pass ? '✓' : '✗'} ${pad(t.id, 18)}${pad(t.check, 20)}${pad(v, 14)}${bound}`);
  }
}

const ret = (r) => Object.entries(r).map(([k, v]) => `${k.toUpperCase()} ${pct(v)}`).join(' ');
console.log(`\nRETENTION  assumed ${ret(rep.retention.assumed)} · simulated ${ret(rep.retention.simulated)}`);

console.log('\nPROGRESSION  days since join, p50 / p90 (reach = share of installs)');
for (const pr of rep.progression) {
  const cells = Object.entries(pr.segments).map(([s, v]) => (v.reach ? `${s} ${v.p50.toFixed(1)}/${v.p90.toFixed(1)} (${pct(v.reach, 0)})` : `${s} —`));
  console.log(`  ${pad(pr.id, 16)}${cells.join(' · ')}`);
}

console.log('\nECONOMY  per run');
for (const [cur, e] of Object.entries(rep.economy)) {
  const g = (rep.economy[cur].walletMedian ?? []).map((v) => big(v));
  console.log(`  ${pad(cur, 8)}source ${big(e.source)} · sink ${big(e.sink)} · sink/source ${e.coverage == null ? '—' : e.coverage.toFixed(2)} · median wallet d0 ${g[0]} → d${g.length - 1} ${g.at(-1)}`);
  const top = (dir) => e.flows.filter((f) => f.flow === dir).slice(0, 4).map((f) => `${f.itemSku} ${pct(f.amount / (dir === 'Source' ? e.source : e.sink), 0)}`).join(', ');
  if (e.source) console.log(`  ${pad('', 8)}sources: ${top('Source')}`);
  if (e.sink) console.log(`  ${pad('', 8)}sinks:   ${top('Sink')}`);
}

if (cfg.lootboxes?.length) {
  console.log('\nLOOTBOXES  odds at base luck, pity applied');
  for (const b of cfg.lootboxes) printOdds(b, rep.lootboxes[b.id].odds);
}

const rv = rep.revenue;
console.log(`\nREVENUE  gross ${num(rv.gross)} ${rv.unit} · net ${num(rv.net)} after ${pct(rv.fee, 0)} fee · ARPDAU ${num(rv.arpdau, 2)} · ARPPU ${num(rv.arppu)} · payer conversion ${Object.entries(rv.conversion).map(([k, v]) => `${k} ${pct(v)}`).join(' ')}`);
if (rv.byOffer.length) console.log(`  ${rv.byOffer.map((x) => `${x.id} ${pct(x.share, 0)}`).join(' · ')}`);
if (o.json) console.log(`\nfull report: ${o.json}`);

process.exit(passed === rep.targets.length ? 0 : 2);
