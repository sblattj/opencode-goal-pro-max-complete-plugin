// Multi-process lease contract: TWO real `opencode serve` processes share ONE
// project directory, and the goal plugin's per-session persistence lease is
// observed across them.
//
// The plugin keeps per-session state at
//   <project>/.opencode/goals/state.json.sessions/<sha256(sessionID)>/state.json
// and takes an exclusive lease there: `claim-<uuid>.json` files (JSON with
// `pid`, `hostname`, `token`, `protocol`) inside `state.json.lock.claims-v2/`.
// The claim file's `pid` is the most direct observable of ownership, and it is
// compared against the PID that actually listens on each serve process's port.
//
// Arms (each prints PASS/FAIL lines; the script exits 1 if a required arm fails):
//   1  Distinct sessions  — A runs a goal in S1, B runs a goal in S2. Neither is
//      passive for its own session; each claim carries its own process's pid.
//   2  Shared-session takeover — A touches S with an ordinary prompt (no goal)
//      and goes quiet; B then runs `/goal` in S. Post-fix contract: A has
//      released the idle lease, so B's goal is active, B is not passive and the
//      claim pid is B. (A process that holds a lease it does not need until it
//      exits makes this arm FAIL — B goes passive and the claim stays A's.)
//   3  Exclusivity while running — B's goal is running in S3; A issues a goal
//      command in S3. A must be passive (refused) and the claim must stay B's.
//
// "Passive" is observed from the goal command's own output: the plugin rewrites
// the command's synthetic user message, so a refused command carries
// "Goal controls are unavailable ..." and an accepted `/goal <objective>`
// carries "New active goal". The host log (warning "Goal controls are passive
// ...") is reported as a second, unauthoritative observable because that log is
// buffered and shared by both processes.
//
// Requires `opencode` on PATH and a bundled `dist/` (the installer copies
// `dist/`). Deliberately NOT part of `release:check`: the binary is not a dev
// dependency, and the run takes a couple of minutes.
//
// Usage: npm run smoke:multi-process
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  completedCallIDs,
  hostApi,
  installPlugin,
  makeIsolatedTree,
  configureHost,
  promptSession,
  readHostLog,
  runGoalCommand,
  sleep,
  startMockProvider,
  startServe,
  textTurn,
  toolCallTurn,
  waitForToolIds,
} from "./lib/todo-smoke-host.mjs"

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scratch =
  process.env.SMOKE_MULTI_PROCESS_DIR || path.join(os.tmpdir(), "opencode-goal-multi-process-smoke")
const DEADLINE_MS = Number(process.env.SMOKE_MULTI_PROCESS_DEADLINE_MS) || 270_000
const MODEL = `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`
// Long enough for a post-fix process to see the session idle and release.
const QUIET_MS = 8_000
const START_GAP_MS = 2_000

// ---------------------------------------------------------------------------
// Mock model: a goal turn that never finishes the goal
// ---------------------------------------------------------------------------

// Every prompt gets ONE tool call (so no no-tool-call/no-progress brake fires)
// and then a text stop, keyed on the conversation (a tool result is the last
// message) rather than on a call counter. The goal is never completed, so it
// stays "running" until the driver stops it. A request with no tools (title
// and summary calls) gets plain text.
function respond(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  if (tools.length === 0) return textTurn("ok")
  const messages = Array.isArray(body?.messages) ? body.messages : []
  if (messages.at(-1)?.role === "tool") return textTurn("still working")
  const used = completedCallIDs(messages).size
  return toolCallTurn(`call_poll_${used + 1}`, "get_goal", {})
}

// ---------------------------------------------------------------------------
// Result recorder
// ---------------------------------------------------------------------------

