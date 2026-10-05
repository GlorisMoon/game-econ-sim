# 입력 형식 v0.1 (`econ-sim/0.1`)

게임 하나의 경제 설계를 JSON 파일 하나(`*.econ.json`)로 적는다. 엔진은 이 파일로 플레이어 집단을 몬테카를로로 돌리고,
`targets`(설계 의도)를 판정하고, 뽑기 확률 공개표를 정확 계산으로 낸다.
전체 예시: [examples/pet_sim.econ.json](examples/pet_sim.econ.json) (로블록스 펫 수집 시뮬레이터형 게임)
같은 파일로 공개 확률표와 서버 뽑기 로그를 검증하는 방법은 [VERIFY.md](VERIFY.md).

## 원칙

1. **코드 문자열 금지.** 수식은 정해진 곡선·분포 어휘로만 쓴다. 같은 시드면 같은 결과가 나온다.
2. **단위는 이름에 박는다.** 시간은 `Minutes`·`Days`·`Hours`. 실제 돈은 `price`(단위는 `platform`이 정함), 게임 내 통화는 통화 id로 적는다.
3. **참조는 id 문자열.** 통화·스탯·아이템·뽑기·펫·상품·이벤트는 모두 id로 서로를 가리킨다. id는 파일 전체에서 유일하다.
4. **게임 코드와 SKU를 맞춘다.** 각 획득처·소모처의 `analytics.itemSku`는 게임이 경제 이벤트 로그(로블록스 `AnalyticsService:LogEconomyEvent` 등)에 넘기는 문자열과 같아야 나중에 실측과 대조된다.
5. **게임 설정은 파싱하지 않고 뽑는다.** 로블록스라면 Studio 내장 MCP의 `execute_luau`로 설정 ModuleScript를 `require` → `HttpService:JSONEncode` 해서 이 형식으로 옮긴다.

## 최상위 구조

| 블록 | 필수 | 내용 |
|---|---|---|
| `schema` | ● | `"econ-sim/0.1"` |
| `game` | | 이름 등 메타 |
| `platform` | | `roblox`(기본) · `google_play` · `app_store` · `web`, 또는 `{"id", "unit", "fee"}`로 덮어쓰기 |
| `sim` | ● | 기간·인원·반복·시드 |
| `currencies` | ● | 게임 내 통화 |
| `stats` | ● | 배율·운·슬롯 같은 플레이어 수치 (보상·뽑기에 곱해짐) |
| `activities` | ● | 획득처 (플레이 시간을 써서 통화를 얻는 것) |
| `items` | | 소모처 (해금·업그레이드·소모품·교환) |
| `lootboxes` | | 뽑기 (알·상자·가챠) |
| `collectibles`, `collection` | | 뽑기로 얻는 펫·유닛과 장착 규칙 |
| `rebirth` | | 환생(프레스티지) |
| `offers` | | 실제 돈으로 사는 상품 |
| `segments` | ● | 플레이어 유형별 행동·잔존·지출 |
| `events` | | 기간 한정 이벤트 |
| `progression` | | 레벨·경험치 (쓰는 게임만) |
| `targets` | | 설계 의도 판정 |

### platform 기본값

| id | 가격 단위 | 플랫폼 수수료 |
|---|---|---|
| `roblox` | Robux | 30% |
| `google_play` | USD | 15% |
| `app_store` | USD | 15% |
| `web` | USD | 3% (결제대행 수수료 가정) |

수수료는 매출 보고에서 순매출을 낼 때만 쓴다. 실제 조건(스토어 매출 구간, 구독, 지역)에 맞게 `{"id":"app_store","fee":0.3,"unit":"KRW"}`처럼 덮어쓴다.

## 공통 값 타입

### Amount — 숫자 또는 분포

| 형태 | 예 | 뜻 |
|---|---|---|
| 숫자 | `40` | 고정값 |
| `fixed` | `{"dist":"fixed","value":40}` | 고정값 |
| `uniform` | `{"dist":"uniform","min":3,"max":6}` | 균등 |
| `normal` | `{"dist":"normal","mean":40,"sd":8}` | 정규 (0 미만은 0) |
| `lognormal` | `{"dist":"lognormal","median":10,"p90":30}` | 로그정규. 중앙값·상위 10%로 적는다 |
| `poisson` | `{"dist":"poisson","mean":1.2}` | 횟수 |

### Curve — 비용·경험치처럼 "몇 번째인가"가 있는 값

