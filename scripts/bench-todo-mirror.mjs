#!/usr/bin/env node

// Todo-mirror behaviour benchmark (design §5.5).
//
// The scenario that produced the screenshot: one goal, a five-action plan, and a
// model that keeps a seven-row todo list of its own wording beside it. Two arms,
// the SAME script: `mirrorTodos: "off"` (v1.0.0 behaviour) and `"plan"`.
//
// Modelled on `scripts/behavior-benchmark.mjs`: an in-process host, scripted
// assistant messages, and the plugin's REAL hooks. No network, no real model, no
// `opencode` binary — every number below is produced by
// `tool.execute.before` / `tool.execute.after` / the idle continuation /
// `buildSidebarMetadata` / `goalPanelModel` on this tree's own source, so the run
// is deterministic and finishes in milliseconds. That is why it is in
// `release:check`, next to `benchmark:behavior`, while the real-host smokes
// (`smoke:todo-mirror`, `smoke:todo-safety`) are not.
//
// Metrics
//   divergence           turns in which the todo list that reached `execute` and
//                        the plan describe different work. Target 0 under
//                        "plan"; every turn under "off".
//   persistent_surfaces  distinct PERSISTENT checklists the sidebar would render
//                        at the end of the run: the host's builtin Todo section
//                        plus the Goal panel's action list when it is non-empty.
//                        Target 1 under "plan" with a clean plan, 2 under "off".
//                        (Design §5.5 is explicit that the two transcript
//                        bubbles are unreachable by any plugin and are not
//                        counted here.)
// Observations only — one scripted run cannot separate the mirror from ordinary
// model variance, so nothing below is asserted except the no-regression rule on
// turns-to-first-evidence:
//   todowrite calls per goal turn, model-authored todowrite payload bytes, the
//   bytes that reached `execute`, turns-to-first-evidence, and the count of
//   todowrite transcript bubbles still showing the model's own pre-mirror
//   wording — which design §5.5 reports precisely because no plugin can reach a
//   transcript bubble, so the design does not claim to fix it.
//
// Usage: npm run benchmark:todo-mirror   (exit 0 = every target met)

import assert from "node:assert/strict"

import { GoalPlugin, testInternals } from "../src/goal-plugin.js"
import { goalPanelModel } from "../src/goal-sidebar-view.js"

const TURNS = 8

// CONTRACTS "Strings", the T14/T19 nudge. The scripted model reacts to this line
// exactly as the plugin asks it to: it spends that turn's todowrite on the
// refresh idiom instead of on its own list.
const NUDGE_LINE =
  "Todo panel is stale — call todowrite({todos: []}) once; the plan is copied into it for you."

const OBJECTIVE = "ship the todo mirror without a second checklist"

// The plan: five falsifiable actions, the size the screenshot showed.
const PLAN_ACTIONS = [
  { id: "a1", title: "Reproduce the divergent todo list in a scratch session" },
  { id: "a2", title: "Project the plan into todo rows" },
  { id: "a3", title: "Intercept the empty refresh call" },
  { id: "a4", title: "Publish the mirror state to the sidebar payload" },
  { id: "a5", title: "Prove the two surfaces agree" },
]

// The model's own seven-row list — the screenshot's divergence. Same work, the
// model's wording, plus two steps that are nowhere in the plan. No row carries an
// `aN · ` prefix, which the fixture self-check below proves.
const MODEL_TODOS = [
  { content: "Reproduce the bug", status: "in_progress", priority: "high" },
  { content: "Write the projector", status: "pending", priority: "medium" },
  { content: "Handle the empty list", status: "pending", priority: "medium" },
  { content: "Update the sidebar payload", status: "pending", priority: "medium" },
  { content: "Write the tests", status: "pending", priority: "medium" },
  { content: "Run the suite", status: "pending", priority: "low" },
  { content: "Update the changelog", status: "pending", priority: "low" },
]

