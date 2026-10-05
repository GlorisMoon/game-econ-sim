# game-econ-sim

Simulate a free-to-play game economy on your own machine before your players do.
Write the economy as one JSON file — currencies, earn and spend loops, upgrades, rebirth, eggs and gacha with pity,
paid offers, player segments — and get back progression times, inflation, sink coverage, revenue,
a pity-aware **odds disclosure table**, and pass/fail on your design targets.

Then **verify the odds you publish**: check your disclosed odds table and your server's pull logs against the config —
statistical tests per item, pity violations, a publishable odds table — in one report.

Roblox first (Robux, game passes, developer products, Roblox analytics names). Mobile and web games use the same format
with a different `platform`.

- Runs locally. Node.js 18.17+, no dependencies, no network, no account.
- Deterministic: same seed, same report — so you can compare balance changes.
- Odds are computed exactly (pity cycle math), not sampled.

[한국어 안내는 아래에 있습니다.](#한국어)

## Quick start

```bash
git clone https://github.com/GlorisMoon/game-econ-sim
cd game-econ-sim
node src/cli.mjs examples/pet_sim.econ.json
```

Your own file, without cloning:

```bash
npx github:GlorisMoon/game-econ-sim my-game.econ.json
```

Options: `--runs N` `--players N` `--seed N` `--json report.json` (full report) `--odds` (odds disclosure only).
Exit code 0 = all targets pass, 1 = invalid config, 2 = a target failed — usable in CI.

## What you get

Trimmed output for the bundled pet-simulator example:

```
TARGETS  8/10 pass
  ✓ zone2_fast        daysToOwn           0.5           in [0.2, 1.5]
  ✓ zone3_week        daysToOwn           4.16          in [3, 7]
  ✗ first_rebirth     daysToRebirth       16.109        in [5, 10]
  ✗ gem_sinks         sinkCoverage        0.445         min 0.6

ECONOMY  per run
  gems    source 2.02M · sink 898.7k · sink/source 0.45 · median wallet d0 70 → d29 445
          sources: duplicate 38%, daily_quests 22%, daily_login 21%, gems_l 18%
          sinks:   slot_upgrade 75%, coin_potion 25%

LOOTBOXES  odds at base luck, pity applied
  egg_robux · 99 Robux  PAID RANDOM ITEM: odds must be disclosed
    fox             epic       base 70.000%  effective 68.786%
    dragon          legendary  base 26.000%  effective 25.549%
    phoenix         mythic     base 4.000%   effective 5.665%
    pity: mythic guaranteed by pull 30 · expected pulls 17.7 · 30.6% of cycles reach the hard pity

REVENUE  gross 262,225 Robux · net 183,557 after 30% fee · ARPDAU 7.14 · ARPPU 1,523 · payer conversion d1 1.1% d7 1.7% d30 1.7%
```

Read it as: grinders reach their first rebirth in ~16 days, not the intended 5–10; gems pile up because duplicate pets
convert into gems faster than anything spends them; the paid egg's mythic rate is 4% on paper but 5.7% once pity is counted.

The report covers retention (assumed vs simulated), days to each unlock / pet / rebirth per segment,
every currency flow by `transactionType` and `itemSku`, median wallets per day, odds and pulls-to-rarity for every box,
revenue by offer, and each target.

## Verify odds disclosure

```bash
node src/cli.mjs verify examples/pet_sim.econ.json \
  --logs examples/pulls_bug.csv --disclosed examples/disclosed.csv --report report.md
```

Three checks, one Markdown report ([sample input](examples/), [design](VERIFY.md)):

1. **Disclosed table vs config** — every item present, totals add up, and whether you show base rates or pity-adjusted
   effective rates (base rates with a pity get a warning to state the pity terms).
2. **Server pull logs vs config** — a pull log (`player,box,item,time`, CSV or JSONL) is replayed with the pity counter,
   so each pull is tested against its own probability: per-item z-tests (Bonferroni), a χ² goodness-of-fit test,
   pity violations (the guaranteed pull that wasn't), the pity-rarity rate by pull number, and the minimum difference
   your data could have detected.
3. **Publishable odds table** — per-item rates, pity-adjusted effective rates, and the pity and luck terms in plain words.

```
game-econ-sim 0.2.0 verify — 펫 수집 시뮬레이터 (예시)
  egg_robux     FAIL     2,000 pulls
      ! disclosure_base
      ! luck_not_logged
      ✗ pity_violation: 25
      ✗ item_rejected: fox, dragon, phoenix
      ✗ gof_rejected
      ! pity_curve
```

The bundled `pulls_bug.csv` comes from a server with two bugs (hard pity at 40 instead of 30, mythic weight 3 instead of 4);
`pulls_ok.csv` from one that follows the config and only gets the two warnings. Measured on synthetic logs at α = 0.05:
a faithful server is flagged about 5% of the time, a broken pity is always caught, and a 4% → 3% weight bug is caught
52% of the time with 2,000 pulls and every time with 10,000.

Report language: `--lang en` (default) or `--lang ko`.

## The format

One `*.econ.json` per game. Spec: [INPUT_SPEC.md](INPUT_SPEC.md) (Korean for now). Example:
[examples/pet_sim.econ.json](examples/pet_sim.econ.json).

| block | what |
|---|---|
| `platform` | `roblox` · `google_play` · `app_store` · `web` (price unit and store fee) |
| `currencies`, `stats` | soft / hard / event currencies; multipliers, luck, slots |
| `activities` | repeatable, cooldown, daily, offline earnings |
| `items` | unlocks, upgrade curves, consumable boosts, event exchanges |
| `lootboxes`, `collectibles` | weighted pools, soft and hard pity, luck, equip slots, duplicates |
| `rebirth`, `offers` | prestige resets; paid permanent / consumable offers |
| `segments` | player types: share, D1/D7/D30, sessions, payer rate, budget, buying policy |
| `events`, `targets` | limited-time events; design intents checked on every run |

## Use it with Claude Code

```
/plugin marketplace add GlorisMoon/game-econ-sim
/plugin install game-econ-sim@game-econ-sim
```

The bundled skill lets Claude write and edit the config, pull Roblox config ModuleScripts through the Roblox Studio MCP,
run the engine, explain failed targets with the numbers behind them, and run the odds verification on your logs.

## Odds disclosure

The odds table reflects your config; `verify` checks your logs against it, but only the logs you give it — it cannot tell
whether they are genuine or complete. Which disclosure rules apply to you (app store policies, Roblox paid random items,
local law such as Korea's probability disclosure duty) and how to display the odds is yours to check. This is not legal advice.

## Data and privacy

game-econ-sim makes no network requests and sends nothing anywhere. It reads only the files you pass on the command line
and writes only the report files you name. Pull logs can identify players: pseudonymise player ids before running `verify`.

## Roadmap

Comparing against live metrics (Roblox Open Cloud Analytics, GA4, GameAnalytics, CSV) · rewarded ads · season pass ·
energy / stamina · LTV and payback · stall-driven churn · verifying enhancement / fusion odds and limited-time rate-ups.

## License

[AGPL-3.0](LICENSE). If you run a modified version as a service, you must publish your source.
For a commercial license without AGPL obligations, contact [@GlorisMoon](https://github.com/GlorisMoon).

---

## 한국어

부분 유료화 게임의 경제를 **내 컴퓨터에서** 미리 돌려 보는 도구입니다. 통화·획득처·소모처·업그레이드·환생·알/가챠(천장 포함)·
유료 상품·플레이어 유형을 JSON 파일 하나에 적으면, 진행 속도·인플레이션·소모 비율·매출·**천장 반영 확률 공개표**와
설계 목표 통과 여부를 돌려줍니다.

- 로블록스 우선(Robux, 게임패스, 개발자 상품, 로블록스 분석 이벤트 이름). 모바일·웹은 `platform`만 바꿔 같은 형식으로.
- Node.js 18.17 이상만 있으면 됩니다. 설치할 패키지·네트워크·계정 없음.
- 같은 시드면 같은 결과라서 밸런스 수정 전후를 비교할 수 있습니다.
- 확률은 표본 추출이 아니라 천장 주기로 정확히 계산합니다.

```bash
git clone https://github.com/GlorisMoon/game-econ-sim
cd game-econ-sim
node src/cli.mjs examples/pet_sim.econ.json
```

**확률 공개 검증 리포트** — 공개 중인 확률표와 서버 뽑기 로그를 설정과 대조해 한 장의 리포트로 냅니다.
공개표 누락·합계·천장 표기, 항목별 통계 검정(본페로니)·적합도 검정·천장 위반·천장 구간별 출현률·검출 가능 최소 차이,
그리고 공개용 확률표(천장 반영 실효 확률과 천장 문구 포함)까지. 설계와 판정 기준은 [VERIFY.md](VERIFY.md).

```bash
node src/cli.mjs verify examples/pet_sim.econ.json \
  --logs examples/pulls_bug.csv --disclosed examples/disclosed.csv --report report.md --lang ko
```

합성 로그로 잰 성능(α = 0.05): 정상 서버를 실패로 잘못 잡는 비율 약 5%, 천장 버그는 항상 검출,
신화 확률 4%→3% 같은 가중치 버그는 2,000회 로그에서 52%, 10,000회에서 100% 검출.

형식 문서: [INPUT_SPEC.md](INPUT_SPEC.md). 결과의 확률 공개표는 설정 파일 기준입니다. 실제 게임 코드가 같은 가중치·천장을 쓰는지,
어떤 공개 규정(스토어 정책, 로블록스 유료 랜덤 아이템 규정, 국내 게임산업법의 확률 공개 의무 등)이 적용되는지는 직접 확인하세요.
법률 자문이 아닙니다.

네트워크 요청을 하지 않고 어디로도 데이터를 보내지 않습니다. 명령에 넘긴 파일만 읽고, 지정한 리포트 파일만 씁니다. 뽑기 로그의 플레이어 식별자는 가명 처리한 뒤 넣으세요.

라이선스는 AGPL-3.0입니다. 수정본을 서비스로 운영하면 소스를 공개해야 합니다. AGPL 의무 없는 상용 라이선스는
[@GlorisMoon](https://github.com/GlorisMoon)으로 문의하세요.
