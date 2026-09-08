// Real-host smoke for the Todo mirror's DESTRUCTIVE paths (design 5.4, script 2).
//
// Every assertion here is about rows SURVIVING, not about rows changing — which
// is why it is a separate script from `smoke:todo-mirror`. It is the run that
// would have caught revision 1's data-loss bug: an empty `todowrite` arriving
// after the goal record is gone must re-emit the last mirrored rows instead of
// wiping the user's list, and it must still mean "clear the list" in a session
// that never had a goal.
//
// Nothing is faked except the model. The plugin is installed the production
// way, `opencode serve` runs headless against an isolated HOME/XDG tree, and
// the observables come off the real HTTP API:
//   * GET /session/:id/todo     (routes/instance/httpapi/groups/session.ts:156 `todo`)
//   * GET /session/:id/message  (routes/instance/httpapi/groups/session.ts:179 `messages`)
//   * GET /experimental/tool    (the live tool definitions, for F17)
// plus the plugin's own per-session state file under the isolated project cwd,
// which is where `goal.mirror.nudges` lives.
//
// Requires the `opencode` binary on PATH and a bundled `dist/` (`npm run bundle`)
// — the installer copies `dist/`, so a stale bundle smokes the OLD code. It is
// deliberately NOT part of `release:check`: the binary is not a dev dependency.
//
// Usage: npm run smoke:todo-safety
//
// Arms (all five sessions share ONE isolated host and one mock; the mock routes
// on a token in the conversation, so no per-arm model declaration is needed):
//   STOP      design step 6 — mirror, `/goal stop`, then todowrite({todos: []})
//   CONTROL   design step 6 — the same empty call with no goal, must clear
//   COMPLETE  design step 7 — the same after a genuine [goal:complete]
//   HANDBACK  design step 7 — the handback line in a completion RESPONSE (X2)
//   BASH      design step 8 — a `bash` call must not touch the mirror
// Design step 9's two captures (F17, F19) are printed as OBSERVED lines.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { promisify } from "node:util"

import {
  MOCK_MODEL_ID,
  MOCK_MODEL_REF,
  MOCK_PROVIDER_ID,
  bootHost,
  promptSession,
  readHostLog,
  routeByConversation,
  runGoalCommand,
  sleep,
  stepResponder,
  waitForTodos,
} from "./lib/todo-smoke-host.mjs"

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scratch =
  process.env.SMOKE_TODO_SAFETY_DIR || path.join(process.env.TMPDIR || "/tmp", "opencode-goal-todo-safety-smoke")

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

const ID_SEPARATOR = " · "
// The exact bytes of the T17 handback (CONTRACTS "Strings"), with ${N} left open.
const HANDBACK_HEAD = "The Todo list still shows this plan's "
const HANDBACK_TAIL = " rows. It is yours again: your next todowrite replaces it."
const handbackLine = (rows) => `${HANDBACK_HEAD}${rows}${HANDBACK_TAIL}`

const PLAN_ACTIONS = [
  { id: "a1", title: "Mirror the plan into the native todo list" },
  { id: "a2", title: "Prove an empty todowrite cannot wipe it" },
  { id: "a3", title: "Record the verdict" },
]

// A plan that already satisfies the CEV gate, so a completion claim is accepted
// rather than re-prompted: with a recorded plan the plugin refuses completion
// unless every action is `done` with a claim, falsifying evidence and
// verdict=pass (skills/using-the-goal-plugin/SKILL.md §5, "The plan outranks the
// markers").
const VERIFIED_PLAN_ACTIONS = PLAN_ACTIONS.map((action) => ({
  ...action,
  status: "done",
  claim: `${action.title} is finished`,
  evidence: "GET /session/{id}/todo returned the mirrored rows in plan order",
  verdict: "pass",
}))

const MODEL_ROWS = [
  { content: "Draft the safety smoke", status: "in_progress", priority: "high" },
  { content: "Read the terminal snapshot path", status: "pending", priority: "medium" },
]

