import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { GoalPlugin, testInternals } from "../src/goal-plugin.js"

const { currentGoal, normalizePersistedGoal } = testInternals

const MODEL = { providerID: "ferry", modelID: "big-model" }
const THRESHOLD = 200_000
const never = () => new Promise(() => {})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function eventually(check, label) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (check()) return
    await sleep(5)
  }
  assert.fail(`timed out waiting for ${label}`)
}

function assistantInfo(sessionID, id, total, extra = {}) {
  return {
    id,
    role: "assistant",
    sessionID,
    ...MODEL,
    tokens: { input: total - 100, output: 100, reasoning: 0 },
    ...extra,
  }
}

function assistant(sessionID, id, total, text = "made progress", extra = {}) {
  return {
    info: assistantInfo(sessionID, id, total, extra),
    parts: [{ type: "text", text }],
  }
}

// A host whose summarize stays pending, as the real one does until its run ends.
async function createHost(overrides = {}) {
  const host = { prompts: [], summarizes: [], logs: [], messages: [] }
  let counter = 0
  const client = {
    ...(overrides.config ? { config: overrides.config } : {}),
    app: {
      log: async (input) => {
        host.logs.push(input)
      },
    },
    session: {
      messages: async () => ({ data: host.messages }),
      promptAsync: async (input) => {
        host.prompts.push(input)
        counter += 1
        const sessionID = input?.path?.id || input?.sessionID
        const messageID = `routed-${counter}`
        await host.hooks["chat.message"](
          { sessionID, messageID, agent: "build" },
          {
            message: { id: messageID, role: "user", sessionID },
            parts: (input?.body?.parts || input?.parts || []).map((part, index) => ({
              ...part,
              id: `${messageID}-part-${index}`,
              messageID,
              sessionID,
            })),
          },
        )
        return {}
      },
      abort: async () => ({}),
    },
  }
  if (overrides.summarize !== null) {
    client.session.summarize = (input) => {
      host.summarizes.push(input)
      return (overrides.summarize || never)(input)
    }
  }
  host.client = client
  host.hooks = await GoalPlugin(
    { client, ...(overrides.directory ? { directory: overrides.directory } : {}) },
    {
      persistState: false,
      minDelayMs: 1,
      noToolCallTurnsBeforePause: 0,
      ...(overrides.options || {}),
    },
  )
  return host
}

async function startGoal(host, sessionID, args = "ship it") {
  await host.hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: args },
    { parts: [] },
  )
}

const updated = (host, info) =>
  host.hooks.event({ event: { type: "message.updated", properties: { info } } })

// One assistant step of a running turn, as message.updated reports it.
const step = (host, sessionID, id, total, finish = "tool-calls") =>
  updated(host, assistantInfo(sessionID, id, total, finish ? { finish } : {}))

const statusIdle = (host, sessionID) =>
  host.hooks.event({
    event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
  })

const statusBusy = (host, sessionID) =>
  host.hooks.event({
    event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
  })

const compacted = (host, sessionID) =>
  host.hooks.event({ event: { type: "session.compacted", properties: { sessionID } } })

// Ends a turn: its last assistant is what the idle pass reads from the host.
async function endTurn(host, sessionID, id, total, text) {
  host.messages = [assistant(sessionID, id, total, text)]
  await step(host, sessionID, id, total, null)
  await statusIdle(host, sessionID)
}

test("1. idle at 199,999 continues; idle at 200,000 compacts with exactly the model and no auto", async () => {
  const sessionID = "fc-idle-threshold"
  const host = await createHost()
  await startGoal(host, sessionID)

  await endTurn(host, sessionID, "below", THRESHOLD - 1)
  assert.equal(host.prompts.length, 1, "below the threshold the goal continues")
  assert.equal(host.summarizes.length, 0, "below the threshold nothing is forced")
  const turnsBefore = currentGoal(sessionID).turnCount

  await endTurn(host, sessionID, "at", THRESHOLD)
  assert.equal(host.summarizes.length, 1, "exactly at the threshold it forces")
  assert.deepEqual(host.summarizes[0], { path: { id: sessionID }, body: MODEL })
  assert.equal("auto" in host.summarizes[0].body, false)
  assert.equal(host.prompts.length, 1, "no continuation is sent with the request")
  const goal = currentGoal(sessionID)
  assert.equal(goal.turnCount, turnsBefore, "the forced request is not a turn")
  assert.equal(goal.continuationClaim, null, "the claim is cleared so a later idle is not deduped")
  assert.ok(goal.history.some((entry) => /forced compaction/i.test(entry.detail)))
})

test("2. a finished tool-calls step over the threshold compacts once and is not awaited", async () => {
  const sessionID = "fc-mid-turn"
  const host = await createHost()
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)

  await step(host, sessionID, "under", THRESHOLD - 1)
  assert.equal(host.summarizes.length, 0, "a step under the threshold does not trigger")

  const outcome = await Promise.race([
    step(host, sessionID, "over", THRESHOLD).then(() => "returned"),
    sleep(1000).then(() => "hung"),
  ])
  assert.equal(outcome, "returned", "the handler must not wait on the never-settling summarize")
  assert.equal(host.summarizes.length, 1)
  assert.deepEqual(host.summarizes[0], { path: { id: sessionID }, body: MODEL })

  // The host repeats message.updated for one step, then more steps arrive.
  await step(host, sessionID, "over", THRESHOLD)
  await step(host, sessionID, "over-2", THRESHOLD + 10)
  assert.equal(host.summarizes.length, 1, "a request is already pending")
  assert.equal(host.prompts.length, 0)
})

