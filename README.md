# game-econ-sim

Simulate a free-to-play game economy on your own machine before your players do.
Write the economy as one JSON file — currencies, earn and spend loops, upgrades, rebirth, eggs and gacha with pity,
paid offers, player segments — and get back progression times, inflation, sink coverage, revenue,
a pity-aware **odds disclosure table**, and pass/fail on your design targets.

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
run the engine, and explain failed targets with the numbers behind them.

## Odds disclosure

The odds table reflects your config, not your live game. Check that your game code uses the same weights and pity,
and which disclosure rules apply to you (app store policies, Roblox paid random items, local law such as Korea's
probability disclosure duty). This is not legal advice.

## Roadmap

Comparing against live metrics (Roblox Open Cloud Analytics, GA4, GameAnalytics, CSV) · rewarded ads · season pass ·
energy / stamina · LTV and payback · stall-driven churn.

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

형식 문서: [INPUT_SPEC.md](INPUT_SPEC.md). 결과의 확률 공개표는 설정 파일 기준입니다. 실제 게임 코드가 같은 가중치·천장을 쓰는지,
어떤 공개 규정(스토어 정책, 로블록스 유료 랜덤 아이템 규정, 국내 게임산업법의 확률 공개 의무 등)이 적용되는지는 직접 확인하세요.
법률 자문이 아닙니다.

라이선스는 AGPL-3.0입니다. 수정본을 서비스로 운영하면 소스를 공개해야 합니다. AGPL 의무 없는 상용 라이선스는
[@GlorisMoon](https://github.com/GlorisMoon)으로 문의하세요.
