import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { promises as sharedFs } from "node:fs"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { acquirePersistenceLease } from "../src/persistence-lease.js"

// LEASE_TEST_SRC points the whole file at another copy of src/ (used to prove
// the cross-process tests fail against the previous release).
const srcDirectory = process.env.LEASE_TEST_SRC || new URL("../src/", import.meta.url).pathname
const moduleURL = pathToFileURL(join(srcDirectory, "goal-plugin.js")).href
const { GoalPlugin } = await import(moduleURL)

const GRACE = 50
const FAST = { idleLeaseReleaseMs: GRACE, leaseHeartbeatMs: 20, registerTools: false, minDelayMs: 1 }
const UNAVAILABLE = /Goal controls are unavailable/
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function shardDirectory(stateFilePath, sessionID) {
  const key = createHash("sha256").update(sessionID).digest("hex")
  return join(`${stateFilePath}.sessions`, key)
}

function shardStatePath(stateFilePath, sessionID) {
  return join(shardDirectory(stateFilePath, sessionID), "state.json")
}

async function claimFiles(stateFilePath, sessionID) {
  const directory = `${shardStatePath(stateFilePath, sessionID)}.lock.claims-v2`
  try {
    return (await readdir(directory)).filter((name) => /^claim-.*\.json$/.test(name))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

async function eventually(check, { timeout = 3000, step = 10, message = "condition" } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last
    await sleep(step)
  }
  throw new Error(`timed out waiting for ${message}`)
}

function makeHost() {
  const host = { logs: [], prompts: [], updates: [], lifecycle: [], messages: [] }
  host.client = {
    app: { log: async (input) => host.logs.push(input) },
    session: {
      messages: async () => ({ data: host.messages }),
      promptAsync: async (input) => {
        host.prompts.push(input)
        return {}
      },
      get: async () => ({ data: { title: "My own title" } }),
      update: async (input) => {
        host.updates.push(input)
        return {}
      },
    },
  }
  host.lifecycleMessenger = async (sessionID, text) => {
    host.lifecycle.push({ sessionID, text })
  }
  return host
}

async function makePlugin(directory, stateFilePath, host, options = {}) {
  return GoalPlugin(
    { client: host.client, directory },
    { stateFilePath, lifecycleMessenger: host.lifecycleMessenger, ...FAST, ...options },
  )
}

async function goal(hooks, sessionID, args) {
  const output = { parts: [] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: args }, output)
  return output.parts[0]?.text ?? ""
}

// A full command turn: the command, the host accepting it as a user message, the
// assistant answering, and the idle event that retires it. Until that happens the
// plugin rightly treats the session as busy and keeps its lease.
let turnCounter = 0
async function goalCycle(hooks, host, sessionID, args) {
  const messageID = `cycle-${(turnCounter += 1)}`
  const output = { message: { id: messageID, role: "user", sessionID }, parts: [] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: args }, output)
  const text = output.parts[0]?.text ?? ""
  if (UNAVAILABLE.test(text)) return text
  Object.assign(output.parts[0], { id: `${messageID}-part`, messageID, sessionID })
  await hooks["chat.message"]({ sessionID, messageID, agent: "build" }, output)
  host.messages = [{
    info: { id: `${messageID}-assistant`, parentID: messageID, role: "assistant", sessionID },
    parts: [{ type: "text", text: "Done." }],
  }]
  await idleEvent(hooks, sessionID, `idle-${messageID}`)
  return text
}

function touch(hooks, sessionID) {
  return hooks["chat.params"]({ sessionID, agent: "build" })
}

function assistantMessage(sessionID) {
  return {
    info: { id: `assistant-${sessionID}`, role: "assistant", sessionID, tokens: { input: 10, output: 100, reasoning: 0 } },
    parts: [{ type: "text", text: "Work remains." }],
  }
}

function idleEvent(hooks, sessionID, id) {
  return hooks.event({
    event: { id, type: "session.status", properties: { id, sessionID, status: { type: "idle" } } },
  })
}

