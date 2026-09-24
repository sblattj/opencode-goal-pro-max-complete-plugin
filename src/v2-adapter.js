// v2 host adapter (opencode >= 2.0) for the goal plugin.
//
// The plugin keeps ONE entry module for both host generations: v1 hosts call
// `default.server(input, options)`, v2 hosts call `default.setup(ctx)` and
// ignore `server`. This file owns the v2 side of that pair:
//
//   * a hand-rolled HTTP client that stands in for v1's injected SDK client
//     (the v2 setup context carries no client). It reads the host's service
//     endpoint from service.json, speaks Basic auth, and bridges the v1 SDK's
//     method names onto the routes opencode 2.x actually serves —
//     `prompt_async` → `/prompt`, `abort` → `/interrupt`, `update` →
//     `PATCH /session/{id}`, `messages` → the singular `/message`.
//   * zod → JSON-Schema tool registration through `ctx.tool.transform`.
//   * per-hook bridges for every mappable v1 hook kind, each registered
//     quietly so an unsupported surface degrades instead of failing the load.
//
// Deliberately NOT used: `@opencode-ai/sdk` (not a dependency of this package,
// and its v2 error interceptor turns non-JSON 404/405 responses into silent
// `data: undefined` fake successes). Plain `fetch` against a route table that
// was probed live against opencode 2.0.14 is cheaper to verify.
//
// Omitted v1 surfaces (all 404 on 2.0.14) fail soft inside the plugin body by
// its own design: `session.todo`/`children`/`status`, `config.providers`,
// `client.tui.showToast`, `client.app.log`. The adapter must not invent
// methods that fake success for them.

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const SERVICE_FILE_RETRY_DELAYS_MS = [250, 500, 1000, 2000]

// Wire identifier shared with the v1 body (part-level continuation nonces).
const PLUGIN_METADATA_KEY = "opencode-goal-plugin"

// ---------------------------------------------------------------------------
// Host sniffing. The primary discriminator is structural: which method the
// host calls. Each method additionally asserts its argument shape so a
// mis-routed call still lands on the right factory.
// ---------------------------------------------------------------------------

export function isV2SetupContext(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !value.client &&
      (typeof value.tool?.transform === "function" ||
        typeof value.session?.hook === "function"),
  )
}

export function isV1PluginInput(value) {
  return Boolean(value && typeof value === "object" && value.client && !value.tool)
}

// ---------------------------------------------------------------------------
// Service endpoint discovery.
//
// v2 hosts publish { url, password } in service.json under the opencode state
// directory. When XDG_STATE_HOME is redirected the server may still write the
// real default path, so BOTH candidates are read and whichever parses wins.
// ---------------------------------------------------------------------------

function serviceFilePaths() {
  const paths = []
  if (process.env.XDG_STATE_HOME) {
    paths.push(join(process.env.XDG_STATE_HOME, "opencode", "service.json"))
  }
  paths.push(join(homedir(), ".local", "state", "opencode", "service.json"))
  return [...new Set(paths)]
}

export async function readServiceEndpointOnce() {
  for (const filePath of serviceFilePaths()) {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"))
      if (typeof parsed?.url === "string" && parsed.url) return parsed
    } catch {}
  }
  return undefined
}

async function readServiceEndpoint() {
  for (let attempt = 0; ; attempt++) {
    const service = await readServiceEndpointOnce()
    if (service) return service
    if (attempt >= SERVICE_FILE_RETRY_DELAYS_MS.length) return undefined
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, SERVICE_FILE_RETRY_DELAYS_MS[attempt])
      timer.unref?.()
    })
  }
}

// ---------------------------------------------------------------------------
// HTTP client shim (replaces v1's injected SDK client).
// ---------------------------------------------------------------------------

function baseUrlFrom(service) {
  return `${service.url.replace(/\/+$/, "")}/api`
}