| 형태 | 예 | n번째 값 |
|---|---|---|
| 숫자 | `5000` | 항상 같음 |
| `linear` | `{"curve":"linear","base":100,"step":50}` | base + step·(n−1) |
| `geometric` | `{"curve":"geometric","base":300,"ratio":1.22}` | base·ratio^(n−1) |
| `power` | `{"curve":"power","base":100,"exp":1.5}` | base·n^exp |
| `table` | `{"curve":"table","values":[100,250,500]}` | values[n−1] (넘으면 마지막 값) |

보상(`rewards`, `grants`)은 Amount, 비용(`cost`)과 `xpPerLevel`은 Curve를 쓴다. 비용은 정수로 반올림한다.

### Cost / Grants

```json
"cost":   {"coins": {"curve":"geometric","base":300,"ratio":1.22}}
"grants": {"gems": 300, "collectible": "cat"}
```

### Effect — 스탯 변경

```json
{"stat":"coin_mult","add":0.08}
{"stat":"coin_mult","mul":2,"durationMinutes":60}
```

최종 스탯 = (base + Σadd) × Πmul. 업그레이드 n단계면 add가 n번, 환생 n회면 mul이 n번 적용된다.
`durationMinutes`는 **플레이 시간** 기준이다(접속 안 한 시간은 흐르지 않는다). 없으면 영구.

### Unlock — 모든 조건을 AND

```json
{"owns":"zone_2", "rebirths":1, "level":5, "joinDay":{"min":0,"max":3}}
```

`owns`는 아이템·펫·상품 id(문자열 또는 목록). `joinDay`는 가입 후 며칠째인지(0 = 가입일).

### analytics 태그 — 생략하면 기본값

```json
"analytics": {"transactionType":"Gameplay","itemSku":"farm_z1"}
```

`transactionType`은 로블록스 `Enum.AnalyticsEconomyTransactionType` 값을 쓴다: `IAP`, `Shop`, `Gameplay`, `ContextualPurchase`, `TimedReward`, `Onboarding`.

| 어디에 | 기본 transactionType | 기본 itemSku |
|---|---|---|
| activities: repeatable | `Gameplay` | id |
| activities: cooldown·daily·offline | `TimedReward` | id |
| activities: `onboarding: true` | `Onboarding` | id |
| items, 통화로 사는 lootboxes | `Shop` | id |
| offers, 돈으로 사는 lootboxes | `IAP` (`window`가 있으면 `ContextualPurchase`) | id |

엔진이 자체로 남기는 흐름: 환생 초기화 `rebirth`, 이벤트 통화 소멸 `expired`, 중복 펫 환전 `duplicate` (모두 `Gameplay`).

## 블록별 필드

### sim

| 필드 | 뜻 |
|---|---|
| `days` | 시뮬 기간. 0일 = 가입일 |
| `players` | 가입 집단 인원 (0일에 한꺼번에 가입) |
| `installsPerDay` | 선택. 있으면 `players` 대신 매일 이만큼 새로 들어온다 |
| `runs`, `seed` | 반복 횟수, 난수 시드 |

### currencies

`{id, kind, start, cap?}` — `kind`: `soft`(일반 재화), `hard`(돈으로도 얻는 재화), `event`(이벤트 종료 시 소멸, `events[].expires`에서 지정).
`hard` 통화로 사는 뽑기는 확률 공개표에 "유료로 얻는 통화" 표시가 붙는다.

### stats

`{id, base}` — 배율(`coin_mult`), 운(`luck`), 장착 슬롯 수(`pet_slots`)처럼 효과가 쌓이는 수치.

### activities

| 필드 | 뜻 |
|---|---|
| `kind` | `repeatable`(세션 중 반복) · `cooldown`(N분마다) · `daily`(하루 N회) · `offline`(접속 안 한 동안 누적) |
| `minutes` | 1회 소요 시간 (repeatable 필수, daily 선택) |
| `cooldownMinutes` | cooldown 간격 |
| `limitPerDay` | daily 하루 횟수 (기본 1) |
| `capHours` | offline 최대 누적 시간. offline의 `rewards` amount는 **시간당** 값 |
| `rewards` | `{currency, amount, scaledBy?}` 또는 `{xp}` 목록. `scaledBy` 스탯들이 곱해진다 |
| `rewardsByDay` | daily 연속 출석 보상 (주기 목록, 끝나면 처음부터) |
| `unlock`, `during`, `onboarding`, `analytics` | 공통 |