// Child process playing "another OpenCode process". `steps` run in order, then
// the child prints READY and waits for "stop" on stdin.
function spawnProcess(stateFilePath, steps, options = {}) {
  const source = `
    import { GoalPlugin } from ${JSON.stringify(moduleURL)}
    const client = {
      app: { log: async () => {} },
      session: { messages: async () => ({ data: hostMessages }), promptAsync: async () => ({}) },
    }
    let hostMessages = []
    let turn = 0
    const hooks = await GoalPlugin(
      { client, directory: ${JSON.stringify(tmpdir())} },
      Object.assign({ stateFilePath: ${JSON.stringify(stateFilePath)}, registerTools: false, minDelayMs: 1 }, ${JSON.stringify(options)}),
    )
    const outputs = []
    for (const step of ${JSON.stringify(steps)}) {
      if (step.kind === "touch") {
        await hooks["chat.params"]({ sessionID: step.sessionID, agent: "build" })
      } else {
        const sessionID = step.sessionID
        const messageID = "child-turn-" + (turn += 1)
        const output = { message: { id: messageID, role: "user", sessionID }, parts: [] }
        await hooks["command.execute.before"](
          { command: "goal", sessionID, arguments: step.args },
          output,
        )
        outputs.push(output.parts[0]?.text ?? "")
        Object.assign(output.parts[0], { id: messageID + "-part", messageID, sessionID })
        await hooks["chat.message"]({ sessionID, messageID, agent: "build" }, output)
        hostMessages = [{
          info: { id: messageID + "-assistant", parentID: messageID, role: "assistant", sessionID },
          parts: [{ type: "text", text: "Done." }],
        }]
        await hooks.event({ event: { id: "idle-" + messageID, type: "session.status", properties: { id: "idle-" + messageID, sessionID, status: { type: "idle" } } } })
      }
    }
    process.stdout.write("READY " + JSON.stringify(outputs) + "\\n")
    process.stdin.once("data", async () => {
      await hooks.dispose()
      process.exit(0)
    })
  `
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  let settled = false
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
      const match = stdout.match(/READY (.*)\n/)
      if (match && !settled) {
        settled = true
        resolve(JSON.parse(match[1]))
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("exit", (code) => {
      if (!settled) {
        settled = true
        reject(new Error(`child exited before readiness (${code}): ${stderr}`))
      }
    })
  })
  const exited = new Promise((resolve) => child.once("exit", resolve))
  return {
    child,
    ready,
    async stop() {
      if (child.exitCode === null) child.stdin.write("stop\n")
      await exited
    },
  }
}

async function scenario(name, fn, { timeout = 15_000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "goal-lease-idle-"))
  const stateFilePath = join(directory, "state.json")
  const cleanups = []
  try {
    await fn({
      directory,
      stateFilePath,
      onCleanup: (cleanup) => cleanups.push(cleanup),
    })
  } finally {
    for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
}

test("an idle goal-less session in another process does not block a new goal", { timeout: 20_000 }, async () => {
  await scenario("idle-goalless", async ({ directory, stateFilePath, onCleanup }) => {
    const sessionID = "S-idle-goalless"
    const a = spawnProcess(stateFilePath, [{ kind: "touch", sessionID }], { ...FAST })
    onCleanup(() => a.stop())
    await a.ready
    assert.equal((await claimFiles(stateFilePath, sessionID)).length, 1, "A holds the lease right after the touch")
    await sleep(GRACE * 8)

    const host = makeHost()
    const b = await makePlugin(directory, stateFilePath, host)
    onCleanup(() => b.dispose())
    const text = await goal(b, sessionID, "build the thing")
    assert.doesNotMatch(text, UNAVAILABLE)
    const persisted = JSON.parse(await readFile(shardStatePath(stateFilePath, sessionID), "utf8"))
    assert.equal(persisted.goals.length, 1)
    assert.match(persisted.goals[0].condition, /build the thing/)
  })
})

