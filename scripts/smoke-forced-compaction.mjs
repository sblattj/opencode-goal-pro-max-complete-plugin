// Real-host A/B smoke for forced compaction (`--compact-at`).
//
// The unit suite drives the plugin with a fake client. This is the run it cannot
// do: the real `opencode` binary, the production plugin loader, the real
// POST /session/:id/summarize, the host's compaction loop and the real SQLite
// rows. Nothing is faked except the model, a mock OpenAI-compatible endpoint on
// localhost, so no real model is called and no tokens are spent.
//
// Requires `~/.opencode/bin/opencode` and a bundled `dist/` (`npm run bundle`):
// the installer copies `dist/`, so a stale bundle smokes the OLD code. Not part
// of `release:check`: the binary is not a dev dependency.
//
// Usage: npm run smoke:forced-compaction
//
// Every model has `limit: { context: 0 }` (arm D excepted). That is the real case
// the feature exists for: host overflow.ts `isOverflow` returns false on it, so
// the host never compacts by itself and any summary row is the plugin's.
//
// Arms:
//   B  --compact-at 30k                  the plugin forces a compaction mid-turn
//   A  CONTROL --compact-at 0            same run, plugin off: the host stays quiet
//   D  CONTROL context 20k, compact-at 0 the host DOES compact: A's detector can fail
//   H  input 38k, reserved 8k, compact-at 30k: host and plugin cross on one step,
//      and only one compaction may run
//   C  --compact-at 30k, HTTP 500 on every compaction request: each failed request
//      is deleted, so the goal's work carries on and the cap of 3 ends the forcing
//   T  --compact-at 30k, HTTP 500 on the first plugin request only (a transient
//      outage): that request is deleted and Trigger A asks again on a later step
//   L  --compact-at 30k, the threshold is first crossed by the LAST step of a turn:
//      the host goes idle milliseconds later, while the request is still on its way
//   E  CONTROL no goal at all, a bare POST /summarize that fails: whether a failed
//      compaction blocks later prompts is the host's behaviour, not the plugin's
//
// Two deliberate departures from the shared harness, both wrapped here:
//   * `bootHost` hard-codes the provider block, so the boot is inlined to patch
//     `limit.context` between `configureHost` and the serve.
//   * `startServe`/`isolatedEnv` set OPENCODE_DISABLE_AUTOCOMPACT=1, which the host
//     turns into `compaction.auto=false` (config.ts:593) and which alone makes
//     `isOverflow` false. Left in, arm A would pass whatever `limit.context` says.
//     This script's serve removes it so `limit.context` is the only factor.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  configureHost,
  conversationText,
  findDatabase,
  freePort,
  hostApi,
  installPlugin,
  isolatedEnv,
  makeIsolatedTree,
  runGoalCommand,
  sleep,
  waitForToolIds,
} from "./lib/todo-smoke-host.mjs"

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OPENCODE_BIN = path.join(homedir(), ".opencode", "bin", "opencode")
const EXPECTED_HOST_VERSION = "1.19.0"

const scratch = mkdtempSync(path.join(tmpdir(), "fc-smoke-"))
const logFile = path.join(scratch, "run.log")
writeFileSync(logFile, "")
console.log(`LOG ${logFile}`)

const THRESHOLD = 30_000
const MAX_SCRIPTED_STEPS = 8
const PRE_COMPACTION_USAGE = [5_000, 12_000, 40_000] // then HIGH_USAGE
const HIGH_USAGE = 45_000
const LOW_USAGE = 2_000
// Per-request model latency. SMOKE_FC_LATENCY_MS=0 reproduces the design point
// where no request ever gets out (forced compaction loses the race with the steps).
const MODEL_LATENCY_MS = Number(process.env.SMOKE_FC_LATENCY_MS ?? 1000)
const COMPLETION_TOKENS = 10
const SUMMARY_MARKER = "SMOKE-SUMMARY-MARKER"
const SUMMARIZER_TEXT = "context summarization agent" // the compaction agent's system prompt
const COMPACTION_PROMPT_TEXT = "What did we do so far?" // host message-v2.ts: a compaction part, as the model sees it
const TITLE_TEXT = "title generator"
const CONTROL_TEXT = "goal_command_control"
// One failed compaction request is six HTTP hits: the host's first try plus
// RETRY_MAX_RETRIES=5 (retry.ts), about 60 s of backoff. Arms C and T keep that real timing.
const HOST_ATTEMPTS_PER_REQUEST = 6
const ARM_LIMIT_MS = { B: 150_000, A: 120_000, D: 120_000, L: 120_000, C: 420_000, T: 240_000, E: 150_000, H: 150_000 }
const WHOLE_RUN_LIMIT_MS = 20 * 60_000

function log(line) {
  appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
}

// ---------------------------------------------------------------------------
// Own-PID bookkeeping: only these children are ever signalled
// ---------------------------------------------------------------------------

const liveChildren = new Set()
process.on("exit", () => {
  for (const child of liveChildren) child.kill("SIGKILL")
})
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130))
const wholeRunTimer = setTimeout(() => {
  console.log(`FAIL  WHOLE-RUN exceeded ${WHOLE_RUN_LIMIT_MS} ms; killing own serve PIDs`)
  process.exit(2)
}, WHOLE_RUN_LIMIT_MS)
wholeRunTimer.unref()

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

const results = []

function check(label, body) {
  try {
    body()
    results.push({ label, ok: true })
    console.log(`PASS  ${label}`)
  } catch (error) {
    results.push({ label, ok: false })
    console.log(`FAIL  ${label}: ${error.message}`)
  }
  log(`verdict ${results.at(-1).ok ? "PASS" : "FAIL"} ${label}`)
}

function observe(label, detail) {
  console.log(`OBSERVED  ${label}: ${detail}`)
  log(`observed ${label}: ${detail}`)
}

// ---------------------------------------------------------------------------
// Mock provider: own server, because the shared one always answers 200 and its
// chunk builder cannot carry `usage`. Chunk shapes are the harness's, plus usage.
// ---------------------------------------------------------------------------