### items

| `kind` | 뜻 | 추가 필드 |
|---|---|---|
| `unlock` | 1회 구매 해금 (존, 기능) | `effects`는 보유하는 동안 적용 |
| `upgrade` | 단계형 | `maxLevel`, Curve cost |
| `consumable` | 소모품 (부스트) | `effects`에 `durationMinutes` 필수 |
| `exchange` | 이벤트 상점 교환 | `grants`, `limit` |

공통: `cost`, `effects`, `grants`, `limit`, `unlock`, `during`, `analytics`.

### lootboxes

| 필드 | 뜻 |
|---|---|
| `cost` 또는 `price` | 게임 내 통화 가격(통화 하나), 또는 실제 돈 가격. **`price` 뽑기는 유료 랜덤 아이템**으로 표시된다 |
| `pool` | `{grant, weight, rarity}` 목록 |
| `pity` | `{rarity, hard, soft?:{from, addWeightPerPull}}` — hard번째 뽑기에 확정. from번째부터 그 등급 가중치가 매번 `addWeightPerPull`씩 커진다 |
| `luck` | `{stat, rarities}` — 해당 등급 가중치에 스탯값을 곱한다 |
| `unlock`, `during`, `analytics` | 공통 |

### collectibles · collection

- `collectibles`: `{id, rarity, effects}` — 장착해야 효과가 난다.
- `collection`: `{equipLimitStat, equipBy, duplicates}` — 슬롯 스탯만큼, `equipBy` 스탯 기여가 큰 순서로 장착. `duplicates`는 `"keep"`(기본, 같은 펫 여러 마리 장착 가능) 또는 `{"convertTo": Grants}`.

### rebirth

`{cost, resets, effects, unlock?}` — `resets`의 통화는 시작값으로, 아이템은 미보유로 돌린다. `effects`는 환생 1회마다 적용.

### offers

| 필드 | 뜻 |
|---|---|
| `type` | `permanent`(1회, 영구) · `consumable`(반복 구매). 로블록스 별칭 `gamePass`·`devProduct`도 받는다 |
| `price` | 가격 (`platform` 단위) |
| `grants`, `effects` | 지급물·효과 (`durationMinutes`가 있으면 기간제) |
| `limit` | 1인당 구매 한도 |
| `window` | `{fromJoinDay, toJoinDay}` — 가입 후 이 기간에만 노출 |
| `unlock`, `during`, `analytics` | 공통 |

### segments

| 필드 | 뜻 |
|---|---|
| `share` | 집단 비율 (합 = 1) |
| `retention` | `{d1, d7, d30}` — 이 세 점을 지나는 생존 곡선을 맞춘다. 플레이어는 이탈 전까지 매일 접속한다 |
| `sessionsPerDay` | 접속한 날의 세션 수 (최소 1) |
| `sessionMinutes` | 세션 길이 |
| `spend.payerRate` | 결제 성향: 첫 결제일까지 남아 있으면 결제하는 비율. 실제 전환율은 이탈과 겹쳐 출력에 나온다 |
| `spend.firstPurchaseDay` | 첫 결제 시점 분포 (가입 후 일수) |
| `spend.budget` | 결제자 1인의 기간 총예산 (`platform` 단위) |
| `spend.priority` | 예산을 쓰는 순서 (offer·`price` lootbox id) |
| `policy.lootboxShare` | 뽑기 통화 수입 중 뽑기 몫 (기본 0.5) |
| `policy.rebirth` | `"asap"`(기본) · `"never"` · `{"afterDays":2}` |
| `policy.consumables` | 세션 시작마다 살 소모품 id 목록 (같은 효과가 남아 있으면 안 산다) |

### events

`{id, startDay, endDay, expires}` — `startDay`일부터 `endDay`일 **전까지** 열린다. 활동·아이템·뽑기·상품에 `"during":"<이벤트 id>"`를 달면 그 기간에만 열린다. `expires`의 통화는 `endDay`에 0이 된다.

### progression (선택)

`{xpPerLevel: Curve, maxLevel}` — 활동 `rewards`에 `{"xp": Amount}`를 넣고, `unlock.level`로 쓴다.

### targets — 설계 의도

`{id, check, ...조건, between | min | max}`. `percentile`이 없으면 중앙값.