const arms = []
let currentArm
function beginArm(id, title, { required = true } = {}) {
  currentArm = { id, title, required, checks: [], skipped: undefined }
  arms.push(currentArm)
  console.log(`\n--- arm ${id}: ${title}${required ? "" : " (informational)"}`)
}
function check(label, ok, detail = "") {
  currentArm.checks.push({ label, ok: Boolean(ok) })
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  return Boolean(ok)
}
function observe(label, detail) {
  console.log(`  OBSERVED  ${label}: ${detail}`)
}
function endArm() {
  const failed = currentArm.checks.filter((entry) => !entry.ok)
  const verdict = currentArm.skipped ? "SKIPPED" : failed.length === 0 ? "PASS" : "FAIL"
  currentArm.verdict = verdict
  console.log(`ARM ${currentArm.id} ${verdict}: ${currentArm.title}${currentArm.skipped ? ` (${currentArm.skipped})` : ""}`)
}

// ---------------------------------------------------------------------------
// Observables
// ---------------------------------------------------------------------------

/** The PID that LISTENS on a serve process's port: the process hosting the plugin. */
async function listenerPid(port) {
  const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
  const pids = stdout.split("\n").map((line) => line.trim()).filter(Boolean).map(Number)
  if (pids.length !== 1) throw new Error(`expected one listener on :${port}, saw ${JSON.stringify(pids)}`)
  return pids[0]
}

function claimDirFor(iso, sessionID) {
  const key = createHash("sha256").update(sessionID).digest("hex")
  return path.join(iso.cwd, ".opencode", "goals", "state.json.sessions", key, "state.json.lock.claims-v2")
}

/** Every `claim-*.json` currently in the session's claim directory. */
async function readClaims(iso, sessionID) {
  const dir = claimDirFor(iso, sessionID)
  let names = []
  try {
    names = (await readdir(dir)).filter((name) => name.startsWith("claim-") && name.endsWith(".json"))
  } catch {
    return []
  }
  const claims = []
  for (const name of names) {
    try {
      claims.push(JSON.parse(await readFile(path.join(dir, name), "utf8")))
    } catch {
      // a claim mid-write or mid-removal is not a claim yet
    }
  }
  return claims
}

const pidsOf = (claims) => [...new Set(claims.map((claim) => claim.pid))].sort((a, b) => a - b)

/** Poll until the claim pids equal `expected` exactly. Returns the last pids seen. */
async function waitForClaimPids(iso, sessionID, expected, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  let pids = []
  do {
    pids = pidsOf(await readClaims(iso, sessionID))
    if (pids.length === expected.length && pids.every((pid, index) => pid === expected[index])) return pids
    await sleep(250)
  } while (Date.now() < deadline)
  return pids
}

const listMessages = async (api, sessionID) => (await api.get(`/session/${sessionID}/message`)) ?? []

/** The text of every user message whose id is not in `knownIDs`, joined. */
function newUserText(messages, knownIDs) {
  return messages
    .filter((message) => message?.info?.role === "user" && !knownIDs.has(message.info.id))
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

const PASSIVE_TEXT = /Goal controls are unavailable/
const ACTIVE_TEXT = /New active goal/

async function goalState(api, sessionID) {
  const info = await api.get(`/session/${sessionID}`)
  return info?.metadata?.goal
}

async function waitForGoalState(api, sessionID, state, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  let goal
  do {
    goal = await goalState(api, sessionID)
    if (goal?.state === state) return goal
    await sleep(250)
  } while (Date.now() < deadline)
  return goal
}

/**
 * `/goal <args>` through the production route; returns the plugin's rewritten
 * command text. It is read from the user messages that did not exist before the
 * command, NOT from the reply's `parentID`: when another process is already
 * driving the session, the reply's parent can be that process's auto-continuation
 * prompt rather than this command's own message. (A timestamp window is no
 * better: the host stamps a command's message tens of milliseconds late, so a
 * window wide enough to catch it also catches the previous command's message.)
 */
async function goalCommand(api, sessionID, args) {
  const known = new Set((await listMessages(api, sessionID)).map((message) => message.info.id))
  await runGoalCommand(api, sessionID, args, { model: MODEL, timeoutMs: 60_000 })
  return newUserText(await listMessages(api, sessionID), known)
}

const snippet = (text) => JSON.stringify(String(text).replace(/\s+/g, " ").slice(0, 120))

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const cleanups = []
let finished = false

async function cleanup() {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()
    try {
      await fn()
    } catch {
      // best effort: a failed stop must not mask the verdict
    }
  }
}