const sse = (value) => (value === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(value)}\n\n`)

function chunk({ delta = {}, finish, usage }) {
  return {
    id: "chatcmpl-smoke",
    object: "chat.completion.chunk",
    choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
    ...(usage ? { usage } : {}),
  }
}

function usageBlock(promptTokens) {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: COMPLETION_TOKENS,
    total_tokens: promptTokens + COMPLETION_TOKENS,
  }
}

function toolTurn(callID, name, args, promptTokens) {
  return [
    chunk({ delta: { role: "assistant" } }),
    chunk({ delta: { tool_calls: [{ index: 0, id: callID, type: "function", function: { name, arguments: "" } }] } }),
    chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }),
    chunk({ finish: "tool_calls", usage: usageBlock(promptTokens) }),
    "[DONE]",
  ]
}

function textTurn(text, promptTokens) {
  return [
    chunk({ delta: { role: "assistant" } }),
    chunk({ delta: { content: text } }),
    chunk({ finish: "stop", usage: usageBlock(promptTokens) }),
    "[DONE]",
  ]
}

function lastUserText(messages) {
  const user = (Array.isArray(messages) ? messages : []).findLast((message) => message?.role === "user")
  return user ? conversationText([user]) : ""
}

function classify(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const text = conversationText(body?.messages)
  if (tools.length === 0) {
    if (text.includes(SUMMARIZER_TEXT)) return "compaction"
    if (text.includes(TITLE_TEXT)) return "title"
    return "toolless-other"
  }
  if (lastUserText(body?.messages).includes(CONTROL_TEXT)) return "control"
  return "work"
}

/** The state-driven script. All counters are read back by the driver and the verdicts. */
function makeScript({ failCompactionHits = 0, crossOnLastStep = false } = {}) {
  const state = {
    seq: 0,
    events: [],
    steps: 0, // scripted tool steps served before any compaction landed
    preTexts: 0,
    compactionHits: 0,
    compactionServed: 0,
    postRequests: 0,
    postTexts: 0,
    afterLastCompaction: 0, // work requests since the newest compaction request
    workLeakedCompactionPrompt: false, // a work request carried a compaction message's text
    level: PRE_COMPACTION_USAGE[0],
  }
  const record = (kind, detail = {}) => {
    state.seq += 1
    const event = { seq: state.seq, at: Date.now(), kind, ...detail }
    state.events.push(event)
    log(`mock #${event.seq} ${kind} ${JSON.stringify(detail)}`)
  }
  const respond = (body) => {
    const kind = classify(body)
    if (kind === "compaction") {
      state.compactionHits += 1
      state.afterLastCompaction = 0
      const failCompaction = state.compactionHits <= failCompactionHits
      record("compaction", {
        hit: state.compactionHits,
        stepsSoFar: state.steps,
        lastLevel: state.level,
        answer: failCompaction ? 500 : "summary",
      })
      if (failCompaction) {
        return { status: 500, json: { error: { message: "smoke: compaction refused", type: "server_error" } } }
      }
      state.compactionServed += 1
      state.level = LOW_USAGE
      // Big usage on the summary itself: the real thing bills the whole history.
      return { lines: textTurn(`${SUMMARY_MARKER}: goal in progress, keep going.`, HIGH_USAGE) }
    }
    if (kind === "title") {
      record("title")
      return { lines: textTurn("Smoke title", 100) }
    }
    if (kind === "toolless-other") {
      record("toolless-other", { text: conversationText(body?.messages).slice(0, 200) })
      return { lines: textTurn("ok", 100) }
    }
    if (kind === "control") {
      record("control", { level: state.level })
      return { lines: textTurn("Control command noted.", state.level) }
    }

    // A work request.
    state.afterLastCompaction += 1
    const text = conversationText(body?.messages)
    state.workLeakedCompactionPrompt ||= state.compactionHits > 0 && text.includes(COMPACTION_PROMPT_TEXT)
    if (state.compactionServed > 0) {
      state.postRequests += 1
      const sawSummary = text.includes(SUMMARY_MARKER)
      const sawGoalBlock = lastUserText(body?.messages).includes("<goal")
      record("post-work", { post: state.postRequests, usage: LOW_USAGE, sawSummary, sawGoalBlock })
      if (state.postRequests <= 2) {
        const id = `call_post${state.postRequests}`
        return { lines: toolTurn(id, "bash", { command: `echo post-${state.postRequests}`, description: "smoke" }, LOW_USAGE) }
      }
      state.postTexts += 1
      return { lines: textTurn("Still working after compaction.", LOW_USAGE) }
    }
    if (crossOnLastStep && state.steps >= 1) {
      state.preTexts += 1
      state.level = HIGH_USAGE
      record("pre-text", { usage: HIGH_USAGE })
      return { lines: textTurn("The turn's last step, over the threshold.", HIGH_USAGE) }
    }
    if (state.steps < MAX_SCRIPTED_STEPS) {
      const usage = PRE_COMPACTION_USAGE[state.steps] ?? HIGH_USAGE
      state.steps += 1
      state.level = usage
      record("step", { step: state.steps, usage })
      const id = `call_s${state.steps}`
      return { lines: toolTurn(id, "bash", { command: `echo step-${state.steps}`, description: "smoke" }, usage) }
    }
    state.preTexts += 1
    state.level = HIGH_USAGE
    record("pre-text", { usage: HIGH_USAGE })
    return { lines: textTurn("Scripted steps done; still working.", HIGH_USAGE) }
  }
  return { state, respond }
}

