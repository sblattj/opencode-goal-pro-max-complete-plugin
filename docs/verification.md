# What "pro max complete" means

The name is not a claim about the feature list. It is a claim about the **process**: every behaviour in [`reference.md`](reference.md) is pinned by a test, most of the load-bearing ones are pinned by a mutation that must make the suite go red, and the numbers in this file were re-measured by running the commands in the table before it was written. Where a claim rests on one observation, it says so.

## The verification ladder

Every row was run against this tree on 2026-09-08 (Node v24.15.0, npm 11.12.1, bun 1.3.14, macOS 26.5.1). `npm run release:check` runs all of them in order, plus a bundle step, and takes about **2.5–3 minutes** on that stack — around nine tenths of it the mutation rung, which re-runs the whole suite once per mutant. (Timed end to end: 150 s, 151 s, 155 s and 173 s before 1.0.0; 153 s, 157 s and 162 s on the 1.0.0 tree, which adds 47 tests and three mutants; and 165 s on the 1.0.1 tree, which adds 100 tests, twelve mutants and a second benchmark.)

| Rung | Command | What it proves | Measured |
|---|---|---|---|
| Unit suite | `npm test` | Every documented behaviour has an executable specification, across 18 test files | **655 tests, 655 pass, 0 fail** |
| Coverage | `npm run test:coverage` | The suite actually reaches the code it claims to cover | **≈97.5% line, ≈88.7% branch, ≈93.9% function** on `src/goal-plugin.js` — the cross-process lease tests race, so `persistence-lease.js` and every total move between runs. Six fresh 1.0.1 runs came out at 97.51–97.55% line, 88.62–88.77% branch and a flat 93.86% function on `goal-plugin.js`, while `persistence-lease.js` itself swung 92.37–93.96% line, 87.79–90.09% branch and 86.67–88.89% function over the same six. Re-measure rather than quote: this row is a range, not a point |
| Mutation contract | `npm run test:mutation` | Each safety property's test is *not vacuous*: the mutant reverts exactly that property in a scratch copy of `src/` and the suite must go red | **95/95 critical mutants killed** |
| Behaviour benchmark | `npm run benchmark:behavior` | Six end-to-end autonomy scenarios — verified success, false completion, loop circuit breaker, human interruption, compaction continuity, restart recovery — behave as specified | **6/6 passed, score 100/100, 0 model calls, 0 external requests** |
| Todo-mirror benchmark | `npm run benchmark:todo-mirror` | The Todo mirror does what it was built for, measured against a pre-v1.0.1 control: one goal, a five-action plan, eight scripted turns, and a model that writes its own divergent list every turn | **passed — under `mirrorTodos: "plan"` the executed list diverges from the plan on 0 of 8 turns and the sidebar settles on 1 persistent checklist; the `"off"` control diverges on 8 of 8 and renders 2. Both arms re-run and deep-equal their first pass** |
| Type contract | `npm run type:check` | A TypeScript consumer can compile against the **packed tarball** under both NodeNext and Bundler resolution, including the `./tui` subpath | **passed** (`opencode-goal-pro-max-complete-plugin-1.0.0.tgz`) |
| Command-hook smoke | `npm run smoke` | The package export path and the `/goal` command hook work with no model call | **passed** |
| Installed-host contract | `npm run smoke:packed-host` | The published artifact, installed into a scratch project, satisfies the OpenCode host contract — hooks, exports, consumer resolution | **passed**, ≈367 kB tarball |
| Installed-tool contract | `npm run smoke:packed-tools` | A clean tarball install exposes the whole agent-tool surface with no separate OpenCode helper package | **passed, 14 tools** |
| Packed-manifest contract | `npm run smoke:packed-manifest` | OpenCode's own `packageTargets`/`readV1Plugin` discovery rules, re-implemented against the tarball, find both halves from `exports` — and the `./tui` entry really registers a `sidebar_content` view | **passed**; `server -> ./dist/goal-plugin.js`, `tui -> ./dist/goal-tui.js` |
| Git-install contract | `npm run smoke:git-install` | None of the six manifest script names that make pacote's `GitFetcher` spawn a missing `npmBin` has reappeared, and the committed `dist/` byte-matches a fresh bundle | **passed**; `dist/goal-plugin.js` and `dist/goal-tui.js` match a fresh bun 1.3.14 bundle |
| Hook-surface verify | `npm run verify` | The installed plugin loads, registers all 11 hooks, answers `/goal status` and `/goal set`, and makes zero model calls | **all 7 checks passed** |
| Dependency audit | `npm audit --omit=dev --audit-level=high` | No known high-severity vulnerability in the runtime dependency (`zod` only) | **0 vulnerabilities** |
| Pack check | `npm run pack:check` | The tarball contains what it should and nothing else | **39 files, ≈401 kB packed, 1.6 MB unpacked** — this file and `README.md` both ship inside the tarball, so the exact packed byte count moves whenever either of them does; only the rounded figure is quotable |