async function main() {
  const { version } = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"))
  const hostVersion = await execFileAsync("opencode", ["--version"]).then(
    (out) => out.stdout.trim(),
    () => "MISSING",
  )
  if (hostVersion === "MISSING") {
    console.error("FAIL  the `opencode` binary is not on PATH; this contract needs the real host")
    return 1
  }
  const bundle = await readFile(path.join(repoRoot, "dist", "goal-plugin.js"), "utf8").catch(() => null)
  if (!bundle) {
    console.error("FAIL  dist/goal-plugin.js is missing; run `npm run bundle` first")
    return 1
  }
  console.log(`multi-process lease contract — plugin ${version}, opencode ${hostVersion}, scratch ${scratch}`)

  const iso = await makeIsolatedTree(scratch)
  const mock = await startMockProvider({ respond })
  cleanups.push(() => mock.close())
  await installPlugin({ repoRoot, iso })
  await configureHost(iso, { baseURL: mock.baseURL })

  // Sequential start: two serve processes launched in the same instant on one
  // data dir fail with "database is locked".
  const serveA = await startServe(iso, { logPath: path.join(scratch, "serve-A.log") })
  cleanups.push(() => serveA.stop())
  const apiA = hostApi(serveA.baseUrl, iso.cwd)
  await waitForToolIds(apiA, ["goal_plan_set"])
  await sleep(START_GAP_MS)
  const serveB = await startServe(iso, { logPath: path.join(scratch, "serve-B.log") })
  cleanups.push(() => serveB.stop())
  const apiB = hostApi(serveB.baseUrl, iso.cwd)
  await waitForToolIds(apiB, ["goal_plan_set"])

  const pidA = await listenerPid(serveA.port)
  const pidB = await listenerPid(serveB.port)
  console.log(`process A pid ${pidA} (:${serveA.port}), process B pid ${pidB} (:${serveB.port}), project ${iso.cwd}`)
  if (pidA === pidB) throw new Error("A and B are the same process")

  const newSession = async (api, title) => (await api.post("/session", { body: { title } })).id
  const claimLine = async (sessionID) => JSON.stringify(pidsOf(await readClaims(iso, sessionID)))

  // --- arm 1 ---------------------------------------------------------------
  beginArm(1, "distinct sessions, one goal per process")
  const s1 = await newSession(apiA, "arm 1 session A")
  const s2 = await newSession(apiB, "arm 1 session B")
  const textA = await goalCommand(apiA, s1, "arm one goal in process A")
  const textB = await goalCommand(apiB, s2, "arm one goal in process B")
  check("A's /goal in S1 was accepted", ACTIVE_TEXT.test(textA), snippet(textA))
  check("B's /goal in S2 was accepted", ACTIVE_TEXT.test(textB), snippet(textB))
  check("A is not passive for S1", !PASSIVE_TEXT.test(textA))
  check("B is not passive for S2", !PASSIVE_TEXT.test(textB))
  const goal1 = await waitForGoalState(apiA, s1, "active")
  const goal2 = await waitForGoalState(apiB, s2, "active")
  check("S1's goal is active", goal1?.state === "active", `state ${goal1?.state}`)
  check("S2's goal is active", goal2?.state === "active", `state ${goal2?.state}`)
  const pids1 = await waitForClaimPids(iso, s1, [pidA])
  const pids2 = await waitForClaimPids(iso, s2, [pidB])
  check(`S1's claim pid = A (${pidA})`, JSON.stringify(pids1) === JSON.stringify([pidA]), `claims ${JSON.stringify(pids1)}`)
  check(`S2's claim pid = B (${pidB})`, JSON.stringify(pids2) === JSON.stringify([pidB]), `claims ${JSON.stringify(pids2)}`)
  endArm()
  // Stop the arm-1 goals so they stop generating turns while the later arms run.
  await goalCommand(apiA, s1, "clear").catch(() => "")
  await goalCommand(apiB, s2, "clear").catch(() => "")

  // --- arm 2 ---------------------------------------------------------------
  beginArm(2, "shared session: the idle lease is released and B takes over")
  const s = await newSession(apiA, "arm 2 shared session")
  await promptSession(apiA, s, "an ordinary prompt, no goal here", { timeoutMs: 60_000 })
  const claimsAfterPrompt = await claimLine(s)
  observe("S's claim pids right after A's ordinary prompt", claimsAfterPrompt)
  console.log(`  ... A goes quiet for ${QUIET_MS / 1000}s`)
  await sleep(QUIET_MS)
  observe("S's claim pids after A's quiet period", await claimLine(s))
  const textTakeover = await goalCommand(apiB, s, "arm two goal taken over by process B")
  check("B's /goal in S was accepted", ACTIVE_TEXT.test(textTakeover), snippet(textTakeover))
  check("B is not passive for S", !PASSIVE_TEXT.test(textTakeover))
  const goalS = await waitForGoalState(apiB, s, "active")
  check("B's goal in S is active", goalS?.state === "active", `state ${goalS?.state}`)
  const pidsS = await waitForClaimPids(iso, s, [pidB])
  check(`S's claim pid = B (${pidB})`, JSON.stringify(pidsS) === JSON.stringify([pidB]), `claims ${JSON.stringify(pidsS)}, A is ${pidA}`)
  endArm()
  await goalCommand(apiB, s, "clear").catch(() => "")

  // --- arm 3 ---------------------------------------------------------------
  beginArm(3, "exclusivity: A is refused while B's goal runs")
  const s3 = await newSession(apiB, "arm 3 session")
  const textRun = await goalCommand(apiB, s3, "arm three goal that keeps running")
  check("B's /goal in S3 was accepted", ACTIVE_TEXT.test(textRun), snippet(textRun))
  const before = await waitForGoalState(apiB, s3, "active")
  check("B's goal in S3 is running (active)", before?.state === "active", `state ${before?.state}`)
  const turnsBefore = before?.turns?.used
  const textRefused = await goalCommand(apiA, s3, "status")
  check("A is passive / refused for S3", PASSIVE_TEXT.test(textRefused), snippet(textRefused))
  await sleep(2_000)
  const pids3 = pidsOf(await readClaims(iso, s3))
  check(`S3's claim pid stays B (${pidB})`, JSON.stringify(pids3) === JSON.stringify([pidB]), `claims ${JSON.stringify(pids3)}`)
  const after = await goalState(apiB, s3)
  check("B's goal in S3 is still active", after?.state === "active", `state ${after?.state}, turns ${turnsBefore} -> ${after?.turns?.used}`)
  endArm()
  await goalCommand(apiB, s3, "clear").catch(() => "")

  // --- the host log, as a second observable --------------------------------
  const log = await readHostLog(iso, { marker: "Goal controls are passive", timeoutMs: 8_000 })
  const warnings = log.split("\n").filter((line) => line.includes("Goal controls are passive"))
  const byRun = new Map()
  for (const line of warnings) {
    const run = line.match(/run=(\S+)/)?.[1] ?? "?"
    byRun.set(run, (byRun.get(run) ?? 0) + 1)
  }
  observe(
    "host log passive warnings (shared, buffered, run id per process)",
    warnings.length === 0
      ? "none reached opencode.log"
      : `${warnings.length} reached opencode.log: ${[...byRun].map(([run, n]) => `run=${run} x${n}`).join(", ")}`,
  )

  const failedRequired = arms.filter((arm) => arm.required && arm.verdict === "FAIL")
  console.log("\nSUMMARY")
  for (const arm of arms) console.log(`  arm ${arm.id}: ${arm.verdict}  ${arm.title}`)
  return failedRequired.length === 0 ? 0 : 1
}

const deadline = setTimeout(async () => {
  if (finished) return
  console.error(`FAIL  overall deadline of ${DEADLINE_MS / 1000}s exceeded`)
  await cleanup()
  process.exit(1)
}, DEADLINE_MS)
deadline.unref()

main().then(
  async (code) => {
    finished = true
    await cleanup()
    process.exit(code)
  },
  async (error) => {
    finished = true
    console.error(`FAIL  ${error?.stack ?? error}`)
    await cleanup()
    process.exit(1)
  },
)