async function startMock(respond) {
  const server = createServer((req, res) => {
    const parts = []
    req.on("data", (part) => parts.push(part))
    req.on("end", () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")
      } catch {
        body = {}
      }
      if (!String(req.url || "").includes("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "not found" }))
        return
      }
      const answer = respond(body)
      if (answer.status) {
        res.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) })
        res.end(JSON.stringify(answer.json))
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
      // A real model takes seconds per step. The plugin's request path awaits a
      // lease check and a persist, so a mock that answers in milliseconds finishes
      // several steps inside that window; see MODEL_LATENCY_MS.
      setTimeout(() => {
        for (const line of answer.lines) res.write(sse(line))
        res.end()
      }, MODEL_LATENCY_MS)
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// ---------------------------------------------------------------------------
// The real host, with `limit.context` as the only varied factor
// ---------------------------------------------------------------------------

function patchContextLimit(iso, context, hostOverflow) {
  const config = JSON.parse(readFileSync(iso.configFile, "utf8"))
  for (const model of Object.values(config.provider[MOCK_PROVIDER_ID].models)) {
    model.limit.context = context
    if (hostOverflow) model.limit.input = hostOverflow.input
  }
  if (hostOverflow) config.compaction = { auto: true, reserved: hostOverflow.reserved }
  writeFileSync(iso.configFile, `${JSON.stringify(config, null, 2)}\n`)
}

function hostEnv(iso) {
  const env = isolatedEnv(iso)
  delete env.OPENCODE_DISABLE_AUTOCOMPACT // see the file header
  return env
}

async function startHost(iso, serveLogPath) {
  const port = await freePort()
  const child = spawn(OPENCODE_BIN, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: iso.cwd,
    env: hostEnv(iso),
    stdio: ["ignore", "pipe", "pipe"],
  })
  liveChildren.add(child)
  log(`serve pid ${child.pid} port ${port} log ${serveLogPath}`)
  let output = ""
  const record = (part) => {
    output += String(part)
    appendFileSync(serveLogPath, String(part))
  }
  child.stdout.on("data", record)
  child.stderr.on("data", record)
  const exited = new Promise((resolve) => {
    child.on("close", () => {
      liveChildren.delete(child)
      resolve("closed")
    })
  })
  const stop = async () => {
    if (!liveChildren.has(child)) return
    child.kill("SIGTERM")
    const raced = await Promise.race([exited, sleep(5000).then(() => "timeout")])
    if (raced === "timeout") child.kill("SIGKILL")
    await exited
  }
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && liveChildren.has(child)) {
    const match = output.match(/listening on (http:\/\/\S+)/)
    if (match) {
      const baseUrl = match[1].trim()
      if (!baseUrl.endsWith(`:${port}`)) {
        await stop()
        throw new Error(`serve bound ${baseUrl}, not the isolated port ${port}`)
      }
      return { baseUrl, stop }
    }
    await sleep(100)
  }
  await stop()
  throw new Error(`opencode serve never reported a URL. Log: ${serveLogPath}`)
}

/**
 * Diagnostic, off by default: SMOKE_FC_TRACE=1 patches the ISOLATED installed copy
 * of the bundle (never `src/` or `dist/`) to record what the host answered the
 * plugin's summarize call. A run with it on is not a production observation.
 */
function patchSummarizeTrace(iso, tracePath) {
  const bundle = path.join(iso.pluginDir, "dist", "goal-plugin.js")
  const needle = "const response = await method.call(client.session, firstInput);"
  const source = readFileSync(bundle, "utf8")
  assert.ok(source.includes(needle), "trace needle not found in the installed bundle")
  const trace = `if (operation === "summarize") { const t0 = Date.now(); import("node:fs").then((fs) => fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ phase: "call", at: t0, input: firstInput }) + "\\n")); }`
  const after = `if (operation === "summarize") { const snap = JSON.stringify({ phase: "answer", at: Date.now(), status: response?.response?.status, url: response?.response?.url, data: response?.data, error: response?.error }); import("node:fs").then((fs) => fs.appendFileSync(${JSON.stringify(tracePath)}, snap + "\\n")); }`
  writeFileSync(bundle, source.replace(needle, `${trace} ${needle} ${after}`))
}

async function boot(armName, { context, hostOverflow, respond }) {
  const root = path.join(scratch, armName)
  const iso = await makeIsolatedTree(root)
  const mock = await startMock(respond)
  await installPlugin({ repoRoot, iso })
  await configureHost(iso, { baseURL: mock.baseURL })
  patchContextLimit(iso, context, hostOverflow)
  if (process.env.SMOKE_FC_TRACE) patchSummarizeTrace(iso, path.join(scratch, `${armName}-summarize-trace.jsonl`))
  const serve = await startHost(iso, path.join(scratch, `${armName}-serve.log`))
  const api = hostApi(serve.baseUrl, iso.cwd)
  const toolIDs = await waitForToolIds(api, ["goal_plan_set", "bash"])
  return {
    iso,
    api,
    toolIDs,
    async stop() {
      await serve.stop()
      await mock.close()
    },
  }
}

/** What the running host resolved the model's limit to: the config file proves nothing. */
async function resolvedContextLimit(api) {
  const answer = await api.get("/config/providers")
  const provider = (answer?.providers ?? []).find((entry) => entry.id === MOCK_PROVIDER_ID)
  return provider?.models?.[MOCK_MODEL_ID]?.limit
}

// ---------------------------------------------------------------------------
// Observables: the real database and the persisted goal
// ---------------------------------------------------------------------------