test("3. summaries, delegated, stale, stopped and unfinished messages do not trigger", async () => {
  const sessionID = "fc-exclusions"
  const host = await createHost()
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)

  await updated(
    host,
    assistantInfo(sessionID, "summary", THRESHOLD * 3, {
      finish: "stop",
      summary: true,
      mode: "compaction",
      agent: "compaction",
    }),
  )
  assert.equal(host.summarizes.length, 0, "a summary message carries pre-compaction tokens")

  await step(host, sessionID, "streaming", THRESHOLD, null)
  assert.equal(host.summarizes.length, 0, "an unfinished assistant does not trigger")

  // Delegated: the usage reaches the goal, proving the child path really ran.
  const child = `${sessionID}-child`
  await host.hooks.event({
    event: { type: "session.updated", properties: { sessionID: child, info: { id: child, parentID: sessionID } } },
  })
  const spendBefore = currentGoal(sessionID).usage.input
  await step(host, child, "child-step", THRESHOLD * 2)
  assert.ok(currentGoal(sessionID).usage.input > spendBefore, "the child step reached the goal")
  assert.equal(host.summarizes.length, 0, "a child's context is not the goal's context")

  // Stale: seen before a compaction, re-delivered finished after it.
  await step(host, sessionID, "in-flight", 10, null)
  await compacted(host, sessionID)
  await step(host, sessionID, "in-flight", THRESHOLD)
  assert.equal(host.summarizes.length, 0, "a message stale for context does not trigger")

  // Stopped. Control first: the same step on a running goal does trigger.
  const stoppedSession = `${sessionID}-stopped`
  await startGoal(host, stoppedSession)
  currentGoal(stoppedSession).stopped = true
  await step(host, stoppedSession, "stopped-step", THRESHOLD)
  assert.equal(host.summarizes.length, 0, "a stopped goal does not trigger")
  currentGoal(stoppedSession).stopped = false
  await step(host, stoppedSession, "running-step", THRESHOLD)
  assert.equal(host.summarizes.length, 1, "control: a running goal triggers")
})

test("4. after session.compacted the next idle continues the goal", async () => {
  const sessionID = "fc-resume"
  const host = await createHost()
  await startGoal(host, sessionID)

  await endTurn(host, sessionID, "at", THRESHOLD)
  assert.equal(host.summarizes.length, 1)
  assert.equal(host.prompts.length, 0)

  // The host's order: the summary update, session.compacted, then idle.
  await updated(
    host,
    assistantInfo(sessionID, "summary", THRESHOLD, { finish: "stop", summary: true, mode: "compaction" }),
  )
  await compacted(host, sessionID)
  const goal = currentGoal(sessionID)
  assert.equal(goal.compactionEpoch, 1)
  assert.equal(currentGoal(sessionID).latestContextTokens, 0)
  assert.equal(goal.compactionSourceAssistantMessageID, "at", "the scored turn stays the source")

  await statusIdle(host, sessionID)
  assert.equal(host.prompts.length, 1, "the goal resumes after compacting")
  assert.equal(host.summarizes.length, 1, "and does not compact again")
  assert.equal(goal.forcedCompaction.failures, 0, "a successful flow counts no failure")
})

test("4b. a step-triggered compaction ending in compacted then idle counts no failure", async () => {
  const sessionID = "fc-resume-step"
  const host = await createHost()
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)
  await step(host, sessionID, "over", THRESHOLD)
  assert.equal(host.summarizes.length, 1)
  host.messages = [assistant(sessionID, "over", THRESHOLD)]

  await compacted(host, sessionID)
  await statusIdle(host, sessionID)
  const goal = currentGoal(sessionID)
  assert.equal(goal.forcedCompaction.failures, 0)
  assert.equal(goal.forcedCompaction.pending, null)
  assert.equal(host.prompts.length, 1)
})

test("5. two idles in one epoch mean one request, then the continuation", async () => {
  const sessionID = "fc-idle-twice"
  const host = await createHost()
  await startGoal(host, sessionID)

  await endTurn(host, sessionID, "at", THRESHOLD)
  assert.equal(host.summarizes.length, 1)
  assert.equal(host.prompts.length, 0)

  // A failed compaction: the summary errors, no session.compacted, idle.
  await updated(
    host,
    assistantInfo(sessionID, "failed-summary", THRESHOLD, { finish: "error", summary: true, mode: "compaction" }),
  )
  await statusIdle(host, sessionID)
  assert.equal(host.summarizes.length, 1, "the failing idle does not request again")
  assert.equal(host.prompts.length, 1, "the claim is not stuck: the goal continues")
  assert.equal(currentGoal(sessionID).forcedCompaction.failures, 1)
  assert.equal(currentGoal(sessionID).stopped, false)
})

test("5b. the status/idle pair of one real idle produces one request and no continuation", async () => {
  const sessionID = "fc-idle-pair"
  const host = await createHost()
  await startGoal(host, sessionID)
  host.messages = [assistant(sessionID, "at", THRESHOLD)]
  await step(host, sessionID, "at", THRESHOLD, null)

  // The host publishes both without waiting on either handler.
  await Promise.all([
    statusIdle(host, sessionID),
    host.hooks.event({ event: { type: "session.idle", properties: { sessionID } } }),
  ])
  assert.equal(host.summarizes.length, 1)
  assert.equal(host.prompts.length, 0)
  assert.equal(currentGoal(sessionID).forcedCompaction.failures, 0)
})

test("5c. the idle that ends a turn with an unanswered step request counts a failure and continues", async () => {
  const sessionID = "fc-step-failure"
  const host = await createHost()
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)
  await step(host, sessionID, "over", THRESHOLD)
  assert.equal(host.summarizes.length, 1)

  host.messages = [assistant(sessionID, "over", THRESHOLD)]
  await statusIdle(host, sessionID)
  assert.equal(currentGoal(sessionID).forcedCompaction.failures, 1)
  assert.equal(host.summarizes.length, 1, "the same pass must not request again")
  assert.equal(host.prompts.length, 1)
})

test("5d. a failed idle pass does not charge the stall gates for the same turn twice", async () => {
  const sessionID = "fc-no-double-charge"
  const host = await createHost({ options: { noToolCallTurnsBeforePause: 50 } })
  await startGoal(host, sessionID)
  await endTurn(host, sessionID, "warmup", 10)
  assert.equal(host.prompts.length, 1)

  await endTurn(host, sessionID, "at", THRESHOLD)
  assert.equal(host.summarizes.length, 1)
  const charged = currentGoal(sessionID).noToolCallTurns
  assert.ok(charged > 0, "control: the requesting pass did charge the talk-only turn")
  await statusIdle(host, sessionID)
  assert.equal(host.prompts.length, 2)
  assert.equal(currentGoal(sessionID).noToolCallTurns, charged)
})

test("5e. a rejected completion is sent now, not parked behind a compaction", async () => {
  const sessionID = "fc-rejected-completion"
  const host = await createHost()
  await startGoal(host, sessionID)
  await endTurn(host, sessionID, "claim", THRESHOLD, "all done\n\n[goal:complete]")
  assert.equal(host.summarizes.length, 0)
  assert.equal(host.prompts.length, 1)
  assert.match(JSON.stringify(host.prompts[0]), /evidence/i)
})

