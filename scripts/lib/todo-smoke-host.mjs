// Shared harness for the real-host todo smokes (`smoke:todo-mirror`, and the
// safety smoke that reuses it). Everything here talks to the REAL `opencode`
// binary: an isolated config/data tree, the production installer, a headless
// `opencode serve`, and a mock OpenAI-compatible provider so no real model is
// ever called.
//
// The provider config and the SSE chunk shapes are PORTS of OpenCode's own test
// harness, not guesses — a divergence there is a decode failure that reads like
// a broken plugin:
//   * the provider block  -> packages/opencode/test/lib/test-provider.ts:9 (`testProviderConfig`)
//   * the SSE chunk shape -> packages/opencode/test/lib/llm-server.ts:69 (`chunk`),
//     :99 (`toolStartLine`), :117 (`toolArgsLine`), :95 (`finishLine`), :56 (`line`)
//   * the isolating env   -> packages/opencode/test/lib/cli-process.ts:62 (`isolatedEnv`)
// (measured against opencode 1.18.29).
//
// One env var from that harness is deliberately NOT reused: `OPENCODE_PURE`.
// packages/opencode/src/plugin/index.ts:181 turns it into `plugins = []`, which
// silently unloads the plugin under test — the smoke would pass by proving
// nothing.
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"

export const MOCK_PROVIDER_ID = "test"
export const MOCK_MODEL_ID = "test-model"
// A second model on the same provider, so one running mock can serve two
// scripts at once. Control 2 (a divergent todowrite in a session with NO goal)
// must not replay the goal_plan_set step, and routing on the model id keeps the
// mock state-driven rather than turning it into a call counter.
export const MOCK_TODOS_MODEL_ID = "todos-model"
export const MOCK_MODEL_REF = { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID }
export const MOCK_TODOS_MODEL_REF = { providerID: MOCK_PROVIDER_ID, modelID: MOCK_TODOS_MODEL_ID }

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

/** Port of `testProviderConfig` (test/lib/test-provider.ts:9): the field set OpenCode's
 *  config-provider loader accepts without a models.dev lookup. `npm` is what
 *  packages/opencode/src/provider/provider.ts:1478 (`configProviders`) resolves; the same
 *  package is the fallback at :1500, so naming it explicitly is belt and braces. */
export function testProviderBlock(baseURL, modelIDs = [MOCK_MODEL_ID, MOCK_TODOS_MODEL_ID]) {
  const models = {}
  for (const modelID of modelIDs) {
    models[modelID] = {
      id: modelID,
      name: "Test Model",
      attachment: false,
      reasoning: false,
      temperature: false,
      tool_call: true,
      release_date: "2025-01-01",
      limit: { context: 100_000, output: 10_000 },
      cost: { input: 0, output: 0 },
      options: {},
    }
  }
  return {
    [MOCK_PROVIDER_ID]: {
      name: "Test",
      id: MOCK_PROVIDER_ID,
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models,
      options: { apiKey: "test-key", baseURL },
    },
  }
}

function sseLine(input) {
  if (input === "[DONE]") return "data: [DONE]\n\n"
  return `data: ${JSON.stringify(input)}\n\n`
}

function chunk(input) {
  return {
    id: "chatcmpl-smoke",
    object: "chat.completion.chunk",
    choices: [{ delta: input.delta ?? {}, ...(input.finish ? { finish_reason: input.finish } : {}) }],
  }
}

/** One assistant turn that calls exactly one tool. */
export function toolCallTurn(callID, name, args) {
  return [
    chunk({ delta: { role: "assistant" } }),
    chunk({
      delta: {
        tool_calls: [{ index: 0, id: callID, type: "function", function: { name, arguments: "" } }],
      },
    }),
    chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }),
    chunk({ finish: "tool_calls" }),
    "[DONE]",
  ]
}

/** One assistant turn that is plain text and stops. */
export function textTurn(text) {
  return [
    chunk({ delta: { role: "assistant" } }),
    chunk({ delta: { content: text } }),
    chunk({ finish: "stop" }),
    "[DONE]",
  ]
}

/**
 * Which tools already have a RESULT in this conversation. The mock answers by
 * conversation state rather than by call count, so a retry, an auto-continue or
 * a second prompt never re-runs a step that already landed.
 */