test("an active goal keeps its lease, so another process stays passive", { timeout: 20_000 }, async () => {
  await scenario("active-holds", async ({ directory, stateFilePath, onCleanup }) => {
    const sessionID = "S-active-holds"
    const a = spawnProcess(stateFilePath, [{ kind: "command", sessionID, args: "keep driving" }], { ...FAST })
    onCleanup(() => a.stop())
    await a.ready
    await sleep(GRACE * 20)

    const host = makeHost()
    const b = await makePlugin(directory, stateFilePath, host)
    onCleanup(() => b.dispose())
    assert.match(await goal(b, sessionID, "status"), UNAVAILABLE)
    assert.equal((await claimFiles(stateFilePath, sessionID)).length, 1)
    assert.equal(host.logs.filter((entry) => entry.body.level === "warn").length, 1)
    const warning = host.logs.find((entry) => entry.body.level === "warn").body.message
    assert.match(warning, /driving or recently touched the session/)
    assert.match(warning, /opencode --continue --fork/)
    assert.match(warning, /retry the goal command/)
  })
})

test("a paused goal is released and loads, then resumes, in another process", { timeout: 20_000 }, async () => {
  await scenario("paused-released", async ({ directory, stateFilePath, onCleanup }) => {
    const sessionID = "S-paused-released"
    const a = spawnProcess(
      stateFilePath,
      [
        { kind: "command", sessionID, args: "finish the migration" },
        { kind: "command", sessionID, args: "pause" },
      ],
      { ...FAST },
    )
    onCleanup(() => a.stop())
    await a.ready
    await eventually(async () => (await claimFiles(stateFilePath, sessionID)).length === 0, {
      message: "A to release the paused session",
    })

    const host = makeHost()
    const b = await makePlugin(directory, stateFilePath, host)
    onCleanup(() => b.dispose())
    const status = await goalCycle(b, host, sessionID, "status")
    assert.doesNotMatch(status, UNAVAILABLE)
    assert.match(status, /finish the migration/)
    assert.match(status, /paused/i)
    const resumed = await goal(b, sessionID, "resume")
    assert.doesNotMatch(resumed, UNAVAILABLE)
    const persisted = JSON.parse(await readFile(shardStatePath(stateFilePath, sessionID), "utf8"))
    assert.equal(persisted.goals[0].stopped, false)
  })
})

test("re-touching a released session keeps its state and does not re-announce recovery", { timeout: 20_000 }, async () => {
  await scenario("retouch", async ({ directory, stateFilePath, onCleanup }) => {
    const goalSession = "S-retouch-goal"
    const resultSession = "S-retouch-result"
    // A previous process leaves a PAUSED goal behind. (An active goal now
    // stays active across a restart and keeps its lease, so it is never idle
    // released; a paused one is, and reloads on every later touch.)
    const previous = spawnProcess(stateFilePath, [
      { kind: "command", sessionID: goalSession, args: "survive reloads" },
      { kind: "command", sessionID: goalSession, args: "pause" },
    ], {
      ...FAST,
      idleLeaseReleaseMs: 0,
    })
    await previous.ready
    await previous.stop()
    // A session whose only state is a finished goal's last result.
    const now = Date.now()
    await rm(shardDirectory(stateFilePath, resultSession), { recursive: true, force: true })
    const { mkdir } = await import("node:fs/promises")
    await mkdir(shardDirectory(stateFilePath, resultSession), { recursive: true })
    await writeFile(
      shardStatePath(stateFilePath, resultSession),
      JSON.stringify({
        version: 1,
        goals: [],
        results: [{
          sessionID: resultSession,
          condition: "the already finished thing",
          state: "achieved",
          evidence: "proof recorded",
          turnCount: 3,
          startedAt: now - 5000,
          finishedAt: now - 1000,
        }],
        archives: [{
          sessionID: resultSession,
          results: [{
            sessionID: resultSession,
            condition: "archived earlier thing",
            state: "achieved",
            startedAt: now - 9000,
            finishedAt: now - 8000,
          }],
        }],
        orderedSessions: [],
      }),
    )

    const host = makeHost()
    const a = await makePlugin(directory, stateFilePath, host)
    onCleanup(() => a.dispose())
    for (let round = 0; round < 3; round += 1) {
      await touch(a, goalSession)
      await touch(a, resultSession)
      await eventually(
        async () =>
          (await claimFiles(stateFilePath, goalSession)).length === 0 &&
          (await claimFiles(stateFilePath, resultSession)).length === 0,
        { message: `round ${round} release` },
      )
    }
    const recoveries = host.lifecycle.filter((entry) => /recovered/i.test(entry.text))
    assert.equal(recoveries.length, 0, "reloading a released paused goal announces no recovery")

    const status = await goalCycle(a, host, goalSession, "status")
    assert.match(status, /survive reloads/)
    assert.match(status, /paused/i)
    const result = await goalCycle(a, host, resultSession, "status")
    assert.match(result, /the already finished thing/)
    assert.match(result, /proof recorded/)
    await eventually(async () => (await claimFiles(stateFilePath, resultSession)).length === 0, {
      message: "result session release",
    })
    // The unloaded session still round-trips its last result and archive.
    const persisted = JSON.parse(await readFile(shardStatePath(stateFilePath, resultSession), "utf8"))
    assert.equal(persisted.results[0].condition, "the already finished thing")
    assert.equal(persisted.archives[0].results[0].condition, "archived earlier thing")
    assert.equal(host.lifecycle.filter((entry) => /recovered/i.test(entry.text)).length, 0)
  })
})