// One `goal_action_update` per turn. Turns 1-3 move work in flight; turns 4-8
// record the claim, the falsifying evidence and the verdict, so the run ends on a
// fully verified — "clean" — plan, which is the state the persistent-surface
// target is defined against.
const TURN_SCRIPT = [
  { id: "a1", status: "in_progress" },
  { id: "a2", status: "in_progress" },
  { id: "a3", status: "in_progress" },
  {
    id: "a1",
    status: "done",
    claim: "the divergent list reproduces on a fresh session",
    evidence: "npm run smoke:todo-mirror",
    verdict: "pass",
  },
  {
    id: "a2",
    status: "done",
    claim: "plan rows carry the action id and the mirrored status",
    evidence: "npm test -- projectPlanToTodos",
    verdict: "pass",
  },
  {
    id: "a3",
    status: "done",
    claim: "an empty todowrite re-projects instead of clearing",
    evidence: "npm run smoke:todo-safety",
    verdict: "pass",
  },
  {
    id: "a4",
    status: "done",
    claim: "the payload reports the mirror state and row count",
    evidence: "npm test -- buildSidebarMetadata",
    verdict: "pass",
  },
  {
    id: "a5",
    status: "done",
    claim: "server and panel agree on the mirrored count",
    evidence: "npm test -- v3 payload and the panel agree",
    verdict: "pass",
  },
]

assert.equal(TURN_SCRIPT.length, TURNS)

// A fixed clock for the published payload: `buildSidebarMetadata` stamps
// `updatedAt`, and nothing measured here may vary with wall time.
const FIXED_NOW = 1_700_000_000_000

// ---------------------------------------------------------------------------
// The in-process host
// ---------------------------------------------------------------------------

// Assistant messages are scripted, not generated. Every turn carries a real work
// tool part (`bash`) beside the bookkeeping ones, because T15 exempts `todowrite`
// from the "did this turn do work?" test under `"plan"` only: a turn of pure
// todowrite would accrue the tool-free strike in one arm and not the other, and
// the benchmark would then be measuring the brake rather than the mirror.
function turnParts(turn) {
  return [
    { type: "text", text: `Turn ${turn}: working the plan.` },
    { type: "tool", tool: "bash" },
    { type: "tool", tool: "goal_action_update" },
    { type: "tool", tool: "todowrite" },
  ]
}

function createHost() {
  const prompts = []
  const turns = new Map()
  return {
    prompts,
    setTurn(sessionID, turn) {
      turns.set(sessionID, turn)
    },
    client: {
      app: { log: async () => {} },
      session: {
        messages: async ({ path }) => {
          const turn = turns.get(path.id) || 0
          return {
            data: [
              {
                info: {
                  id: `assistant-${path.id}-${turn}`,
                  role: "assistant",
                  sessionID: path.id,
                  tokens: { input: 400, output: 320, reasoning: 0 },
                },
                parts: turnParts(turn),
              },
            ],
          }
        },
        promptAsync: async (input) => {
          prompts.push(input)
          return {}
        },
        abort: async () => ({}),
      },
    },
  }
}