export function completedToolNames(messages) {
  const byCallID = new Map()
  const done = new Set()
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      if (call?.id && call?.function?.name) byCallID.set(call.id, call.function.name)
    }
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "tool") continue
    const name = byCallID.get(message?.tool_call_id)
    if (name) done.add(name)
  }
  return done
}

/**
 * Build a responder from an ordered list of steps. Each step is
 * `{ tool, args }`; the first step whose tool has no result yet is replayed.
 * When every step has landed the mock answers with `finalText` and stops.
 *
 * A request that carries no tools at all (OpenCode's session-title and summary
 * calls) always gets plain text: replaying a tool call into a conversation that
 * cannot execute it would hang the turn.
 */
export function scriptedResponder({ steps, finalText = "Done." }) {
  return (body) => {
    const tools = Array.isArray(body?.tools) ? body.tools : []
    if (tools.length === 0) return textTurn("ok")
    const done = completedToolNames(body?.messages)
    for (const step of steps) {
      if (!done.has(step.tool)) return toolCallTurn(`call_${step.tool}`, step.tool, step.args)
    }
    return textTurn(finalText)
  }
}

/** Dispatch to one responder per model id, so one mock serves several scripts. */
export function routeByModel(routes, fallback = () => textTurn("ok")) {
  return (body) => {
    const responder = routes[String(body?.model ?? "")]
    return responder ? responder(body) : fallback(body)
  }
}

/**
 * A mock OpenAI-compatible endpoint. `baseURL` is the value handed to the
 * provider block, i.e. it already carries the `/v1` prefix the AI SDK appends
 * `/chat/completions` to.
 */