test("an active goal recovered after a restart stays active and keeps its lease", { timeout: 20_000 }, async () => {
  await scenario("recovered-active-holds", async ({ directory, stateFilePath, onCleanup }) => {
    const sessionID = "S-recovered-active"
    const previous = spawnProcess(stateFilePath, [{ kind: "command", sessionID, args: "outlive the restart" }], {
      ...FAST,
      idleLeaseReleaseMs: 0,
    })
    await previous.ready
    await previous.stop()

    const host = makeHost()
    const a = await makePlugin(directory, stateFilePath, host)
    onCleanup(() => a.dispose())
    await touch(a, sessionID)
    await sleep(GRACE * 20)
    // The live goal keeps the lease, so no second process can drive it.
    assert.equal((await claimFiles(stateFilePath, sessionID)).length, 1)
    const status = await goal(a, sessionID, "status")
    assert.match(status, /outlive the restart/)
    assert.match(status, /State: active/)
    assert.equal(
      host.lifecycle.filter((entry) => /recovered after a restart and still active/i.test(entry.text)).length,
      1,
      "the recovery is announced once",
    )
  })
})

test("a lost lease is reported once, stops driving, and an explicit command re-acquires", { timeout: 20_000 }, async () => {
  await scenario("lost-lease", async ({ directory, stateFilePath, onCleanup }) => {
    const sessionID = "S-lost-lease"
    const host = makeHost()
    host.messages = [assistantMessage(sessionID)]
    const a = await makePlugin(directory, stateFilePath, host, { idleLeaseReleaseMs: 0 })
    onCleanup(() => a.dispose())
    await goal(a, sessionID, "outlive a reclaim")
    const [claim] = await claimFiles(stateFilePath, sessionID)
    assert.ok(claim, "A holds a claim")
    const claimPath = join(`${shardStatePath(stateFilePath, sessionID)}.lock.claims-v2`, claim)
    await rm(claimPath)
    await eventually(
      () => host.logs.filter((entry) => /moved to another process/.test(entry.body.message)).length === 1,
      { message: "the lost-lease warning" },
    )
    await sleep(GRACE * 4)
    assert.equal(
      host.logs.filter((entry) => /moved to another process/.test(entry.body.message)).length,
      1,
      "the warning is logged once",
    )

    // Another process now owns the session; A must neither write nor drive it.
    const owner = await acquirePersistenceLease(shardStatePath(stateFilePath, sessionID))
    onCleanup(() => owner.release())
    const before = await readFile(shardStatePath(stateFilePath, sessionID), "utf8")
    await idleEvent(a, sessionID, "lost-idle-1")
    await a["chat.params"]({ sessionID, agent: "build" })
    assert.equal(host.prompts.length, 0, "no continuation is sent after the lease is lost")
    assert.equal(await readFile(shardStatePath(stateFilePath, sessionID), "utf8"), before)

    // Once the other owner is gone, an explicit goal command re-acquires.
    await owner.release()
    await sleep(300)
    const status = await goal(a, sessionID, "status")
    assert.doesNotMatch(status, UNAVAILABLE)
    assert.match(status, /outlive a reclaim/)
    assert.equal((await claimFiles(stateFilePath, sessionID)).length, 1)
  })
})