| check | 조건 필드 | 값 |
|---|---|---|
| `daysToOwn` | `item`, `segment?`, `percentile?` | 아이템·펫·상품을 처음 가진 날 (가입 후 일수, 소수) — 도달한 플레이어 기준 |
| `daysToRebirth` | `count`, `segment?`, `percentile?` | n번째 환생까지 일수 — 도달한 플레이어 기준 |
| `walletGrowthPerDay` | `currency`, `fromDay?` | 접속자 지갑 중앙값의 일 증가율 (fromDay → 마지막 날) |
| `sinkCoverage` | `currency` | 소모 ÷ 획득 |
| `pullsToRarity` | `lootbox`, `rarity`, `percentile?` | 해당 등급 첫 획득까지 뽑기 수 (기본 운, 정확 계산) |
| `priceToRarity` | `lootbox`, `rarity`, `percentile?` | 같은 것을 `price`로 |
| `payerConversion` | `day` | 가입 후 day일 안에 결제한 비율 |
| `arpdau` | `fromDay?`, `toDay?` | DAU당 매출 (수수료 전) |
| `offerRevenueShare` | `offer` | 매출 중 해당 상품 비중 |

## 엔진 동작 규칙

플레이어 행동은 단순한 규칙 몇 개로 근사한다. 결과를 읽을 때 이 가정을 같이 본다.

1. **시간**: 하루 = 세션 n번. 세션 시작에 오프라인 보상(직전 세션과 24/n시간 간격으로 가정)·쿨다운 보상·첫 세션의 일일 보상을 받고, 남은 시간은 5분 단위로 반복 활동을 한다.
2. **반복 활동 고르기**: 통화별로 분당 기대 획득이 가장 큰 활동을 고른다(첫 보상 기준). 쓸 곳이 남은 통화가 여럿이면 시간을 고르게 나눈다(이벤트 기간에 이벤트 통화와 코인을 번갈아 모으는 식).
3. **구매** (5분마다 판단):
   - 환생: 비용이 모이면 한다 (`policy.rebirth`).
   - 해금·교환: 살 수 있게 되는 즉시 산다 (싼 것부터).
   - 업그레이드: 비용 대비 스탯 증가율이 큰 것부터 산다. 아직 못 산 해금이 있으면 그 가격의 10% 이하 업그레이드만 산다(해금을 위해 모은다).
   - 뽑기: 뽑기 통화 수입의 `lootboxShare`만큼을 따로 모아, 열린 것 중 가장 비싼 뽑기를 모이는 대로 깐다.
4. **결제**: 결제자는 첫 결제일부터 하루 한 번 `priority`를 훑으며 예산 안에서 산다. 영구 상품은 한 번, 반복 상품·유료 뽑기는 하루에 하나씩.
5. **확률 공개표**는 시뮬이 아니라 정확 계산이다. 천장이 있으면 "천장 주기 동안 각 항목이 나오는 기대 횟수 ÷ 주기 기대 길이"로 실효 확률을 낸다. 기본 운(1) 기준.

## 검증 규칙 (엔진이 거부하는 것)

- id 중복, 없는 id 참조
- `segments[].share` 합 ≠ 1 (±0.001), `retention`이 1 ≥ d1 ≥ d7 ≥ d30 > 0 이 아님
- weight ≤ 0, `pity.hard` < `soft.from`, 천장 등급이 pool에 없음
- lootbox에 `cost`와 `price`가 둘 다 있거나 둘 다 없음
- consumable 효과에 `durationMinutes` 없음
- 이벤트가 0 ≤ startDay < endDay ≤ `sim.days` 밖
- `transactionType`이 6개 값 밖, 모르는 `targets[].check`

## 아직 없는 것 (로드맵)

- **실측 대조**: Open Cloud Analytics(`ForwardD1Retention`, `PayingUsersCVR`, `AverageRevenuePerUser`, `EconomyTransactionAmount`를 `CurrencyType`·`FlowType`·`TransactionType`·`ItemSku`로), GA4·GameAnalytics·CSV 어댑터
- **광고**: 보상형 광고 시청 보상과 광고 매출 (로블록스 보상형 동영상 광고 포함)
- **시즌 패스**: 무료·유료 보상 트랙
- **에너지·스태미나**: 차오르는 통화와 활동별 소모
- **LTV·회수**: 설치당 누적 매출, 유입 단가 대비 회수일
- 진행이 막히면 이탈이 늘어나는 효과, 띄엄띄엄 접속, 플레이어 간 거래