function promptText(prompt) {
  return (prompt?.body?.parts || [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
}

// ---------------------------------------------------------------------------
// The two metrics
// ---------------------------------------------------------------------------

// "The todo list and the plan describe different work." The comparison is made
// against the plugin's OWN projector, so it asks the only question that has a
// defined answer on both arms: of the rows that reached `execute`, do the ones
// this plan owns spell out this plan's current actions, in plan order, with the
// statuses the plan currently justifies? Rows of the model's own are excluded by
// construction — under `"plan"` they are the design's kept extras, and under
// `"off"` the whole list is unowned, which is precisely the divergence.
function describesTheSameWork(executedTodos, goal) {
  const planRows = testInternals.projectPlanToTodos(goal.plan, [])
  const owned = executedTodos.filter((row) => testInternals.isMirrorOwnedRow(row.content, goal))
  const shape = (rows) => JSON.stringify(rows.map((row) => [row.content, row.status]))
  return shape(owned) === shape(planRows)
}

// The persistent checklists a user would be looking at. Two, and only two, are
// reachable from here: the host's builtin Todo section (it renders whenever the
// session's todo list is non-empty) and the Goal panel's action list (T24 makes
// it an exception list while the mirror is live, so a clean plan renders zero
// rows and the panel collapses to its progress line).
function persistentSurfaces(payload, executedTodos) {
  const model = goalPanelModel(payload, { liveTodoCount: executedTodos.length })
  const todoSection = executedTodos.length > 0 ? 1 : 0
  const panelChecklist = model && model.actions.length > 0 ? 1 : 0
  return { count: todoSection + panelChecklist, todoSection, panelChecklist, model }
}

// ---------------------------------------------------------------------------
// One arm
// ---------------------------------------------------------------------------

// ONE plugin instance is live at a time: `GoalPlugin` publishes the runtime the
// module-scope collections read, so the arms MUST run in sequence with a
// `dispose()` between them or the second orphans the first goal.
async function runArm(mirrorTodos, label) {
  const host = createHost()
  const hooks = await GoalPlugin(
    { client: host.client },
    {
      persistState: false,
      registerTools: false,
      registerAgents: false,
      minDelayMs: 1,
      mirrorTodos,
    },
  )
  try {
    // The mode is threaded EXPLICITLY into the handlers: `buildAgentToolHandlers`
    // defaults it to "plan", so an omitted argument would silently run the "off"
    // arm's `goal_action_update` with the nudge switched on.
    const handlers = testInternals.buildAgentToolHandlers({
      defaultGoalOptions: testInternals.normalizeOptions({ minDelayMs: 1 }),
      persist: async () => {},
      mirrorMode: mirrorTodos,
    })
    const sessionID = `bench-todo-mirror-${mirrorTodos}`
    await handlers.setGoal(sessionID, { objective: OBJECTIVE })
    await handlers.setPlan(sessionID, { actions: PLAN_ACTIONS })
    const goal = testInternals.currentGoal(sessionID)

    // Fixture self-checks: fail loud rather than measure the wrong shape.
    assert.ok(goal, `${label}: no goal record after setGoal/setPlan`)
    assert.equal(goal.plan.actions.length, PLAN_ACTIONS.length, `${label}: plan did not record`)
    for (const row of MODEL_TODOS) {
      assert.equal(
        testInternals.isMirrorOwnedRow(row.content, goal),
        false,
        `${label}: a scripted model row is already plan-owned, so divergence cannot be measured`,
      )
    }

    // The host's own todo list. `todowrite` replaces it wholesale with whatever
    // args reached the tool, which is what the before-hook rewrites.
    let executedTodos = []
    const turns = []
    let modelAuthoredBytes = 0
    let executedBytes = 0
    let todowriteCalls = 0
    let ownWordingBubbles = 0
    let turnsToFirstEvidence = null

    for (let turn = 1; turn <= TURNS; turn += 1) {
      const step = TURN_SCRIPT[turn - 1]

      // 1. The model records evidence against one action.
      const updateResult = await handlers.updateAction(sessionID, step)
      assert.match(
        updateResult,
        new RegExp(`^Action ${step.id} updated: ${step.status}\\.`),
        `${label} turn ${turn}: goal_action_update was refused: ${updateResult}`,
      )
      if (step.evidence && turnsToFirstEvidence === null) turnsToFirstEvidence = turn

      // 2. The model writes the todo list. When the plugin nudged it in that same
      //    tool result, it spends the call on the refresh idiom the nudge asks
      //    for; otherwise it writes its own seven rows, as it did in the
      //    screenshot.
      const nudged = updateResult.includes(NUDGE_LINE)
      const authored = nudged ? [] : MODEL_TODOS.map((row) => ({ ...row }))
      modelAuthoredBytes += JSON.stringify(authored).length
      // The transcript bubble for this call shows what the MODEL wrote, not what
      // the host executed (F27): a non-empty authored list is one more bubble
      // carrying the pre-mirror wording, on either arm.
      if (authored.length > 0) ownWordingBubbles += 1

      const call = { args: { todos: authored } }
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID, callID: `bench-${turn}` },
        call,
      )
      // The host now executes `todowrite` with the args it holds a reference to.
      executedTodos = call.args.todos
      executedBytes += JSON.stringify(executedTodos).length
      todowriteCalls += 1
      const afterOutput = { title: "todowrite", output: "", metadata: {} }
      await hooks["tool.execute.after"](
        { tool: "todowrite", sessionID, callID: `bench-${turn}`, args: call.args },
        afterOutput,
      )

      // 3. The turn ends: the host reports the assistant's turn and goes idle, so
      //    the plugin's real continuation path runs and its prompt is captured.
      host.setTurn(sessionID, turn)
      const promptsBefore = host.prompts.length
      await hooks.event({
        event: {
          id: `bench-idle-${mirrorTodos}-${turn}`,
          type: "session.status",
          properties: { sessionID, status: { type: "idle" } },
        },
      })
      const continuation = host.prompts.slice(promptsBefore).map(promptText).join("\n")
      assert.equal(
        goal.stopped,
        false,
        `${label} turn ${turn}: the goal paused mid-run (${goal.stopReason || "no reason"}), so the numbers below would not be comparable`,
      )

      // 4. Measure, at the end of the turn, against the plan as it now stands.
      const payload = testInternals.buildSidebarMetadata(goal, FIXED_NOW, { mirrorMode: mirrorTodos })
      const surfaces = persistentSurfaces(payload, executedTodos)
      turns.push({
        turn,
        nudged,
        diverges: !describesTheSameWork(executedTodos, goal),
        todoRows: executedTodos.length,
        planActions: goal.plan.actions.length,
        mirrorState: payload.plan.mirror.state,
        surfaces: surfaces.count,
        panelRows: surfaces.panelChecklist ? surfaces.model.actions.length : 0,
        continuationNudged: continuation.includes(NUDGE_LINE),
      })
    }

    const payload = testInternals.buildSidebarMetadata(goal, FIXED_NOW, { mirrorMode: mirrorTodos })
    const finalSurfaces = persistentSurfaces(payload, executedTodos)
    const progress = testInternals.planProgress(goal.plan)
    // The persistent-surface target is defined for a CLEAN plan; assert the run
    // actually reached one rather than crediting an arm for an empty panel it got
    // by accident.
    assert.equal(
      progress.verified,
      PLAN_ACTIONS.length,
      `${label}: the run did not end on a fully verified plan (${progress.verified}/${progress.total})`,
    )
    // The idle path really ran: one continuation prompt per turn, built by the
    // plugin's own `buildContinueMessage`. Without this the "real hooks" claim
    // above would be unverified for half the loop.
    assert.equal(
      host.prompts.length,
      TURNS,
      `${label}: expected one continuation prompt per turn, saw ${host.prompts.length}`,
    )

    return {
      arm: label,
      mirrorTodos,
      turns: TURNS,
      // Primary
      divergence: turns.filter((entry) => entry.diverges).length,
      persistent_surfaces: finalSurfaces.count,
      // Observations
      todowrite_calls_per_turn: Number((todowriteCalls / TURNS).toFixed(2)),
      todowrite_payload_bytes: modelAuthoredBytes,
      executed_payload_bytes: executedBytes,
      turns_to_first_evidence: turnsToFirstEvidence,
      transcript_bubbles_own_wording: ownWordingBubbles,
      // Supporting detail, printed under the table
      continuation_prompts: host.prompts.length,
      final_todo_rows: executedTodos.length,
      final_panel_rows: finalSurfaces.panelChecklist ? finalSurfaces.model.actions.length : 0,
      final_mirror_state: payload.plan.mirror.state,
      nudged_turns: turns.filter((entry) => entry.nudged).map((entry) => entry.turn),
      continuation_nudged_turns: turns.filter((entry) => entry.continuationNudged).map((entry) => entry.turn),
      peak_surfaces: Math.max(...turns.map((entry) => entry.surfaces)),
      perTurn: turns,
    }
  } finally {
    await hooks.dispose()
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const ROWS = [
  ["divergence (turns)", "divergence", "0 under plan"],
  ["persistent surfaces", "persistent_surfaces", "1 under plan"],
  ["todowrite calls / turn", "todowrite_calls_per_turn", "observation"],
  ["todowrite payload bytes", "todowrite_payload_bytes", "observation"],
  ["bytes reaching execute", "executed_payload_bytes", "observation"],
  ["turns to first evidence", "turns_to_first_evidence", "must not regress"],
  ["own-wording bubbles", "transcript_bubbles_own_wording", "not fixable (F27)"],
  ["final todo rows", "final_todo_rows", "observation"],
  ["final panel rows", "final_panel_rows", "observation"],
]

function table(off, plan) {
  const header = ["metric", 'mirrorTodos "off"', 'mirrorTodos "plan"', "target"]
  const body = ROWS.map(([name, key, target]) => [name, String(off[key]), String(plan[key]), target])
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((row) => row[column].length)),
  )
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()
  return [
    line(header),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...body.map(line),
  ].join("\n")
}