test("5f. budget wrap-up wins over a forced compaction", async () => {
  const sessionID = "fc-wrapup"
  const host = await createHost()
  await startGoal(host, sessionID, "ship it --max-tokens 210000")
  await endTurn(host, sessionID, "at", THRESHOLD)
  assert.equal(host.summarizes.length, 0)
  assert.equal(currentGoal(sessionID).budgetWrapupSent, true)
  assert.equal(host.prompts.length, 1)
})

test("6. a threshold of 0 never compacts, at a step or at idle", async () => {
  const sessionID = "fc-off"
  const host = await createHost()
  await startGoal(host, sessionID, "ship it --compact-at 0")
  await statusBusy(host, sessionID)
  await step(host, sessionID, "huge-step", THRESHOLD * 5)
  await endTurn(host, sessionID, "huge", THRESHOLD * 5)
  assert.equal(host.summarizes.length, 0)
  assert.equal(host.prompts.length, 1)
})

test("6b. --compact-at is an exact threshold, and a lower one fires", async () => {
  const sessionID = "fc-custom"
  const host = await createHost()
  await startGoal(host, sessionID, "ship it --compact-at 1000")
  await statusBusy(host, sessionID)
  await step(host, sessionID, "under", 999)
  assert.equal(host.summarizes.length, 0)
  await step(host, sessionID, "at", 1000)
  assert.equal(host.summarizes.length, 1)
})

test("7. summarize throwing or rejecting is logged, the goal continues, nothing is unhandled", async () => {
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    for (const [label, summarize] of [
      [
        "throw",
        () => {
          throw new Error("summarize boom")
        },
      ],
      ["reject", async () => Promise.reject(new Error("summarize boom"))],
    ]) {
      const sessionID = `fc-fail-${label}`
      const host = await createHost({ summarize })
      await startGoal(host, sessionID)
      await endTurn(host, sessionID, "at", THRESHOLD)
      assert.equal(host.summarizes.length, 1, label)
      await eventually(() => host.prompts.length === 1, `${label}: the continuation`)
      assert.ok(
        host.logs.some((entry) => /summarize boom/.test(JSON.stringify(entry))),
        `${label}: logged`,
      )
      const goal = currentGoal(sessionID)
      assert.equal(goal.stopped, false, label)
      assert.equal(goal.forcedCompaction.failures, 1, label)
      assert.equal(goal.forcedCompaction.pending, null, label)
    }
    // A step request that rejects mid-turn: nothing happens until the turn ends.
    const sessionID = "fc-fail-step"
    const host = await createHost({ summarize: async () => Promise.reject(new Error("step boom")) })
    await startGoal(host, sessionID)
    await statusBusy(host, sessionID)
    await step(host, sessionID, "over", THRESHOLD)
    await eventually(
      () => host.logs.some((entry) => /step boom/.test(JSON.stringify(entry))),
      "the step rejection log",
    )
    assert.equal(host.prompts.length, 0, "the session is busy: no continuation yet")
    host.messages = [assistant(sessionID, "over", THRESHOLD)]
    await statusIdle(host, sessionID)
    assert.equal(host.prompts.length, 1)
    await sleep(5)
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("7b. the host answering { error } without compacting wakes the idle goal", async () => {
  const sessionID = "fc-resolved-error"
  const host = await createHost({ summarize: async () => ({ error: { name: "BadRequest" } }) })
  await startGoal(host, sessionID)
  await endTurn(host, sessionID, "at", THRESHOLD)
  await eventually(() => host.prompts.length === 1, "the continuation")
  assert.equal(currentGoal(sessionID).forcedCompaction.failures, 1)
})

test("7c. an idle request the host never starts on does not strand the goal", async () => {
  const sessionID = "fc-watchdog"
  const host = await createHost({ options: { promptRetryWakeMs: 20 } })
  await startGoal(host, sessionID)
  await endTurn(host, sessionID, "at", THRESHOLD)
  assert.equal(host.prompts.length, 0)
  await eventually(() => host.prompts.length === 1, "the watchdog continuation")
  assert.equal(currentGoal(sessionID).forcedCompaction.failures, 1)

  // Control: once the host went busy on it, the watchdog leaves it alone.
  const busySession = "fc-watchdog-busy"
  await startGoal(host, busySession)
  host.messages = [assistant(busySession, "busy-at", THRESHOLD)]
  await step(host, busySession, "busy-at", THRESHOLD, null)
  await statusIdle(host, busySession)
  const promptsBefore = host.prompts.length
  await statusBusy(host, busySession)
  await sleep(60)
  assert.equal(host.prompts.length, promptsBefore)
  assert.ok(currentGoal(busySession).forcedCompaction.pending)
})

test("7d. a host without summarize, or a message without a model, fails soft and logs once", async () => {
  const noMethod = "fc-no-method"
  const bare = await createHost({ summarize: null })
  await startGoal(bare, noMethod)
  await endTurn(bare, noMethod, "at", THRESHOLD)
  await endTurn(bare, noMethod, "at-2", THRESHOLD)
  assert.equal(bare.prompts.length, 2, "the goal keeps continuing")
  assert.equal(
    bare.logs.filter((entry) => /no session\.summarize/.test(JSON.stringify(entry))).length,
    1,
  )

  const noIDs = "fc-no-ids"
  const host = await createHost()
  await startGoal(host, noIDs)
  for (const id of ["a", "b"]) {
    const message = assistant(noIDs, id, THRESHOLD)
    delete message.info.providerID
    delete message.info.modelID
    host.messages = [message]
    await updated(host, message.info)
    await statusIdle(host, noIDs)
  }
  assert.equal(host.summarizes.length, 0)
  assert.equal(host.prompts.length, 2)
  assert.equal(
    host.logs.filter((entry) => /names no provider/.test(JSON.stringify(entry))).length,
    1,
  )
})

test("8. a plugin-requested compaction is not a stall; a host compaction still is", async () => {
  const sessionID = "fc-stalled"
  const host = await createHost()
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)
  await step(host, sessionID, "over", THRESHOLD)
  assert.equal(host.summarizes.length, 1)
  await compacted(host, sessionID)
  const goal = currentGoal(sessionID)
  assert.equal(goal.compactionEpoch, 1)
  assert.equal(goal.stalledCompactions, 0, "the plugin asked for this one")
  assert.equal(goal.forcedCompaction.requested, false, "the flag is consumed")

  await step(host, sessionID, "after", 10, null)
  await compacted(host, sessionID)
  assert.equal(goal.compactionEpoch, 2)
  assert.equal(goal.stalledCompactions, 1, "the host's own compaction still counts")
})

test("9. a dropped request retries after N steps, the cap stops it, session.compacted resets it", async () => {
  const sessionID = "fc-retry"
  const host = await createHost()
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)
  const goal = currentGoal(sessionID)

  let serial = 0
  const steps = async (count) => {
    for (let index = 0; index < count; index += 1) {
      serial += 1
      await step(host, sessionID, `step-${serial}`, THRESHOLD + serial)
    }
  }

  await steps(1)
  assert.equal(host.summarizes.length, 1)
  await steps(2)
  assert.equal(host.summarizes.length, 1, "still waiting for the request")
  assert.equal(goal.forcedCompaction.pending.steps, 2)
  // A repeated update of a step is the same step.
  await step(host, sessionID, `step-${serial}`, THRESHOLD + serial)
  assert.equal(goal.forcedCompaction.pending.steps, 2)

  await steps(1)
  assert.equal(goal.forcedCompaction.failures, 1)
  assert.equal(host.summarizes.length, 2, "the third step gives up and retries")
  await steps(3)
  assert.equal(goal.forcedCompaction.failures, 2)
  assert.equal(host.summarizes.length, 3)
  await steps(3)
  assert.equal(goal.forcedCompaction.failures, 3)
  assert.equal(goal.forcedCompaction.pending, null)
  assert.equal(host.summarizes.length, 3, "the cap stops forcing")
  await steps(5)
  assert.equal(host.summarizes.length, 3)
  assert.ok(host.logs.some((entry) => /failed 3 times/.test(JSON.stringify(entry))))
  assert.ok(goal.history.some((entry) => /failed 3 times/.test(entry.detail)))

  // The cap holds at idle too, and the goal goes on.
  host.messages = [assistant(sessionID, "capped", THRESHOLD)]
  await statusIdle(host, sessionID)
  assert.equal(host.summarizes.length, 3)
  assert.equal(host.prompts.length, 1)
  assert.equal(goal.stopped, false)

  // An orphan compaction landing later resets it.
  await compacted(host, sessionID)
  assert.equal(goal.forcedCompaction.failures, 0)
  assert.equal(goal.stalledCompactions, 0, "the orphan was still the plugin's")
  await statusBusy(host, sessionID)
  await steps(1)
  assert.equal(host.summarizes.length, 4, "forcing is allowed again")
})