async function sqliteJson(database, sql) {
  const { stdout } = await execFileAsync("sqlite3", ["-json", database, sql], { maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim() ? JSON.parse(stdout) : []
}

function tokenTotal(tokens) {
  if (!tokens) return 0
  if (tokens.total > 0) return tokens.total
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
}

async function readSessionRows(iso, sessionID) {
  const database = findDatabase(iso)
  assert.ok(database, `no opencode.db under ${iso.data}`)
  assert.ok(database.startsWith(iso.root), `database ${database} is outside the isolated tree`)
  const rows = await sqliteJson(
    database,
    `select id, time_created, data from message where session_id = '${sessionID}' order by id`,
  )
  const parts = await sqliteJson(
    database,
    `select message_id, json_extract(data,'$.type') as type, json_extract(data,'$.auto') as auto from part where session_id = '${sessionID}' order by id`,
  )
  const compactionParents = new Map(parts.filter((part) => part.type === "compaction").map((part) => [part.message_id, part]))
  return rows.map((row) => {
    const data = JSON.parse(row.data)
    return {
      id: row.id,
      at: row.time_created,
      role: data.role,
      summary: Boolean(data.summary),
      mode: data.mode,
      finish: data.finish,
      error: data.error?.name ?? data.error?.message ?? (data.error ? "error" : undefined),
      tokens: tokenTotal(data.tokens),
      compaction: compactionParents.has(row.id),
      compactionAuto: compactionParents.get(row.id)?.auto,
    }
  })
}

const summaryRows = (rows) => rows.filter((row) => row.role === "assistant" && row.summary)
const goodSummaries = (rows) => summaryRows(rows).filter((row) => row.finish && row.finish !== "error" && !row.error)
const stepRows = (rows) => rows.filter((row) => row.role === "assistant" && !row.summary)

function timelineOf(rows) {
  return rows
    .map((row) =>
      row.role === "assistant"
        ? `${row.summary ? "SUMMARY" : "step"}[${row.tokens}${row.finish ? `,${row.finish}` : ""}${row.error ? `,ERR:${row.error}` : ""}]`
        : row.compaction
          ? `compaction-user[auto=${row.compactionAuto}]`
          : "user",
    )
    .join(" > ")
}

function statePathFor(iso, sessionID) {
  const key = createHash("sha256").update(sessionID).digest("hex")
  // resolveStateFilePath: the project-local default, `<cwd>/.opencode/goals/state.json`.
  return path.join(iso.cwd, ".opencode", "goals", "state.json.sessions", key, "state.json")
}

/** The goal record that holds `compactionEpoch`, wherever the state file nests it. */
function findGoalRecord(value) {
  if (!value || typeof value !== "object") return null
  if (!Array.isArray(value) && "compactionEpoch" in value) return value
  for (const child of Object.values(value)) {
    const found = findGoalRecord(child)
    if (found) return found
  }
  return null
}

function readPersistedGoal(iso, sessionID) {
  const file = statePathFor(iso, sessionID)
  if (!existsSync(file)) return null
  try {
    return findGoalRecord(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return null // caught mid-write; the next poll reads it
  }
}

function readLedgerText(iso, sessionID) {
  const file = `${statePathFor(iso, sessionID)}.ledger.jsonl`
  return existsSync(file) ? readFileSync(file, "utf8") : ""
}

async function statusText(api, sessionID) {
  const messages = await api.get(`/session/${sessionID}/message`, { query: { limit: "500" } })
  const texts = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.info?.role !== "user") continue
    for (const part of message.parts ?? []) {
      if (part?.type === "text" && part.text?.includes("Forced compaction:")) texts.push(part.text)
    }
  }
  return texts.at(-1) ?? ""
}

function forcedHistory(goal) {
  return (goal?.history ?? []).filter((entry) => entry.type === "forced-compaction")
}

async function waitUntil(predicate, { deadline, everyMs = 250 }) {
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(everyMs)
  }
  return false
}

// ---------------------------------------------------------------------------
// One arm
// ---------------------------------------------------------------------------

/**
 * Boots an arm, starts the goal WITHOUT awaiting the command (its reply only
 * arrives when the whole run ends), waits for `done(script state, goal)`, then
 * takes the observations while the goal is still active and stops it.
 */
async function runArm(name, { context, hostOverflow, compactAt, script, done, limitMs }) {
  const startedAt = Date.now()
  const deadline = startedAt + limitMs
  log(`=== arm ${name}: context=${context} compactAt=${compactAt}`)
  const host = await boot(name, { context, hostOverflow, respond: script.respond })
  const observed = { name, script: script.state }
  try {
    observed.toolLoaded = host.toolIDs.includes("goal_plan_set")
    observed.limit = await resolvedContextLimit(host.api)
    observed.env = { OPENCODE_DISABLE_AUTOCOMPACT: hostEnv(host.iso).OPENCODE_DISABLE_AUTOCOMPACT ?? "(unset)" }
    const session = await host.api.post("/session", { body: { title: `forced compaction smoke ${name}` } })
    observed.sessionID = session.id
    const args = `prove forced compaction on a real host --compact-at ${compactAt} --max-turns 60`
    runGoalCommand(host.api, session.id, args, {
      model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
      timeoutMs: limitMs,
    }).then(
      () => log(`arm ${name}: the /goal command reply arrived`),
      (error) => log(`arm ${name}: the /goal command reply rejected: ${error.message}`),
    )

    observed.settled = await waitUntil(
      () => done(script.state, readPersistedGoal(host.iso, session.id)),
      { deadline },
    )
    observed.waitedMs = Date.now() - startedAt
    log(`arm ${name}: settled=${observed.settled} after ${observed.waitedMs} ms`)

    observed.goalBeforeStatus = readPersistedGoal(host.iso, session.id)
    observed.rowsBeforeStatus = await readSessionRows(host.iso, session.id)

    const remaining = () => Math.max(5_000, deadline - Date.now())
    try {
      await runGoalCommand(host.api, session.id, "status", {
        model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
        timeoutMs: remaining(),
      })
      observed.status = await statusText(host.api, session.id)
    } catch (error) {
      observed.status = ""
      observed.statusError = error.message
    }
    observed.goalAfterStatus = readPersistedGoal(host.iso, session.id)
    observed.ledger = readLedgerText(host.iso, session.id)

    try {
      await runGoalCommand(host.api, session.id, "stop", {
        model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
        timeoutMs: remaining(),
      })
      observed.stopped = true
    } catch (error) {
      observed.stopped = false
      observed.stopError = error.message
    }
    observed.rows = await readSessionRows(host.iso, session.id)
    observed.ledger = readLedgerText(host.iso, session.id) || observed.ledger
  } finally {
    await host.stop()
  }
  observed.tookMs = Date.now() - startedAt
  observe(`${name} timing`, `settled=${observed.settled} waited ${observed.waitedMs} ms, whole arm ${observed.tookMs} ms`)
  observe(`${name} resolved limit`, `${JSON.stringify(observed.limit)}, env ${JSON.stringify(observed.env)}`)
  observe(`${name} DB order`, timelineOf(observed.rows))
  observe(`${name} mock order`, script.state.events.map(describeEvent).join(" > "))
  observe(
    `${name} mock counters`,
    `steps=${script.state.steps} preTexts=${script.state.preTexts} compactionHits=${script.state.compactionHits} compactionServed=${script.state.compactionServed} postRequests=${script.state.postRequests} afterLastCompaction=${script.state.afterLastCompaction}`,
  )
  observe(`${name} forced-compaction history`, JSON.stringify(forcedHistory(observed.goalAfterStatus).map((entry) => entry.detail)))
  return observed
}