// The model laundering a2 to `completed` plus two rows of its own — the same
// divergent shape the mirror smoke uses, so the mirrored list here is 3 plan
// rows + 2 extras. The laundered row is mirror-owned, so it is NOT kept as an
// extra; it is redrawn from the plan.
const LAUNDERED_ROW = {
  content: `a2${ID_SEPARATOR}${PLAN_ACTIONS[1].title}`,
  status: "completed",
  priority: "high",
}
const DIVERGENT_TODOS = [LAUNDERED_ROW, ...MODEL_ROWS]
const MIRRORED_ROW_COUNT = PLAN_ACTIONS.length + MODEL_ROWS.length

// Routing tokens. Each one goes into exactly one session — in the `/goal set`
// arguments (which the plugin echoes into every continuation's <goal> block) or
// in the arm's first prompt — so one mock model serves five independent scripts.
const ARM_STOP = "smoke-arm-stop"
const ARM_COMPLETE = "smoke-arm-complete"
const ARM_HANDBACK = "smoke-arm-handback"
const ARM_BASH = "smoke-arm-bash"
const ARM_CONTROL = "smoke-arm-control"
// The gate that holds a step back until the driver has finished the destructive
// step it is meant to follow.
const REFRESH = "smoke-refresh-now"
const gateOnRefresh = ({ text }) => text.includes(REFRESH)

// The completion claim. The last two non-blank lines must be the evidence line
// then the marker, consecutive, with nothing after (SKILL.md §5).
const COMPLETION_TEXT = [
  "Every action is recorded done with claim, evidence and a passing verdict.",
  "[goal:evidence] GET /session/{id}/todo returned the mirrored plan rows in plan order.",
  "[goal:complete]",
].join("\n")

const COMPLETION_CLAIM = {
  summary: "The plan was mirrored into the session's native todo list and every action is verified.",
  criteria: [
    {
      criterion: "The host todo list is drawn from the plan",
      evidence: [`GET /session/{id}/todo returned ${MIRRORED_ROW_COUNT} rows, the first three prefixed a1/a2/a3`],
    },
  ],
  checks: [{ command: "GET /session/{id}/todo", result: "passed", exitCode: 0 }],
}

function mockRoutes() {
  return routeByConversation({
    [ARM_STOP]: stepResponder({
      steps: [
        { id: "stop-plan", tool: "goal_plan_set", args: { actions: PLAN_ACTIONS } },
        { id: "stop-mirror", tool: "todowrite", args: { todos: DIVERGENT_TODOS } },
        { id: "stop-empty", tool: "todowrite", args: { todos: [] }, when: gateOnRefresh },
      ],
      finalText: "Plan recorded and the todo list refreshed.",
    }),
    [ARM_COMPLETE]: stepResponder({
      steps: [
        { id: "done-plan", tool: "goal_plan_set", args: { actions: VERIFIED_PLAN_ACTIONS } },
        { id: "done-mirror", tool: "todowrite", args: { todos: DIVERGENT_TODOS } },
        { id: "done-empty", tool: "todowrite", args: { todos: [] }, when: gateOnRefresh },
      ],
      finalText: COMPLETION_TEXT,
    }),
    [ARM_HANDBACK]: stepResponder({
      steps: [
        { id: "hand-plan", tool: "goal_plan_set", args: { actions: VERIFIED_PLAN_ACTIONS } },
        { id: "hand-mirror", tool: "todowrite", args: { todos: DIVERGENT_TODOS } },
        { id: "hand-complete", tool: "goal_complete", args: COMPLETION_CLAIM },
      ],
      finalText: "Completion submitted.",
    }),
    [ARM_BASH]: stepResponder({
      steps: [
        { id: "bash-plan", tool: "goal_plan_set", args: { actions: PLAN_ACTIONS } },
        { id: "bash-mirror", tool: "todowrite", args: { todos: DIVERGENT_TODOS } },
        // Fires while the mirror is FRESH.
        { id: "bash-fresh", tool: "bash", args: { command: "echo ok" } },
        // Makes the mirror stale, which is the only state in which a nudge can
        // be spent — so this is the positive control for the counter.
        { id: "bash-update", tool: "goal_action_update", args: { id: "a1", status: "in_progress" } },
        // Fires while the mirror is STALE and the goal is live: the call that
        // would consume a nudge if `bash` reached the mirror path at all.
        { id: "bash-stale", tool: "bash", args: { command: "echo ok" } },
        // The literal before/after: one more bash call, after the driver has
        // read the counter off disk.
        { id: "bash-after", tool: "bash", args: { command: "echo ok" }, when: gateOnRefresh },
      ],
      finalText: "Two actions remain.",
    }),
    [ARM_CONTROL]: stepResponder({
      steps: [{ id: "control-empty", tool: "todowrite", args: { todos: [] } }],
      finalText: "Todo list cleared.",
    }),
  })
}

