// v1.0.1 T30 — shipped host-args aliasing regression test.
//
// Promotes /tmp/promax-todo/argmut.mjs into the suite (design F1, DESIGN-v1.0.1.md
// section 5.3, lines 794-798). It replicates the OpenCode host's own call shape for a
// tool invocation, confirmed at opencode source SHA 16747470f976aca3d362ad730bcd3fe82ecc2c9a:
//
//   packages/opencode/src/session/tools.ts:106 (execute)  — `yield* plugin.trigger(
//     "tool.execute.before", { tool, sessionID, callID }, { args })`: the host boxes
//     the tool's own `args` object as `output.args` and hands the box to every hook.
//   packages/opencode/src/session/tools.ts:111 (execute)  — `const result = yield*
//     item.execute(args, ctx)`: the host then calls the tool's `execute` with the
//     ORIGINAL `args` variable from its own closure, never with `output.args`.
//   packages/opencode/src/plugin/index.ts:294 (trigger)   — `yield* Effect.promise(
//     async () => fn(input, output))`: each hook function is awaited in turn against
//     the same `output` object; nothing clones it between hooks.
//
// The consequence (F1, CONFIRMED): a hook that does `output.args.todos = rows` (a
// property write on the boxed object) is visible to `execute`, because `output.args`
// and the host's own `args` are the same reference. A hook that does
// `output.args = { ...output.args, todos }` (a reassignment) is invisible to
// `execute`, because reassigning `output.args` only repoints the box's own field —
// it does not touch the host's `args` variable. This is exactly why T10's before-hook
// (src/goal-plugin.js, "tool.execute.before") is written as the former and never the
// latter (mutation anchor 1, scripts/mutation-contract.mjs).
//
// Two arms below, replicating the host shape with a minimal inline `hostCallTool`:
//   (1) the plugin's REAL before-hook, driven through a real goal + plan, mutates
//       `output.args.todos` in place — `execute` sees the mirrored rows.
//   (2) CONTROL: a hook that reassigns `output.args` — `execute` sees the model's
//       original rows, unchanged. The two arms must produce different results.
// Both arms also assert on identity, not just on content: `execute` must receive the
// exact object reference the box held at the moment it was constructed, so a future
// host that starts cloning `args` between the hook and `execute` — which would sever
// this aliasing and silently defeat the mirror hook's writes — turns this file red
// instead of leaving the regression to be found in production.

import assert from "node:assert/strict"
import test from "node:test"
import { GoalPlugin, testInternals } from "../src/goal-plugin.js"

const { buildAgentToolHandlers, currentGoal, normalizeOptions } = testInternals

// Minimal client, matching the shape goal-plugin.test.js's own `createHooks` helper
// builds: enough for GoalPlugin to construct without touching a real OpenCode SDK.
// Nothing on it is called by the "tool.execute.before" hook itself when
// `persistState: false` (ensureSessionLoaded is then a no-op), so this client is
// never actually invoked by either test below — it only satisfies construction.
function minimalClient() {
  return {
    app: { log: async () => {} },
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async () => ({}),
      abort: async () => ({}),
    },
  }
}

function makeAgentHandlers() {
  return buildAgentToolHandlers({
    defaultGoalOptions: normalizeOptions(),
    persist: async () => {},
  })
}

// Replicates packages/opencode/src/plugin/index.ts:284-297 (`trigger`): a list of
// hook maps, each awaited in turn against the SAME output object if it implements
// the named hook.
async function hostTrigger(hookList, name, input, output) {
  for (const hook of hookList) {
    const fn = hook[name]
    if (!fn) continue
    await fn(input, output)
  }
  return output
}

// Replicates packages/opencode/src/session/tools.ts:102-111 (`execute`): box the
// tool's own `args` as `output.args`, run "tool.execute.before" against the box,
// then call the tool's `execute` with the ORIGINAL `args` reference — never with
// `output.args` — exactly as the host does at :111.
async function hostCallTool(hookList, { tool, sessionID, callID }, args, execute) {
  const output = { args }
  await hostTrigger(hookList, "tool.execute.before", { tool, sessionID, callID }, output)
  return execute(args)
}