function describeEvent(event) {
  switch (event.kind) {
    case "step":
      return `step${event.step}@${event.usage}`
    case "compaction":
      return `COMPACTION#${event.hit}(after step ${event.stepsSoFar}, ${event.answer})`
    case "post-work":
      return `post${event.post}@${event.usage}(summary=${event.sawSummary},goalBlock=${event.sawGoalBlock})`
    case "pre-text":
      return `text@${event.usage}`
    default:
      return event.kind
  }
}

function setupChecks(armName, observed, expectedContext) {
  check(`SETUP-${armName} the plugin's tools reached the real registry`, () => {
    assert.equal(observed.toolLoaded, true)
  })
  check(`SETUP-${armName} the running host resolved limit.context=${expectedContext}`, () => {
    assert.equal(observed.limit?.context, expectedContext, `resolved limit ${JSON.stringify(observed.limit)}`)
  })
  check(`SETUP-${armName} the mock's usage reached the DB (first step tokens 5,010)`, () => {
    const first = stepRows(observed.rows)[0]
    assert.equal(first?.tokens, PRE_COMPACTION_USAGE[0] + COMPLETION_TOKENS, `first step row ${JSON.stringify(first)}`)
  })
}

/** Run an arm inside its wall clock; a thrown or timed-out arm FAILs its labels. */
async function guarded(armName, labels, limitMs, body) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`arm ${armName} hit its ${limitMs} ms bound`)), limitMs + 45_000)
  })
  try {
    return await Promise.race([body(), timeout])
  } catch (error) {
    log(`arm ${armName} aborted: ${error.stack}`)
    for (const label of labels) check(label, () => assert.fail(`arm aborted: ${error.message}`))
    for (const child of liveChildren) child.kill("SIGKILL")
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

async function armB() {
  const script = makeScript()
  const observed = await guarded("B", ["B1", "B2", "B3", "B4", "B5"], ARM_LIMIT_MS.B, () =>
    runArm("B", {
      context: 0,
      compactAt: "30k",
      script,
      limitMs: ARM_LIMIT_MS.B,
      // Past the two low tool steps and one plugin continuation's text, so a
      // re-fire from the summary's big usage has had its idle to show itself.
      done: (state) => state.compactionServed >= 1 && state.postTexts >= 2,
    }),
  )
  if (!observed) return null
  setupChecks("B", observed, 0)

  const rows = observed.rows
  const events = observed.script.events
  const steps = stepRows(rows)
  const crossing = steps.findIndex((row) => row.tokens >= THRESHOLD) + 1
  const firstSummaryIndex = rows.findIndex((row) => row.role === "assistant" && row.summary)
  const stepsBeforeSummary = rows.slice(0, Math.max(firstSummaryIndex, 0)).filter((row) => row.role === "assistant" && !row.summary).length
  const firstHit = events.find((event) => event.kind === "compaction")

  check(`B1 a real summary row exists (summary rows ok=${goodSummaries(rows).length}, all=${summaryRows(rows).length})`, () => {
    assert.ok(goodSummaries(rows).length >= 1, timelineOf(rows))
  })
  observe("B2 step numbers", `threshold first crossed at DB step ${crossing}; DB steps before the summary ${stepsBeforeSummary}; mock steps served when the compaction request arrived ${firstHit?.stepsSoFar}; scripted steps ${MAX_SCRIPTED_STEPS}`)
  check(`B2 mid-turn: compaction after step ${crossing} (first >=30k), at step ${stepsBeforeSummary}, within 2 steps and before the script ran out`, () => {
    assert.ok(firstSummaryIndex >= 0, "no summary row")
    assert.ok(crossing >= 1, "no step crossed the threshold")
    assert.ok(stepsBeforeSummary >= crossing, `summary before the crossing step (${stepsBeforeSummary} < ${crossing})`)
    assert.ok(stepsBeforeSummary <= crossing + 2, `summary ${stepsBeforeSummary - crossing} steps after the crossing`)
    assert.ok(firstHit?.stepsSoFar < MAX_SCRIPTED_STEPS, `the script had run out (${firstHit?.stepsSoFar})`)
  })

  const afterSummary = firstSummaryIndex >= 0 ? rows.slice(firstSummaryIndex + 1) : []
  const lowAfter = afterSummary.filter((row) => row.role === "assistant" && !row.summary && row.finish && row.tokens < THRESHOLD)
  const firstPost = events.find((event) => event.kind === "post-work")
  observe("B3 values", `model work requests after the summary ${observed.script.postRequests}; low-token steps after it ${JSON.stringify(lowAfter.map((row) => row.tokens))}; first such request saw the summary=${firstPost?.sawSummary}, goal block=${firstPost?.sawGoalBlock}; arm settled=${observed.settled}`)
  check("B3 the goal continued after compaction (further model requests, later low-token steps, not stuck)", () => {
    assert.ok(observed.script.postRequests >= 1, "no model request after the summary")
    assert.ok(lowAfter.length >= 1, `no low-token step after the summary: ${timelineOf(rows)}`)
    assert.equal(observed.settled, true, "the arm never reached its later continuation: stuck")
    assert.equal(observed.goalBeforeStatus?.stopped ?? false, false, "the goal was stopped before the driver stopped it")
  })

  const goal = observed.goalAfterStatus
  observe("B4 values", `status line ${JSON.stringify((observed.status.match(/Forced compaction:.*/) ?? [""])[0])}${observed.statusError ? ` (status error: ${observed.statusError})` : ""}; compactionEpoch=${goal?.compactionEpoch}; stalledCompactions=${goal?.stalledCompactions}; forcedCompaction=${JSON.stringify(goal?.forcedCompaction)}; turnCount=${goal?.turnCount}`)
  check("B4 status shows the threshold; persisted compactionEpoch>=1, stalledCompactions=0, history has the forced entry", () => {
    assert.match(observed.status, /Forced compaction: at 30,000 tokens/)
    assert.ok(goal, "no persisted goal record")
    assert.ok(goal.compactionEpoch >= 1, `compactionEpoch ${goal.compactionEpoch}`)
    assert.equal(goal.stalledCompactions, 0)
    assert.ok(forcedHistory(goal).some((entry) => /requested/.test(entry.detail)), "no forced-compaction history entry")
  })

  let crossings = 0
  let wasOver = false
  for (const row of steps) {
    const over = row.tokens >= THRESHOLD
    if (over && !wasOver) crossings += 1
    wasOver = over
  }
  check(`B5 one summary per threshold crossing (crossings=${crossings}, summaries=${summaryRows(rows).length}, compaction requests=${observed.script.compactionHits})`, () => {
    assert.equal(summaryRows(rows).length, crossings, timelineOf(rows))
    assert.equal(observed.script.compactionHits, crossings)
  })
  return observed
}

async function armA() {
  const script = makeScript()
  const observed = await guarded("A", ["A1", "A2"], ARM_LIMIT_MS.A, () =>
    runArm("A", {
      context: 0,
      compactAt: "0",
      script,
      limitMs: ARM_LIMIT_MS.A,
      // Every scripted step over the threshold, then idles and continuations:
      // every point at which the host or the plugin could compact has passed.
      done: (state) => state.steps >= MAX_SCRIPTED_STEPS && state.preTexts >= Number(process.env.SMOKE_FC_A_TEXTS ?? 2),
    }),
  )
  if (!observed) return null
  setupChecks("A", observed, 0)
  const rows = observed.rows
  const peak = Math.max(0, ...stepRows(rows).map((row) => row.tokens))
  observe("A values", `summary rows ${summaryRows(rows).length}; compaction-part user rows ${rows.filter((row) => row.compaction).length}; compaction requests ${observed.script.compactionHits}; peak tokens ${peak}; status line ${JSON.stringify((observed.status.match(/Forced compaction:.*/) ?? [""])[0])}`)
  check(`A1 no summary row and no compaction request with --compact-at 0 and context 0 (rows=${summaryRows(rows).length}, requests=${observed.script.compactionHits})`, () => {
    assert.equal(summaryRows(rows).length, 0, `the host compacted by itself, so arm B proves nothing: ${timelineOf(rows)}`)
    assert.equal(observed.script.compactionHits, 0, "a compaction request reached the mock")
  })
  check(`A2 peak tokens >=30k (peak=${peak}), so arm A really was over the threshold`, () => {
    assert.ok(peak >= THRESHOLD)
  })
  return observed
}

async function armD() {
  const script = makeScript()
  const observed = await guarded("D", ["D1"], ARM_LIMIT_MS.D, () =>
    runArm("D", {
      context: 20_000,
      compactAt: "0",
      script,
      limitMs: ARM_LIMIT_MS.D,
      done: (state) => state.compactionServed >= 1 && state.postTexts >= 1,
    }),
  )
  if (!observed) return null
  setupChecks("D", observed, 20_000)
  check(`D1 CONTROL with context 20k the host compacts by itself and the same detector sees it (rows=${summaryRows(observed.rows).length}, requests=${observed.script.compactionHits}): only limit.context differs from arm A`, () => {
    assert.ok(goodSummaries(observed.rows).length >= 1, timelineOf(observed.rows))
  })
  return observed
}

// The host's own threshold and the plugin's land on the same step: a model with
// real limits, input 38k minus reserved 8k = 30k, and --compact-at 30k. The same
// shape as ferry lanes declaring input 208k with reserved 8k and the 200k default.
async function armH() {
  const script = makeScript()
  const observed = await guarded("H", ["H1", "H2"], ARM_LIMIT_MS.H, () =>
    runArm("H", {
      context: 38_000,
      hostOverflow: { input: 38_000, reserved: 8_000 },
      compactAt: "30k",
      script,
      limitMs: ARM_LIMIT_MS.H,
      done: (state) => state.compactionServed >= 1 && state.postTexts >= 2,
    }),
  )
  if (!observed) return null
  setupChecks("H", observed, 38_000)
  const rows = observed.rows
  observe("H order", timelineOf(rows))
  check(`H1 host and plugin thresholds equal: one summary for one crossing (summaries=${summaryRows(rows).length}, compaction requests=${observed.script.compactionHits})`, () => {
    assert.equal(goodSummaries(rows).length, 1, timelineOf(rows))
    assert.equal(observed.script.compactionHits, 1, timelineOf(rows))
  })
  check(`H2 the goal continued after it (${observed.script.postRequests} work requests after the summary, settled=${observed.settled})`, () => {
    assert.equal(observed.settled, true, timelineOf(rows))
    assert.ok(observed.script.postRequests >= 1, timelineOf(rows))
  })
  return observed
}

async function armL() {
  const script = makeScript({ crossOnLastStep: true })
  const observed = await guarded("L", ["L1", "L2"], ARM_LIMIT_MS.L, () =>
    runArm("L", {
      context: 0,
      compactAt: "30k",
      script,
      limitMs: ARM_LIMIT_MS.L,
      done: (state) => state.compactionServed >= 1 && state.postRequests >= 2,
    }),
  )
  if (!observed) return null
  setupChecks("L", observed, 0)
  const rows = observed.rows
  const goal = observed.goalAfterStatus
  const failed = forcedHistory(goal).filter((entry) => /did not land/.test(entry.detail))
  const firstHit = script.state.events.find((event) => event.kind === "compaction")
  observe("L values", `texts before the compaction request ${script.state.preTexts}; compaction hits ${script.state.compactionHits}; good summaries ${goodSummaries(rows).length}; failures in history ${failed.length}; forcedCompaction=${JSON.stringify(goal?.forcedCompaction)}; settled=${observed.settled}`)
  check(`L1 a request made on a turn's last step lands as one compaction and counts no failure (hits ${script.state.compactionHits}, good summaries ${goodSummaries(rows).length}, failures in history ${failed.length})`, () => {
    assert.ok(firstHit, `no compaction request: ${timelineOf(rows)}`)
    assert.equal(firstHit.stepsSoFar, 1, "the crossing must be the turn's last step, the script's second request")
    assert.equal(goodSummaries(rows).length, 1, timelineOf(rows))
    assert.deepEqual(failed.map((entry) => entry.detail), [])
  })
  check(`L2 the goal continued after it (${script.state.postRequests} work requests after the summary, settled=${observed.settled})`, () => {
    assert.equal(observed.settled, true, timelineOf(rows))
    assert.ok(script.state.postRequests >= 1, timelineOf(rows))
  })
  return observed
}

/** Model work reached the mock after the newest compaction request: the "not hung" predicate. */
function workAfterLastCompaction(events) {
  const lastHit = events.findLast((event) => event.kind === "compaction")
  if (!lastHit) return 0
  return events.filter((event) => event.seq > lastHit.seq && ["step", "pre-text", "post-work"].includes(event.kind)).length
}

async function armC() {
  const script = makeScript({ failCompactionHits: Infinity })
  const observed = await guarded("C", ["C1", "C2", "C3", "C4"], ARM_LIMIT_MS.C, () =>
    runArm("C", {
      context: 0,
      compactAt: "30k",
      script,
      limitMs: ARM_LIMIT_MS.C,
      // The plugin's cap reached, then either enough further work to catch a fourth
      // try, or a whole further host retry cycle with no work in between: a wedge.
      done: (state, goal) =>
        (goal?.forcedCompaction?.failures ?? 0) >= 3 &&
        (state.afterLastCompaction >= 3 || state.compactionHits >= 4 * HOST_ATTEMPTS_PER_REQUEST),
    }),
  )
  if (!observed) return null
  setupChecks("C", observed, 0)
  const rows = observed.rows
  const ledgerRequests = (observed.ledger.match(/Forced compaction requested/g) ?? []).length
  const compactionUsers = rows.filter((row) => row.compaction).length
  const workAfter = workAfterLastCompaction(script.state.events)
  observe("C values", `plugin requests (ledger) ${ledgerRequests}; compaction user rows ${compactionUsers}; HTTP 500s served ${script.state.compactionHits}; summary rows with error ${summaryRows(rows).filter((row) => row.error).length}/${summaryRows(rows).length}; work requests after the last compaction request ${workAfter}; forcedCompaction=${JSON.stringify(observed.goalAfterStatus?.forcedCompaction)}; settled=${observed.settled}; goal status=${observed.goalAfterStatus?.status ?? "n/a"}, lastStatus=${JSON.stringify(observed.goalAfterStatus?.lastStatus)}`)
  check(`C1 not hung: ${workAfter} non-compaction model request(s) after the last failed compaction request`, () => {
    assert.ok(script.state.compactionHits >= 1, "the compaction request never reached the mock, so nothing failed")
    assert.ok(workAfter >= 1, timelineOf(rows))
    assert.equal(observed.goalAfterStatus?.stopped ?? false, false, "the goal stopped itself")
  })
  check(`C2 capped: at most 3 plugin compaction requests in the run (ledger=${ledgerRequests}, compaction rows=${compactionUsers}; HTTP hits ${script.state.compactionHits}, host retries included)`, () => {
    assert.ok(ledgerRequests >= 1, "no forced compaction request in the ledger")
    assert.ok(ledgerRequests <= 3, `${ledgerRequests} requests`)
    assert.ok(compactionUsers <= 3, `${compactionUsers} compaction rows`)
  })
  // Before the driver's status and stop commands: their finished assistants would
  // move the bound past an orphan, and C3 could not fail.
  const settledRows = observed.rowsBeforeStatus
  const lastFinishedIndex = settledRows.findLastIndex((row) => row.role === "assistant" && row.finish)
  const orphans = settledRows.slice(lastFinishedIndex + 1).filter((row) => row.compaction && !row.compactionAuto)
  const lastFailure = script.state.events.findLast((event) => event.kind === "compaction")
  const stepsAfterLastFailure = script.state.steps - (lastFailure?.stepsSoFar ?? script.state.steps)
  const crossing = stepRows(rows).findIndex((row) => row.tokens >= THRESHOLD) + 1
  observe("C3/C4 values", `orphan compaction rows ${orphans.length}; plugin compaction rows left anywhere ${settledRows.filter((row) => row.compaction && !row.compactionAuto).length}; failed summary rows left ${summaryRows(settledRows).filter((row) => row.error).length}; threshold crossed at step ${crossing}; mock steps ${script.state.steps} (${stepsAfterLastFailure} after the last failure), texts ${script.state.preTexts}; a work request carried the compaction prompt=${script.state.workLeakedCompactionPrompt}`)
  check(`C3 no orphan compaction user message remains after the last failure (${orphans.length} orphans, ${ledgerRequests} requests failed)`, () => {
    assert.equal(observed.goalBeforeStatus?.forcedCompaction?.failures, 3, "the cap was never reached, so nothing was exercised")
    assert.equal(orphans.length, 0, timelineOf(settledRows))
  })
  check(`C4 the goal's work went on past the crossing: step ${crossing} crossed, ${script.state.steps} steps served, ${workAfter} work requests after the last failure, and none of them saw a compaction message`, () => {
    assert.ok(crossing >= 1, "no step crossed the threshold")
    assert.ok(script.state.steps > crossing + 1, `${script.state.steps} steps: nothing ran after the first failure`)
    assert.ok(workAfter >= 1, timelineOf(rows))
    assert.equal(script.state.workLeakedCompactionPrompt, false, "a compaction message reached the model as work")
  })
  return observed
}

async function armT() {
  const script = makeScript({ failCompactionHits: HOST_ATTEMPTS_PER_REQUEST })
  const observed = await guarded("T", ["T1"], ARM_LIMIT_MS.T, () =>
    runArm("T", {
      context: 0,
      compactAt: "30k",
      script,
      limitMs: ARM_LIMIT_MS.T,
      done: (state) => state.compactionServed >= 1 && state.postTexts >= 1,
    }),
  )
  if (!observed) return null
  setupChecks("T", observed, 0)
  const workAfter = workAfterLastCompaction(script.state.events)
  const goal = observed.goalAfterStatus
  observe("T values", `HTTP hits ${script.state.compactionHits} (${HOST_ATTEMPTS_PER_REQUEST} refused); good summaries ${goodSummaries(observed.rows).length}; work requests after the last compaction request ${workAfter}; compactionEpoch=${goal?.compactionEpoch}; stalledCompactions=${goal?.stalledCompactions}; forcedCompaction=${JSON.stringify(goal?.forcedCompaction)}`)
  check(`T1 a transient failure recovers: the C1 predicate passes (${workAfter} work requests after the last compaction request) and a summary landed`, () => {
    assert.ok(script.state.compactionHits > HOST_ATTEMPTS_PER_REQUEST, "the outage never ended")
    assert.ok(goodSummaries(observed.rows).length >= 1, timelineOf(observed.rows))
    assert.ok(workAfter >= 1, timelineOf(observed.rows))
  })
  return observed
}

/** No goal, no plugin request: the driver itself POSTs /summarize against a failing model. */
async function armE() {
  const state = { failing: false, hits: 0, work: 0, events: [] }
  const respond = (body) => {
    const kind = classify(body)
    state.events.push(kind)
    log(`mock E ${kind} failing=${state.failing}`)
    if (kind === "compaction") {
      state.hits += 1
      if (state.failing) {
        // Backoff shortened: this arm is about what runs next, not about timing.
        return { status: 500, headers: { "retry-after-ms": "50" }, json: { error: { message: "smoke: compaction refused", type: "server_error" } } }
      }
      return { lines: textTurn(`${SUMMARY_MARKER}: control summary.`, LOW_USAGE) }
    }
    if (kind === "work") state.work += 1
    return { lines: textTurn("ok", LOW_USAGE) }
  }
  const prompt = (host, sessionID, text) =>
    host.api.post(`/session/${sessionID}/message`, {
      body: { model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID }, agent: "build", parts: [{ type: "text", text }] },
      timeoutMs: 45_000,
    })
  const observed = await guarded("E", ["E1", "E2"], ARM_LIMIT_MS.E, async () => {
    const host = await boot("E", { context: 0, respond })
    try {
      const session = await host.api.post("/session", { body: { title: "failed compaction control" } })
      await prompt(host, session.id, "first prompt")
      const workBefore = state.work
      state.failing = true
      await host.api
        .post(`/session/${session.id}/summarize`, { body: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID }, timeoutMs: 45_000 })
        .catch((error) => log(`E summarize answered: ${error.message}`))
      const hitsAfterSummarize = state.hits
      await prompt(host, session.id, "second prompt").catch((error) => log(`E second prompt: ${error.message}`))
      const hitsAfterSecond = state.hits
      const workAfterSecond = state.work
      state.failing = false
      await prompt(host, session.id, "third prompt").catch((error) => log(`E third prompt: ${error.message}`))
      const hitsAfterThird = state.hits
      await prompt(host, session.id, "fourth prompt").catch((error) => log(`E fourth prompt: ${error.message}`))
      const rows = await readSessionRows(host.iso, session.id)
      return { workBefore, hitsAfterSummarize, hitsAfterSecond, workAfterSecond, hitsAfterThird, workFinal: state.work, rows }
    } finally {
      await host.stop()
    }
  })
  if (!observed) return null
  observe("E DB order", timelineOf(observed.rows))
  observe("E values", `work before ${observed.workBefore}; compaction hits after /summarize ${observed.hitsAfterSummarize}; after the second prompt ${observed.hitsAfterSecond} with work ${observed.workAfterSecond}; after the third (model healthy) ${observed.hitsAfterThird}; final work ${observed.workFinal}`)
  check(`E1 CONTROL with no goal, the prompt after a failed /summarize re-runs the compaction and never reaches the model as work (hits ${observed.hitsAfterSummarize} -> ${observed.hitsAfterSecond}, work ${observed.workBefore} -> ${observed.workAfterSecond})`, () => {
    assert.ok(observed.hitsAfterSummarize >= 1, "the failing compaction never reached the mock")
    assert.ok(observed.hitsAfterSecond > observed.hitsAfterSummarize, "the prompt did not re-run the compaction")
    assert.equal(observed.workAfterSecond, observed.workBefore, "the prompt reached the model as work")
  })
  check(`E2 CONTROL the block clears once a compaction succeeds (good summaries ${goodSummaries(observed.rows).length}, work ${observed.workAfterSecond} -> ${observed.workFinal})`, () => {
    assert.ok(goodSummaries(observed.rows).length >= 1, timelineOf(observed.rows))
    assert.ok(observed.workFinal > observed.workAfterSecond, "no work after the successful compaction")
  })
  return observed
}