/**
 * Record what the MOCK put on the wire, keyed by call id. Without this the
 * script cannot tell an empty `todowrite` from a mirrored one: the before-hook
 * rewrites `output.args.todos` in place, and the transcript part records the
 * REWRITTEN arguments (that is F19's verdict, below). The model's side of the
 * call only exists here.
 */
function recordEmissions(responder, sink) {
  return (body) => {
    const lines = responder(body)
    let pending
    for (const line of lines) {
      const call = line?.choices?.[0]?.delta?.tool_calls?.[0]
      if (!call) continue
      if (call.id) pending = { callID: call.id, tool: call.function?.name, args: "" }
      const chunk = call.function?.arguments
      if (pending && typeof chunk === "string") pending.args += chunk
    }
    if (pending) sink.set(pending.callID, pending)
    return lines
  }
}

// ---------------------------------------------------------------------------
// Result recorder — one PASS/FAIL line per observable, non-zero exit on any FAIL
// ---------------------------------------------------------------------------

const results = []

// The body must be SYNCHRONOUS: an async body resolves after `check` has
// already returned and records a vacuous PASS.
function check(label, body) {
  try {
    body()
    results.push({ label, ok: true })
    console.log(`PASS  ${label}`)
  } catch (error) {
    results.push({ label, ok: false, error })
    console.log(`FAIL  ${label}: ${error.message}`)
  }
}

function observe(label, detail) {
  console.log(`OBSERVED  ${label}: ${detail}`)
}

const rowShape = (rows) => rows.map((row) => ({ content: row.content, status: row.status, priority: row.priority }))
const contents = (rows) => rows.map((row) => row.content)

// ---------------------------------------------------------------------------
// Host observables
// ---------------------------------------------------------------------------

/** Every `{ info, parts }` message of a session, newest last. */
function messagesOf(api, sessionID) {
  return api.get(`/session/${sessionID}/message`, { query: { limit: "200" } })
}

/** Every transcript part for one tool id, in order. */
function toolParts(messages, toolName) {
  const found = []
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (part?.type === "tool" && part?.tool === toolName) found.push(part)
    }
  }
  return found
}

/** Every text the session carries, whatever role wrote it. */
function transcriptText(messages) {
  const chunks = []
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (typeof part?.text === "string") chunks.push(part.text)
    }
  }
  return chunks.join("\n")
}

/**
 * The plugin's per-session state file. The default location is
 * `<project cwd>/.opencode/goals/state.json` (`PROJECT_LOCAL_STATE_SUBPATH`),
 * with one directory per session keyed by sha256 of the session id
 * (`sessionDirectoryFor` / `sessionKey` in src/goal-plugin.js). The isolated
 * project cwd is the tree `makeIsolatedTree` created, so this is the only place
 * a goal record can be read from disk.
 */
function sessionStatePath(iso, sessionID) {
  const key = createHash("sha256").update(sessionID).digest("hex")
  return path.join(iso.cwd, ".opencode", "goals", "state.json.sessions", key, "state.json")
}