test("10. two ineffective compactions hold forcing; a step below the threshold releases it", async () => {
  const sessionID = "fc-ineffective"
  const host = await createHost()
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)
  const goal = currentGoal(sessionID)
  const held = () => host.logs.filter((entry) => /not lowering the context/.test(JSON.stringify(entry))).length

  await step(host, sessionID, "s1", THRESHOLD)
  assert.equal(host.summarizes.length, 1)
  assert.equal(goal.forcedCompaction.strikes, 0, "the first epoch's step is no strike")
  await compacted(host, sessionID)

  await step(host, sessionID, "s2", THRESHOLD)
  assert.equal(goal.forcedCompaction.strikes, 1)
  assert.equal(host.summarizes.length, 2, "one strike still forces")
  await compacted(host, sessionID)

  await step(host, sessionID, "s3", THRESHOLD)
  assert.equal(goal.forcedCompaction.strikes, 2)
  assert.equal(goal.forcedCompaction.held, true)
  assert.equal(host.summarizes.length, 2, "two strikes hold")
  await step(host, sessionID, "s4", THRESHOLD)
  assert.equal(host.summarizes.length, 2, "still held")
  assert.equal(goal.forcedCompaction.strikes, 2, "later steps in the epoch are no strike")
  assert.equal(held(), 1, "logged once")

  // Held at idle too; the goal continues rather than compacts.
  host.messages = [assistant(sessionID, "s4", THRESHOLD)]
  await statusIdle(host, sessionID)
  assert.equal(host.summarizes.length, 2)
  assert.equal(host.prompts.length, 1)

  await statusBusy(host, sessionID)
  await step(host, sessionID, "s5", THRESHOLD - 1)
  assert.equal(goal.forcedCompaction.held, false)
  assert.equal(goal.forcedCompaction.strikes, 0)
  await step(host, sessionID, "s6", THRESHOLD)
  assert.equal(host.summarizes.length, 3, "released")
})

function shardDirectory(stateFilePath, sessionID) {
  return join(`${stateFilePath}.sessions`, createHash("sha256").update(sessionID).digest("hex"))
}

function stripForcedCompaction(value) {
  if (Array.isArray(value)) return value.map(stripForcedCompaction)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "forcedCompaction" && key !== "compactAtTokens")
      .map(([key, entry]) => [key, stripForcedCompaction(entry)]),
  )
}