// ---------------------------------------------------------------------------

async function main() {
  // Sequential, never parallel: see `runArm`.
  const off = await runArm("off", "off")
  const plan = await runArm("plan", "plan")

  console.log("todo-mirror behaviour benchmark — design §5.5")
  console.log(
    `one goal, ${PLAN_ACTIONS.length}-action plan, ${TURNS} scripted turns, a ${MODEL_TODOS.length}-row model list; same script in both arms\n`,
  )
  console.log(table(off, plan))
  console.log("")
  console.log(
    `plan arm: mirror ${plan.final_mirror_state}, ${plan.continuation_prompts} continuations,` +
      ` nudged on turns [${plan.nudged_turns.join(", ") || "-"}]` +
      ` (the continuation still carried a nudge on [${plan.continuation_nudged_turns.join(", ") || "-"}]),` +
      ` peak surfaces ${plan.peak_surfaces} while the plan still had exceptions`,
  )
  console.log(
    `off  arm: mirror ${off.final_mirror_state}, ${off.continuation_prompts} continuations,` +
      ` nudged on turns [${off.nudged_turns.join(", ") || "-"}], peak surfaces ${off.peak_surfaces}`,
  )
  console.log("")

  const failures = []
  const target = (label, body) => {
    try {
      body()
      console.log(`PASS  ${label}`)
    } catch (error) {
      failures.push({ label, error })
      console.log(`FAIL  ${label}: ${error.message}`)
    }
  }

  target('divergence is 0 under mirrorTodos "plan"', () => {
    assert.equal(plan.divergence, 0)
  })
  target('the sidebar renders ONE persistent checklist under "plan" with a clean plan', () => {
    assert.equal(plan.persistent_surfaces, 1)
  })
  // The control. Without it, both targets above are satisfied by a benchmark that
  // measured nothing: an arm that never ran the mirror would have to come out
  // different, and here it does.
  target('CONTROL — "off" diverges on every turn and renders TWO checklists', () => {
    assert.equal(off.divergence, TURNS, "the pre-v1.0.1 arm must diverge on every turn")
    assert.equal(off.persistent_surfaces, 2)
    assert.notEqual(plan.divergence, off.divergence)
    assert.notEqual(plan.persistent_surfaces, off.persistent_surfaces)
  })
  target("turns-to-first-evidence does not regress — the mirror is not a bookkeeping tax", () => {
    assert.ok(
      plan.turns_to_first_evidence <= off.turns_to_first_evidence,
      `plan reached evidence on turn ${plan.turns_to_first_evidence}, off on turn ${off.turns_to_first_evidence}`,
    )
  })

  // Determinism is a release-gate property, not a nicety: this script runs inside
  // `release:check`, so a metric that moved run to run would turn the chain red at
  // random. Re-run both arms and compare the measured numbers.
  const repeat = { off: await runArm("off", "off"), plan: await runArm("plan", "plan") }
  target("the benchmark is deterministic — a second run measures the same numbers", () => {
    for (const [name, first, second] of [
      ["off", off, repeat.off],
      ["plan", plan, repeat.plan],
    ]) {
      assert.deepEqual(second.perTurn, first.perTurn, `${name} arm drifted between runs`)
      for (const [, key] of ROWS) assert.deepEqual(second[key], first[key], `${name} arm: ${key} drifted`)
    }
  })

  console.log("")
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        benchmark: "opencode-goal-pro-max-complete-plugin-todo-mirror",
        turns: TURNS,
        planActions: PLAN_ACTIONS.length,
        modelRows: MODEL_TODOS.length,
        modelCalls: 0,
        externalRequests: 0,
        arms: {
          off: { ...off, perTurn: undefined },
          plan: { ...plan, perTurn: undefined },
        },
        passed: failures.length === 0,
      },
      null,
      2,
    ),
  )

  if (failures.length) {
    for (const failure of failures) console.error(`FAILED: ${failure.label}\n${failure.error.stack}`)
    process.exitCode = 1
    return
  }
  console.log("\ntodo mirror behaviour benchmark passed")
}

await main()