async function readSessionState(iso, sessionID) {
  const file = sessionStatePath(iso, sessionID)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * The persisted `goal.mirror` record for a session. The nudge counter is
 * incremented AFTER `updateAction`'s own persist, so it reaches disk on the
 * next write of the record — poll rather than read once.
 */
async function readMirrorRecord(iso, sessionID, { accept = () => true, timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const state = await readSessionState(iso, sessionID)
    const goal = Array.isArray(state?.goals) ? state.goals[0] : undefined
    last = goal?.mirror
    if (last && accept(last)) return last
    await sleep(250)
  }
  return last
}

/** Poll the state file until the goal record is gone and a result was archived. */
async function waitForArchivedGoal(iso, sessionID, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let state
  while (Date.now() < deadline) {
    state = await readSessionState(iso, sessionID)
    const gone = Array.isArray(state?.goals) && state.goals.length === 0
    const result = Array.isArray(state?.results) ? state.results[0] : undefined
    if (gone && result) return result
    await sleep(250)
  }
  return Array.isArray(state?.results) ? state.results[0] : undefined
}

/**
 * Drive one goal turn and wait for the plan to reach the host todo list. The
 * host runs the whole tool loop inside the command's turn, so a follow-up
 * prompt is normally unnecessary — and an unnecessary one pauses the goal as
 * "user intervention".
 */
async function mirrorPlan(host, title, token, { turns = 2 } = {}) {
  const session = await host.api.post("/session", { body: { title } })
  await runGoalCommand(host.api, session.id, `${token} prove the todo mirror is not destructive --max-turns ${turns}`, {
    model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
  })
  const enough = (list) => list.length >= MIRRORED_ROW_COUNT
  let rows = await waitForTodos(host.api, session.id, enough, { timeoutMs: 20_000 })
  if (!enough(rows)) {
    await promptSession(host.api, session.id, "continue", { model: MOCK_MODEL_REF })
    rows = await waitForTodos(host.api, session.id, enough, { timeoutMs: 20_000 })
  }
  return { session, rows }
}

function assertMirrored(label, rows) {
  check(label, () => {
    assert.equal(
      rows.length,
      MIRRORED_ROW_COUNT,
      `expected ${MIRRORED_ROW_COUNT} mirrored rows, saw ${rows.length}: ${JSON.stringify(contents(rows))}`,
    )
    for (const [index, action] of PLAN_ACTIONS.entries()) {
      assert.ok(
        rows[index].content.startsWith(`${action.id}${ID_SEPARATOR}`),
        `row ${index} is ${JSON.stringify(rows[index].content)}, expected it to start with ${action.id}${ID_SEPARATOR}`,
      )
    }
    assert.deepEqual(contents(rows.slice(PLAN_ACTIONS.length)), contents(MODEL_ROWS))
  })
}

/**
 * Wait for the empty `todowrite` an arm's script holds behind the refresh gate,
 * then return the todo list. The call is identified by CALL ID, not by its
 * recorded arguments: the before-hook rewrote those before the part was
 * recorded, so `state.input.todos` shows the mirrored rows even for the call the
 * model sent as `[]`.
 */
async function fireGatedEmptyTodowrite(host, sessionID, { emissions, callID, expectedCalls }) {
  await promptSession(host.api, sessionID, `${REFRESH} refresh the panel`, { model: MOCK_MODEL_REF })
  const deadline = Date.now() + 30_000
  let parts = []
  while (Date.now() < deadline) {
    parts = toolParts(await messagesOf(host.api, sessionID), "todowrite")
    if (parts.some((part) => part.callID === callID && part.state?.status === "completed")) break
    await sleep(250)
  }
  const rows = await host.api.get(`/session/${sessionID}/todo`)
  const emitted = emissions.get(callID)
  return { parts, rows, emitted, expectedCalls }
}

function assertEmptyRefreshRan(label, { parts, emitted, callID, expectedCalls }) {
  check(label, () => {
    assert.ok(emitted, `the mock never emitted ${callID}`)
    assert.deepEqual(
      JSON.parse(emitted.args).todos,
      [],
      `the model sent ${emitted.args} for ${callID}, not an empty list`,
    )
    assert.equal(parts.length, expectedCalls, `expected ${expectedCalls} todowrite calls, saw ${parts.length}`)
    const part = parts.find((entry) => entry.callID === callID)
    assert.ok(part, `no transcript part for ${callID}: ${JSON.stringify(parts.map((entry) => entry.callID))}`)
    assert.equal(part.state?.status, "completed", `${callID} state: ${part.state?.status}`)
  })
}

// ---------------------------------------------------------------------------
// Arm STOP (design step 6) + its CONTROL
// ---------------------------------------------------------------------------

async function stopArm(host, emissions) {
  const { session, rows } = await mirrorPlan(host, "todo safety — stop", ARM_STOP)
  assertMirrored("STOP: the plan is mirrored into the host todo list before the goal ends", rows)

  await runGoalCommand(host.api, session.id, "stop", { model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}` })
  const afterStop = transcriptText(await messagesOf(host.api, session.id))
  check("STOP: the /goal stop response hands the list back and names the row count (X2)", () => {
    assert.ok(
      afterStop.includes(handbackLine(rows.length)),
      `the /goal stop response does not carry ${JSON.stringify(handbackLine(rows.length))}`,
    )
  })

  const fired = await fireGatedEmptyTodowrite(host, session.id, {
    emissions,
    callID: "call_stop-empty",
    expectedCalls: 2,
  })
  assertEmptyRefreshRan("STOP: the model's empty todowrite really ran after the goal was stopped", {
    ...fired,
    callID: "call_stop-empty",
  })
  check("STOP: after /goal stop an empty todowrite leaves the mirrored rows standing", () => {
    assert.deepEqual(rowShape(fired.rows), rowShape(rows))
  })

  return { session, rows, parts: fired.parts }
}

async function controlArm(host, emissions) {
  const session = await host.api.post("/session", { body: { title: "todo safety — control" } })
  await promptSession(host.api, session.id, `${ARM_CONTROL} clear the todo list`, { model: MOCK_MODEL_REF })
  const deadline = Date.now() + 30_000
  let parts = []
  while (Date.now() < deadline) {
    parts = toolParts(await messagesOf(host.api, session.id), "todowrite")
    if (parts.some((part) => part.state?.status === "completed")) break
    await sleep(250)
  }
  const rows = await host.api.get(`/session/${session.id}/todo`)
  assertEmptyRefreshRan("CONTROL: the empty todowrite really ran in a session that never had a goal", {
    parts,
    emitted: emissions.get("call_control-empty"),
    callID: "call_control-empty",
    expectedCalls: 1,
  })
  check("CONTROL: with no goal the same empty todowrite still means an empty list", () => {
    assert.deepEqual(rows, [], `expected [], saw ${JSON.stringify(rowShape(rows))}`)
    // The mirror left the args alone, so the transcript shows what was sent.
    assert.deepEqual(parts[0]?.state?.input?.todos, [])
  })
  return rows
}

// ---------------------------------------------------------------------------
// Arm COMPLETE (design step 7)
// ---------------------------------------------------------------------------

async function completeArm(host, emissions) {
  const { session, rows } = await mirrorPlan(host, "todo safety — completion", ARM_COMPLETE)
  assertMirrored("COMPLETE: the plan is mirrored before the completion claim", rows)

  const archived = await waitForArchivedGoal(host.iso, session.id)
  check("COMPLETE: the [goal:complete] marker was accepted and the goal archived", () => {
    assert.ok(archived, "no archived result reached the plugin's state file")
    assert.equal(archived.state, "achieved", `archived state is ${archived.state}`)
  })

  const fired = await fireGatedEmptyTodowrite(host, session.id, {
    emissions,
    callID: "call_done-empty",
    expectedCalls: 2,
  })
  assertEmptyRefreshRan("COMPLETE: the model's empty todowrite really ran after the goal completed", {
    ...fired,
    callID: "call_done-empty",
  })
  check("COMPLETE: after a genuine completion an empty todowrite leaves the mirrored rows standing", () => {
    assert.deepEqual(rowShape(fired.rows), rowShape(rows))
  })

  return { session, rows }
}

// ---------------------------------------------------------------------------
// Arm HANDBACK (design step 7, X2)
// ---------------------------------------------------------------------------

/**
 * The marker path's handback rides `announceLifecycle`, whose only surfaces are
 * a TUI toast (absent under `opencode serve`) and `client.app.log` — and the
 * host's log file is buffered and does NOT flush on SIGTERM, so it cannot carry
 * a late-run assertion. `goal_complete` is the structured alternative SKILL.md
 * §5 documents for exactly this reason, and on that path the handback rides the
 * TOOL RESULT, which the transcript keeps forever.
 */
async function handbackArm(host) {
  const { session, rows } = await mirrorPlan(host, "todo safety — handback", ARM_HANDBACK)
  assertMirrored("HANDBACK: the plan is mirrored before goal_complete is called", rows)

  const deadline = Date.now() + 30_000
  let part
  while (Date.now() < deadline) {
    part = toolParts(await messagesOf(host.api, session.id), "goal_complete").find(
      (entry) => entry.state?.status === "completed",
    )
    if (part) break
    await sleep(250)
  }
  const archived = await waitForArchivedGoal(host.iso, session.id)
  check("HANDBACK: goal_complete archived the goal", () => {
    assert.ok(archived, "no archived result reached the plugin's state file")
    assert.equal(archived.state, "achieved", `archived state is ${archived.state}`)
  })
  check("HANDBACK: the completion response carries the handback line (X2)", () => {
    assert.ok(part, "goal_complete never produced a completed transcript part")
    const envelope = JSON.parse(part.state.output)
    assert.equal(envelope.ok, true, `goal_complete returned ${part.state.output}`)
    assert.ok(
      envelope.message.includes(handbackLine(rows.length)),
      `the completion response does not carry ${JSON.stringify(handbackLine(rows.length))}: ${envelope.message}`,
    )
  })
  return { session, rows }
}

// ---------------------------------------------------------------------------
// Arm BASH (design step 8, X3/F22)
// ---------------------------------------------------------------------------

async function bashArm(host) {
  const { session, rows } = await mirrorPlan(host, "todo safety — bash", ARM_BASH)
  assertMirrored("BASH: the plan is mirrored, so the session really is a mirroring one", rows)

  // `/goal pause` persists the goal record, which is what flushes the nudge the
  // action update spent: mirrorNudgeLine increments AFTER updateAction's own
  // persist, so without a later write it would still be in memory only.
  await runGoalCommand(host.api, session.id, "pause", { model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}` })
  const before = await readMirrorRecord(host.iso, session.id, { accept: (mirror) => mirror.nudges > 0 })

  const messagesBefore = await messagesOf(host.api, session.id)
  const bashBefore = toolParts(messagesBefore, "bash")
  check("BASH: two bash calls ran inside the mirroring turn", () => {
    assert.ok(bashBefore.length >= 2, `expected at least 2 bash calls, saw ${bashBefore.length}`)
    for (const part of bashBefore) assert.equal(part.state?.status, "completed", "a bash call did not complete")
  })

  check("BASH: the goal_action_update spent exactly one nudge and the bash calls spent none", () => {
    assert.ok(before, "no persisted goal.mirror record for the session")
    // The positive control: a 0 here would make the "unchanged" assertion below
    // vacuous, because nothing would have been there to change.
    assert.equal(
      before.nudges,
      1,
      `expected exactly 1 nudge (the single goal_action_update); saw ${before.nudges}. ` +
        "Two bash calls ran in the same turn, one of them with the mirror stale.",
    )
  })

  // The literal before/after: one more bash call, with the counter already read.
  await promptSession(host.api, session.id, `${REFRESH} run the check again`, { model: MOCK_MODEL_REF })
  const deadline = Date.now() + 30_000
  let bashAfter = bashBefore
  while (Date.now() < deadline) {
    bashAfter = toolParts(await messagesOf(host.api, session.id), "bash")
    if (bashAfter.length > bashBefore.length) break
    await sleep(250)
  }
  const after = await readMirrorRecord(host.iso, session.id, { accept: () => true, timeoutMs: 5000 })

  check("BASH: goal.mirror.nudges did not move across a bash call", () => {
    assert.ok(bashAfter.length > bashBefore.length, "the extra bash call never ran, so nothing was measured")
    assert.ok(after, "no persisted goal.mirror record after the bash call")
    assert.equal(after.nudges, before.nudges, `nudges moved ${before.nudges} -> ${after.nudges}`)
    assert.equal(after.rows.length, rows.length, "the mirrored row record changed across a bash call")
  })

  check("BASH: bash's arguments gained no `todos` key (X3, F22)", () => {
    assert.ok(bashAfter.length >= 3, `expected 3 bash calls, saw ${bashAfter.length}`)
    for (const part of bashAfter) {
      const input = part.state?.input ?? {}
      assert.equal(input.command, "echo ok", `bash input.command is ${JSON.stringify(input.command)}`)
      assert.equal(
        Object.hasOwn(input, "todos"),
        false,
        `bash args gained a todos key: ${JSON.stringify(Object.keys(input))}`,
      )
    }
    // The positive control for the same read: the mirrored todowrite DOES carry
    // a todos key on the very same surface, so "no todos key" is a fact about
    // bash and not about how this script reads the transcript.
    const mirrored = toolParts(messagesBefore, "todowrite")[0]
    assert.ok(Array.isArray(mirrored?.state?.input?.todos), "todowrite's transcript input carries no todos array")
  })

  return { session, rows, before, after }
}