async function withStateDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "forced-compaction-"))
  try {
    await run(directory, join(directory, "goals.json"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const durableOptions = (stateFilePath, extra = {}) => ({
  persistState: true,
  stateFilePath,
  lifecycleMessenger: async () => {},
  registerTools: false,
  idleLeaseReleaseMs: 0,
  leaseHeartbeatMs: 3_600_000,
  ...extra,
})

test("11. a goal persisted by v1.4.1 loads with defaults and triggers at 200000", async () => {
  const legacy = normalizePersistedGoal({
    sessionID: "legacy",
    condition: "ship it",
    startedAt: Date.now(),
    compactionEpoch: 3,
    options: { maxTurns: 0, maxDurationMs: 60_000, maxTokens: 1_000_000, contextWindowTokens: 0 },
  })
  assert.equal(legacy.options.compactAtTokens, 200_000)
  assert.deepEqual(legacy.forcedCompaction, {
    pending: null,
    requested: false,
    failures: 0,
    strikes: 0,
    held: false,
    checkedEpoch: 3,
    lastStepID: "",
    cleanupDue: false,
    hostGraceEpoch: 0,
  })

  await withStateDir(async (directory, stateFilePath) => {
    const sessionID = "fc-legacy"
    const first = await createHost({ directory, options: durableOptions(stateFilePath) })
    await startGoal(first, sessionID)
    await first.hooks.dispose()

    const statePath = join(shardDirectory(stateFilePath, sessionID), "state.json")
    const saved = JSON.parse(await readFile(statePath, "utf8"))
    assert.match(JSON.stringify(saved), /forcedCompaction/, "control: the new state was persisted")
    const stripped = JSON.stringify(stripForcedCompaction(saved))
    assert.doesNotMatch(stripped, /forcedCompaction|compactAtTokens/)
    await writeFile(statePath, stripped)

    const second = await createHost({ directory, options: durableOptions(stateFilePath) })
    try {
      await statusBusy(second, sessionID)
      await step(second, sessionID, "below", THRESHOLD - 1)
      assert.equal(second.summarizes.length, 0)
      await step(second, sessionID, "at", THRESHOLD)
      assert.equal(second.summarizes.length, 1)
      assert.deepEqual(second.summarizes[0].body, MODEL)
    } finally {
      await second.hooks.dispose()
    }
  })
})

test("11b. the outcome state survives a restart, and a corrupt record falls back to defaults", async () => {
  await withStateDir(async (directory, stateFilePath) => {
    const sessionID = "fc-restart"
    const first = await createHost({ directory, options: durableOptions(stateFilePath) })
    await startGoal(first, sessionID)
    await statusBusy(first, sessionID)
    await step(first, sessionID, "over", THRESHOLD)
    assert.equal(first.summarizes.length, 1)
    await first.hooks.dispose()

    const second = await createHost({ directory, options: durableOptions(stateFilePath) })
    try {
      await statusBusy(second, sessionID)
      await step(second, sessionID, "over", THRESHOLD)
      const goal = currentGoal(sessionID)
      assert.equal(goal.forcedCompaction.pending.trigger, "step")
      assert.equal(goal.forcedCompaction.requested, true)
      assert.equal(second.summarizes.length, 0, "the open request and step are remembered")
      await compacted(second, sessionID)
      assert.equal(currentGoal(sessionID).stalledCompactions, 0)
    } finally {
      await second.hooks.dispose()
    }
  })

  const corrupt = normalizePersistedGoal({
    sessionID: "corrupt",
    condition: "ship it",
    startedAt: Date.now(),
    forcedCompaction: { pending: { id: 7, epoch: "x" }, failures: -1, held: "yes", lastStepID: 9 },
    options: {},
  })
  assert.equal(corrupt.forcedCompaction.pending, null)
  assert.equal(corrupt.forcedCompaction.failures, 0)
  assert.equal(corrupt.forcedCompaction.held, false)
  assert.equal(corrupt.forcedCompaction.lastStepID, "")
})

test("11c. resume starts the forced-compaction state over", async () => {
  const sessionID = "fc-paused"
  const host = await createHost()
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)
  await step(host, sessionID, "over", THRESHOLD)
  assert.equal(currentGoal(sessionID).forcedCompaction.requested, true)
  await startGoal(host, sessionID, "pause")
  assert.equal(currentGoal(sessionID).stopped, true)
  await compacted(host, sessionID)
  await startGoal(host, sessionID, "resume")
  const goal = currentGoal(sessionID)
  assert.equal(goal.stopped, false)
  assert.equal(goal.forcedCompaction.pending, null)
  assert.equal(goal.forcedCompaction.requested, false)
  await step(host, sessionID, "later", 10, null)
  await compacted(host, sessionID)
  assert.equal(goal.stalledCompactions, 1, "a later host compaction counts as usual")
})

test("12. a process that lost the lease does not compact", async () => {
  await withStateDir(async (directory, stateFilePath) => {
    const run = async (sessionID, dropLease) => {
      const host = await createHost({ directory, options: durableOptions(stateFilePath) })
      try {
        await startGoal(host, sessionID)
        await statusBusy(host, sessionID)
        const goal = currentGoal(sessionID)
        if (dropLease) {
          const claims = `${join(shardDirectory(stateFilePath, sessionID), "state.json")}.lock.claims-v2`
          const [claim] = (await readdir(claims)).filter((name) => /^claim-.*\.json$/.test(name))
          assert.ok(claim, "control: a claim file exists to remove")
          await rm(join(claims, claim))
        }
        await step(host, sessionID, "over", THRESHOLD)
        const recorded = goal.history.some((entry) => /Forced compaction requested/.test(entry.detail))
        assert.equal(recorded, !dropLease, "only a process holding the lease gets as far as recording it")
        return host.summarizes.length
      } finally {
        await host.hooks.dispose()
      }
    }
    assert.equal(await run("fc-lease-held", false), 1, "control: with the lease it compacts")
    assert.equal(await run("fc-lease-lost", true), 0, "without the lease it must not")
  })
})

test("13. a replayed session.compacted does not double-count, in this process or a peer's", async () => {
  await withStateDir(async (directory, stateFilePath) => {
    const sessionID = "fc-replay"
    const first = await createHost({ directory, options: durableOptions(stateFilePath) })
    await startGoal(first, sessionID)
    await statusBusy(first, sessionID)
    await step(first, sessionID, "over", THRESHOLD)
    assert.equal(first.summarizes.length, 1)
    const event = { type: "session.compacted", properties: { sessionID } }
    await first.hooks.event({ event })
    await first.hooks.event({ event: structuredClone(event) })
    assert.equal(currentGoal(sessionID).compactionEpoch, 1)
    assert.equal(currentGoal(sessionID).stalledCompactions, 0)
    await first.hooks.dispose()

    // The peer process loads the persisted state and sees the same event.
    const peer = await createHost({ directory, options: durableOptions(stateFilePath) })
    try {
      await peer.hooks.event({ event: structuredClone(event) })
      const goal = currentGoal(sessionID)
      assert.equal(goal.compactionEpoch, 1, "the replay opens no new epoch")
      assert.equal(goal.stalledCompactions, 0, "the replay is no host compaction")
      assert.equal(goal.forcedCompaction.pending, null)

      // Control: a real later compaction does count.
      await step(peer, sessionID, "later", 10, null)
      await peer.hooks.event({ event: structuredClone(event) })
      assert.equal(goal.compactionEpoch, 2)
      assert.equal(goal.stalledCompactions, 1)
    } finally {
      await peer.hooks.dispose()
    }
  })
})

// A summary signalled on only one of the two shapes a message.updated carries:
// the `info` object, or the wrapping `message` envelope.
test("14. a summary flagged only on the info, or only on the envelope, is no Trigger A step", async () => {
  const sessionID = "fc-summary-shapes"
  const host = await createHost()
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)

  const over = (id, infoExtra, envelope) =>
    host.hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: assistantInfo(sessionID, id, THRESHOLD * 2, { finish: "stop", ...infoExtra }),
          ...(envelope ? { message: envelope } : {}),
        },
      },
    })

  await over("by-info", { summary: true }, { role: "assistant", id: "by-info" })
  assert.equal(host.summarizes.length, 0, "a summary on the info alone does not trigger")

  await over("by-envelope", {}, { role: "assistant", id: "by-envelope", mode: "compaction" })
  assert.equal(host.summarizes.length, 0, "a summary on the envelope alone does not trigger")

  await over("control", {}, { role: "assistant", id: "control" })
  assert.equal(host.summarizes.length, 1, "control: the same step with neither flag triggers")
})