function serviceHeaders(service) {
  const headers = { "content-type": "application/json" }
  if (typeof service.password === "string" && service.password) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}`
  }
  return headers
}

// The plugin's session API feeds BOTH historical SDK argument shapes into
// `client.session.<op>`: flat `{ sessionID, ...body }` and legacy
// `{ path: { id }, body | query }`. Extract the parts the routes need.
export function sessionIDFrom(input) {
  const id = input?.sessionID ?? input?.path?.id ?? input?.path?.sessionID
  return typeof id === "string" && id ? id : undefined
}

export function bodyFrom(input) {
  if (!input || typeof input !== "object") return {}
  if (input.body !== undefined) {
    return input.body && typeof input.body === "object" ? input.body : {}
  }
  const body = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === "sessionID" || key === "path" || key === "query") continue
    body[key] = value
  }
  return body
}

function queryFrom(input) {
  return input && typeof input === "object" && input.query && typeof input.query === "object"
    ? input.query
    : undefined
}

function messageQueryString(query) {
  if (!query) return ""
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" && value) params.set(key, value)
    else if (typeof value === "number" && Number.isFinite(value)) params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

// Translate a v1 prompt body (parts[]-based) onto v2's text-based
// SessionPromptInput:
//   * `parts[]` → `text` (the plugin's prompts are single text parts)
//   * part-level `metadata["opencode-goal-plugin"]` (the continuation nonce)
//     is hoisted to message-level `metadata` so correlation can survive
//   * `messageID` → `id`
//   * `agent` is returned separately; the caller best-effort switches the
//     session agent through ctx.session.switchAgent before prompting.
export function translatePromptBody(body) {
  const source = body && typeof body === "object" ? body : {}
  const translated = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === "parts" || key === "agent" || key === "messageID") continue
    translated[key] = value
  }
  const parts = Array.isArray(source.parts) ? source.parts : []
  const texts = []
  const metadata = {}
  for (const part of parts) {
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      texts.push(part.text)
    }
    const nonce = part?.metadata?.[PLUGIN_METADATA_KEY]
    if (nonce !== undefined) metadata[PLUGIN_METADATA_KEY] = nonce
  }
  if (texts.length > 0) translated.text = texts.join("\n")
  if (typeof source.messageID === "string" && source.messageID) translated.id = source.messageID
  if (Object.keys(metadata).length > 0) {
    translated.metadata = {
      ...(source.metadata && typeof source.metadata === "object" ? source.metadata : {}),
      ...metadata,
    }
  }
  return {
    body: translated,
    agent: typeof source.agent === "string" && source.agent ? source.agent : undefined,
  }
}

/**
 * Build the v1-shaped `client` object handed to the plugin factory. The
 * session object ALWAYS exists (the factory throws at creation time without
 * it — that would fail the whole plugin under v2); when no service endpoint
 * can be read, every method rejects per-call and each plugin call site fails
 * soft individually.
 */
export function createV2ServiceClient(ctx = {}, options = {}) {
  const state = {
    service: options.service ?? null,
    baseUrl: options.service ? baseUrlFrom(options.service) : "",
  }

  const ensureService = async () => {
    if (state.service) return state.service
    const service = await readServiceEndpoint()
    if (!service) return null
    state.service = service
    state.baseUrl = baseUrlFrom(service)
    return service
  }

  const send = async (operation, method, path, body) => {
    if (!(await ensureService())) {
      throw new Error(`OpenCode v2 service endpoint unavailable (session.${operation})`)
    }
    const attempt = () => {
      const service = state.service
      return globalThis.fetch(`${state.baseUrl}${path}`, {
        method,
        headers: serviceHeaders(service),
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    }
    let response
    try {
      response = await attempt()
    } catch (error) {
      throw new Error(`OpenCode v2 service request failed (session.${operation}): ${String(error?.message || error)}`)
    }
    if (response.status === 401) {
      // Password rotation: lazily re-read service.json once before failing.
      try {
        const rotated = await readServiceEndpointOnce()
        if (rotated && rotated.password !== state.service.password) {
          state.service = rotated
          state.baseUrl = baseUrlFrom(rotated)
          response = await attempt()
        }
      } catch {}
    }
    if (!response.ok) {
      throw new Error(`OpenCode v2 service request failed (session.${operation}): HTTP ${response.status}`)
    }
    const text = await response.text().catch(() => "")
    if (!text) return { data: undefined }
    try {
      return JSON.parse(text)
    } catch {
      return { data: text }
    }
  }

  // Return the RAW parsed body: the plugin's session API unwraps the {data}
  // envelope itself (opencode-session-api.js `unwrapData`), so unwrapping
  // here would strip one level too many.
  const requireSessionID = (operation, input) => {
    const sessionID = sessionIDFrom(input)
    if (!sessionID) {
      throw new Error(`OpenCode v2 service call requires a sessionID (session.${operation})`)
    }
    return sessionID
  }

  const prompt = async (operation, input) => {
    const sessionID = requireSessionID(operation, input)
    const translated = translatePromptBody(bodyFrom(input))
    if (translated.agent && typeof ctx?.session?.switchAgent === "function") {
      try {
        await ctx.session.switchAgent({ sessionID, agent: translated.agent })
      } catch {}
    }
    return send(operation, "POST", `/session/${encodeURIComponent(sessionID)}/prompt`, translated.body)
  }

  return {
    session: {
      get: (input) =>
        send("get", "GET", `/session/${encodeURIComponent(requireSessionID("get", input))}`),
      // v1's plural /messages route 404s on 2.x; the message list is singular.
      messages: (input) => {
        const sessionID = requireSessionID("messages", input)
        // Both SDK shapes put the list options in the query: legacy under
        // `query`, flat as loose keys next to sessionID.
        const query = queryFrom(input) ?? bodyFrom(input)
        const qs = messageQueryString(query)
        return send("messages", "GET", `/session/${encodeURIComponent(sessionID)}/message${qs}`)
      },
      prompt: (input) => prompt("prompt", input),
      // v1's /prompt_async route 404s on 2.x; the continuation engine must
      // not break, so async prompts ride the synchronous route.
      promptAsync: (input) => prompt("promptAsync", input),
      create: (input) => send("create", "POST", "/session", bodyFrom(input)),
      // v1's POST /session/{id}/update 404s on 2.x; PATCH /session/{id} is it.
      update: (input) =>
        send("update", "PATCH", `/session/${encodeURIComponent(requireSessionID("update", input))}`, bodyFrom(input)),
      delete: (input) =>
        send("delete", "DELETE", `/session/${encodeURIComponent(requireSessionID("delete", input))}`),
      // v1's POST /session/{id}/abort 404s on 2.x; /interrupt is the route.
      abort: (input) =>
        send("abort", "POST", `/session/${encodeURIComponent(requireSessionID("abort", input))}/interrupt`),
    },
  }
}

// ---------------------------------------------------------------------------
// Tool + hook bridges.
// ---------------------------------------------------------------------------

function toolInputSchema(args) {
  try {
    if (args && typeof args === "object" && typeof z.object === "function" && typeof z.toJSONSchema === "function") {
      return z.toJSONSchema(z.object(args), { target: "draft-2020-12" })
    }
  } catch {}
  return { type: "object" }
}

// v1 tool results are strings or {title, output, metadata}; v2 Tool.Results
// are {content, metadata?}.
function toolResultToV2(result) {
  if (typeof result === "string") return { content: result }
  const title = typeof result?.title === "string" ? result.title : ""
  const output = result?.output
  const outputText =
    typeof output === "string"
      ? output
      : output === undefined || output === null
        ? ""
        : (JSON.stringify(output, null, 2) ?? String(output))
  const adapted = { content: [title, outputText].filter(Boolean).join("\n") || "{}" }
  if (result?.metadata && typeof result.metadata === "object") adapted.metadata = result.metadata
  return adapted
}

// One unsupported surface must never kill the plugin load: the shipped v2
// typings lag the binary, so every registration is guarded and quiet.
function registerQuietly(register) {
  try {
    const pending = register()
    return pending && typeof pending.catch === "function" ? pending.catch(() => {}) : Promise.resolve()
  } catch {
    return Promise.resolve()
  }
}

// v2 events are flat {type, ...}; the v1 handler expects
// {directory, event: {type, properties}} and already probes
// properties.X ?? data.X. message.updated carries the message under `info`.
function v1EventPayload(directory, event) {
  if (!event || typeof event.type !== "string") return undefined
  const properties = {}
  for (const [key, value] of Object.entries(event)) {
    if (key === "type") continue
    properties[key] = value
  }
  if (event.type === "message.updated" && properties.info && typeof properties.info === "object") {
    if (typeof properties.messageID !== "string" && typeof properties.info.id === "string") {
      properties.messageID = properties.info.id
    }
    if (typeof properties.sessionID !== "string" && typeof properties.info.sessionID === "string") {
      properties.sessionID = properties.info.sessionID
    }
  }
  return { directory, event: { type: event.type, properties } }
}

function promptHookText(input) {
  const prompt = input?.prompt
  if (prompt && typeof prompt === "object" && typeof prompt.text === "string") return prompt.text
  const parts = Array.isArray(prompt?.parts) ? prompt.parts : []
  const texts = []
  for (const part of parts) {
    if (part && typeof part === "object" && typeof part.text === "string") texts.push(part.text)
  }
  return texts.length > 0 ? texts.join("\n") : undefined
}

// Introduce an agent definition through an AgentDraft. The shipped typings
// expose only list/get/update/remove (no add), and whether update-on-missing
// creates is binary-version-dependent — so try the richest path first and
// degrade quietly.
function registerAgentDefinition(draft, name, definition) {
  const def = definition && typeof definition === "object" ? definition : {}
  try {
    if (typeof draft?.add === "function") {
      draft.add({ ...def, name })
      return
    }
  } catch {}
  try {
    const existing = typeof draft?.get === "function" ? draft.get(name) : undefined
    if (existing && typeof draft?.update === "function") {
      draft.update(name, (agent) => {
        if (agent && typeof agent === "object") Object.assign(agent, def)
      })
      return
    }
  } catch {}
  try {
    // Some drafts create-on-update when the id is absent; if the callback is
    // never invoked this is a silent no-op.
    if (typeof draft?.update === "function") {
      draft.update(name, (agent) => {
        if (agent && typeof agent === "object") Object.assign(agent, def)
      })
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// setup(ctx) — the v2 entry.
// ---------------------------------------------------------------------------

/**
 * Build the `setup(ctx)` function for the dual-host default export.
 *
 * @param {object} args
 * @param {Function} args.GoalPlugin the v1 hook factory (same reference the
 *   default export's `server` key carries).
 * @param {string} [args.commandName] fallback /command name ("goal").
 * @param {boolean} [args.commandTextBridge] enable the v2 /goal text bridge
 *   (default true; `v2CommandTextBridge: false` in plugin options disables).
 */
export function createV2Setup({ GoalPlugin, commandName = "goal", commandTextBridge = true } = {}) {
  if (typeof GoalPlugin !== "function") {
    throw new TypeError("createV2Setup requires the GoalPlugin factory")
  }
  return async function goalPluginV2Setup(context, legacyOptions) {
    // Mis-route guard: a v1 host that somehow called `setup` with a
    // PluginInput still lands on the v1 factory.
    if (isV1PluginInput(context)) return GoalPlugin(context, legacyOptions)

    const ctx = context
    const directory =
      typeof ctx?.location?.directory === "string" && ctx.location.directory
        ? ctx.location.directory
        : process.cwd()
    const pluginOptions = ctx?.options ?? {}
    const bridgeEnabled = commandTextBridge && pluginOptions.v2CommandTextBridge !== false
    const effectiveCommandName =
      typeof pluginOptions.commandName === "string" && pluginOptions.commandName.trim()
        ? pluginOptions.commandName.trim()
        : commandName

    const client = createV2ServiceClient(ctx)
    const hooks = await GoalPlugin({ client, directory }, pluginOptions)
    const pending = []

    // --- tools (+ best-effort tool.definition bridge) ---
    if (hooks?.tool && typeof ctx?.tool?.transform === "function") {
      const definitions = hooks.tool
      const toolDefinitionHook =
        typeof hooks["tool.definition"] === "function" ? hooks["tool.definition"] : null
      pending.push(
        registerQuietly(() =>
          ctx.tool.transform((registry) => {
            for (const [name, definition] of Object.entries(definitions)) {
              if (!definition || typeof definition.execute !== "function") continue
              try {
                registry.add({
                  name,
                  description: typeof definition.description === "string" ? definition.description : "",
                  input: toolInputSchema(definition.args),
                  execute: async (args, toolCtx) =>
                    toolResultToV2(
                      await definition.execute(args, {
                        ...toolCtx,
                        directory,
                        abort: toolCtx?.signal,
                        callID: toolCtx?.id,
                      }),
                    ),
                })
              } catch {}
            }
            // tool.definition bridge: append the todo-mirror paragraph to the
            // host's todowrite description when the registry exposes reads.
            if (toolDefinitionHook && registry && typeof registry.get === "function") {
              try {
                const existing = registry.get("todowrite")
                if (existing && typeof existing.description === "string") {
                  const output = { description: existing.description }
                  Promise.resolve(toolDefinitionHook({ toolID: "todowrite", tool: existing }, output))
                    .then(() => {
                      if (
                        typeof output.description === "string" &&
                        output.description !== existing.description &&
                        typeof registry.update === "function"
                      ) {
                        registry.update("todowrite", (def) => {
                          if (def && typeof def === "object") def.description = output.description
                        })
                      }
                    })
                    .catch(() => {})
                }
              } catch {}
            }
          }),
        ),
      )
    }

    // --- tool.execute.before / after ---
    if (typeof hooks?.["tool.execute.before"] === "function" && typeof ctx?.tool?.hook === "function") {
      const handler = hooks["tool.execute.before"]
      // Errors deliberately propagate: throwing from execute.before is the
      // plugin's designed mechanism for blocking tool calls during a control
      // command turn.
      pending.push(
        registerQuietly(() =>
          ctx.tool.hook("execute.before", (input) =>
            handler(
              {
                tool: input?.tool,
                sessionID: input?.sessionID,
                messageID: input?.messageID,
                callID: input?.id,
              },
              // Passing the v2 payload's own `input` bag as `output.args`
              // means the todo mirror's property writes land on the mutable
              // field the host may read back.
              { args: input?.input },
            ),
          ),
        ),
      )
    }
    if (typeof hooks?.["tool.execute.after"] === "function" && typeof ctx?.tool?.hook === "function") {
      const handler = hooks["tool.execute.after"]
      pending.push(
        registerQuietly(() =>
          ctx.tool.hook("execute.after", (input) => {
            const result = input?.status === "error" ? undefined : input?.result
            return handler(
              {
                tool: input?.tool,
                sessionID: input?.sessionID,
                messageID: input?.messageID,
                callID: input?.id,
                args: input?.input,
              },
              {
                title: "",
                output: typeof result?.content === "string" ? result.content : "",
                metadata: result?.metadata && typeof result.metadata === "object" ? result.metadata : undefined,
              },
            )
          }),
        ),
      )
    }

    // --- session hooks: prompt (chat.message + /goal text bridge),
    //     compaction, context (system transform) ---
    const chatMessageHook = typeof hooks?.["chat.message"] === "function" ? hooks["chat.message"] : null
    const commandHook =
      typeof hooks?.["command.execute.before"] === "function" ? hooks["command.execute.before"] : null
    if ((chatMessageHook || (bridgeEnabled && commandHook)) && typeof ctx?.session?.hook === "function") {
      pending.push(
        registerQuietly(() =>
          ctx.session.hook("prompt", async (input) => {
            const sessionID = input?.sessionID
            if (!sessionID) return
            const messageID = input?.messageID
            const parts = Array.isArray(input?.prompt?.parts) ? input.prompt.parts : []
            const prefix = `/${effectiveCommandName}`
            if (bridgeEnabled && commandHook && chatMessageHook) {
              const text = promptHookText(input)
              if (typeof text === "string" && (text === prefix || text.startsWith(`${prefix} `))) {
                // v2 has no pre-execution command interception. Run the v1
                // /goal handler for its STATE side effects (pause/resume/
                // stop/clear/set + ledger + persistence), then correlate the
                // turn through chat.message exactly as v1's host flow did.
                // The framed reply text cannot be injected into the real
                // user message — accepted degradation under v2.
                const commandOutput = { parts: [] }
                try {
                  await commandHook(
                    { command: effectiveCommandName, sessionID, arguments: text.slice(prefix.length).trim() },
                    commandOutput,
                  )
                } catch {}
                await chatMessageHook(
                  { sessionID, messageID },
                  { message: { id: messageID, role: "user", sessionID }, parts: commandOutput.parts },
                )
                return
              }
            }
            if (chatMessageHook) {
              await chatMessageHook(
                { sessionID, messageID },
                { message: { id: messageID, role: "user", sessionID }, parts },
              )
            }
          }),
        ),
      )
    }

    if (typeof hooks?.["experimental.session.compacting"] === "function" && typeof ctx?.session?.hook === "function") {
      const handler = hooks["experimental.session.compacting"]
      pending.push(
        registerQuietly(() =>
          ctx.session.hook("compaction", (input) =>
            handler(
              { sessionID: input?.sessionID ?? input?.session?.id },
              { context: [] },
            ),
          ),
        ),
      )
    }

    if (
      typeof hooks?.["experimental.chat.system.transform"] === "function" &&
      typeof ctx?.session?.hook === "function"
    ) {
      const handler = hooks["experimental.chat.system.transform"]
      pending.push(
        registerQuietly(() =>
          ctx.session.hook("context", async (input) => {
            const system = Array.isArray(input?.system) ? input.system : null
            if (!system) return
            const before = [...system]
            const output = { system: before }
            try {
              await handler(
                { sessionID: input?.sessionID, agent: input?.agent, model: input?.model },
                output,
              )
            } catch {
              return
            }
            // The v1 hook replaces output.system wholesale; splice the
            // result back into the context's own (mutable) array so the
            // host sees it, preserving unchanged blocks by identity.
            const after = Array.isArray(output.system) ? output.system : before
            const unchanged =
              after.length === before.length && after.every((block, index) => block === before[index])
            if (unchanged) return
            system.splice(0, system.length, ...after)
          }),
        ),
      )
    }

    // --- config hook → agent registration ---
    if (typeof hooks?.config === "function" && typeof ctx?.agent?.transform === "function") {
      const configHook = hooks.config
      const syntheticConfig = { agent: {} }
      try {
        // Running the real hook (not a reimplementation) also flips the
        // plugin's internal verifierRegistrationReady flag.
        await configHook(syntheticConfig)
      } catch {}
      const agentDefs = syntheticConfig.agent
      if (agentDefs && typeof agentDefs === "object" && Object.keys(agentDefs).length > 0) {
        pending.push(
          registerQuietly(() =>
            ctx.agent.transform((draft) => {
              for (const [name, definition] of Object.entries(agentDefs)) {
                registerAgentDefinition(draft, name, definition)
              }
            }),
          ),
        )
      }
    }

    // --- event stream (fire-and-forget, aborted on dispose) ---
    let eventsAbort
    if (typeof hooks?.event === "function" && typeof ctx?.event?.subscribe === "function") {
      eventsAbort = new AbortController()
      const dispatch = hooks.event
      const signal = eventsAbort.signal
      ;(async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal })) {
            const payload = v1EventPayload(directory, event)
            if (!payload) continue
            try {
              await dispatch(payload)
            } catch {}
          }
        } catch {}
      })()
    }

    await Promise.all(pending)

    let disposed = false
    // v2 treats a truthy setup return as the dispose finalizer.
    return async () => {
      if (disposed) return
      disposed = true
      try {
        eventsAbort?.abort()
      } catch {}
      try {
        await hooks?.dispose?.()
      } catch {}
    }
  }
}

export const v2AdapterInternals = Object.freeze({
  isV2SetupContext,
  isV1PluginInput,
  readServiceEndpointOnce,
  serviceFilePaths,
  sessionIDFrom,
  bodyFrom,
  translatePromptBody,
  toolInputSchema,
  toolResultToV2,
  v1EventPayload,
  promptHookText,
  registerAgentDefinition,
})