// ---------------------------------------------------------------------------
// Design step 9 — the two facts the in-tree suite cannot close
// ---------------------------------------------------------------------------

async function captureF17(host) {
  const definitions = await host.api.get("/experimental/tool", {
    query: { provider: MOCK_PROVIDER_ID, model: MOCK_MODEL_ID },
  })
  const todowrite = (Array.isArray(definitions) ? definitions : []).find((entry) => entry.id === "todowrite")
  const goalTools = host.toolIDs.filter((id) => id.startsWith("goal_")).length
  observe(
    "F17 — which todowrite implementation executed",
    todowrite
      ? `the host builtin (packages/opencode/src/tool/todo.ts:15 \`TodoWriteTool\`), decorated by the plugin's ` +
          `tool.definition hook: description ${todowrite.description.length} chars, GOAL PLUGIN paragraph ` +
          `${todowrite.description.includes("GOAL PLUGIN:") ? "present" : "ABSENT"}. The plugin registers ` +
          `${goalTools} goal_* tools and no todowrite of its own, and the rows landed in the host's own todo table.`
      : "not reported by /experimental/tool",
  )
}

function captureF19(parts, emissions) {
  const mirrored = parts.find((part) => part.callID === "call_stop-mirror") ?? parts[0]
  const input = mirrored?.state?.input?.todos
  const metadata = mirrored?.state?.metadata?.todos
  const sent = contents(DIVERGENT_TODOS)
  const inputContents = Array.isArray(input) ? contents(input) : null
  const metadataContents = Array.isArray(metadata) ? contents(metadata) : null
  const emitted = emissions.get("call_stop-mirror")
  const emittedContents = emitted ? contents(JSON.parse(emitted.args).todos) : null
  const inputIsPreMirror = JSON.stringify(inputContents) === JSON.stringify(sent)
  observe(
    "F19 — the transcript tool-call part for the mirrored todowrite",
    `the model SENT ${JSON.stringify(emittedContents)}; the part records input.todos = ` +
      `${JSON.stringify(inputContents)} and metadata.todos = ${JSON.stringify(metadataContents)}`,
  )
  observe(
    "F19 — verdict",
    inputIsPreMirror
      ? "OPEN AS FEARED — `input` shows the model's PRE-MIRROR wording, so a todowrite transcript bubble still " +
          "renders the un-mirrored list even though the panel and the host table hold the mirrored rows."
      : JSON.stringify(inputContents) === JSON.stringify(metadataContents)
        ? "CLOSED — `input` and `metadata` both show the MIRRORED rows, not the wording the model sent, so the " +
          "transcript bubble agrees with the panel and the host table. `tool.execute.before` rewrites " +
          "`output.args.todos` in place and the host records the part from that same object, so the rewrite " +
          "reaches the transcript. (Design 5.5's `count(todowrite transcript bubbles showing pre-mirror wording)` " +
          "is therefore 0 for the mirrored call, and the empty-refresh call renders as the re-emitted rows.)"
        : `INDETERMINATE — input and metadata disagree and input is not the sent list either: ${JSON.stringify(inputContents)}`,
  )
  return { inputContents, metadataContents, inputIsPreMirror }
}