// A parent deferred behind a busy child, then re-driven by the child going idle
// while the parent itself is still busy with a forced compaction open.
async function deferredParentWithOpenRequest(sessionID, options = {}) {
  const host = await createHost({
    options: { noContinueWhileChildrenActive: true, minDelayMs: 60, ...options },
  })
  host.client.session.children = async () => ({ data: [{ id: `${sessionID}-kid` }] })
  host.client.session.status = async () => ({ data: { [`${sessionID}-kid`]: { type: "busy" } } })
  await startGoal(host, sessionID)
  await endTurn(host, sessionID, "first", 10)
  assert.equal(host.prompts.length, 0, "control: the goal is deferred behind the child")

  await statusBusy(host, sessionID)
  await step(host, sessionID, "over", THRESHOLD)
  assert.equal(host.summarizes.length, 1)
  host.messages = [assistant(sessionID, "over", THRESHOLD)]
  host.client.session.status = async () => ({ data: {} })
  return host
}

const childIdle = (host, sessionID) =>
  host.hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: `${sessionID}-kid`, status: { type: "idle" } },
    },
  })

test("15. a child wake while the session is busy is no forced-compaction outcome", async () => {
  const sessionID = "fc-busy-wake"
  const host = await deferredParentWithOpenRequest(sessionID)
  await childIdle(host, sessionID)
  const forced = currentGoal(sessionID).forcedCompaction
  assert.equal(forced.failures, 0, "a busy session did not fail the request")
  assert.ok(forced.pending, "the request is still open")
  assert.equal(host.summarizes.length, 1)
  assert.equal(host.prompts.length, 0, "a busy session is not continued")

  // Control: the same open request on a session that really went idle is a failure.
  await statusIdle(host, sessionID)
  assert.equal(currentGoal(sessionID).forcedCompaction.failures, 1)
})

test("16. an idle pass cannot send a second request while one is still open", async () => {
  const sessionID = "fc-pending-blocks"
  const host = await deferredParentWithOpenRequest(sessionID)
  // The wake pass reads the busy session (no outcome), waits out the cooldown,
  // and finds the session idle by the time it claims the continuation.
  currentGoal(sessionID).lastContinueAt = Date.now()
  const wake = childIdle(host, sessionID)
  await sleep(15)
  await statusIdle(host, sessionID)
  await wake
  assert.equal(host.prompts.length, 1, "control: the pass got as far as the continuation")
  assert.equal(host.summarizes.length, 1, "the open request blocks a second one")
  assert.equal(currentGoal(sessionID).forcedCompaction.failures, 0)
})

test("17. a plugin-requested compaction never trips the stalled-compaction stop", async () => {
  const sessionID = "fc-stall-guard"
  const host = await createHost()
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)
  await step(host, sessionID, "over", THRESHOLD)
  assert.equal(host.summarizes.length, 1)
  const goal = currentGoal(sessionID)
  const stallWarnings = () =>
    goal.history.filter((entry) => /without productive non-compaction work/.test(entry.detail))
  goal.stalledCompactions = 2 // earlier host compactions already at the stall limit
  await compacted(host, sessionID)
  assert.equal(goal.stalledCompactions, 2, "the plugin's own compaction is not counted")
  assert.equal(stallWarnings().length, 0, "no stall warning for a compaction the plugin asked for")
  assert.doesNotMatch(goal.lastStatus || "", /compactions without a productive/)

  // Control: a host compaction at the limit does set the warning.
  await step(host, sessionID, "after", 10, null)
  goal.stalledCompactions = 2 // productive output above reset it; put it back at the limit
  await compacted(host, sessionID)
  assert.equal(goal.stalledCompactions, 3)
  assert.equal(stallWarnings().length, 1)
  assert.match(goal.lastStatus, /compactions without a productive/)
})

// A real failed-compaction session, as the host's message list returns it.
function userRow(sessionID, id, created, parts = [{ type: "text", text: "go" }]) {
  return { info: { id, role: "user", sessionID, time: { created } }, parts }
}
const compactionRow = (sessionID, id, created, auto = false) =>
  userRow(sessionID, id, created, [{ type: "compaction", auto }])
function assistantRow(sessionID, id, created, extra = {}) {
  return {
    info: { ...assistantInfo(sessionID, id, 1000), time: { created }, ...extra },
    parts: [{ type: "text", text: "made progress" }],
  }
}
const failedSummaryRow = (sessionID, id, created, parentID) =>
  assistantRow(sessionID, id, created, {
    summary: true,
    parentID,
    error: { name: "APIError", data: { message: "refused" } },
  })

// A step request answered by nothing: the idle that follows is the failure.
async function failedRequest(sessionID, overrides = {}) {
  const host = await createHost(overrides)
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)
  await step(host, sessionID, "over", THRESHOLD)
  assert.equal(host.summarizes.length, 1)
  host.messages = [
    assistantRow(sessionID, "over", 100, { finish: "tool-calls" }),
    compactionRow(sessionID, "orphan", 200),
    failedSummaryRow(sessionID, "failed-summary", 300, "orphan"),
  ]
  return host
}

function recordDeletes(host, impl = async () => ({ data: true })) {
  const deletes = []
  host.client.session.deleteMessage = (input) => {
    deletes.push(input?.path?.messageID ?? input?.messageID)
    return impl(input)
  }
  return deletes
}