test("the write fence stops persist and prompts before the heartbeat notices a lost claim", { timeout: 20_000 }, async () => {
  await scenario("fence", async ({ directory, stateFilePath, onCleanup }) => {
    const sessionID = "S-fence"
    const host = makeHost()
    host.messages = [assistantMessage(sessionID)]
    // The heartbeat never fires, so only the per-write verification can notice.
    const a = await makePlugin(directory, stateFilePath, host, { idleLeaseReleaseMs: 0, leaseHeartbeatMs: 3_600_000 })
    onCleanup(() => a.dispose())
    await goal(a, sessionID, "fence stale writers")
    const [claim] = await claimFiles(stateFilePath, sessionID)
    await rm(join(`${shardStatePath(stateFilePath, sessionID)}.lock.claims-v2`, claim))
    const before = await readFile(shardStatePath(stateFilePath, sessionID), "utf8")
    await idleEvent(a, sessionID, "fence-idle-1")
    assert.equal(host.prompts.length, 0, "a lost lease must not drive a goal turn")
    assert.equal(await readFile(shardStatePath(stateFilePath, sessionID), "utf8"), before)
  })
})

test("the prompt fence catches a claim lost after the last snapshot write", { timeout: 20_000 }, async () => {
  await scenario("prompt-fence", async ({ directory, stateFilePath, onCleanup }) => {
    const sessionID = "S-prompt-fence"
    const host = makeHost()
    host.messages = [assistantMessage(sessionID)]
    const a = await makePlugin(directory, stateFilePath, host, { idleLeaseReleaseMs: 0, leaseHeartbeatMs: 3_600_000 })
    onCleanup(() => a.dispose())
    await goal(a, sessionID, "never prompt without a lease")
    const claimDirectory = `${shardStatePath(stateFilePath, sessionID)}.lock.claims-v2`
    const statePath = shardStatePath(stateFilePath, sessionID)
    // The snapshot write passes its own lease check; the claim then vanishes, so
    // only the check right before promptAsync can still stop the goal turn.
    const originalRename = sharedFs.rename
    let lost = false
    sharedFs.rename = async (from, to, ...rest) => {
      const result = await originalRename(from, to, ...rest)
      if (to === statePath && !lost) {
        lost = true
        for (const name of await claimFiles(stateFilePath, sessionID)) await rm(join(claimDirectory, name))
      }
      return result
    }
    onCleanup(() => {
      sharedFs.rename = originalRename
    })
    await idleEvent(a, sessionID, "prompt-fence-idle")
    sharedFs.rename = originalRename
    assert.equal(lost, true, "the claim was removed after a snapshot write")
    assert.equal(host.prompts.length, 0, "no goal turn is prompted once the lease is gone")
  })
})