export async function startMockProvider({ respond }) {
  const requests = []
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
      requests.push({ url: req.url, body })
      if (!String(req.url || "").includes("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "not found" }))
        return
      }
      const lines = respond(body)
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      for (const line of lines) res.write(sseLine(line))
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  return {
    port,
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      // Keep-alive sockets the host left open would keep `close()` pending
      // forever, which reads as a hung smoke rather than a finished one.
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// ---------------------------------------------------------------------------
// Isolated tree
// ---------------------------------------------------------------------------

/**
 * An isolated HOME/XDG tree plus an EMPTY project directory to run in. The
 * empty cwd matters: a project-level `opencode.json` (or `.claude/skills`) in
 * the working directory is a third config source and would merge into the run.
 */
export async function makeIsolatedTree(root) {
  await rm(root, { recursive: true, force: true })
  const iso = {
    root,
    home: path.join(root, "home"),
    cfg: path.join(root, "cfg"),
    data: path.join(root, "data"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
    cwd: path.join(root, "project"),
  }
  iso.configDir = path.join(iso.cfg, "opencode")
  iso.configFile = path.join(iso.configDir, "opencode.json")
  iso.pluginDir = path.join(iso.data, "opencode-goal-plugin-copy")
  iso.dbPath = path.join(iso.data, "opencode", "opencode.db")
  for (const dir of [iso.home, iso.cfg, iso.data, iso.state, iso.cache, iso.cwd, iso.configDir]) {
    await mkdir(dir, { recursive: true })
  }
  return iso
}

/** Port of `isolatedEnv` (test/lib/cli-process.ts:62), minus `OPENCODE_PURE`. */
export function isolatedEnv(iso, extra = {}) {
  const base = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("OPENCODE_")) continue
    if (key.startsWith("XDG_")) continue
    if (key === "HOME") continue
    if (value === undefined) continue
    base[key] = value
  }
  return {
    ...base,
    HOME: iso.home,
    OPENCODE_TEST_HOME: iso.home,
    XDG_CONFIG_HOME: iso.cfg,
    XDG_DATA_HOME: iso.data,
    XDG_STATE_HOME: iso.state,
    XDG_CACHE_HOME: iso.cache,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    ...extra,
  }
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (part) => {
      stdout += part
    })
    child.stderr.on("data", (part) => {
      stderr += part
    })
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * Install the plugin the way a user does: the shipped CLI, pointed at the
 * isolated config and data directories. `--data-dir` must stay colon-free —
 * the TUI half cannot load a plugin from a path containing ':' or '#'.
 */
export async function installPlugin({ repoRoot, iso }) {
  const cli = path.join(repoRoot, "scripts", "cli.mjs")
  const result = await runProcess(
    process.execPath,
    [cli, "install", "--config-dir", iso.configDir, "--data-dir", iso.pluginDir, "--json"],
    { cwd: iso.cwd, env: isolatedEnv(iso) },
  )
  if (result.code !== 0) {
    throw new Error(`plugin install failed (exit ${result.code})\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

/**
 * Merge the mock provider, the `/goal` command and the plugin options into the
 * config the installer just wrote. The installer owns the `plugin` array; this
 * only rewrites the entry into the `[spec, options]` tuple form when options are
 * asked for (`docs/reference.md` "Options reference": options travel as the
 * second element of the plugin entry).
 */
export async function configureHost(iso, { baseURL, pluginOptions, commandName = "goal" }) {
  const config = JSON.parse(await readFile(iso.configFile, "utf8"))
  config.provider = { ...(config.provider ?? {}), ...testProviderBlock(baseURL) }
  config.model = `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`
  config.permission = "allow"
  config.formatter = false
  config.lsp = false
  config.command = {
    ...(config.command ?? {}),
    [commandName]: {
      description: "Set a session-scoped goal and auto-continue until complete.",
      template: "$ARGUMENTS",
      agent: "build",
    },
  }
  const entries = Array.isArray(config.plugin) ? config.plugin : []
  config.plugin = entries.map((entry) => {
    const spec = Array.isArray(entry) ? entry[0] : entry
    if (!String(spec).includes("goal")) return entry
    return pluginOptions ? [spec, pluginOptions] : spec
  })
  await writeFile(iso.configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return config
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * A port nothing is listening on. `opencode serve --port 0` does NOT bind an
 * ephemeral port — it falls back to the default 4096, which is very likely the
 * port a real opencode server is already on. Talking to the developer's live
 * server instead of the isolated one would be a smoke that proves nothing (and
 * writes todos into their sessions), so the port is chosen here and the URL the
 * child prints is asserted against it.
 */
export async function freePort() {
  const { createServer: createNetServer } = await import("node:net")
  const probe = createNetServer()
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

export async function startServe(iso, { logPath, port }) {
  const chosen = port ?? (await freePort())
  const log = []
  const child = spawn("opencode", ["serve", "--port", String(chosen), "--hostname", "127.0.0.1"], {
    cwd: iso.cwd,
    env: isolatedEnv(iso),
    stdio: ["ignore", "pipe", "pipe"],
  })
  const record = (part) => {
    log.push(String(part))
  }
  child.stdout.on("data", record)
  child.stderr.on("data", record)
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)))
  let settled = false
  child.on("close", () => {
    settled = true
  })

  const deadline = Date.now() + 60_000
  let baseUrl
  while (Date.now() < deadline) {
    const match = log.join("").match(/listening on (http:\/\/\S+)/)
    if (match) {
      baseUrl = match[1].trim()
      break
    }
    if (settled) break
    await sleep(100)
  }
  const flush = async () => {
    if (logPath) await writeFile(logPath, log.join(""), "utf8")
  }
  if (!baseUrl) {
    await flush()
    child.kill("SIGKILL")
    throw new Error(`opencode serve never reported a URL. Log: ${logPath ?? log.join("").slice(0, 2000)}`)
  }
  if (!baseUrl.endsWith(`:${chosen}`)) {
    await flush()
    child.kill("SIGKILL")
    throw new Error(`opencode serve bound ${baseUrl}, not the isolated port ${chosen}`)
  }
  return {
    baseUrl,
    port: chosen,
    log,
    logText: () => log.join(""),
    async stop() {
      await flush()
      if (settled) return
      child.kill("SIGTERM")
      const raced = await Promise.race([exited, sleep(5000).then(() => "timeout")])
      if (raced === "timeout") child.kill("SIGKILL")
      await flush()
    },
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A tiny typed client over the instance HTTP API, pinned to one project directory. */
export function hostApi(baseUrl, directory) {
  const url = (route, query = {}) => {
    const target = new URL(route, baseUrl)
    target.searchParams.set("directory", directory)
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value)
    return target
  }
  const call = async (method, route, { query, body, timeoutMs = 120_000 } = {}) => {
    const response = await fetch(url(route, query), {
      method,
      headers: { "content-type": "application/json", "x-opencode-directory": directory },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    if (!response.ok) {
      throw new Error(`${method} ${route} -> ${response.status}: ${text.slice(0, 800)}`)
    }
    return parsed
  }
  return {
    get: (route, options) => call("GET", route, options),
    post: (route, options) => call("POST", route, options),
  }
}

/**
 * The decisive plugin-load check. `opencode debug config` does NOT instantiate
 * plugins, so a green config says nothing; this route only answers once the
 * server has built the tool registry, plugin tools included.
 */
export async function waitForToolIds(api, required, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = []
  let lastError
  while (Date.now() < deadline) {
    try {
      last = await api.get("/experimental/tool/ids", { timeoutMs: 30_000 })
      if (Array.isArray(last) && required.every((id) => last.includes(id))) return last
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  const detail = lastError ? ` last error: ${lastError.message}` : ` saw: ${JSON.stringify(last).slice(0, 400)}`
  throw new Error(`tool ids never listed ${required.join(", ")}.${detail}`)
}

/**
 * Everything a smoke arm needs: an isolated tree, the plugin installed the
 * production way, a mock provider, a running `opencode serve`, and proof that
 * the plugin's tools reached the registry.
 */
export async function bootHost({
  repoRoot,
  root,
  respond,
  pluginOptions,
  logPath,
  requiredToolIDs = ["goal_plan_set", "todowrite"],
}) {
  const iso = await makeIsolatedTree(root)
  const mock = await startMockProvider({ respond })
  await installPlugin({ repoRoot, iso })
  await configureHost(iso, { baseURL: mock.baseURL, pluginOptions })
  const serve = await startServe(iso, { logPath })
  const api = hostApi(serve.baseUrl, iso.cwd)
  const toolIDs = await waitForToolIds(api, requiredToolIDs)
  return {
    iso,
    mock,
    serve,
    api,
    toolIDs,
    async restart() {
      await serve.stop()
      const next = await startServe(iso, { logPath: logPath ? `${logPath}.restart` : undefined })
      return { serve: next, api: hostApi(next.baseUrl, iso.cwd) }
    },
    async stop() {
      await serve.stop()
      await mock.close()
    },
  }
}

/** `POST /session/:id/command` — the `/goal` slash command's production route. */
export function runGoalCommand(api, sessionID, args, { command = "goal", model, timeoutMs = 240_000 } = {}) {
  return api.post(`/session/${sessionID}/command`, {
    body: { command, arguments: args, ...(model ? { model } : {}) },
    timeoutMs,
  })
}

/** `POST /session/:id/message` — the prompt route. */
export function promptSession(api, sessionID, text, { model = MOCK_MODEL_REF, agent = "build", timeoutMs = 240_000 } = {}) {
  return api.post(`/session/${sessionID}/message`, {
    body: { model, agent, parts: [{ type: "text", text }] },
    timeoutMs,
  })
}

/** Poll `GET /session/:id/todo` until it satisfies `predicate` (default: any row). */
export async function waitForTodos(api, sessionID, predicate = (rows) => rows.length > 0, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let rows = []
  while (Date.now() < deadline) {
    rows = (await api.get(`/session/${sessionID}/todo`)) ?? []
    if (predicate(rows)) return rows
    await sleep(250)
  }
  return rows
}

/**
 * OpenCode's own structured log for the isolated run
 * (`$XDG_DATA_HOME/opencode/log/opencode.log`). It is BUFFERED and SIGTERM does
 * not flush it, so a read taken right after the server stops can be several
 * seconds behind — `marker` polls for a line rather than reporting a not-yet
 * -flushed line as absent.
 */
export async function readHostLog(iso, { marker, timeoutMs = 5000 } = {}) {
  const file = path.join(iso.data, "opencode", "log", "opencode.log")
  const deadline = Date.now() + (marker ? timeoutMs : 0)
  let text = ""
  do {
    text = existsSync(file) ? await readFile(file, "utf8") : ""
    if (!marker || text.includes(marker)) return text
    await sleep(250)
  } while (Date.now() < deadline)
  return text
}

export function findDatabase(iso) {
  const candidates = [
    iso.dbPath,
    path.join(iso.data, "opencode", "db", "opencode.db"),
    path.join(iso.data, "opencode", "storage", "opencode.db"),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}