test("18. a failed request's compaction message is deleted; older, host and finished rows are not", async () => {
  const sessionID = "fc-cleanup-ids"
  const host = await failedRequest(sessionID)
  const deletes = recordDeletes(host)
  host.messages = [
    userRow(sessionID, "first", 10),
    // A compaction that ran: its finished summary is newer than it.
    compactionRow(sessionID, "landed", 20),
    assistantRow(sessionID, "landed-summary", 30, { summary: true, finish: "stop", parentID: "landed" }),
    // Older than the last finished assistant.
    compactionRow(sessionID, "older", 40),
    assistantRow(sessionID, "over", 100, { finish: "tool-calls" }),
    // Same millisecond as the last finished one: the host's tie-break is the id.
    compactionRow(sessionID, "ovei-tie-older", 100),
    compactionRow(sessionID, "tie-newer", 100),
    // The host's own: not ours, newer or not.
    compactionRow(sessionID, "host-auto", 150, true),
    compactionRow(sessionID, "orphan-1", 200),
    failedSummaryRow(sessionID, "failed-1", 210, "orphan-1"),
    userRow(sessionID, "plain-user", 220),
    compactionRow(sessionID, "orphan-2", 230),
    failedSummaryRow(sessionID, "failed-2", 240, "orphan-2"),
  ]
  await statusIdle(host, sessionID)
  assert.deepEqual(deletes, ["tie-newer", "orphan-1", "orphan-2"])
  assert.equal(currentGoal(sessionID).forcedCompaction.failures, 1)
  assert.equal(currentGoal(sessionID).forcedCompaction.cleanupDue, false)
  assert.equal(host.prompts.length, 1, "the goal continues")
})

test("18b. no finished assistant in the session: every plugin compaction is newer than none", async () => {
  const sessionID = "fc-cleanup-no-finish"
  const host = await failedRequest(sessionID)
  const deletes = recordDeletes(host)
  host.messages = [
    userRow(sessionID, "first", 10),
    compactionRow(sessionID, "orphan", 20),
    failedSummaryRow(sessionID, "failed", 30, "orphan"),
  ]
  await statusIdle(host, sessionID)
  assert.deepEqual(deletes, ["orphan"])
})

test("18c. a delete that throws logs once, continues, and retries at the next idle", async () => {
  const sessionID = "fc-cleanup-throws"
  const host = await failedRequest(sessionID)
  let refuse = true
  const deletes = recordDeletes(host, async () => {
    if (refuse) throw new Error("session is busy")
    return { data: true }
  })
  await statusIdle(host, sessionID)
  assert.deepEqual(deletes, ["orphan"])
  assert.equal(host.prompts.length, 1, "the goal continues past the failed cleanup")
  assert.equal(currentGoal(sessionID).forcedCompaction.cleanupDue, true)
  const logged = () => host.logs.filter((log) => /Could not delete/.test(JSON.stringify(log))).length
  assert.equal(logged(), 1)

  // The wedge's own idle: no request is open and the host re-ran the compaction.
  host.messages = [...host.messages, userRow(sessionID, "continuation", 400)]
  await statusBusy(host, sessionID)
  await statusIdle(host, sessionID)
  assert.deepEqual(deletes, ["orphan", "orphan"], "retried though no request is open")
  assert.equal(logged(), 1, "logged once")

  refuse = false
  await statusBusy(host, sessionID)
  await statusIdle(host, sessionID)
  assert.deepEqual(deletes, ["orphan", "orphan", "orphan"])
  assert.equal(currentGoal(sessionID).forcedCompaction.cleanupDue, false)
  await statusBusy(host, sessionID)
  await statusIdle(host, sessionID)
  assert.equal(deletes.length, 3, "nothing further once it succeeded")
})

test("18d. a host with no way to delete logs once and the goal continues", async () => {
  const sessionID = "fc-cleanup-missing"
  const host = await failedRequest(sessionID)
  assert.equal(host.client.session.deleteMessage, undefined, "control: this host has no method")
  await statusIdle(host, sessionID)
  assert.equal(host.prompts.length, 1)
  assert.equal(host.logs.filter((log) => /Could not delete/.test(JSON.stringify(log))).length, 1)
  assert.equal(currentGoal(sessionID).forcedCompaction.failures, 1)
})

test("18e. a delete that never answers cannot hang the goal", async () => {
  const sessionID = "fc-cleanup-hangs"
  const host = await failedRequest(sessionID)
  const deletes = recordDeletes(host, never)
  const startedAt = Date.now()
  await statusIdle(host, sessionID)
  assert.deepEqual(deletes, ["orphan"])
  assert.equal(host.prompts.length, 1, "the goal continues at the deadline")
  assert.ok(Date.now() - startedAt < 10_000, "bounded")
})

test("18f. the same pass does not delete when nothing failed", async () => {
  const sessionID = "fc-cleanup-nothing-failed"
  const host = await failedRequest(sessionID)
  const deletes = recordDeletes(host)
  await compacted(host, sessionID)
  await statusIdle(host, sessionID)
  assert.deepEqual(deletes, [], "a compaction landed: the request did not fail")
  assert.equal(currentGoal(sessionID).forcedCompaction.failures, 0)
})

test("18g. a process that lost the lease does not delete", async () => {
  await withStateDir(async (directory, stateFilePath) => {
    const run = async (sessionID, dropLease) => {
      const host = await failedRequest(sessionID, { directory, options: durableOptions(stateFilePath) })
      try {
        // The first attempt is refused, which leaves the cleanup due. The retry
        // is the path with no persist in front of it to notice a lost lease.
        let refuse = true
        const deletes = recordDeletes(host, async () => {
          if (refuse) throw new Error("session is busy")
          return { data: true }
        })
        await statusIdle(host, sessionID)
        assert.deepEqual(deletes, ["orphan"])
        assert.equal(currentGoal(sessionID).forcedCompaction.cleanupDue, true)
        refuse = false

        await statusBusy(host, sessionID)
        const listMessages = host.client.session.messages
        let reads = 0
        host.client.session.messages = async (input) => {
          reads += 1
          if (dropLease && reads === 1) {
            const claims = `${join(shardDirectory(stateFilePath, sessionID), "state.json")}.lock.claims-v2`
            const [claim] = (await readdir(claims)).filter((name) => /^claim-.*\.json$/.test(name))
            assert.ok(claim, "control: a claim file exists to remove")
            await rm(join(claims, claim))
          }
          return listMessages(input)
        }
        await statusIdle(host, sessionID)
        assert.ok(reads >= 1, "control: the retry's pass reached the transcript read")
        return deletes.slice(1)
      } finally {
        await host.hooks.dispose()
      }
    }
    assert.deepEqual(await run("fc-cleanup-lease-held", false), ["orphan"], "control: with the lease it deletes")
    assert.deepEqual(await run("fc-cleanup-lease-lost", true), [], "without the lease it must not")
  })
})