test("idle release in one plugin instance leaves another instance's goal alone", { timeout: 20_000 }, async () => {
  await scenario("two-instances", async ({ directory, stateFilePath, onCleanup }) => {
    // Same session id on purpose, with separate state roots: a timer callback that
    // resolved the wrong runtime would see the other instance's ACTIVE goal.
    const sessionID = "S-shared-id"
    const stateY = join(directory, "y", "state.json")
    const stateX = join(directory, "x", "state.json")
    const hostY = makeHost()
    const hostX = makeHost()
    const y = await makePlugin(directory, stateY, hostY)
    // X is created last so it is the module's `lastRuntime` fallback.
    const x = await makePlugin(directory, stateX, hostX)
    onCleanup(() => y.dispose())
    onCleanup(() => x.dispose())
    await goal(x, sessionID, "x keeps running")
    await goalCycle(y, hostY, sessionID, "y gets paused")
    await goalCycle(y, hostY, sessionID, "pause")
    await eventually(async () => (await claimFiles(stateY, sessionID)).length === 0, {
      message: "Y to release its paused session",
    })
    await sleep(GRACE * 6)
    assert.equal((await claimFiles(stateX, sessionID)).length, 1, "X still holds its lease")
    const xStatus = await goal(x, sessionID, "status")
    assert.match(xStatus, /x keeps running/)
    assert.doesNotMatch(xStatus, /paused/i)
    const yStatus = await goalCycle(y, hostY, sessionID, "status")
    assert.match(yStatus, /y gets paused/)
    assert.match(yStatus, /paused/i)
  })
})

test("an unfinished command turn keeps the lease even with the goal paused", { timeout: 20_000 }, async () => {
  await scenario("pending-turn", async ({ directory, stateFilePath, onCleanup }) => {
    const sessionID = "S-pending-turn"
    const host = makeHost()
    const a = await makePlugin(directory, stateFilePath, host)
    onCleanup(() => a.dispose())
    await goalCycle(a, host, sessionID, "pause me later")
    // The pause is issued but the host never answers it, so its turn stays pending.
    await goal(a, sessionID, "pause")
    await sleep(GRACE * 10)
    assert.equal((await claimFiles(stateFilePath, sessionID)).length, 1, "a pending command turn is not idle")
  })
})

test("idleLeaseReleaseMs: 0 keeps the lifetime lease", { timeout: 20_000 }, async () => {
  await scenario("lifetime", async ({ directory, stateFilePath, onCleanup }) => {
    const sessionID = "S-lifetime"
    const a = spawnProcess(stateFilePath, [{ kind: "touch", sessionID }], { ...FAST, idleLeaseReleaseMs: 0 })
    onCleanup(() => a.stop())
    await a.ready
    await sleep(GRACE * 10)
    const host = makeHost()
    const b = await makePlugin(directory, stateFilePath, host)
    onCleanup(() => b.dispose())
    assert.match(await goal(b, sessionID, "status"), UNAVAILABLE)
  })
})

test("two processes drive different sessions with active goals at once", { timeout: 20_000 }, async () => {
  await scenario("concurrent", async ({ stateFilePath, onCleanup }) => {
    const first = spawnProcess(stateFilePath, [{ kind: "command", sessionID: "S-one", args: "goal one" }], { ...FAST })
    const second = spawnProcess(stateFilePath, [{ kind: "command", sessionID: "S-two", args: "goal two" }], { ...FAST })
    onCleanup(() => first.stop())
    onCleanup(() => second.stop())
    const [firstOutputs, secondOutputs] = await Promise.all([first.ready, second.ready])
    assert.doesNotMatch(firstOutputs[0], UNAVAILABLE)
    assert.doesNotMatch(secondOutputs[0], UNAVAILABLE)
    await sleep(GRACE * 10)
    for (const [sessionID, condition] of [["S-one", /goal one/], ["S-two", /goal two/]]) {
      const persisted = JSON.parse(await readFile(shardStatePath(stateFilePath, sessionID), "utf8"))
      assert.match(persisted.goals[0].condition, condition)
      assert.equal((await claimFiles(stateFilePath, sessionID)).length, 1, `${sessionID} is still held by its driver`)
    }
  })
})