// ---------------------------------------------------------------------------

async function main() {
  const { stdout } = await execFileAsync(OPENCODE_BIN, ["--version"], { env: { PATH: process.env.PATH } }).catch(() => ({ stdout: "MISSING" }))
  const version = stdout.trim()
  const { version: pluginVersion } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
  console.log(`forced compaction smoke: plugin ${pluginVersion}, opencode ${version} at ${OPENCODE_BIN}, model latency ${MODEL_LATENCY_MS} ms, scratch ${scratch}`)
  if (version !== EXPECTED_HOST_VERSION) {
    console.log(`FAIL  host version is ${version}, expected ${EXPECTED_HOST_VERSION}`)
    process.exitCode = 1
    return
  }
  // The installer copies `dist/`: a bundle that cannot force a compaction would
  // make every arm below a claim about an older build.
  const bundlePath = path.join(repoRoot, "dist", "goal-plugin.js")
  if (!existsSync(bundlePath) || !readFileSync(bundlePath, "utf8").includes("Forced compaction requested")) {
    console.log("FAIL  dist/goal-plugin.js has no forced compaction code; run `npm run bundle` first")
    process.exitCode = 1
    return
  }

  const only = (process.env.SMOKE_FC_ARMS || "B,A,D,H,L,E,T,C").split(",")
  if (only.includes("B")) await armB()
  if (only.includes("A")) await armA()
  if (only.includes("D")) await armD()
  if (only.includes("H")) await armH()
  if (only.includes("L")) await armL()
  if (only.includes("E")) await armE()
  if (only.includes("T")) await armT()
  if (only.includes("C")) await armC()

  const failed = results.filter((result) => !result.ok)
  console.log(`\nVERDICT ${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map((result) => result.label.split(" ")[0]).join(", ")}` : ""}; log ${logFile}`)
  if (failed.length) process.exitCode = 1
}

await main()
// The serve children are gone by now; nothing else should hold the loop open.
process.exit(process.exitCode ?? 0)