// ---------------------------------------------------------------------------

async function main() {
  const { version } = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"))
  const hostVersion = await execFileAsync("opencode", ["--version"]).then(
    (out) => out.stdout.trim(),
    () => "MISSING",
  )
  if (hostVersion === "MISSING") {
    console.error("FAIL  the `opencode` binary is not on PATH; this smoke needs the real host")
    process.exitCode = 1
    return
  }
  console.log(`todo safety smoke — plugin ${version}, opencode ${hostVersion}, scratch ${scratch}`)

  // The installer copies `dist/`, so an unbundled tree smokes the OLD code and
  // every observable below would be a claim about the last build. mtime alone is
  // not enough — `git checkout -- dist` restores an OLD bundle with a NEW mtime
  // — so the bundle must also be able to produce the string this script asserts.
  const [sourceStat, bundleStat] = await Promise.all([
    stat(path.join(repoRoot, "src", "goal-plugin.js")),
    stat(path.join(repoRoot, "dist", "goal-plugin.js")).catch(() => null),
  ])
  if (!bundleStat) {
    console.error("FAIL  dist/goal-plugin.js is missing; run `npm run bundle` first")
    process.exitCode = 1
    return
  }
  if (bundleStat.mtimeMs < sourceStat.mtimeMs) {
    console.error("FAIL  dist/goal-plugin.js is older than src/goal-plugin.js; run `npm run bundle` first")
    process.exitCode = 1
    return
  }
  const bundle = await readFile(path.join(repoRoot, "dist", "goal-plugin.js"), "utf8")
  if (!bundle.includes(HANDBACK_HEAD)) {
    console.error("FAIL  dist/goal-plugin.js carries no todo-mirror handback; run `npm run bundle` first")
    process.exitCode = 1
    return
  }

  const emissions = new Map()
  const host = await bootHost({
    repoRoot,
    root: path.join(scratch, "safety"),
    respond: recordEmissions(mockRoutes(), emissions),
    logPath: path.join(scratch, "safety-serve.log"),
    requiredToolIDs: ["goal_plan_set", "goal_action_update", "goal_complete", "todowrite", "bash"],
  })
  let stop
  let complete
  try {
    check("the production loader registered the plugin's tools alongside todowrite and bash", () => {
      for (const id of ["goal_plan_set", "goal_action_update", "goal_complete", "todowrite", "bash"]) {
        assert.ok(host.toolIDs.includes(id), `${id} missing from /experimental/tool/ids`)
      }
    })

    stop = await stopArm(host, emissions)
    await controlArm(host, emissions)
    complete = await completeArm(host, emissions)
    await handbackArm(host)
    await bashArm(host)

    check("the two survival arms and the control disagree — the re-emission is real", () => {
      assert.equal(stop.rows.length, MIRRORED_ROW_COUNT)
      assert.equal(complete.rows.length, MIRRORED_ROW_COUNT)
      assert.deepEqual(contents(stop.rows), contents(complete.rows))
    })

    await captureF17(host)
    captureF19(stop.parts, emissions)
  } finally {
    await host.stop()
  }

  // OpenCode buffers `$XDG_DATA_HOME/opencode/log/opencode.log` and SIGTERM does
  // NOT flush it: a run of this length loses everything after the first second,
  // which is why the marker path's handback is reported rather than asserted.
  const handback = handbackLine(MIRRORED_ROW_COUNT)
  const log = await readHostLog(host.iso, { marker: handback, timeoutMs: 5000 })
  const lifecycle = log.split("\n").filter((line) => line.includes("kind=goal-lifecycle"))
  observe(
    "the marker path's handback surface",
    `[goal:complete] hands the list back through announceLifecycle (client.app.log + tui.showToast), not a tool ` +
      `result. Under \`opencode serve\` there is no TUI, and the host log kept only ${lifecycle.length} ` +
      `goal-lifecycle line(s) of this run (handback present: ${log.includes(handback)}) — the buffer is not ` +
      `flushed on SIGTERM. The HANDBACK arm asserts the same string on goal_complete's tool result instead.`,
  )

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} observables passed`)
  if (failed.length) {
    for (const result of failed) console.error(`FAILED: ${result.label}\n${result.error.stack}`)
    process.exitCode = 1
    return
  }
  console.log("todo safety host smoke passed")
}

await main()