test("idle release never restores the host title or touches session metadata", { timeout: 20_000 }, async () => {
  await scenario("sidebar", async ({ directory, stateFilePath, onCleanup }) => {
    const sessionID = "S-sidebar"
    const host = makeHost()
    const a = await makePlugin(directory, stateFilePath, host)
    onCleanup(() => a.dispose())
    await goalCycle(a, host, sessionID, "show a sidebar")
    await goalCycle(a, host, sessionID, "pause")
    await eventually(async () => (await claimFiles(stateFilePath, sessionID)).length === 0, {
      message: "paused session release",
    })
    const updatesAtRelease = host.updates.length
    assert.ok(updatesAtRelease > 0, "the sidebar was rendered while the goal was live")
    await sleep(GRACE * 6)
    assert.equal(host.updates.length, updatesAtRelease, "release itself issues no host call")
    // Another process takes the released session. Our next event lands on a
    // passive session with no goal in memory; a leftover applied-title record
    // would make syncSidebar "restore" the title the new owner is managing.
    const owner = await acquirePersistenceLease(shardStatePath(stateFilePath, sessionID))
    onCleanup(() => owner.release())
    await a.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    await sleep(GRACE * 6)
    assert.equal(host.updates.length, updatesAtRelease, "no title restore or metadata clear after release")
    assert.equal(host.updates.filter((update) => update.body?.metadata?.goal === null).length, 0)
  })
})

test("child-session events churn the child lease once per event, parent goal untouched", { timeout: 20_000 }, async () => {
  await scenario("child-churn", async ({ directory, stateFilePath, onCleanup }) => {
    const parent = "S-churn-parent"
    const child = "S-churn-child"
    const host = makeHost()
    const a = await makePlugin(directory, stateFilePath, host)
    onCleanup(() => a.dispose())
    await goal(a, parent, "parent keeps going")
    const seenClaims = new Set()
    let polling = true
    const poller = (async () => {
      while (polling) {
        for (const name of await claimFiles(stateFilePath, child)) seenClaims.add(name)
        await sleep(2)
      }
    })()
    const events = 4
    for (let index = 0; index < events; index += 1) {
      await a.event({
        event: { type: "session.status", properties: { sessionID: child, status: { type: "busy" } } },
      })
      await sleep(GRACE * 4)
    }
    polling = false
    await poller
    assert.equal(await claimFiles(stateFilePath, child).then((files) => files.length), 0, "the child shard is released")
    assert.equal((await claimFiles(stateFilePath, parent)).length, 1, "the parent goal's lease is kept")
    console.log(`child-session churn: ${events} events spaced ${GRACE * 4}ms -> ${seenClaims.size} child claims acquired`)
    assert.equal(seenClaims.size, events, "each spaced child event is one acquire/release cycle")
  })
})

// A handler may load a session, await the host for longer than the idle grace,
// and only then mutate goal state; the hook wrapper holds the session meanwhile.
test("a running hook or tool call holds its session against idle release", async () => {
  const { testInternals } = await import(moduleURL)
  const { holdSessionDuring, hookSessionID } = testInternals
  const runtime = { sessionHookDepth: new Map() }

  let finish
  const slow = holdSessionDuring(runtime, "S", () => new Promise((resolve) => { finish = resolve }), [])
  const nested = holdSessionDuring(runtime, "S", async () => "nested", [])
  assert.equal(runtime.sessionHookDepth.get("S"), 2)
  assert.equal(await nested, "nested")
  assert.equal(runtime.sessionHookDepth.get("S"), 1, "the slow call still holds the session")
  finish("done")
  assert.equal(await slow, "done")
  assert.equal(runtime.sessionHookDepth.has("S"), false)

  await assert.rejects(holdSessionDuring(runtime, "S", async () => { throw new Error("boom") }, []), /boom/)
  assert.throws(() => holdSessionDuring(runtime, "S", () => { throw new Error("sync") }, []), /sync/)
  assert.equal(holdSessionDuring(runtime, "S", (value) => value * 2, [21]), 42)
  assert.equal(runtime.sessionHookDepth.size, 0, "rejections, throws and sync returns all release the hold")
  assert.equal(holdSessionDuring(runtime, undefined, () => "no session", []), "no session")
  assert.equal(runtime.sessionHookDepth.size, 0)

  assert.equal(hookSessionID("chat.params", [{ sessionID: "A" }]), "A")
  assert.equal(hookSessionID("event", [{ event: { properties: { sessionID: "B" } } }]), "B")
  assert.equal(hookSessionID("event", [{ event: { properties: { info: { sessionID: "C" } } } }]), "C")
})