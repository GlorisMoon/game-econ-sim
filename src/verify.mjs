// Odds disclosure verification: disclosed table vs config, server pull logs vs config, publishable table.
// Pure functions: the CLI reads files and passes their text. Design: VERIFY.md
import { weightsAt, disclosure } from './odds.mjs';
import { normalQuantile, chiSquareSf, twoSidedP } from './stats.mjs';

const ALIASES = {
  player: ['player', 'player_id', 'user', 'user_id', 'uid'],
  box: ['box', 'lootbox', 'banner', 'gacha', 'egg'],
  item: ['item', 'result', 'reward', 'grant'],
  rarity: ['rarity', 'grade', 'tier'],
  time: ['time', 'timestamp', 'ts', 'created_at'],
  pity: ['pity', 'pity_count', 'counter'],
  luck: ['luck'],
  probability: ['probability', 'prob', 'rate', 'odds', 'chance'],
};

// CSV (header row, quoted fields), JSON array, or JSONL.
export function parseTable(text) {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return [];
  if (t[0] === '[') return JSON.parse(t);
  if (t[0] === '{') return t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cells = (line) => {
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const head = cells(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(cells(l).map((v, i) => [head[i], v])));
}

function fields(rows) {
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  const map = {};
  for (const [f, names] of Object.entries(ALIASES)) map[f] = [...keys].find((k) => names.includes(k.toLowerCase()));
  return (row, f) => (map[f] == null ? undefined : row[map[f]]);
}

const blank = (v) => v == null || v === '';
const SEVERITY = {
  pity_violation: 'fail', unknown_item: 'fail', item_rejected: 'fail', gof_rejected: 'fail',
  disclosure_mismatch: 'fail', disclosure_missing_item: 'fail', disclosure_extra_item: 'fail',
  disclosure_sum: 'fail', disclosure_absent: 'fail',
  disclosure_base: 'warn', luck_not_logged: 'warn', low_power: 'warn', pity_curve: 'warn',
};

// Names a log or table row may use for a pool entry: collectible id or the disclosure label.
function nameIndex(box, rows) {
  const ix = new Map();
  box.pool.forEach((e, i) => {
    for (const n of [e.grant.collectible, rows[i].grant]) if (n != null && !ix.has(String(n).toLowerCase())) ix.set(String(n).toLowerCase(), i);
  });
  return ix;
}

// "4", "4%", "0.04" → { value (fraction or raw), percent: bool|null, tol (in the same unit as value) }
function readProb(v) {
  const s = String(v).trim(), percent = s.endsWith('%') ? true : null;
  const num = s.replace('%', '').trim();
  const dec = num.includes('.') ? num.split('.')[1].length : 0;
  return { value: Number(num), percent, tol: 0.5 * 10 ** -dec };
}

function checkDisclosure(box, odds, rows) {
  const names = nameIndex(box, odds.rows), reasons = [], lines = [];
  const probs = rows.map((r) => readProb(r.probability));
  const sum = probs.reduce((s, p) => s + p.value, 0);
  const asPercent = probs.some((p) => p.percent) || sum > 1.5;
  const found = new Array(box.pool.length).fill(null), extra = [];
  rows.forEach((r, k) => {
    const i = names.get(String(r.item).toLowerCase());
    const p = probs[k], scale = asPercent ? 100 : 1;
    const value = p.value / scale, tol = p.tol / scale + 1e-12;
    if (i == null) extra.push(r.item);
    else found[i] = { shown: String(r.probability), value, tol };
  });
  let allEff = true, allBase = true, bad = [];
  odds.rows.forEach((o, i) => {
    const f = found[i];
    if (!f) { lines.push({ item: o.grant, rarity: o.rarity, base: o.base, effective: o.effective, shown: null, match: 'missing' }); allEff = allBase = false; return; }
    const eff = Math.abs(f.value - o.effective) <= f.tol, base = Math.abs(f.value - o.base) <= f.tol;
    allEff &&= eff;
    allBase &&= base;
    if (!eff && !base) bad.push(o.grant);
    lines.push({ item: o.grant, rarity: o.rarity, base: o.base, effective: o.effective, shown: f.shown, value: f.value, match: eff && base ? 'both' : eff ? 'effective' : base ? 'base' : 'none' });
  });
  const missing = lines.filter((l) => l.match === 'missing').map((l) => l.item);
  if (missing.length) reasons.push({ code: 'disclosure_missing_item', items: missing });
  if (extra.length) reasons.push({ code: 'disclosure_extra_item', items: extra });
  if (bad.length) reasons.push({ code: 'disclosure_mismatch', items: bad });
  const tolSum = found.reduce((s, f) => s + (f?.tol ?? 0), 0);
  const total = found.reduce((s, f) => s + (f?.value ?? 0), 0);
  if (!missing.length && Math.abs(total - 1) > tolSum) reasons.push({ code: 'disclosure_sum', sum: total });
  if (!bad.length && !missing.length && !allEff && box.pity) reasons.push({ code: 'disclosure_base' });
  return { lines, sum: total, reasons };
}

function checkLogs(box, odds, rows, get, alpha) {
  const reasons = [], quality = { rows: rows.length, unknownItems: 0, unknownExamples: [], duplicates: 0, timeReversals: 0 };
  const itemMode = rows.some((r) => !blank(get(r, 'item')));
  const names = nameIndex(box, odds.rows);
  // cells: pool entries (item mode) or rarities (rarity-only logs)
  const rarities = [...new Set(box.pool.map((e) => e.rarity))];
  const cells = itemMode
    ? odds.rows.map((o, i) => ({ name: o.grant, rarity: o.rarity, members: [i] }))
    : rarities.map((ra) => ({ name: ra, rarity: ra, members: box.pool.flatMap((e, i) => (e.rarity === ra ? [i] : [])) }));
  const cellOf = (r) => {
    if (itemMode) {
      const i = names.get(String(get(r, 'item')).toLowerCase());
      return i == null ? -1 : i;
    }
    return rarities.indexOf(String(get(r, 'rarity')));
  };
  for (const c of cells) Object.assign(c, { O: 0, E: 0, V: 0 });

  const pity = box.pity;
  const soft = pity?.soft?.from;
  const buckets = !pity ? [] : [
    { from: 1, to: (soft ?? pity.hard) - 1 },
    ...(soft ? [{ from: soft, to: pity.hard - 1 }] : []),
    { from: pity.hard, to: pity.hard },
  ].filter((b) => b.from <= b.to).map((b) => ({ ...b, n: 0, hits: 0, E: 0, V: 0 }));
  const violations = { n: 0, examples: [] };
  const luckLogged = rows.some((r) => !blank(get(r, 'luck')));
  const pityLogged = rows.some((r) => !blank(get(r, 'pity')));
  if (box.luck && !luckLogged) reasons.push({ code: 'luck_not_logged' });

  const byPlayer = new Map();
  rows.forEach((r, idx) => {
    const p = String(get(r, 'player'));
    if (!byPlayer.has(p)) byPlayer.set(p, []);
    byPlayer.get(p).push({ r, idx, t: blank(get(r, 'time')) ? NaN : Number.isFinite(+get(r, 'time')) ? +get(r, 'time') : Date.parse(get(r, 'time')) });
  });
  let n = 0;
  for (const [player, list] of byPlayer) {
    for (let k = 1; k < list.length; k++) if (list[k].t < list[k - 1].t) quality.timeReversals++;
    const seen = new Set();
    for (const x of list) {
      const key = `${x.t}|${get(x.r, 'item') ?? get(x.r, 'rarity')}`;
      if (!Number.isNaN(x.t) && seen.has(key)) quality.duplicates++;
      seen.add(key);
    }
    list.sort((a, b) => (Number.isNaN(a.t) || Number.isNaN(b.t) ? a.idx - b.idx : a.t - b.t || a.idx - b.idx));
    let counter = 0, pulls = 0, broken = false;
    for (const { r } of list) {
      pulls++;
      if (pityLogged && !blank(get(r, 'pity'))) counter = +get(r, 'pity');
      const luck = luckLogged && !blank(get(r, 'luck')) ? +get(r, 'luck') : 1;
      const w = weightsAt(box, counter + 1, luck), W = w.reduce((s, v) => s + v, 0);
      const c = cellOf(r);
      const rarity = c < 0 ? null : cells[c].rarity;
      if (c < 0) {
        quality.unknownItems++;
        if (quality.unknownExamples.length < 5) quality.unknownExamples.push(String(get(r, 'item') ?? get(r, 'rarity')));
      } else {
        n++;
        for (const cell of cells) {
          const pr = cell.members.reduce((s, i) => s + w[i], 0) / W;
          cell.E += pr;
          cell.V += pr * (1 - pr);
        }
        cells[c].O++;
      }
      if (pity) {
        const k = counter + 1, pr = box.pool.reduce((s, e, i) => s + (e.rarity === pity.rarity ? w[i] : 0), 0) / W;
        const hit = rarity === pity.rarity;
        const b = buckets.find((bk) => k >= bk.from && k <= bk.to);
        if (b && c >= 0) { b.n++; b.hits += hit; b.E += pr; b.V += pr * (1 - pr); }
        // one violation per pity cycle: the guaranteed pull was missed (later pulls in the same cycle are the same failure)
        if (k >= pity.hard && !hit && c >= 0 && !broken) {
          broken = true;
          if (violations.n++ < 5) violations.examples.push({ player, pull: pulls, counter: k });
        }
        if (hit) broken = false;
        counter = hit ? 0 : k;
      }
    }
  }

  if (quality.unknownItems) reasons.push({ code: 'unknown_item', n: quality.unknownItems, items: quality.unknownExamples });
  if (violations.n) reasons.push({ code: 'pity_violation', n: violations.n, examples: violations.examples });

  const m = cells.length, aItem = alpha / m;
  const zCrit = normalQuantile(1 - aItem / 2), z80 = normalQuantile(0.8);
  for (const c of cells) {
    c.rate = n ? c.O / n : 0;
    c.expRate = n ? c.E / n : 0;
    c.z = c.V > 0 ? (c.O - c.E) / Math.sqrt(c.V) : c.O === c.E ? 0 : Infinity;
    c.p = c.V > 0 ? twoSidedP(c.z) : c.O === c.E ? 1 : 0;
    c.ci = n ? [c.rate - (1.96 * Math.sqrt(c.V)) / n, c.rate + (1.96 * Math.sqrt(c.V)) / n] : [0, 0];
    c.mde = n ? ((zCrit + z80) * Math.sqrt(c.V)) / n : null;
    c.rejected = n > 0 && c.p < aItem;
  }
  const rejected = cells.filter((c) => c.rejected).map((c) => c.name);
  if (rejected.length) reasons.push({ code: 'item_rejected', items: rejected });

  // χ² over cells, pooling those with E < 5
  const big = cells.filter((c) => c.E >= 5), small = cells.filter((c) => c.E < 5);
  const gofCells = [...big.map((c) => [c.O, c.E]), ...(small.length ? [[small.reduce((s, c) => s + c.O, 0), small.reduce((s, c) => s + c.E, 0)]] : [])].filter(([, E]) => E > 0);
  const chi2 = gofCells.reduce((s, [O, E]) => s + (O - E) ** 2 / E, 0), df = gofCells.length - 1;
  const gof = { chi2, df, p: df > 0 ? chiSquareSf(chi2, df) : null };
  if (gof.p != null && gof.p < alpha) reasons.push({ code: 'gof_rejected', p: gof.p });

  const rarest = cells.filter((c) => c.expRate > 0).sort((a, b) => a.expRate - b.expRate)[0];
  if (n && rarest && rarest.mde > 0.5 * rarest.expRate) reasons.push({ code: 'low_power', item: rarest.name, mde: rarest.mde, rate: rarest.expRate });

  for (const b of buckets) {
    b.rate = b.n ? b.hits / b.n : null;
    b.expRate = b.n ? b.E / b.n : null;
    b.z = b.V > 0 ? (b.hits - b.E) / Math.sqrt(b.V) : 0;
    b.p = b.V > 0 ? twoSidedP(b.z) : 1;
  }
  const curve = buckets.filter((b) => b.V > 0 && b.p < alpha / Math.max(1, buckets.length));
  if (curve.length) reasons.push({ code: 'pity_curve', buckets: curve.map((b) => [b.from, b.to]) });

  return {
    mode: itemMode ? 'item' : 'rarity', pulls: n, players: byPlayer.size, cells, gof, alphaItem: aItem,
    pity: pity ? { rarity: pity.rarity, hard: pity.hard, soft, violations: violations.n, examples: violations.examples, buckets, counterFrom: pityLogged ? 'logged' : 'rebuilt' } : null,
    luck: box.luck ? (luckLogged ? 'logged' : 'assumed-1') : null,
    quality, reasons,
  };
}

export function verify(cfg, { logs = null, disclosed = null, alpha = 0.05 } = {}) {
  const boxes = cfg.lootboxes ?? [];
  const ids = new Set(boxes.map((b) => b.id));
  const lget = logs?.length ? fields(logs) : null;
  const dget = disclosed?.length ? fields(disclosed) : null;
  const unknownBoxes = {};
  if (lget) for (const r of logs) { const b = String(lget(r, 'box')); if (!ids.has(b)) unknownBoxes[b] = (unknownBoxes[b] ?? 0) + 1; }

  const out = boxes.map((box) => {
    const odds = disclosure(box);
    const paid = box.price != null || (box.cost && cfg.currencies?.find((c) => c.id === Object.keys(box.cost)[0])?.kind === 'hard');
    const res = { id: box.id, price: box.price ?? null, cost: box.cost ?? null, paid: !!paid, odds, reasons: [] };
    if (dget) {
      const rows = disclosed.filter((r) => String(dget(r, 'box')) === box.id).map((r) => ({ item: dget(r, 'item'), probability: dget(r, 'probability') }));
      if (rows.length) {
        res.disclosure = checkDisclosure(box, odds, rows);
        res.reasons.push(...res.disclosure.reasons);
      } else if (box.price != null) res.reasons.push({ code: 'disclosure_absent' });
    }
    if (lget) {
      const rows = logs.filter((r) => String(lget(r, 'box')) === box.id);
      if (rows.length) {
        res.log = checkLogs(box, odds, rows, lget, alpha);
        res.reasons.push(...res.log.reasons);
      }
    }
    for (const r of res.reasons) r.severity = SEVERITY[r.code];
    res.verdict = res.reasons.some((r) => r.severity === 'fail') ? 'fail'
      : res.reasons.some((r) => r.severity === 'warn') ? 'warn'
      : lget && !res.log ? 'nologs' : 'pass';
    return res;
  });
  return { alpha, boxes: out, unknownBoxes, logRows: logs?.length ?? 0, disclosedRows: disclosed?.length ?? 0 };
}

// ---------- report ----------

const L = {
  title: ['확률 공개 검증 리포트', 'Odds disclosure verification report'],
  game: ['게임', 'Game'], inputs: ['입력', 'Inputs'], generated: ['생성', 'Generated'], engine: ['엔진', 'Engine'],
  alpha: ['유의수준', 'Significance'], bonf: ['항목별 검정은 본페로니 보정', 'item tests Bonferroni-corrected'],
  config: ['설정', 'config'], logsF: ['뽑기 로그', 'pull logs'], disclosedF: ['공개표', 'disclosed table'],
  summary: ['요약', 'Summary'], box: ['뽑기', 'Box'], paidCol: ['유료', 'Paid'], pullsCol: ['뽑기 수', 'Pulls'],
  verdictCol: ['판정', 'Verdict'], reasonsCol: ['사유', 'Reasons'],
  pass: ['통과', 'PASS'], warn: ['경고', 'WARN'], fail: ['실패', 'FAIL'], nologs: ['로그 없음', 'NO LOGS'],
  s1: ['1. 공개표와 설정 대조', '1. Disclosed table vs config'],
  item: ['항목', 'Item'], rarity: ['등급', 'Rarity'], shown: ['공개', 'Disclosed'], base: ['설정 기본', 'Config base'],
  eff: ['설정 실효(천장 반영)', 'Config effective (pity)'], match: ['일치', 'Matches'],
  mEff: ['실효 확률', 'effective'], mBase: ['기본 확률', 'base'], mBoth: ['기본·실효 모두(표시 자릿수 안)', 'base and effective (within display precision)'], mNone: ['불일치', 'neither'], mMissing: ['공개표에 없음', 'missing'],
  sumLine: ['공개 합계', 'Disclosed total'], noDisclosed: ['공개표에 이 뽑기가 없습니다.', 'This box is not in the disclosed table.'],
  s2: ['2. 로그와 설정 대조', '2. Pull logs vs config'],
  pullsLine: ['뽑기', 'pulls'], playersLine: ['플레이어', 'players'],
  obs: ['관측', 'Observed'], exp: ['기대', 'Expected'], obsRate: ['관측률', 'Obs. rate'], expRate: ['기대율', 'Exp. rate'],
  ci: ['95% 구간', '95% CI'], mde: ['검출 가능 최소 차이', 'Min. detectable diff.'], flag: ['판정', 'Flag'],
  gof: ['적합도 검정', 'Goodness of fit'], df: ['자유도', 'df'],
  pityH: ['천장 점검', 'Pity check'], violations: ['위반', 'violations'],
  bucket: ['직전 천장 이후 몇 번째 뽑기', 'Pull number since last'], n: ['횟수', 'n'],
  assume: ['적용한 가정', 'Assumptions'],
  aRebuilt: ['천장 카운터는 로그 순서로 다시 셌고, 각 플레이어의 첫 기록을 0으로 봤습니다. 로그 시작 전 뽑기 이력이 있으면 pity 열을 넣어야 합니다.', 'The pity counter was rebuilt from log order, starting each player at 0. If players pulled before the log starts, add a pity column.'],
  aLogged: ['천장 카운터는 로그의 pity 열을 썼습니다.', 'The pity counter comes from the log\'s pity column.'],
  aLuck1: ['운(luck)이 로그에 없어 1로 계산했습니다.', 'Luck is not logged; computed at luck 1.'],
  aLuckLogged: ['운(luck)은 로그 값을 썼습니다.', 'Luck comes from the log.'],
  aRarity: ['로그에 항목이 없어 등급 단위로 검정했습니다.', 'The log has no item column; tested by rarity.'],
  s3: ['3. 데이터 품질', '3. Data quality'],
  qRows: ['로그 행', 'Log rows'], qUsed: ['검정에 쓴 행', 'Rows used'], qUnknownBox: ['설정에 없는 뽑기', 'Boxes not in config'],
  qUnknownItem: ['설정에 없는 항목', 'Results not in config'], qDup: ['같은 시각·같은 결과 중복 의심', 'Same time and result (possible duplicates)'],
  qRev: ['시간 역순', 'Time going backwards'],
  s4: ['4. 공개용 확률표 (설정 기준)', '4. Publishable odds table (from config)'],
  prob: ['확률', 'Probability'], effCol: ['실효 확률(천장 반영)', 'Effective (with pity)'],
  s5: ['이 리포트가 하지 않는 것', 'What this report does not do'],
  limits: [[
    '로그가 진짜인지, 빠짐없는지는 확인하지 않습니다. 받은 로그 안에서만 판단합니다.',
    '통계적으로 벗어나지 않았다는 것은 같다는 증명이 아닙니다. 검출 가능 최소 차이를 함께 읽으세요.',
    '강화·합성처럼 이전 상태에 따라 바뀌는 확률과 기간 한정 확률 상승은 다루지 않습니다.',
    '법률 자문이 아닙니다. 어떤 공개 의무(국내 게임산업법, 앱 마켓 정책, 로블록스 유료 랜덤 아이템 규정 등)가 적용되는지와 표기 위치·형식은 직접 확인하세요.',
  ], [
    'It does not check that the logs are genuine or complete; it judges only the logs it was given.',
    'Not rejecting a difference does not prove the rates are equal. Read the minimum detectable difference alongside.',
    'Probabilities that depend on earlier state (enhancement, fusion) and limited-time rate-ups are not covered.',
    'This is not legal advice. Which disclosure duties apply to you (local law, app store policies, Roblox paid random items) and where and how to display them is yours to check.',
  ]],
};

function reasonText(r, ko) {
  const list = (xs) => xs.join(', ');
  const pct = (x) => `${(x * 100).toFixed(3)}%`;
  const T = {
    pity_violation: [`천장 위반 ${r.n}회 — 확정 차례에 천장 등급이 나오지 않은 천장 주기 수`, `${r.n} pity violations — pity cycles where the guaranteed pull did not give the pity rarity`],
    unknown_item: [`설정에 없는 결과 ${r.n}건 (${list(r.items ?? [])})`, `${r.n} results not in config (${list(r.items ?? [])})`],
    item_rejected: [`설정 확률에서 벗어남: ${list(r.items ?? [])}`, `Rates differ from config: ${list(r.items ?? [])}`],
    gof_rejected: [`적합도 검정 기각 (p = ${r.p?.toPrecision(2)})`, `Goodness of fit rejected (p = ${r.p?.toPrecision(2)})`],
    disclosure_mismatch: [`공개 확률이 설정과 다름: ${list(r.items ?? [])}`, `Disclosed rates differ from config: ${list(r.items ?? [])}`],
    disclosure_missing_item: [`공개표에 빠진 항목: ${list(r.items ?? [])}`, `Missing from the disclosed table: ${list(r.items ?? [])}`],
    disclosure_extra_item: [`설정에 없는 공개 항목: ${list(r.items ?? [])}`, `Disclosed items not in config: ${list(r.items ?? [])}`],
    disclosure_sum: [`공개 합계가 100%가 아님 (${pct(r.sum ?? 0)})`, `Disclosed total is not 100% (${pct(r.sum ?? 0)})`],
    disclosure_absent: ['유료 뽑기인데 공개표에 없음', 'Paid box missing from the disclosed table'],
    disclosure_base: ['공개표가 천장 미반영 기본 확률 — 천장 조건을 함께 표기했는지 확인', 'Disclosed table shows base rates — make sure the pity terms are stated too'],
    luck_not_logged: ['설정에 운(luck)이 있는데 로그에 없음 — 운 1로 계산', 'Config uses luck but the log does not — computed at luck 1'],
    low_power: [`데이터 부족: ${r.item}의 검출 가능 최소 차이 ${pct(r.mde ?? 0)}p가 기대율 ${pct(r.rate ?? 0)}의 절반 이상`, `Too little data: minimum detectable difference for ${r.item} is ${pct(r.mde ?? 0)}pt, over half its ${pct(r.rate ?? 0)} rate`],
    pity_curve: [`천장 구간 출현률이 기대와 다름: ${(r.buckets ?? []).map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', ')}번째`, `Pity-rarity rate differs in pulls ${(r.buckets ?? []).map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', ')}`],
  };
  return T[r.code][ko ? 0 : 1];
}

export function renderReport(res, meta, lang = 'en') {
  const ko = lang === 'ko', t = (k) => L[k][ko ? 0 : 1];
  const pct = (x, d = 3) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
  const num = (x, d = 0) => (x == null ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
  const pv = (p) => (p == null ? '—' : p < 1e-6 ? '< 0.000001' : p.toPrecision(2));
  const verdict = (v) => `**${t(v)}**`;
  const priceOf = (b) => (b.price != null ? `${num(b.price)} ${meta.unit}` : b.paid ? ko ? '유료 통화' : 'paid currency' : '—');
  const out = [];
  out.push(`# ${t('title')}`, '');
  out.push(`- ${t('game')}: ${meta.game ?? '—'}`);
  out.push(`- ${t('inputs')}: ${meta.files.map((f) => `${t(f.role)} \`${f.name}\` (sha256 ${f.sha})`).join(' · ')}`);
  out.push(`- ${t('generated')}: ${meta.generated} · ${t('engine')}: game-econ-sim ${meta.version}`);
  out.push(`- ${t('alpha')}: α = ${res.alpha} (${t('bonf')})`, '');

  out.push(`## ${t('summary')}`, '', `| ${t('box')} | ${t('paidCol')} | ${t('pullsCol')} | ${t('verdictCol')} | ${t('reasonsCol')} |`, '|---|---|---|---|---|');
  for (const b of res.boxes) out.push(`| ${b.id} | ${priceOf(b)} | ${b.log ? num(b.log.pulls) : '—'} | ${verdict(b.verdict)} | ${b.reasons.map((r) => reasonText(r, ko)).join('<br>') || '—'} |`);
  out.push('');

  if (res.disclosedRows) {
    out.push(`## ${t('s1')}`, '');
    for (const b of res.boxes) {
      out.push(`### ${b.id}`, '');
      if (!b.disclosure) { out.push(t('noDisclosed'), ''); continue; }
      out.push(`| ${t('item')} | ${t('rarity')} | ${t('shown')} | ${t('base')} | ${t('eff')} | ${t('match')} |`, '|---|---|---:|---:|---:|---|');
      for (const l of b.disclosure.lines) {
        const m = { effective: t('mEff'), base: t('mBase'), both: t('mBoth'), none: `**${t('mNone')}**`, missing: `**${t('mMissing')}**` }[l.match];
        out.push(`| ${l.item} | ${l.rarity} | ${l.shown ?? '—'} | ${pct(l.base)} | ${pct(l.effective)} | ${m} |`);
      }
      out.push('', `${t('sumLine')}: ${pct(b.disclosure.sum)}`, '');
    }
  }

  if (res.logRows) {
    out.push(`## ${t('s2')}`, '');
    for (const b of res.boxes) {
      if (!b.log) continue;
      const g = b.log;
      out.push(`### ${b.id}`, '', `${num(g.pulls)} ${t('pullsLine')} · ${num(g.players)} ${t('playersLine')}`, '');
      out.push(`| ${t('item')} | ${t('rarity')} | ${t('obs')} | ${t('exp')} | ${t('obsRate')} | ${t('expRate')} | ${t('ci')} | z | p | ${t('mde')} | ${t('flag')} |`, '|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|');
      for (const c of g.cells) out.push(`| ${c.name} | ${c.rarity} | ${num(c.O)} | ${num(c.E, 1)} | ${pct(c.rate)} | ${pct(c.expRate)} | ${pct(c.ci[0])} – ${pct(c.ci[1])} | ${Number.isFinite(c.z) ? c.z.toFixed(2) : '∞'} | ${pv(c.p)} | ${pct(c.mde)}p | ${c.rejected ? `**${t('fail')}**` : '—'} |`);
      out.push('', `${t('gof')}: χ² = ${g.gof.chi2.toFixed(2)}, ${t('df')} ${g.gof.df}, p = ${pv(g.gof.p)} · ${ko ? '항목별 기준' : 'per-item threshold'} p < ${g.alphaItem.toPrecision(2)}`, '');
      if (g.pity) {
        out.push(`**${t('pityH')}** — ${g.pity.rarity}, ${ko ? `${g.pity.hard}번째 확정` : `guaranteed by pull ${g.pity.hard}`} · ${t('violations')} ${num(g.pity.violations)}`);
        if (g.pity.examples.length) out.push('', ...g.pity.examples.map((e) => `- ${ko ? '플레이어' : 'player'} \`${e.player}\` · ${ko ? `${e.pull}번째 기록, 천장 ${e.counter}번째 뽑기` : `record ${e.pull}, pity pull ${e.counter}`}`));
        out.push('', `| ${t('bucket')} ${g.pity.rarity} | ${t('n')} | ${t('obsRate')} | ${t('expRate')} | z |`, '|---|---:|---:|---:|---:|');
        for (const k of g.pity.buckets) out.push(`| ${k.from === k.to ? k.from : `${k.from}–${k.to}`} | ${num(k.n)} | ${pct(k.rate)} | ${pct(k.expRate)} | ${k.V > 0 ? k.z.toFixed(2) : '—'} |`);
        out.push('');
      }
      const notes = [g.mode === 'rarity' ? t('aRarity') : null, g.pity ? t(g.pity.counterFrom === 'logged' ? 'aLogged' : 'aRebuilt') : null, g.luck ? t(g.luck === 'logged' ? 'aLuckLogged' : 'aLuck1') : null].filter(Boolean);
      if (notes.length) out.push(`${t('assume')}:`, '', ...notes.map((x) => `- ${x}`), '');
    }

    out.push(`## ${t('s3')}`, '', `| | ${ko ? '값' : 'Value'} |`, '|---|---:|');
    const used = res.boxes.reduce((s, b) => s + (b.log?.pulls ?? 0), 0);
    const sumQ = (k) => res.boxes.reduce((s, b) => s + (b.log?.quality[k] ?? 0), 0);
    const ub = Object.entries(res.unknownBoxes);
    out.push(`| ${t('qRows')} | ${num(res.logRows)} |`, `| ${t('qUsed')} | ${num(used)} |`,
      `| ${t('qUnknownBox')} | ${ub.length ? ub.map(([k, v]) => `${k} (${v})`).join(', ') : 0} |`,
      `| ${t('qUnknownItem')} | ${num(sumQ('unknownItems'))} |`, `| ${t('qDup')} | ${num(sumQ('duplicates'))} |`, `| ${t('qRev')} | ${num(sumQ('timeReversals'))} |`, '');
  }

  out.push(`## ${t('s4')}`, '');
  for (const b of res.boxes) {
    out.push(`### ${b.id} · ${priceOf(b)}`, '', `| ${t('item')} | ${t('rarity')} | ${t('prob')} |${b.odds.pity ? ` ${t('effCol')} |` : ''}`, `|---|---|---:|${b.odds.pity ? '---:|' : ''}`);
    for (const r of b.odds.rows) out.push(`| ${r.grant} | ${r.rarity} | ${pct(r.base, meta.digits)} |${b.odds.pity ? ` ${pct(r.effective, meta.digits)} |` : ''}`);
    const total = b.odds.rows.reduce((s, r) => s + Number((r.base * 100).toFixed(meta.digits)), 0);
    out.push('', ko ? `표시 합계 ${total.toFixed(meta.digits)}% (소수 ${meta.digits}자리 반올림)` : `Displayed total ${total.toFixed(meta.digits)}% (rounded to ${meta.digits} decimals)`);
    const p = b.odds.pity, box = meta.boxes.find((x) => x.id === b.id);
    if (p) {
      out.push('', ko
        ? `천장: ${p.hard}번째 뽑기까지 ${p.rarity} 등급이 나오지 않으면 ${p.hard}번째에 ${p.rarity} 등급이 확정됩니다.${box.pity.soft ? ` ${box.pity.soft.from}번째 뽑기부터는 ${p.rarity} 등급 확률이 매번 올라갑니다.` : ''} 천장을 반영한 장기 평균 확률은 '실효 확률' 열이며, ${p.rarity} 등급을 얻기까지 평균 ${p.expectedPulls.toFixed(1)}회가 걸립니다.`
        : `Pity: if no ${p.rarity} appears in ${p.hard - 1} pulls, pull ${p.hard} is guaranteed ${p.rarity}.${box.pity.soft ? ` From pull ${box.pity.soft.from} the ${p.rarity} rate rises with each pull.` : ''} The long-run rates including pity are in the Effective column; a ${p.rarity} takes ${p.expectedPulls.toFixed(1)} pulls on average.`);
    }
    if (box.luck) out.push('', ko ? `운(luck) 스탯이 ${box.luck.rarities.join(', ')} 등급의 가중치에 곱해집니다. 위 확률은 운 1 기준입니다.` : `The luck stat multiplies the weight of ${box.luck.rarities.join(', ')}. Rates above are at luck 1.`);
    out.push('');
  }

  out.push(`## ${t('s5')}`, '', ...L.limits[ko ? 0 : 1].map((x) => `- ${x}`), '');
  return out.join('\n');
}