test("the plugin's real before-hook mutates output.args.todos in place, so the host's execute call sees the mirrored rows", async () => {
  const sessionID = "host-args-aliasing-plugin-arm"
  // GoalPlugin's construction publishes `lastRuntime` (src/goal-plugin.js ~:9165,
  // read by currentRuntime() ~:229); the goal must be set AFTER the plugin exists
  // so both operate on the same runtime's `goalStates` map — setting it first
  // would orphan it the moment this file's plugin instance is created.
  const hooks = await GoalPlugin({ client: minimalClient() }, { persistState: false })
  const handlers = makeAgentHandlers()
  await handlers.setGoal(sessionID, { objective: "ship the todo mirror" })
  await handlers.setPlan(sessionID, { actions: [{ id: "a1", title: "write the code" }] })
  assert.equal(currentGoal(sessionID).plan.actions.length, 1, "the plan must be recorded before the hook runs")

  const args = { todos: [{ content: "model wrote this", status: "pending", priority: "low" }] }
  let paramsSeenByExecute
  const contentSeenByExecute = await hostCallTool(
    [hooks],
    { tool: "todowrite", sessionID, callID: "call-plugin-arm" },
    args,
    (params) => {
      paramsSeenByExecute = params
      return params.todos.map((row) => row.content)
    },
  )

  // The mirrored plan row comes first, with the model's own row kept as an extra
  // below it — both written into `output.args.todos` in place (mutation anchor 1).
  assert.deepEqual(contentSeenByExecute, ["a1 · write the code", "model wrote this"])
  // Identity: `execute` was handed the exact object the box held, not a clone —
  // this is the assertion that fails loudly if a host stops aliasing.
  assert.equal(paramsSeenByExecute, args, "execute must receive the same args object the tool.execute.before box held")
  assert.equal(args.todos, paramsSeenByExecute.todos)
})

test("CONTROL: a hook that reassigns output.args is invisible to the host's execute call", async () => {
  const originalTodos = [{ content: "model wrote this", status: "pending", priority: "low" }]
  const args = { todos: originalTodos }
  const reassigningHook = {
    "tool.execute.before": async (input, output) => {
      output.args = { todos: [{ content: "REASSIGNED", status: "pending", priority: "high" }] }
    },
  }

  let paramsSeenByExecute
  const contentSeenByExecute = await hostCallTool(
    [reassigningHook],
    { tool: "todowrite", sessionID: "host-args-aliasing-control-arm", callID: "call-control-arm" },
    args,
    (params) => {
      paramsSeenByExecute = params
      return params.todos.map((row) => row.content)
    },
  )

  // The reassignment never reaches the host: execute still sees the model's
  // original row, because the host calls `item.execute(args, ctx)` with its own
  // `args` variable, never with `output.args` (tools.ts:111).
  assert.deepEqual(contentSeenByExecute, ["model wrote this"])
  // Same identity assertion as the plugin arm, and the same reference the caller
  // started with — reassigning `output.args` provably never touched it.
  assert.equal(paramsSeenByExecute, args)
  assert.equal(args.todos, originalTodos)
})

test("the two arms disagree: an in-place write reaches execute, a reassignment does not", async () => {
  // A single run of both shapes against the identical starting args, so a future
  // edit that accidentally makes them agree (e.g. hostCallTool changed to read
  // `output.args` instead of `args`) cannot pass by only running one arm.
  const startingTodos = () => [{ content: "model wrote this", status: "pending", priority: "low" }]

  const inPlaceHook = {
    "tool.execute.before": async (input, output) => {
      output.args.todos = [{ content: "MIRRORED", status: "pending", priority: "high" }]
    },
  }
  const reassigningHook = {
    "tool.execute.before": async (input, output) => {
      output.args = { todos: [{ content: "REASSIGNED", status: "pending", priority: "high" }] }
    },
  }
  const execute = (params) => params.todos.map((row) => row.content)

  const inPlaceResult = await hostCallTool(
    [inPlaceHook],
    { tool: "todowrite", sessionID: "host-args-aliasing-diff-inplace", callID: "call-diff-inplace" },
    { todos: startingTodos() },
    execute,
  )
  const reassignedResult = await hostCallTool(
    [reassigningHook],
    { tool: "todowrite", sessionID: "host-args-aliasing-diff-reassign", callID: "call-diff-reassign" },
    { todos: startingTodos() },
    execute,
  )

  assert.deepEqual(inPlaceResult, ["MIRRORED"])
  assert.deepEqual(reassignedResult, ["model wrote this"])
  assert.notDeepEqual(inPlaceResult, reassignedResult)
})