// The idle that ends a turn beats its last step's request out of the door.
async function idleBeforeSend(sessionID, directory, stateFilePath, options = {}) {
  const host = await createHost({ directory, options: { ...durableOptions(stateFilePath), ...options } })
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)
  host.messages = [assistant(sessionID, "last-step", THRESHOLD)]
  const stepped = step(host, sessionID, "last-step", THRESHOLD, "stop")
  const deadline = Date.now() + 3000
  while (!currentGoal(sessionID).forcedCompaction.pending) {
    assert.ok(Date.now() < deadline, "the step never opened a request")
    await new Promise(setImmediate)
  }
  assert.equal(host.summarizes.length, 0, "control: the request has not been sent yet")
  const idled = statusIdle(host, sessionID)
  return { host, stepped, idled }
}

test("19. an idle before the request is sent counts no failure, and the compaction still goes out", async () => {
  await withStateDir(async (directory, stateFilePath) => {
    const sessionID = "fc-unsent-idle"
    const { host, stepped, idled } = await idleBeforeSend(sessionID, directory, stateFilePath)
    try {
      await Promise.all([stepped, idled])
      const state = currentGoal(sessionID).forcedCompaction
      assert.equal(state.failures, 0, "nothing was sent, so nothing failed")
      assert.equal(host.summarizes.length, 1, "the request went out")
      assert.ok(state.pending, "and is still open")
      assert.equal(host.prompts.length, 0, "the compaction drives the next idle, not a continuation")

      await compacted(host, sessionID)
      await statusIdle(host, sessionID)
      assert.equal(host.prompts.length, 1, "the goal continues after it")
    } finally {
      await host.hooks.dispose()
    }
  })
})

test("19b. a host that never starts on that request cannot strand the goal", async () => {
  await withStateDir(async (directory, stateFilePath) => {
    const sessionID = "fc-unsent-idle-never-started"
    const { host, stepped, idled } = await idleBeforeSend(sessionID, directory, stateFilePath, {
      promptRetryWakeMs: 30,
    })
    try {
      await Promise.all([stepped, idled])
      assert.equal(currentGoal(sessionID).forcedCompaction.failures, 0)
      await eventually(() => host.prompts.length === 1, "the wake's continuation")
      assert.equal(currentGoal(sessionID).forcedCompaction.failures, 1, "now it did fail")
    } finally {
      await host.hooks.dispose()
    }
  })
})

const catalogWithContext = (context) => ({
  providers: async () => ({
    data: { providers: [{ id: MODEL.providerID, models: { [MODEL.modelID]: { limit: { context } } } }] },
  }),
})

test("20. a model whose host check is alive gets one step: the host compacting means no request", async () => {
  const sessionID = "fc-grace-host"
  const host = await createHost({ config: catalogWithContext(208_000) })
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)

  await step(host, sessionID, "over", THRESHOLD + 5)
  await step(host, sessionID, "over", THRESHOLD + 5)
  assert.equal(host.summarizes.length, 0, "the crossing step is left to the host")

  await compacted(host, sessionID)
  await step(host, sessionID, "after", 4000)
  assert.equal(host.summarizes.length, 0, "the host compacted, so nothing is forced")
})

test("20b. the host passing on it: the next step over the threshold forces once", async () => {
  const sessionID = "fc-grace-pass"
  const host = await createHost({ config: catalogWithContext(1_000_000) })
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)

  await step(host, sessionID, "over-1", THRESHOLD + 5)
  assert.equal(host.summarizes.length, 0)
  await step(host, sessionID, "over-2", THRESHOLD + 10)
  assert.equal(host.summarizes.length, 1)
  await step(host, sessionID, "over-3", THRESHOLD + 15)
  assert.equal(host.summarizes.length, 1, "a request is already pending")
})

test("20c. limit.context 0, an unknown model and a broken catalog all force on the crossing step", async () => {
  const hosts = {
    zero: catalogWithContext(0),
    unknown: { providers: async () => ({ data: { providers: [] } }) },
    broken: {
      providers: async () => {
        throw new Error("catalog down")
      },
    },
  }
  for (const [name, config] of Object.entries(hosts)) {
    const sessionID = `fc-grace-${name}`
    const host = await createHost({ config })
    await startGoal(host, sessionID)
    await statusBusy(host, sessionID)
    await step(host, sessionID, "over", THRESHOLD)
    assert.equal(host.summarizes.length, 1, name)
  }
})

test("20d. a step below the threshold ends the grace, and a compaction grants a new one", async () => {
  const sessionID = "fc-grace-reset"
  const host = await createHost({ config: catalogWithContext(1_000_000) })
  await startGoal(host, sessionID)
  await statusBusy(host, sessionID)

  await step(host, sessionID, "over-1", THRESHOLD)
  await step(host, sessionID, "under", THRESHOLD - 1)
  await step(host, sessionID, "over-2", THRESHOLD)
  assert.equal(host.summarizes.length, 0, "a fresh crossing gets its own step")
  assert.equal(currentGoal(sessionID).forcedCompaction.hostGraceEpoch, 1)

  await compacted(host, sessionID)
  await step(host, sessionID, "over-3", THRESHOLD)
  assert.equal(host.summarizes.length, 0, "the first crossing after a compaction gets a step too")
  assert.equal(currentGoal(sessionID).forcedCompaction.hostGraceEpoch, 2)
})

test("20e. the idle backstop does not wait: the turn ended with no host compaction", async () => {
  const sessionID = "fc-grace-idle"
  const host = await createHost({ config: catalogWithContext(1_000_000) })
  await startGoal(host, sessionID)
  await endTurn(host, sessionID, "at", THRESHOLD)
  assert.equal(host.summarizes.length, 1)
  assert.equal(host.prompts.length, 0)
})

test("20f. the grace survives a restart and a corrupt value falls back to none", () => {
  const load = (hostGraceEpoch) =>
    normalizePersistedGoal({
      sessionID: "fc-grace-persist",
      condition: "ship it",
      startedAt: Date.now(),
      compactionEpoch: 2,
      options: { maxTurns: 0, maxDurationMs: 60_000, maxTokens: 1_000_000, contextWindowTokens: 0 },
      forcedCompaction: { hostGraceEpoch },
    }).forcedCompaction.hostGraceEpoch
  assert.equal(load(3), 3)
  assert.equal(load("nope"), 0)
})
