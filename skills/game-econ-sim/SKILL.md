---
name: game-econ-sim
description: Simulate a free-to-play game economy locally (Roblox, mobile, web) and verify lootbox odds. Use when the user wants to balance currencies, sources and sinks, upgrade or rebirth curves, gacha / egg / loot box odds and pity, Robux or IAP offers, or check progression speed, inflation, payer conversion and ARPDAU against design targets — or needs to check a published odds table or server pull logs against the configured probabilities (odds disclosure / 확률 공개 검증), or a pity-aware odds table to publish. Writes or edits a `*.econ.json` file and runs the bundled engine.
---

# game-econ-sim

The engine and the format live in this plugin. From this skill's base directory:

- format: `../../INPUT_SPEC.md` (Korean) — read it before writing a config
- odds verification: `../../VERIFY.md` (Korean) — log and table formats, tests, verdict rules
- example: `../../examples/pet_sim.econ.json` — copy its shape
- engine: `node ../../src/cli.mjs <file.econ.json>` (Node 18.17+; no install, no network)

## Workflow

1. **Get the design into one `*.econ.json`.**
   - Roblox: if the Roblox Studio MCP is connected, pull the game's config ModuleScripts with `execute_luau`
     (`return game:GetService("HttpService"):JSONEncode(require(path.to.Config))`) and map them onto the format.
     Do not hand-parse Luau.
   - Otherwise ask for the tables (prices, rewards, drop weights, pity, offers) or read them from the user's files.
   - Retention, session length and spending are assumptions. Say which numbers you assumed.
2. **Validate and run**: `node <base>/../../src/cli.mjs game.econ.json --json report.json`.
   Exit 1 = invalid config (fix the listed errors), 2 = some target failed (that is a finding, not an error).
   `--odds` prints only the lootbox odds disclosure. `--runs`, `--players`, `--seed` override `sim`.
3. **Report back**: failed targets first, each with the number that caused it (for example "gems: sink/source 0.44 —
   duplicates convert to gems and are 38% of the source"). Then propose the smallest config change that would fix it,
   change it, and rerun to show the effect.

## Odds verification

`node <base>/../../src/cli.mjs verify game.econ.json --logs pulls.csv --disclosed table.csv --report report.md [--lang ko]`

- Logs: one row per pull, `player,box,item,time` (+ optional `pity` = counter before the pull, `luck`). JSONL works too.
  Player ids must be pseudonymised before they reach you; never ask for raw account ids.
- If the logs start after players had already pulled, ask for the `pity` column — otherwise the rebuilt counter is wrong.
- Read the report to the user verdict first: FAIL reasons (pity violations with examples, rejected items with observed vs expected),
  then WARN, then the minimum detectable difference so they know what "pass" can and cannot rule out.
- Section 4 of the report is a publishable odds table; say which column (base or effective) they currently show.

## Rules

- Every assumption is a number in the file, not prose. Keep `seed` fixed while comparing changes.
- The odds disclosure is computed exactly at base luck. Tell the user it reflects the config, not the live game:
  they must check that the game code uses the same weights and pity, and that disclosure rules apply to them
  (store policies, Roblox paid random items, and local law such as Korea's probability disclosure duty). Not legal advice.
- `analytics.itemSku` values should match what the game logs (Roblox `AnalyticsService:LogEconomyEvent`).
  If the Studio MCP is available, `script_grep` for `LogEconomyEvent` and point out mismatches.