## The process behind 0.11.0

The ladder is the artifact. The process that produced the current defaults is the reason the ladder is worth anything:

- **Three reviewer lenses per change, run independently.** Each change to the budget and brake model was reviewed separately for *budget semantics* (does this number mean what its name says), for *correctness*, and for *"does it still brake"* (can a runaway loop still be stopped). The lenses disagreed with the implementation more than once, and the implementation lost.
- **Every fix proved with a polarity mutant.** A green suite proves nothing about a test that cannot fail. Each fix landed with a test *and* with a mutant that reverts exactly the fixed property, so the claim rests on a red/green pair. Twelve of the 80 mutants in the contract are new in 0.11.0.
- **An independent verifier that ran the shipped bundle, not `src/`.** The final verification pass imported `dist/goal-plugin.js` — the bytes a user installs — rather than the source tree, because a bundler is a loader that can disagree with `node`.
- **Decisions reversed by evidence.** Three of the shipped defaults are the *second* answer:
  - A fixed 200,000-token context guard was replaced by the model's own window read from the host, because the wrap-up *pauses* the goal and a fixed ceiling would have ended healthy runs at a 160,000-token peak on 400k- and 1M-context models ([CHANGELOG 0.11.0](../CHANGELOG.md)).
  - The talk-only pause moved from **2** turns to **10**, because judging a goal purely on tool calls is a blunt instrument.
  - `maxTokens` was redefined from *peak context* to *cumulative spend*, after review showed the shipped 100,000,000 could never be reached against a `Math.max` over single-message context sizes — the token brake, the token warning and the token half of the wrap-up handoff were all dead code on a default goal, and every continuation prompt was telling the model it had roughly 500× its real headroom.

## One live-session measurement

The turn-aggregation fix in 0.11.0 rests on a measurement of **one real OpenCode session** (43 turns with assistant replies). An analyzer grouped that session's assistant messages by the user message they answer (`parentID`) and asked, per turn, whether the *last* assistant message carried a tool part — which is what the pre-0.11.0 brakes scored:

- **33 of 43 turns used tools.**
- In **28 of those 33**, the last assistant message was text-only. Under the old single-message check, 28 productive turns out of 33 were charged as "no tool calls" — and a default goal paused after two of them.
- Over the last **40** turns, **10** ended with a message carrying no text part at all, and **3** ended with a message carrying both a tool part and text. That is why a turn's completion marker is now read from its last *text-bearing* step rather than its last message: a `[goal:complete]` written before one final tool call used to be silently discarded.

This is one session, on one host build, with one model. It is enough to prove the old check was wrong — a single counterexample does that — and not enough to establish a distribution. The raw counts and the reasoning are in [`CHANGELOG.md`](../CHANGELOG.md) under 0.11.0.

## What this does not prove

Read this section before running anything unattended.

- **The measurement above is one session.** It refutes the old behaviour; it does not characterise your workload.
- **One host line.** `engines.opencode` is `>=1.17.15 <2`. OpenCode 2 is unsupported and untested. Live-host verification exists for specific builds (1.17.15, 1.18.25, 1.18.29) and specific providers, not for the matrix you will actually run — the 1.17.15 provider matrix is in [`providers.md`](providers.md), and the 1.18.25 and 1.18.29 runs are recorded per release in [`CHANGELOG.md`](../CHANGELOG.md).
- **The plugin depends on experimental OpenCode hooks, and the host may not call them.** Real OpenCode 1.17.15 and 1.18.10 never invoke `experimental.chat.system.transform`; it is registered as defence in depth, and every command-control protection is deliberately self-contained so correctness does not depend on it.
- **Completion quality is model-dependent.** The evidence gate is structural: it checks that a `[goal:complete]` is preceded by a non-empty `[goal:evidence]` line, not that the evidence is true. The independent completion auditor is **optional and off by default**, and when on it performs static inspection with `read`, `glob`, and `grep` only — it cannot execute a command.
- **`src/goal-tui.js` is not in the coverage report.** The panel's render logic lives in `src/goal-sidebar-view.js` (100% line, 95.29% branch) and is covered; the thin `@opentui/solid` entrypoint is exercised by `smoke:packed-manifest` loading it the way the TUI runtime does, not by the unit suite.
- **The brakes cannot catch useless work.** The no-tool-call and no-progress pauses are skipped for any turn that called a tool. An agent re-running the same failing command with real output every turn trips neither; for that run the binding brakes are the clock, the spend budget, and the context window.
- **No sandbox.** This plugin makes an agent keep working. It adds no restriction on what that agent may do.

## Re-running the ladder

Every command above is an npm script in this repository; the cheat sheet with what each one covers is in [`reference.md`](reference.md#development), and the order a release runs them in is in [`releasing.md`](releasing.md).
