# opencode-goal-pro-max-complete-plugin

A session-scoped `/goal` workflow for [OpenCode](https://opencode.ai/). Set a goal, and the plugin keeps it in context, auto-continues the session whenever the assistant goes idle, and stops when the goal is marked complete with evidence, a concrete blocker is reported, or a safety limit is reached. State is persisted per session, so a goal survives compaction and a restart; the whole thing runs with no model call of its own.

The name is not a claim about the feature list. It is a claim about the **process**: every behaviour below is pinned by a test, most of the load-bearing ones are pinned by a mutation that must make the suite go red, and the numbers in this README were re-measured by running the commands in the table before it was written. Where a claim rests on one observation, it says so.

## Lineage

This is a fork of **[willytop8/OpenCode-goal-plugin](https://github.com/willytop8/OpenCode-goal-plugin)** (MIT, copyright willytop8 — `LICENSE` is retained unchanged). Upstream history runs through **v0.9.0** (2026-08-29) and includes contributions from [@harryzhou2000](https://github.com/harryzhou2000) (the post-compaction epoch guard, `noInterruptOnUserMessage`, `noContinueWhileChildrenActive`) and others; parts of the compaction and objective-edit design were ported from `prevalentWare/opencode-goal-plugin`.

The fork continued at [sblattj/OpenCode-goal-plugin](https://github.com/sblattj/OpenCode-goal-plugin) through **v0.11.0** — nine commits that bundled the runtime, added the sidebar panel, the verified action plan, and long handoffs, made the package installable from a git spec again, and then rebuilt the budget and brake model from scratch. It is renamed here.

[`CHANGELOG.md`](CHANGELOG.md) is the authoritative record of what was inherited and what was rebuilt, with the reasoning and the measurements behind each change. Read it before trusting anything in this file.

---

## What "pro max complete" means

### The verification ladder

Every row was run against this tree on 2026-09-07 (Node v24.15.0, npm 11.12.1, bun 1.3.14, macOS 26.5.1). `npm run release:check` runs all of them in order, plus a bundle step, and takes about **2.5–3 minutes** on that stack — around nine tenths of it the mutation rung, which re-runs the whole suite once per mutant. (Timed end to end on this tree: 150 s, 151 s, 155 s and 173 s.)

| Rung | Command | What it proves | Measured |
|---|---|---|---|
| Unit suite | `npm test` | Every documented behaviour has an executable specification, across 12 test files | **508 tests, 508 pass, 0 fail** |
| Coverage | `npm run test:coverage` | The suite actually reaches the code it claims to cover | **≈97% line, ≈88.5% branch, ≈94% function** over `src/` — the cross-process lease tests race, so `persistence-lease.js` and the totals move a tenth of a point or so between runs (four runs on this tree spanned 97.02–97.15% line, 88.46–88.67% branch, 93.88–94.06% function) |
| Mutation contract | `npm run test:mutation` | Each safety property's test is *not vacuous*: the mutant reverts exactly that property in a scratch copy of `src/` and the suite must go red | **80/80 critical mutants killed** |
| Behaviour benchmark | `npm run benchmark:behavior` | Six end-to-end autonomy scenarios — verified success, false completion, loop circuit breaker, human interruption, compaction continuity, restart recovery — behave as specified | **6/6 passed, score 100/100, 0 model calls, 0 external requests** |
| Type contract | `npm run type:check` | A TypeScript consumer can compile against the **packed tarball** under both NodeNext and Bundler resolution, including the `./tui` subpath | **passed** (`opencode-goal-pro-max-complete-plugin-0.11.0.tgz`) |
| Command-hook smoke | `npm run smoke` | The package export path and the `/goal` command hook work with no model call | **passed** |
| Installed-host contract | `npm run smoke:packed-host` | The published artifact, installed into a scratch project, satisfies the OpenCode host contract — hooks, exports, consumer resolution | **passed**, ≈330 kB tarball |
| Installed-tool contract | `npm run smoke:packed-tools` | A clean tarball install exposes the whole agent-tool surface with no separate OpenCode helper package | **passed, 14 tools** |
| Packed-manifest contract | `npm run smoke:packed-manifest` | OpenCode's own `packageTargets`/`readV1Plugin` discovery rules, re-implemented against the tarball, find both halves from `exports` — and the `./tui` entry really registers a `sidebar_content` view | **passed**; `server -> ./dist/goal-plugin.js`, `tui -> ./dist/goal-tui.js` |
| Git-install contract | `npm run smoke:git-install` | None of the six manifest script names that make pacote's `GitFetcher` spawn a missing `npmBin` has reappeared, and the committed `dist/` byte-matches a fresh bundle | **passed**; `dist/goal-plugin.js` and `dist/goal-tui.js` match a fresh bun 1.3.14 bundle |
| Hook-surface verify | `npm run verify` | The installed plugin loads, registers all 9 hooks, answers `/goal status` and `/goal set`, and makes zero model calls | **all 7 checks passed** |
| Dependency audit | `npm audit --omit=dev --audit-level=high` | No known high-severity vulnerability in the runtime dependency (`zod` only) | **0 vulnerabilities** |
| Pack check | `npm run pack:check` | The tarball contains what it should and nothing else | **32 files, ≈330 kB packed, 1.4 MB unpacked** — `README.md` ships inside the tarball, so the exact packed byte count moves whenever this file does |

### The process behind 0.11.0

The ladder is the artifact. The process that produced the current defaults is the reason the ladder is worth anything:

- **Three reviewer lenses per change, run independently.** Each change to the budget and brake model was reviewed separately for *budget semantics* (does this number mean what its name says), for *correctness*, and for *"does it still brake"* (can a runaway loop still be stopped). The lenses disagreed with the implementation more than once, and the implementation lost.
- **Every fix proved with a polarity mutant.** A green suite proves nothing about a test that cannot fail. Each fix landed with a test *and* with a mutant that reverts exactly the fixed property, so the claim rests on a red/green pair. Twelve of the 80 mutants in the contract are new in 0.11.0.
- **An independent verifier that ran the shipped bundle, not `src/`.** The final verification pass imported `dist/goal-plugin.js` — the bytes a user installs — rather than the source tree, because a bundler is a loader that can disagree with `node`.
- **Decisions reversed by evidence.** Three of the shipped defaults are the *second* answer:
  - A fixed 200,000-token context guard was replaced by the model's own window read from the host, because the wrap-up *pauses* the goal and a fixed ceiling would have ended healthy runs at a 160,000-token peak on 400k- and 1M-context models ([CHANGELOG 0.11.0](CHANGELOG.md)).
  - The talk-only pause moved from **2** turns to **10**, because judging a goal purely on tool calls is a blunt instrument.
  - `maxTokens` was redefined from *peak context* to *cumulative spend*, after review showed the shipped 100,000,000 could never be reached against a `Math.max` over single-message context sizes — the token brake, the token warning and the token half of the wrap-up handoff were all dead code on a default goal, and every continuation prompt was telling the model it had roughly 500× its real headroom.

### One live-session measurement

The turn-aggregation fix in 0.11.0 rests on a measurement of **one real OpenCode session** (43 turns with assistant replies). An analyzer grouped that session's assistant messages by the user message they answer (`parentID`) and asked, per turn, whether the *last* assistant message carried a tool part — which is what the pre-0.11.0 brakes scored:

- **33 of 43 turns used tools.**
- In **28 of those 33**, the last assistant message was text-only. Under the old single-message check, 28 productive turns out of 33 were charged as "no tool calls" — and a default goal paused after two of them.
- Over the last **40** turns, **10** ended with a message carrying no text part at all, and **3** ended with a message carrying both a tool part and text. That is why a turn's completion marker is now read from its last *text-bearing* step rather than its last message: a `[goal:complete]` written before one final tool call used to be silently discarded.

This is one session, on one host build, with one model. It is enough to prove the old check was wrong — a single counterexample does that — and not enough to establish a distribution. The raw counts and the reasoning are in [`CHANGELOG.md`](CHANGELOG.md) under 0.11.0.

### What this does not prove

Read this section before running anything unattended.

- **The measurement above is one session.** It refutes the old behaviour; it does not characterise your workload.
- **One host line.** `engines.opencode` is `>=1.17.15 <2`. OpenCode 2 is unsupported and untested. Live-host verification exists for specific builds (1.17.15, 1.18.25, 1.18.29) and specific providers, not for the matrix you will actually run — the 1.17.15 provider matrix is in [`docs/providers.md`](docs/providers.md), and the 1.18.25 and 1.18.29 runs are recorded per release in [`CHANGELOG.md`](CHANGELOG.md).
- **The plugin depends on experimental OpenCode hooks, and the host may not call them.** Real OpenCode 1.17.15 and 1.18.10 never invoke `experimental.chat.system.transform`; it is registered as defence in depth, and every command-control protection is deliberately self-contained so correctness does not depend on it.
- **Completion quality is model-dependent.** The evidence gate is structural: it checks that a `[goal:complete]` is preceded by a non-empty `[goal:evidence]` line, not that the evidence is true. The independent completion auditor is **optional and off by default**, and when on it performs static inspection with `read`, `glob`, and `grep` only — it cannot execute a command.
- **`src/goal-tui.js` is not in the coverage report.** The panel's render logic lives in `src/goal-sidebar-view.js` (100% line, 95.29% branch) and is covered; the thin `@opentui/solid` entrypoint is exercised by `smoke:packed-manifest` loading it the way the TUI runtime does, not by the unit suite.
- **The brakes cannot catch useless work.** The no-tool-call and no-progress pauses are skipped for any turn that called a tool. An agent re-running the same failing command with real output every turn trips neither; for that run the binding brakes are the clock, the spend budget, and the context window.
- **No sandbox.** This plugin makes an agent keep working. It adds no restriction on what that agent may do.

---

## Install

A full install is **two entries in two different files**. `opencode.json`'s `plugin` array only ever produces *server* plugins; OpenCode reads *TUI* plugins from a separate `tui.json`. The server half works alone — you get the status line and no panel.

Always write the spec in the **named form** `<package>@<source>`. A bare `github:owner/repo` or a bare tarball URL is accepted by the config and then silently never loads: OpenCode looks the installed package up by the name `npm-package-arg` parses out of the spec, a bare git or tarball spec has none, and the host falls back to the whole spec string as a directory name and throws *after* the files are on disk, with nothing logged.

> **Nothing is published under this name yet.** The first release under `opencode-goal-pro-max-complete-plugin` is pending: no git tag has been cut, and the npm name is **unclaimed, not reserved** — `npm view opencode-goal-pro-max-complete-plugin` answers `E404` today, and npm has no reservation mechanism short of publishing, so anyone could take the name before this project does. Do not trust a future `<pkg>@npm` spec until a release exists to check against. Until then, use the local `file://` form below, or a tag from the [previous repository](https://github.com/sblattj/OpenCode-goal-plugin) with its old package name. Every `<tag>` below — including the ones in [`examples/`](examples/) — is a placeholder that resolves only once a tag exists.

```jsonc
// opencode.json — the server half: commands, tools, hooks, sidebar payload
{
  "plugin": ["opencode-goal-pro-max-complete-plugin@github:sblattj/opencode-goal-pro-max-complete-plugin#<tag>"],
  "command": {
    "goal": {
      "description": "Set a session-scoped goal and auto-continue until complete.",
      "template": "$ARGUMENTS",
      "agent": "build"
    }
  }
}
```

```jsonc
// tui.json, beside it — the TUI half: the sidebar panel
{ "plugin": ["opencode-goal-pro-max-complete-plugin@github:sblattj/opencode-goal-pro-max-complete-plugin#<tag>"] }
```

Or let OpenCode write both entries:

```sh
opencode plugin 'opencode-goal-pro-max-complete-plugin@github:sblattj/opencode-goal-pro-max-complete-plugin#<tag>' --global
```

### Spec forms

Both of these name the package before the source, and both work:

```
opencode-goal-pro-max-complete-plugin@github:sblattj/opencode-goal-pro-max-complete-plugin#<tag>
opencode-goal-pro-max-complete-plugin@https://github.com/sblattj/opencode-goal-pro-max-complete-plugin/archive/refs/tags/<tag>.tar.gz
```

These do **not** work and fail *silently*, for the reason above:

```
github:sblattj/opencode-goal-pro-max-complete-plugin#<tag>
https://github.com/sblattj/opencode-goal-pro-max-complete-plugin/archive/refs/tags/<tag>.tar.gz
```

Pin a tag rather than tracking a branch, so an install is reproducible.

### Local install from a copy

Tooling that vendors its own copy of the package points at the **package directory** as a `file://` URL — no name prefix, because a local path needs no registry lookup:

```jsonc
{ "plugin": ["file:///absolute/path/to/opencode-goal-pro-max-complete-plugin"] }
```

Two rules for that path:

- **Name the package directory, never a file inside it.** OpenCode reads `package.json` from the target file's own directory and does not walk upward, so a config naming `…/dist/goal-plugin.js` can never resolve `exports["./tui"]` and loads the server half only.
- **Keep `:` and `#` out of the path** if you want the panel. The TUI plugin runner splits a module path at the first colon into `namespace:path`, so a copy living under a directory with a colon in its name never reaches the host-module shim that supplies `solid-js`. The server half loads from such a path without complaint, which is what makes the breakage invisible.

The same path goes in `tui.json`. See [`examples/`](examples/) for both files, and [`demo/`](demo/) for a runnable end-to-end demo.

---

## Usage

```
/goal fix the failing tests and verify the suite passes
```

```
/goal ship the release --success "tests pass and changelog updated" --constraints "do not touch the public API" --mode ordered
```

Flags accept `--flag value` or `--flag=value`. A **known** flag missing a value, given a non-positive integer, or (for `--mode`) an unrecognised mode is rejected with a specific error. An **unknown** `--flag` is never a rejection: it is left in the objective text exactly as typed, because it is far more likely to be part of what you are asking for than a typo.

### Flags

Every flag below is a key of `GOAL_FLAG_SPECS` in `src/goal-plugin.js` (17 keys, including aliases).

| Flag | Controls |
|---|---|
| `--max-turns <n>` | Auto-continue turn limit. `0`, `unlimited`, `none`, `inf`, `infinite`, `infinity`, or `∞` (case-insensitive) means no ceiling — which is the default |
| `--max-minutes <n>` | Duration limit, in minutes |
| `--max-duration-ms <n>` | Duration limit, in milliseconds |
| `--max-tokens <n>` | Cumulative token **spend** limit |
| `--budget <n>` | Spend limit shorthand; accepts a `k`/`m` suffix (`100k`, `1.5m`) |
| `--context-window <n>` | Ceiling for **peak context** — a different quantity from spend. Overrides the auto-detected window. Accepts `k`/`m` |
| `--cooldown-ms <n>` | Minimum delay between continues |
| `--no-progress-threshold <n>` | Output-token floor below which a turn counts as stalled |
| `--no-progress-turns <n>` | Consecutive stalled low-output turns before pausing |
| `--no-tool-turns <n>` | Consecutive tool-free continuation turns before pausing |
| `--success <text>` | Success criteria (alias `--success-criteria`); quote multi-word text |
| `--constraints <text>` | Constraints / non-goals (alias `--non-goals`) |
| `--mode <normal\|ordered>` | Prompt mode for one goal; `ordered` preserves step order inside its objective |
| `--objective <text>` | Short label for the title, sidebar, and goal list (alias `--title`); defaults to the objective's first line |

```sh
/goal fix tests --max-turns 20 --max-tokens 400000
/goal fix tests --max-turns unlimited --max-minutes 480
/goal fix tests --budget 5m --context-window 1m
/goal fix tests --no-progress-threshold 50 --no-progress-turns 2
```

### Subcommands

| Command | Effect |
|---|---|
| `/goal` *(bare)* or `/goal status` | Report the focused goal: `Active goal:`, an explicit `State:` line (`active`, `paused`, `blocked`), budget usage, `Token spend:`, `Peak context:`, a `Completion audit:` line, and the plan |
| `/goal <objective>` | Set (replace) the focused goal |
| `/goal add <objective>` | Background the current goal and focus a new one |
| `/goal list` | Numbered live goals plus the per-session archive of achieved goals, each with its state |
| `/goal focus <n>` | Switch the focused goal; survives a restart |
| `/goal sequence a; b; c` | Strict queue: one objective at a time, auto-promoting on completion (alias `sisyphus`) |
| `/goal edit <objective>` | Revise the objective in place, preserving budget and history and clearing pause/blocked state. Deliberately does **not** parse flags — the rest of the line is the new objective, verbatim |
| `/goal history` | Lifecycle history and the latest checkpoint |
| `/goal pause` | Pause without clearing |
| `/goal resume` | Continue with a fresh local budget window |
| `/goal clear` | Clear live goals and saved status (aliases `stop`, `off`, `reset`, `none`, `cancel`) |

Rename the command with the `commandName` option; the user-facing hints follow it.

### Long handoffs

Paste a whole handoff as the goal. The objective is bounded only by the command-argument ceiling (32 KiB), and so are `--success` and `--constraints`. Two rules make that safe:

- **Only the first line is parsed for flags.** Everything after the first newline is body: stored verbatim, never tokenised. `git push --force`, `curl … -s -- --no-opencode`, and a `--max-turns` inside a fenced code block all survive untouched.
- **A `---` line on its own ends the flag region.** Put flags above it when the first line is prose you want kept intact.

The **full text** is injected into every continuation turn. For the compact surfaces — session title, sidebar, `/goal list` — the plugin derives a short **objective label** from the first non-empty line; override it with `--objective`.

### Markers

The plugin stops when it sees one of these at the end of an assistant response:

```
[goal:evidence] ran npm test (508 passing), verified the build output
[goal:complete]
```

```
The deploy step needs a production API token I don't have.
[goal:blocked]
```

- `[goal:complete]` is **only** honoured when the immediately adjacent line begins with `[goal:evidence]` and carries a non-empty summary of what was verified. A stale or non-adjacent evidence marker is rejected. The accepted evidence shows in `/goal status`.
- `[goal:blocked]` is **only** honoured when the line immediately before it states a concrete blocker.
- An unsubstantiated claim is not a stop: the plugin rejects it and re-prompts for the missing evidence or blocker.
- Markers must be on their own final line. The bracketed form is canonical; bare `goal:complete` / `goal:blocked` / `goal:evidence` are also accepted, because some models omit brackets. Natural-language phrases like "goal complete" are intentionally ignored.

A marker is read from the turn's last **text-bearing** step, not its last message — see the measurement above.

### Agent tools

The same workflow is registered as callable model tools (`registerTools: false` to omit them). A clean tarball install exposes **14**, verified by `npm run smoke:packed-tools`:

| Group | Tools |
|---|---|
| Canonical | `goal_status`, `goal_set`, `goal_pause`, `goal_resume`, `goal_block`, `goal_complete` — compact versioned JSON envelopes, so an agent can branch without parsing prose |
| Plan | `goal_plan_set`, `goal_action_update`, `goal_plan_get` |
| Compatibility aliases | `get_goal`, `get_goal_history`, `set_goal`, `update_goal`, `clear_goal` — unchanged text responses |

`goal_set` / `set_goal` are constrained to user-requested goals. `goal_complete` takes a structured claim: a required non-empty `summary`, plus optional criterion/evidence pairs, checks (`passed`/`failed`/`not-run`), changed files, and known limitations; failed checks and empty criterion evidence are rejected before archival. Tools and the command path drive the same per-session multi-goal state.

The plugin's **own** `goal_*` calls do not count as a turn's work — otherwise a model could hold the anti-self-chat brake off forever by calling `goal_plan_set` every turn. A host-namespaced spelling behind a non-alphanumeric separator (`…_goal_status`, `mcp.goal_plan_set`) counts too; `upgoal_set` and `goal_plan_setter` do not.

### Verified action plan (Claim → Evidence → Verdict)

A long handoff is not one action, and "I'm done" is not evidence. The assistant is told to decompose the goal into an ordered list of actions living in the same persisted state:

```json
{ "id": "a3", "title": "rebuild dist", "status": "done",
  "claim": "dist/goal-plugin.js contains the new parser",
  "evidence": "grep -c splitGoalCommandText dist/goal-plugin.js → 3",
  "verdict": "pass" }
```

`status` is `pending`, `in_progress`, `done`, or `blocked`; `verdict` is `pass`, `fail`, or `null`.

| Tool | Purpose |
|---|---|
| `goal_plan_set(actions)` | Record or revise the plan. Re-planning preserves claim, evidence, and verdict already recorded against an action id, so a re-submit cannot launder a verified action back to unverified |
| `goal_action_update(id, status, claim?, evidence?, verdict?)` | Move one action. `done` is refused without a claim, evidence, and `verdict: "pass"`; `blocked` is refused without a stated reason |
| `goal_plan_get()` | Read the plan and its progress |

The plan and its rule are injected compactly into every auto-continue turn:

> **CEV rule:** Claim → the minimum Evidence sufficient to prove or break it → Verdict (pass/fail). Evidence is an observation the world produced (command output, file content, HTTP response), never the work's own report of itself. Evidence that cannot fail proves nothing.

**The completion gate consults the plan.** Once a plan exists, a goal can only complete when every action is `done` with a passing verdict *or* `blocked` with a stated reason. Both paths are gated — the `[goal:complete]` marker and the `goal_complete` / `update_goal` tools — and a refusal names the outstanding actions. A goal with no plan completes the old way, so the plan stays opt-in for short goals and existing automation.

---

## Budget and brakes

These are the 0.11.0 defaults, every one of them a field of `DEFAULT_OPTIONS` in `src/goal-plugin.js`.

| Limit | Default | Rendered |
|---|---|---|
| Auto-continue turns | unlimited (`maxTurns: 0`) | `3/∞` |
| Max duration | 8 hours (`28800000` ms) | `2m/8h` |
| Token spend | 100,000,000 cumulative tokens | `147k/100m` |
| Context window | the model's own window, learned from the host; **no ceiling** if the host cannot say | `147k/200k ctx`, or the stat is dropped |
| Min delay between continues | 1,500 ms | — |
| No-progress pause | 2 consecutive stalled turns under 50 output tokens | — |
| Talk-only pause | 10 consecutive tool-free continuation turns | — |
| Wrap-up threshold | 80% of spend, context, or clock — whichever arrives first (6.4 h of 8 h) | — |
| Auto-continue failure pause | 3 consecutive prompt failures | — |

**Unlimited is `0`, not `Infinity`.** These options round-trip through persisted JSON, and `JSON.stringify(Infinity)` is the literal `null` — an unlimited goal written as `Infinity` would reload indistinguishable from a missing field and be handed a bounded default.

**What actually brakes a default run.** With unlimited turns and an 8-hour clock, neither the turn counter nor (usually) the spend budget is the brake. Two cheaper pauses come first: the **talk-only pause** (ten consecutive tool-free continuation turns) and the **no-progress pause** (two consecutive stalled turns under 50 output tokens). Both judge the **whole turn** and both are **skipped for any turn that calls a tool anywhere in it**. So they catch a loop that has stopped *doing* anything, and they do **not** catch a loop that keeps working uselessly. For that run the binding brakes are the 8-hour window, the 100,000,000-token spend budget, and the model's own context window.

**Wrap-up pauses the goal, so 80% is the real ceiling.** At `budgetWrapupRatio` of whichever of the three reachable budgets arrives first, the plugin sends one handoff prompt asking for a summary of what is done, what remains, and the next concrete step — and pauses. `/goal resume` restarts the spend and peak-context counters from zero. The 100% stop reasons (`max tokens reached`, `context window reached`, `max duration reached`) fire only when one turn crosses from below 80% straight past 100%.

**The token budget is cumulative SPEND.** Every token the goal was billed for, summed over every message it produced:

```
spend = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
```

Cache reads are in the sum because they are billed. The counter only grows, is deduplicated per message (a streaming update adds only its delta; a message billed before a restart is not billed again), and survives a restart because it lives in the persisted `usage` record. **Delegated work counts**: a child session has no goal of its own, so its tokens are charged up the `parentID` chain to the nearest ancestor session that holds one — nothing else about a child is inherited, including its context.

**Context pressure is a separate guard on a separate number.** Peak context is the largest single-message `input + output + reasoning + cache` the goal has seen — the count OpenCode displays. It is bounded by the model and reset by a compaction, so it can never stand in for spend. `contextWindowTokens` defaults to `0` = **auto-detect**: the plugin reads `client.config.providers()` once and takes `models[<the goal's model>].limit.context`. An explicit value or `--context-window` always wins and skips the lookup. Every failure path — no `config` API, a throwing catalog, an unknown model, a model with no declared window — yields **no context ceiling at all**: `/goal status` shows `Peak context: 147,000/∞`, the continuation prompt says `context_remaining: unlimited`, and the sidebar drops the `ctx` stat rather than rendering a budget of zero. That is deliberate, because the wrap-up *pauses* — a guessed 200,000 would have ended healthy runs at a 160,000-token peak on 400k- and 1M-context models, below where the host itself compacts.

The continuation prompt reports both, as `tokens_remaining` and `context_remaining`.

**Judgement is per turn, not per message.** OpenCode writes a new assistant message for every LLM step of one prompt, so an ordinary working turn is several messages sharing one `parentID`: the steps that ran tools, then a separate text-only closing summary. The plugin groups every assistant message answering the same prompt (falling back to the trailing run of assistant messages on hosts that do not report a parent, and stopping at a compaction summary) and asks the question of the group: a tool call — or a subtask delegation — **anywhere** in the turn resets the counter. A turn the visibility window sliced in half charges nothing in either direction and is recorded as a `warning` in the goal's history.

---

## Options reference

Pass options when registering the plugin to change the defaults for all goals.

```json
{
  "plugin": [
    [
      "opencode-goal-pro-max-complete-plugin",
      {
        "maxTurns": 0,
        "maxDurationMs": 28800000,
        "maxTokens": 100000000,
        "contextWindowTokens": 0,
        "minDelayMs": 1500,
        "maxRecentMessages": 200,
        "noProgressTokenThreshold": 50,
        "noProgressTurnsBeforePause": 2,
        "noToolCallTurnsBeforePause": 10,
        "budgetWrapupRatio": 0.8,
        "maxPromptFailures": 3,
        "persistState": true,
        "stateFilePath": ".opencode/goals/state.json",
        "resultRetentionMs": 604800000,
        "maxStoredResults": 200
      }
    ]
  ]
}
```

| Option | Default | Notes |
|---|---|---|
| `maxRecentMessages` | `200` | The **visibility window**: how many recent messages are fetched to reconstruct the latest turn. A narrow window can slice off a long turn's tool-bearing head and leave only its text-only summary visible — the same false reading by another route. The host answers any limit with the same two queries, so a wider window costs rows, not round trips; omitting the limit is worse still, since the host then pages the whole session |
| `noProgressTurnsBeforePause` | `2` | Grace window for low-output stalls; tokens are summed across the whole turn |
| `noToolCallTurnsBeforePause` | `10` | Grace window for tool-free turns. Set the **plugin option** to `0` to disable the brake for legitimate writing/research workflows; `--no-tool-turns 0` is rejected as invalid |
| `warnTurnsRemaining` / `warnDurationMsRemaining` / `warnTokensRemaining` | `3` / `600000` / `25000` | Thresholds for the "limits are near" warning. `warnTokensRemaining` is applied to both token ceilings. Under the shipped defaults the **turn** warning is silent, because an unlimited budget has nothing to run out of; the context warning is silent while no context ceiling is known |
| `noInterruptOnUserMessage` | `false` | When `true`, a new human message steers the next continuation instead of pausing the goal — so `/goal pause` and `/goal stop` become the way to halt it |
| `noContinueWhileChildrenActive` | `false` | When `true`, auto-continue is deferred while the session has active children (subagents, background tasks). Adds a `children` and a `status` call per idle. **Fails open** for hosts that cannot report children/status, for sessions with more concurrent children than can be tracked, and for children running goals of their own. Every deferral is reported in `/goal status` and the history, so a waiting goal is not mistaken for a hung one |
| `commandName` | `goal` | The slash command the plugin owns; a leading slash is tolerated. Register the matching name in your OpenCode `command` config |
| `registerCommand` | `true` | Set `false` to drive the workflow programmatically with no slash command |
| `registerTools` | `true` | Set `false` to omit the agent-tool surface |
| `registerAgents` | `true` | Adds native `goal` and `goal-verify` agents. Existing agents with those names are preserved; your default agent is never changed |
| `goalAgentName` / `verifierAgentName` | `goal` / `goal-verify` | The verifier is a hidden subagent with a default-deny tool policy: only `read`, `glob`, `grep` |
| `restrictedAgents` | `["plan"]` | Planning-only agent names (case-insensitive). Pass `[]` to release the restriction |
| `allowGoalExecutionFromPlan` | `false` | `true` allows goal creation and auto-continue under a restricted agent. The default-on restriction is pinned by the mutation contract: hardcoding this to `true` fails the suite |
| `sidebarStatus` | `true` | Mirror live status into the sidebar. `sessionTitleStatus` is the pre-0.10.0 spelling, still honoured when this is unset |
| `completionAudit` | `false` | Spawn an independent OpenCode child session to verify a completion; it replies `[audit:approved]` or `[audit:rejected]` with a reason |
| `auditor` | — | `async ({ goal, sessionID, latestText }) => ({ approved, reason })`; takes precedence over `completionAudit` |
| `auditorOptions` | `{ timeoutMs: 120000, failurePolicy: "reject" }` | Ignored when a custom `auditor` is supplied. `failurePolicy: "reject"` means an unavailable API, missing child-session ID, provider error, or timeout **rejects** and pauses the goal. `"approve"` is an explicit escape hatch; a genuinely negative or malformed verdict still rejects |
| `auditMessages` / `lifecycleMessages` | `true` / `true` | Separate controls. Audit messages describe completion/block validation; lifecycle notices describe applied state transitions. When `auditMessages` is on it owns the terminal announcement; when off and lifecycle is on, the lifecycle channel emits one terminal fallback |
| `auditMessenger` / `lifecycleMessenger` | — | `(sessionID, text)`; route notices somewhere other than the structured log and TUI toast |
| `sdkShape` | `legacy` | Session-client argument shape: `legacy` (`{ path, body, query }`) or `flat` (`{ sessionID, … }`). Read-only calls may probe the alternate shape after an argument/schema `TypeError`; mutating calls are never replayed |
| `persistState` | `true` | `false` keeps purely in-memory behaviour and also disables the ledger |
| `stateFilePath` | `.opencode/goals/state.json` | Root of the persisted shard namespace; overrides `OPENCODE_GOAL_STATE_PATH` |
| `ledgerMaxBytes` / `ledgerRetentionFiles` | `2 MiB` / `3` | Retention `0` discards the active ledger at the size ceiling |
| `resultRetentionMs` / `maxStoredResults` | 7 days / `200` | How long and how many completed-goal summaries stay reachable through `/goal status` |

On approval a goal is archived as achieved; on **rejection** it is *not* archived — it pauses with stop reason `audit rejected` and the reason in its status, so you can address the gap and `/goal resume`. Audit **messages** are visibility only: enabling them does not turn on the auditor. The evidence gate always applies.

---

## State and persistence

Goal state is persisted to a **project-local** namespace rooted at `.opencode/goals/state.json` relative to the working directory, so goals follow the project rather than your home directory. Each session gets a separate hashed shard at `<stateFilePath>.sessions/<sha256(sessionID)>/state.json`, so unrelated sessions in one project run concurrently. State is local and is not synchronised across machines. Consider adding `.opencode/goals/` to `.gitignore`.

Resolution precedence: the `stateFilePath` option → the `OPENCODE_GOAL_STATE_PATH` environment variable → the project-local default. When a project has no shard namespace yet, the plugin migrates all sessions from the legacy `~/.opencode-goal-plugin/state.json` and the XDG path on first access; migration is exclusively claimed, and the sources are retired to timestamped `.migrated…` backups so another project cannot import the same private goal state. An explicit option or env path is used literally, with no migration fallback.

The state directory is owner-only and the JSON file is written `0600`, because it may contain goal text, assistant checkpoints, and workflow history.

**Lifecycle ledger.** Alongside each shard is an append-only `state.json.ledger.jsonl` (also `0600`). Every lifecycle event — set, edit, auto-continue, pause, resume, blocked, completed, limit — is one JSON line. The in-memory history is capped, so the ledger is the durable record: if a state file is missing or corrupted, still-active goals are reconstructed from it at startup and reloaded **paused**, with a recovery note, so unattended auto-continue does not resume blindly. Terminal events are written to the ledger *before* the state write, so a terminal outcome survives a failed write (**fail-closed**); such a failure is logged at error level.

**One writer per session shard.** If the same session is opened in a second process, that process enters **passive goal mode**: ordinary chat and unrelated tools keep working, but `/goal` commands and goal tools report that another process owns the workflow, and canonical tools return the stable envelope code `error: "session_owned_elsewhere"`. The passive process never reads, mutates, persists, or auto-continues that session's state, and never falls back to an unpersisted copy. After the owner exits, retry an explicit goal command; the process acquires the shard and loads any recovered goal paused. To work concurrently without waiting, fork: `opencode --continue --fork`.

Ownership uses immutable per-process claim files, so a delayed stale-lock cleanup or a duplicate release cannot delete a newer owner's lease. A complete regular-file compatibility guard is published atomically at `<shard>/state.json.lock`, and the owner is elected from claims in the sibling `<shard>/state.json.lock.claims-v2/` directory. That no-replace publication makes startup safe against older releases: either the older lock directory wins and the current plugin stays passive, or the guard wins and the older release cannot reclaim it. Legacy, incomplete, tampered, or unsupported layouts fail closed rather than being rewritten online; the filesystem must support regular-file hard links and preserve the guard's future timestamp.

**Session forks and child sessions.** Goals are scoped to the session that created them. A child or fork does not inherit its parent's goal. This is deliberate: OpenCode includes `parentID` for ordinary child sessions but does not expose the source session in the `session.created` event for forks, and inferring ancestry from a mutable title such as `(fork #1)` could attach a goal to the wrong session. (Spend accounting is the one exception — it deliberately walks the `parentID` chain, because the tokens are real and somebody is billed for them.)

---

## Sidebar

### Status line

```
▶ ship the release · 2/4 · 3/∞ · 2m/8h · 147k/100m · 3/7✓
```

Status icon, objective label, sequence position (only for `/goal sequence`), auto-continues used / limit, elapsed / duration limit, cumulative token **spend** / budget, verified actions / total. Peak context is not in the title — it has its own guard and its own line in `/goal status`, `metadata.goal.context`, and the panel. The icon distinguishes running (`▶`), paused (`⏸`), blocked (`⛔`), completed (`✓`); blocked outranks paused, because it needs you rather than a resume. A paused goal freezes its elapsed clock.

Durations render in whole seconds under a minute (`45s`), then minutes, then from an hour in hours with one decimal and no trailing `.0` (`45m`, `1h`, `1.5h`, `8h`). Every duration is **truncated, never rounded up**, so elapsed never reaches the limit's own rendering early: 7h57m of an 8-hour window reads `7.9h/8h`, and 481 minutes reads `8h`. Elapsed and limit are formatted independently, so a fresh 8-hour goal reads `0s/8h`.

Both halves of the write are one `PATCH /session/{id}` (`client.session.update`). This needs no TUI entrypoint and no `@opentui` dependency, so it works on every client that shows a session title — including `opencode run`, the desktop client, and any host reading the session record over HTTP. Renders are idempotent on a JSON fingerprint, so a read-only command costs nothing; a failure is logged at debug level and never interrupts the goal loop; a host that rejects `metadata` is demoted once to title-only. The sidebar refreshes on goal commands and on idle, compaction, and interruption events — **not** on the `message.updated` events that stream during a turn, because that would put an API round trip in the response path for a cosmetic update.

Two kill switches: `sidebarStatus: false`, or `OPENCODE_GOAL_SIDEBAR=0` (also `false`/`off`) in the environment.

The original title is captured before the first overwrite and restored by `/goal clear`, which also clears `metadata.goal`. The captured title lives in memory only, so a hard kill leaves the last status line on the session; the plugin recognises its own status lines and will not promote one to your permanent title, but it cannot recover a title it never saw. `metadata.goal` is the plugin's own namespace, so a clear drops it even after a restart.

### `metadata.goal` payload, schema `v: 2`

```json
{
  "v": 2,
  "goalId": "…",
  "state": "active",
  "objective": "ship the release",
  "turns": { "used": 3, "max": null, "unlimited": true },
  "durationMs": { "used": 120000, "max": 28800000 },
  "minutes": { "used": 2, "max": 480 },
  "tokens": { "used": 147000, "max": 100000000 },
  "context": { "used": 147000, "max": 200000 },
  "plan": { "total": 7, "verified": 3, "blocked": 1, "actions": [ … ] },
  "successCriteria": "tests pass and changelog updated",
  "constraints": "do not touch the public API",
  "sequence": { "ordered": true, "position": 2, "total": 4 },
  "updatedAt": 1767225600000
}
```

`durationMs` and `minutes` are plain numbers for the same duration, and **both are quantized to the granularity they are rendered at** — `durationMs` to whole seconds below a minute and to whole minutes above, `minutes` to whole minutes. An elapsed 147,000 ms is written as `"durationMs": { "used": 120000 }`, not `147000`: a field that ticked every millisecond would cost a `PATCH /session/{id}` on every event of a multi-hour run, and quantizing here is what keeps the payload and the truncated session-title duration from disagreeing. `tokens` is cumulative **spend** against `maxTokens`; `context` is **peak context** against the learned or configured window, and is **omitted entirely** when no ceiling is known rather than written as `max: 0`. Within one budget window only `context.used` can go down — but `/goal resume` starts a new window, which resets `turns.used`, `durationMs.used`, `minutes.used` and `tokens.used` to zero as well, so none of them is a monotonic counter across a resume. The one budget with a "no ceiling" state is `turns`, carried as `"max": null` plus an explicit `"unlimited": true` — never `Infinity`, which JSON serialises to `null` and would be indistinguishable from a missing field. A bounded goal carries `{ "used": 3, "max": 10 }` with no `unlimited` key. The block above is an **active, unblocked** goal: `stopReason` is written only once the goal has stopped and `blockedReason` only once a blocker is recorded, so neither key appears here.

**Upgrade both halves together.** `v: 2` landed in 0.11.0: `turns.max` became nullable, `durationMs` and `context` were added, and `tokens.used` was redefined from context size to cumulative spend. Every v1 field is still written, so a v1 consumer keeps working — with one exception. The panel is registered separately from the server half, so the two can skew, and a **0.10.x panel reading a 0.11.0 payload drops the turns stat** (it reads `"max": null` as a missing budget). The current panel reads either version.

### Sidebar panel (TUI)

When the host's TUI supports plugin sidebar slots (1.18.x and later), the package renders the whole goal as a panel above the todo list:

```
Goal
▶ ship the release
3/∞ turns · 2m/8h · 147k/100m tokens · 147k/200k ctx
step 2/4
3/7 actions verified, 1 blocked
● rebuild dist [pass]
◐ rerun the suite
⛔ waiting on the audit
● update the changelog [pass]
● re-time the ladder [pass]
○ tag the release
○ announce the release
Success: tests pass and changelog updated
Constraints: do not touch the public API
```

That is the payload above, rendered: every action in the plan gets a row. The panel lists **at most 12** actions and appends a `+N more` line only past that (`MAX_PANEL_ACTIONS` in `src/goal-sidebar-view.js`), and the server caps the array it publishes at **20** (`SIDEBAR_METADATA_MAX_ACTIONS` in `src/goal-plugin.js`), so `N` counts what `plan.total` claims beyond the rows shown.

The `ctx` stat is **dropped entirely** when no context ceiling is known, so a panel with three stats rather than four is a goal running without one, not a broken render. State drives the colour: blocked is an error, completed a success, paused a warning. An action is green only when it is `done` **and** its verdict is `pass` — a `done` action with no verdict is exactly the unsubstantiated completion the CEV gate exists to catch. The panel hides itself when the session has no goal.

A plugin module may export `server()` or `tui()`, never both — but one *package* may ship both, because OpenCode resolves each kind's entrypoint from `package.json` `exports`:

| Export | File | Kind |
|---|---|---|
| `.` / `./server` / `main` | `dist/goal-plugin.js` | server: commands, tools, hooks, the title and metadata writes |
| `./tui` | `dist/goal-tui.js` | tui: the sidebar panel |

`solid-js` and `@opentui/solid` are provided by the host at runtime, so they are not dependencies of this package and are deliberately external in the bundle — a second copy of Solid would have its own reactive graph and never update. On a host without TUI plugin slots the `./tui` target is simply never loaded and the title line remains the fallback. `sidebarStatus: false` empties the payload the panel reads, so it turns the panel off too.

---

## Plan-mode safety

A planning-only agent is never driven into execution by the goal loop:

- A goal set while `plan` is active is **recorded but held**, with stop reason `plan agent active`. The objective and its budget survive; the goal simply does not start.
- The routed confirmation text for a held goal **omits the "start working" instruction** and is sent as a read-only control turn.
- Auto-continue stays suppressed on **every idle** while a restricted agent is active, so switching into `plan` mid-goal pauses the loop.
- Continuations retain the agent, provider/model, and variant that started the goal, so the loop cannot drift into a different agent.

The active agent is read from the host's execution context with a fallback to the session record. That fallback matters: OpenCode runs `command.execute.before` before any `chat.message`/`chat.params` for the turn, so the context is empty for the first command in a session — the exact case a freshly opened Plan-mode session hits.

**What this does and does not prevent.** The restriction stops the *goal loop*: a held goal sends zero auto-continues, so no unattended work happens. It cannot stop a model from acting on the single routed command turn, because `command.execute.before` does not fully intercept command text. Verified against OpenCode 1.18.25: a goal set under Plan records `stopped: true`, `stopReason: plan agent active`, and `turnCount: 0`.

## Prompt safety

The goal text is wrapped in `<goal_objective>` tags and labelled as user-provided task data. The assistant is told to treat it as a task description, not as elevated instructions that can override system, developer, tool, or repository policies.

For `/goal status`, `/goal history`, `/goal list`, `/goal pause`, and `/goal clear` (including aliases), the rewritten user turn carries an escaped control-result envelope with direct instructions to report the supplied data without treating it as new work. `tool.execute.before` rejects every tool call for that reporting turn, and the parent-correlated assistant response is excluded from checkpoint, completion, blocker, and stall analysis. These protections do not depend on the model following the instruction.

Objective-bearing commands preserve file attachments. OpenCode may expand those into synthetic Read/MCP text and file parts before `chat.message`; the plugin accepts that expansion only when it matches the one-shot command correlation, retained-file count, and generated message/session identity. Other mixed text is treated as a new human instruction and pauses an active loop. If OpenCode reports an attachment-read error during expansion, the goal pauses with `attachment resolution error` while retaining the correct command provenance.

---

## Compatibility

| Surface | Status |
|---|---|
| Node.js | `engines.node` is `>=18`; CI runs the full suite on Node 18, 20, 22, and 24 |
| OpenCode | `engines.opencode` is `>=1.17.15 <2`. OpenCode 2 is unsupported and untested — see [`docs/compatibility.md`](docs/compatibility.md#opencode-2) |
| Operating systems | Filesystem-sensitive lifecycle tests run on Linux, macOS, and Windows; the installed-package type, host, and tool contracts also run on Windows |
| Package entrypoints | Installed-tarball contracts verify all three export paths (`.`, `./server`, `./tui`), the plugin-manifest targets OpenCode reads from `exports`, consumer TypeScript resolution, the 9 hooks, and all 14 tools |
| Provider/backend quirks | Strict-template backends require the goal block to merge into the primary `system` message; covered by regression tests. See [`docs/providers.md`](docs/providers.md) |
| Runtime dependencies | `zod` only, bundled into `dist/` |

Live-host verification is recorded per release rather than claimed in general: **four** provider/model combinations on OpenCode 1.17.15 for the v0.6.6–v0.9.0 lifecycle matrix ([`docs/providers.md`](docs/providers.md)), one live OpenCode **1.18.25** TUI run for the plan-mode hold and the status indicator in 0.9.0, and OpenCode **1.18.29** for the sidebar, TUI-config and git-install findings in 0.10.0 and 0.10.1 — those last two runs are recorded in [`CHANGELOG.md`](CHANGELOG.md), not in [`docs/providers.md`](docs/providers.md). `/goal status` and auto-continue are graded on **state correctness** — verified directly against persisted state and file effects — not on terminal rendering, because OpenCode custom commands are prompts, not plugin-rendered TUI responses: after `command.execute.before` runs, the host sends its retained command-parts array through a normal model turn. The plugin mutates that array in place so the model receives the deterministic plugin-generated result rather than the raw `/goal` argument, but the model still produces the visible response and may paraphrase it. The 1.17.15 matrix and its session evidence are in [`docs/providers.md`](docs/providers.md); the 1.18.x runs are in the changelog entries for the releases that made them.

**Re-test against the exact OpenCode build and provider stack you plan to use for unattended work.** Nothing in this repository can do that for you.

## Identifier policy

The **package** is renamed; the plugin's **wire and state identifiers deliberately keep the historical `opencode-goal-plugin` string**, so a user upgrading from the old package keeps their goals and their in-flight sessions. That means the slash command stays `/goal`, the tools keep their `goal_*` names, the session metadata key stays `metadata.goal`, the environment variables stay `OPENCODE_GOAL_STATE_PATH` and `OPENCODE_GOAL_SIDEBAR`, the state root stays `.opencode/goals/state.json`, and the legacy migration sources — `~/.opencode-goal-plugin/state.json` and the XDG path under `opencode-goal-plugin/` — are unchanged. Only what names the *package* changed: the install spec, the repository URLs, and the packed artifact.

---

## Diagnostics and recovery

Start with `/goal status`, then `/goal history`. Together they show whether a goal is active, its stop reason and budget usage, and the recent lifecycle/checkpoint trail without exposing the on-disk ledger to the model.

If a goal does not continue:

1. Check for a deliberate pause: user intervention, a hard limit, repeated tool-free or no-progress turns, prompt failures, or a rejected completion audit all stop unattended work by design.
2. Run `/goal resume` only after resolving the reported reason. Resume creates a fresh local budget window; it does not erase the objective or history.
3. If a goal control reports that another process owns the session, close that owner and retry, or fork. If it reports an older, incomplete, tampered, or unsupported lease, close and upgrade every process that could own the session first; if it persists, remove only the affected shard's adjacent `.lock` file or legacy directory **and** its `.lock.claims-v2` directory. Keep the state and ledger. Never point two copies of one session at different state paths — that creates divergent histories.
4. Check OpenCode's structured logs for persistence, SDK-shape, prompt, or auditor errors.
5. Confirm the project directory and the state-path precedence above. A daemon started elsewhere makes a relative path surprising.
6. From an install, run the shipped verifier — `npx opencode-goal-pro-max-complete-plugin`, which is `npm run verify` — when diagnosing registration problems. The packaging contracts (`npm run smoke`, `npm run smoke:packed-host`, and the rest of the ladder) live in a git checkout only: `package.json` `files` ships `scripts/verify.mjs` and nothing else from `scripts/`, so running them inside `node_modules` fails with `MODULE_NOT_FOUND`.

Do not paste `state.json`, its ledger, or verbose logs into a public issue without reviewing them: they can contain goal text, assistant checkpoints, blockers, local paths, and command evidence. Prefer the bounded status/history output. There is intentionally no broad "dump diagnostics" tool — exposing process-wide session state or persistence paths to the model would add more privacy risk than troubleshooting value.

## Development

```sh
npm test                     # 508 unit tests
npm run test:coverage        # tests with coverage
npm run type:check           # compile installed-package consumers (NodeNext + Bundler)
npm run test:mutation        # 80 critical mutants must all be killed (~2.3 min)
npm run benchmark:behavior   # 6 deterministic autonomy scenarios, no provider call
npm run smoke                # package export + command hook, no model call
npm run smoke:packed-host    # install the packed tarball, exercise the host contract
npm run smoke:packed-tools   # all 14 tools from an installed tarball
npm run smoke:packed-manifest # both plugin targets discovered from the packed exports
npm run smoke:git-install    # no install-time scripts; dist matches a fresh bundle
npm run verify               # installed hook surface
npm run check                # syntax check + tests
npm run pack:check           # package contents
npm run release:check        # the complete gate, in order (~3 min)
```

Point OpenCode at your checkout for local testing with the package **directory**, not a file inside it. Keep test files outside OpenCode's auto-loaded plugin directory — it will try to load plugin-like files it finds there. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full contribution checklist and [`SECURITY.md`](SECURITY.md) for vulnerability reporting.

## License

MIT. Copyright (c) 2026 willytop8 — see [`LICENSE`](LICENSE), retained unchanged from [willytop8/OpenCode-goal-plugin](https://github.com/willytop8/OpenCode-goal-plugin), the upstream project this is a fork of.

This project is independently implemented for OpenCode. Product names used elsewhere identify their respective owners; no feature-parity or endorsement claim is implied.
