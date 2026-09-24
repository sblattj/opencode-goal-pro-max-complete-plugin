import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { z } from "zod"

import pluginModule, { GoalPlugin, GoalPluginV2 } from "../src/goal-plugin.js"
import {
  createV2Setup,
  createV2ServiceClient,
  isV1PluginInput,
  isV2SetupContext,
  translatePromptBody,
  v2AdapterInternals,
} from "../src/v2-adapter.js"

const { bodyFrom, sessionIDFrom, toolResultToV2, v1EventPayload } = v2AdapterInternals

// ---------------------------------------------------------------------------
// Module shape (dual host)
// ---------------------------------------------------------------------------

test("default export carries id + server + setup for both host generations", () => {
  assert.equal(pluginModule.id, "opencode-goal-plugin")
  // v1 contract: server stays the SAME reference (packed-host-contract).
  assert.equal(pluginModule.server, GoalPlugin)
  // v2 contract: setup is present and callable.
  assert.equal(typeof pluginModule.setup, "function")
  assert.equal(pluginModule.setup, GoalPluginV2.setup)
})

test("host sniff discriminates v2 setup contexts from v1 plugin inputs", () => {
  const v2ctx = {
    location: { directory: "/tmp" },
    options: {},
    tool: { transform: async () => ({ dispose: async () => {} }), hook: async () => ({ dispose: async () => {} }) },
    session: { hook: async () => ({ dispose: async () => {} }) },
  }
  const v1input = { client: { session: {} }, directory: "/tmp" }
  assert.equal(isV2SetupContext(v2ctx), true)
  assert.equal(isV2SetupContext(v1input), false)
  assert.equal(isV1PluginInput(v1input), true)
  assert.equal(isV1PluginInput(v2ctx), false)
  assert.equal(isV2SetupContext(undefined), false)
  assert.equal(isV1PluginInput(undefined), false)
})

// ---------------------------------------------------------------------------
// Prompt body translation
// ---------------------------------------------------------------------------

test("translatePromptBody maps v1 parts onto v2 text", () => {
  const translated = translatePromptBody({
    agent: "goal",
    messageID: "msg_1",
    model: "anthropic/claude",
    parts: [
      { type: "text", text: "Continue the goal." },
      {
        type: "text",
        text: "[continue]",
        metadata: { "opencode-goal-plugin": { kind: "continuation", id: "cont_7" } },
      },
    ],
  })
  assert.equal(translated.agent, "goal")
  assert.equal(translated.body.text, "Continue the goal.\n[continue]")
  assert.equal(translated.body.id, "msg_1")
  assert.equal(translated.body.model, "anthropic/claude")
  assert.equal(translated.body.parts, undefined)
  assert.equal(translated.body.agent, undefined)
  assert.deepEqual(translated.body.metadata, {
    "opencode-goal-plugin": { kind: "continuation", id: "cont_7" },
  })
})

test("translatePromptBody leaves part-free bodies intact", () => {
  const translated = translatePromptBody({ text: "already v2" })
  assert.equal(translated.body.text, "already v2")
  assert.equal(translated.agent, undefined)
  assert.equal(translated.body.metadata, undefined)
})

// ---------------------------------------------------------------------------
// Argument-shape extraction
// ---------------------------------------------------------------------------

test("sessionIDFrom and bodyFrom accept both SDK argument shapes", () => {
  assert.equal(sessionIDFrom({ sessionID: "ses_1", parts: [] }), "ses_1")
  assert.equal(sessionIDFrom({ path: { id: "ses_2" }, body: {} }), "ses_2")
  assert.equal(sessionIDFrom({ path: { sessionID: "ses_3" } }), "ses_3")
  assert.equal(sessionIDFrom({}), undefined)
  assert.deepEqual(bodyFrom({ sessionID: "ses_1", title: "t" }), { title: "t" })
  assert.deepEqual(bodyFrom({ path: { id: "ses_1" }, body: { title: "t" } }), { title: "t" })
  assert.deepEqual(bodyFrom(undefined), {})
})

// ---------------------------------------------------------------------------
// Route bridges against a mocked fetch (no live server in unit tests)
// ---------------------------------------------------------------------------

function mockFetchRouter(routes) {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET"
    const pathname = new URL(String(url)).pathname
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers })
    for (const route of routes) {
      if (route.method !== method) continue
      if (pathname === route.path || (route.prefix && pathname.startsWith(route.prefix))) {
        if (route.status && route.status !== 200) {
          return { ok: false, status: route.status, text: async () => "" }
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(route.body ?? { data: undefined }) }
      }
    }
    return { ok: false, status: 404, text: async () => "" }
  }
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

function injectedServiceClient() {
  return createV2ServiceClient({}, { service: { url: "http://127.0.0.1:45999", password: "pw" } })
}

test("session client bridges v1 SDK method names onto live v2 routes", async () => {
  const fetchMock = mockFetchRouter([
    { method: "GET", path: "/api/session/ses_A/message", body: { data: [], cursor: "c1" } },
    { method: "GET", path: "/api/session/ses_A", body: { data: { id: "ses_A" } } },
    { method: "POST", path: "/api/session/ses_A/prompt", body: { data: { id: "msg_1" } } },
    { method: "POST", path: "/api/session", body: { data: { id: "ses_child" } } },
    { method: "PATCH", path: "/api/session/ses_A", body: { data: { id: "ses_A" } } },
    { method: "DELETE", path: "/api/session/ses_A", body: { data: undefined } },
    { method: "POST", path: "/api/session/ses_A/interrupt", body: { data: undefined } },
  ])
  try {
    const client = injectedServiceClient()
    const session = client.session

    // messages: flat shape, singular route
    const messages = await session.messages({ sessionID: "ses_A", limit: 5 })
    assert.deepEqual(messages, { data: [], cursor: "c1" })
    assert.equal(fetchMock.calls.at(-1).method, "GET")
    assert.equal(fetchMock.calls.at(-1).url, "http://127.0.0.1:45999/api/session/ses_A/message?limit=5")

    // messages: legacy shape lands on the same route
    await session.messages({ path: { id: "ses_A" }, query: {} })
    assert.equal(fetchMock.calls.at(-1).url, "http://127.0.0.1:45999/api/session/ses_A/message")

    // get
    await session.get({ sessionID: "ses_A" })
    assert.equal(fetchMock.calls.at(-1).url, "http://127.0.0.1:45999/api/session/ses_A")
    assert.equal(fetchMock.calls.at(-1).method, "GET")

    // promptAsync rides the synchronous /prompt route with a translated body
    await session.promptAsync({
      sessionID: "ses_A",
      agent: "goal",
      parts: [{ type: "text", text: "keep going" }],
    })
    assert.equal(fetchMock.calls.at(-1).method, "POST")
    assert.equal(fetchMock.calls.at(-1).url, "http://127.0.0.1:45999/api/session/ses_A/prompt")
    assert.deepEqual(fetchMock.calls.at(-1).body, { text: "keep going" })

    // create
    await session.create({ title: "goal completion audit", parentID: "ses_A" })
    assert.equal(fetchMock.calls.at(-1).url, "http://127.0.0.1:45999/api/session")
    assert.deepEqual(fetchMock.calls.at(-1).body, { title: "goal completion audit", parentID: "ses_A" })

    // update is a PATCH on the session itself
    await session.update({ sessionID: "ses_A", title: "new title" })
    assert.equal(fetchMock.calls.at(-1).method, "PATCH")
    assert.equal(fetchMock.calls.at(-1).url, "http://127.0.0.1:45999/api/session/ses_A")
    assert.deepEqual(fetchMock.calls.at(-1).body, { title: "new title" })

    // delete
    await session.delete({ sessionID: "ses_A" })
    assert.equal(fetchMock.calls.at(-1).method, "DELETE")
    assert.equal(fetchMock.calls.at(-1).url, "http://127.0.0.1:45999/api/session/ses_A")

    // abort bridges onto /interrupt
    await session.abort({ sessionID: "ses_A" })
    assert.equal(fetchMock.calls.at(-1).method, "POST")
    assert.equal(fetchMock.calls.at(-1).url, "http://127.0.0.1:45999/api/session/ses_A/interrupt")

    // Basic auth from service.json is on every request
    for (const call of fetchMock.calls) {
      assert.match(call.headers.authorization, /^Basic /)
    }
  } finally {
    fetchMock.restore()
  }
})

test("session client sends Basic auth credentials for opencode", async () => {
  const expected = `Basic ${Buffer.from("opencode:pw").toString("base64")}`
  const fetchMock = mockFetchRouter([{ method: "GET", path: "/api/session/ses_A", body: { data: { id: "ses_A" } } }])
  try {
    await injectedServiceClient().session.get({ sessionID: "ses_A" })
    assert.equal(fetchMock.calls.at(-1).headers.authorization, expected)
  } finally {
    fetchMock.restore()
  }
})

test("session client surfaces HTTP failures as rejections, not fake successes", async () => {
  const fetchMock = mockFetchRouter([{ method: "GET", path: "/api/session/ses_missing", status: 404 }])
  try {
    await assert.rejects(
      injectedServiceClient().session.get({ sessionID: "ses_missing" }),
      /HTTP 404/,
    )
  } finally {
    fetchMock.restore()
  }
})

test("prompt switches the session agent before prompting when ctx offers switchAgent", async () => {
  const switchCalls = []
  const ctx = {
    session: {
      switchAgent: async (input) => {
        switchCalls.push(input)
      },
    },
  }
  const fetchMock = mockFetchRouter([{ method: "POST", path: "/api/session/ses_A/prompt", body: { data: { id: "msg_1" } } }])
  try {
    const client = createV2ServiceClient(ctx, { service: { url: "http://127.0.0.1:45999", password: "pw" } })
    await client.session.prompt({ sessionID: "ses_A", agent: "goal", parts: [{ type: "text", text: "work" }] })
    assert.deepEqual(switchCalls, [{ sessionID: "ses_A", agent: "goal" }])
    assert.deepEqual(fetchMock.calls.at(-1).body, { text: "work" })
  } finally {
    fetchMock.restore()
  }
})

test("unavailable surfaces are omitted instead of faked (todo/children/status/app/tui)", () => {
  const client = injectedServiceClient()
  assert.equal(client.session.todo, undefined)
  assert.equal(client.session.children, undefined)
  assert.equal(client.session.status, undefined)
  assert.equal(client.app, undefined)
  assert.equal(client.tui, undefined)
  assert.equal(client.config, undefined)
})

// ---------------------------------------------------------------------------
// Result + event mapping helpers
// ---------------------------------------------------------------------------

test("toolResultToV2 maps v1 tool results onto v2 Tool.Result", () => {
  assert.deepEqual(toolResultToV2("plain string"), { content: "plain string" })
  assert.deepEqual(toolResultToV2({ title: "T", output: "O", metadata: { k: 1 } }), {
    content: "T\nO",
    metadata: { k: 1 },
  })
  assert.deepEqual(toolResultToV2({}), { content: "{}" })
})

test("v1EventPayload wraps flat v2 events and backfills message.updated ids", () => {
  const payload = v1EventPayload("/proj", {
    type: "message.updated",
    info: { id: "msg_9", sessionID: "ses_9" },
  })
  assert.deepEqual(payload, {
    directory: "/proj",
    event: {
      type: "message.updated",
      properties: { info: { id: "msg_9", sessionID: "ses_9" }, messageID: "msg_9", sessionID: "ses_9" },
    },
  })
  assert.equal(v1EventPayload("/proj", { notAnEvent: true }), undefined)
})

// ---------------------------------------------------------------------------
// setup(ctx) wiring against a fake host context + fake v1 factory
// ---------------------------------------------------------------------------

function eventQueue() {
  const queue = []
  let onPush = () => {}
  const subscribe = async function* ({ signal }) {
    while (true) {
      while (queue.length > 0) yield queue.shift()
      if (signal?.aborted) return
      await new Promise((resolve) => {
        onPush = resolve
        signal?.addEventListener("abort", () => resolve(), { once: true })
      })
    }
  }
  return { subscribe, push: (event) => { queue.push(event); onPush() } }
}

function createFakeContext({ directory = "/tmp/fake-project", events } = {}) {
  const state = {
    addedTools: new Map(),
    toolHooks: new Map(),
    sessionHooks: new Map(),
    agentDrafts: [],
    signals: [],
  }
  const ctx = {
    location: { directory },
    options: {},
    tool: {
      transform: async (fn) => {
        const registry = {
          add: (tool) => state.addedTools.set(tool.name, tool),
          get: (name) => state.addedTools.get(name),
          update: (name, updater) => {
            const tool = state.addedTools.get(name)
            if (tool) updater(tool)
          },
        }
        await fn(registry)
        return { dispose: async () => {} }
      },
      hook: async (kind, callback) => {
        state.toolHooks.set(kind, callback)
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async (kind, callback) => {
        state.sessionHooks.set(kind, callback)
        return { dispose: async () => {} }
      },
      switchAgent: async () => {},
    },
    agent: {
      transform: async (fn) => {
        const draft = {
          added: [],
          list: () => [],
          get: () => undefined,
          update: () => {},
          remove: () => {},
          add: (agent) => draft.added.push(agent),
        }
        state.agentDrafts.push(draft)
        await fn(draft)
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: async function* ({ signal }) {
        state.signals.push(signal)
        if (events) {
          yield* events.subscribe({ signal })
          return
        }
        await new Promise((resolve) => {
          if (signal?.aborted) return resolve()
          signal?.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    },
  }
  return { ctx, state }
}

function fakeV1Factory() {
  const calls = {
    factory: [],
    chatMessage: [],
    command: [],
    events: [],
    compacting: [],
    systemTransform: [],
    executeBefore: [],
    executeAfter: [],
    dispose: 0,
  }
  const hooks = {
    config: async (config) => {
      config.agent ||= {}
      config.agent.goal = { description: "goal agent", mode: "primary", prompt: "p" }
      config.agent["goal-verify"] = { description: "verifier", mode: "subagent", hidden: true }
    },
    "chat.message": async (input, output) => {
      calls.chatMessage.push({ input, output })
    },
    "command.execute.before": async (input, output) => {
      calls.command.push({ input, output })
      output.parts = [{ type: "text", text: "framed reply" }]
    },
    event: async (payload) => {
      calls.events.push(payload)
    },
    "experimental.session.compacting": async (input, output) => {
      calls.compacting.push({ input, output })
      output.context.push("goal summary context")
    },
    "experimental.chat.system.transform": async (input, output) => {
      calls.systemTransform.push({ input, output })
      output.system = [...output.system, "<opencode_goal_plugin id='g1'>goal</opencode_goal_plugin>"]
    },
    "tool.execute.before": async (input, output) => {
      calls.executeBefore.push({ input, output })
      if (output && output.args) output.args.todos = [{ id: "t1", content: "mirror row" }]
    },
    "tool.execute.after": async (input, output) => {
      calls.executeAfter.push({ input, output })
    },
    "tool.definition": async () => {},
    dispose: async () => {
      calls.dispose += 1
    },
    tool: {
      goal_status: {
        description: "Return goal state.",
        args: { verbose: z.boolean().optional() },
        execute: async () => ({ title: "status", output: "idle", metadata: { k: 1 } }),
      },
    },
  }
  const GoalPlugin = async (context, options) => {
    calls.factory.push({ context, options })
    return hooks
  }
  return { GoalPlugin, hooks, calls }
}

const waitFor = async (predicate, label = "condition") => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(predicate(), `timed out waiting for ${label}`)
}

test("setup registers tools with JSON-Schema inputs and maps results", async () => {
  const fake = fakeV1Factory()
  const { ctx, state } = createFakeContext()
  const dispose = await createV2Setup({ GoalPlugin: fake.GoalPlugin })(ctx)

  const tool = state.addedTools.get("goal_status")
  assert.ok(tool, "goal_status registered")
  assert.equal(tool.description, "Return goal state.")
  assert.equal(tool.input.type, "object")
  assert.equal(tool.input.properties.verbose.type, "boolean")

  const result = await tool.execute({ verbose: true }, { sessionID: "ses_1", id: "call_1", signal: "SIG" })
  assert.deepEqual(result, { content: "status\nidle", metadata: { k: 1 } })

  await dispose()
})

test("setup wires tool execute.before so args mutations land on the v2 payload", async () => {
  const fake = fakeV1Factory()
  const { ctx, state } = createFakeContext()
  const dispose = await createV2Setup({ GoalPlugin: fake.GoalPlugin })(ctx)

  const before = state.toolHooks.get("execute.before")
  assert.ok(before, "execute.before wired")
  const payload = { tool: "todowrite", sessionID: "ses_1", id: "call_2", input: { todos: [] } }
  await before(payload)
  // The mirror's property write landed on the v2 payload's own input bag.
  assert.deepEqual(payload.input.todos, [{ id: "t1", content: "mirror row" }])

  await dispose()
})

test("setup wires tool execute.after with the completed result mapped back", async () => {
  const fake = fakeV1Factory()
  const { ctx, state } = createFakeContext()
  const dispose = await createV2Setup({ GoalPlugin: fake.GoalPlugin })(ctx)

  const after = state.toolHooks.get("execute.after")
  assert.ok(after, "execute.after wired")
  await after({
    tool: "todowrite",
    sessionID: "ses_1",
    id: "call_3",
    input: { todos: [] },
    status: "completed",
    result: { content: "written", metadata: { m: 2 } },
  })
  assert.deepEqual(fake.calls.executeAfter.at(-1).output, {
    title: "",
    output: "written",
    metadata: { m: 2 },
  })

  await dispose()
})

test("prompt hook bridges chat.message and routes /goal text through the command bridge", async () => {
  const fake = fakeV1Factory()
  const { ctx, state } = createFakeContext()
  const dispose = await createV2Setup({ GoalPlugin: fake.GoalPlugin })(ctx)

  const prompt = state.sessionHooks.get("prompt")
  assert.ok(prompt, "prompt hook wired")

  // Ordinary user text reaches chat.message with the prompt parts.
  await prompt({ sessionID: "ses_1", messageID: "msg_1", prompt: { parts: [{ type: "text", text: "hello" }] } })
  assert.equal(fake.calls.chatMessage.at(-1).input.sessionID, "ses_1")
  assert.equal(fake.calls.chatMessage.at(-1).input.messageID, "msg_1")
  assert.equal(fake.calls.command.length, 0)

  // /goal text is routed through the v1 command handler for state effects,
  // then correlated via chat.message with the framed parts.
  await prompt({ sessionID: "ses_1", messageID: "msg_2", prompt: { parts: [{ type: "text", text: "/goal pause" }] } })
  assert.equal(fake.calls.command.length, 1)
  assert.equal(fake.calls.command.at(-1).input.command, "goal")
  assert.equal(fake.calls.command.at(-1).input.arguments, "pause")
  assert.equal(fake.calls.chatMessage.at(-1).input.messageID, "msg_2")
  assert.deepEqual(fake.calls.chatMessage.at(-1).output.parts, [{ type: "text", text: "framed reply" }])

  await dispose()
})

test("v2CommandTextBridge: false disables the /goal text bridge", async () => {
  const fake = fakeV1Factory()
  const { ctx, state } = createFakeContext()
  ctx.options = { v2CommandTextBridge: false }
  const dispose = await createV2Setup({ GoalPlugin: fake.GoalPlugin })(ctx)

  const prompt = state.sessionHooks.get("prompt")
  await prompt({ sessionID: "ses_1", messageID: "msg_3", prompt: { parts: [{ type: "text", text: "/goal pause" }] } })
  assert.equal(fake.calls.command.length, 0)
  assert.equal(fake.calls.chatMessage.length, 1)

  await dispose()
})

test("compaction hook is bridged onto session.hook('compaction')", async () => {
  const fake = fakeV1Factory()
  const { ctx, state } = createFakeContext()
  const dispose = await createV2Setup({ GoalPlugin: fake.GoalPlugin })(ctx)

  const compaction = state.sessionHooks.get("compaction")
  assert.ok(compaction, "compaction wired")
  await compaction({ sessionID: "ses_1" })
  assert.deepEqual(fake.calls.compacting.at(-1).output.context, ["goal summary context"])

  await dispose()
})

test("context hook splices the system array when the system transform fires", async () => {
  const fake = fakeV1Factory()
  const { ctx, state } = createFakeContext()
  const dispose = await createV2Setup({ GoalPlugin: fake.GoalPlugin })(ctx)

  const contextHook = state.sessionHooks.get("context")
  assert.ok(contextHook, "context wired")
  const system = [{ type: "text", text: "base prompt" }]
  await contextHook({ sessionID: "ses_1", system })
  assert.equal(system.length, 2)
  assert.equal(system[0].text, "base prompt")
  assert.match(system[1], /<opencode_goal_plugin id='g1'>/)

  await dispose()
})

test("config hook output is registered through agent.transform", async () => {
  const fake = fakeV1Factory()
  const { ctx, state } = createFakeContext()
  const dispose = await createV2Setup({ GoalPlugin: fake.GoalPlugin })(ctx)

  assert.equal(state.agentDrafts.length, 1)
  const names = state.agentDrafts[0].added.map((agent) => agent.name ?? agent)
  assert.ok(names.includes("goal"))
  assert.ok(names.includes("goal-verify"))

  await dispose()
})

test("event subscription wraps flat v2 events for the v1 event handler", async () => {
  const events = eventQueue()
  const fake = fakeV1Factory()
  const { ctx, state } = createFakeContext({ events })
  const dispose = await createV2Setup({ GoalPlugin: fake.GoalPlugin })(ctx)

  events.push({ type: "session.idle", sessionID: "ses_1" })
  await waitFor(() => fake.calls.events.length > 0, "event dispatch")
  const payload = fake.calls.events.at(-1)
  assert.equal(payload.directory, "/tmp/fake-project")
  assert.equal(payload.event.type, "session.idle")
  assert.equal(payload.event.properties.sessionID, "ses_1")

  events.push({ type: "message.updated", info: { id: "msg_9", sessionID: "ses_9" } })
  await waitFor(() => fake.calls.events.length > 1, "message.updated dispatch")
  assert.equal(fake.calls.events.at(-1).event.properties.messageID, "msg_9")

  await dispose()
})

test("dispose aborts the event stream, disposes the v1 runtime once, and is idempotent", async () => {
  const fake = fakeV1Factory()
  const { ctx, state } = createFakeContext()
  const dispose = await createV2Setup({ GoalPlugin: fake.GoalPlugin })(ctx)
  assert.equal(state.signals.length, 1)
  assert.equal(state.signals[0].aborted, false)

  await dispose()
  assert.equal(state.signals[0].aborted, true)
  assert.equal(fake.calls.dispose, 1)

  await dispose()
  assert.equal(fake.calls.dispose, 1)
})

test("setup mis-routed with a v1 PluginInput still lands on the v1 factory", async () => {
  const fake = fakeV1Factory()
  const setup = createV2Setup({ GoalPlugin: fake.GoalPlugin })
  const v1Input = { client: { session: {} }, directory: "/tmp/proj" }
  const hooks = await setup(v1Input, { persistState: false })
  assert.equal(hooks, fake.hooks)
  assert.deepEqual(fake.calls.factory.at(-1).context, v1Input)
  assert.deepEqual(fake.calls.factory.at(-1).options, { persistState: false })
})

test("setup degrades quietly when ctx surfaces are missing", async () => {
  const fake = fakeV1Factory()
  const ctx = { location: { directory: "/tmp/proj" }, options: {} }
  const dispose = await createV2Setup({ GoalPlugin: fake.GoalPlugin })(ctx)
  assert.equal(typeof dispose, "function")
  await dispose()
  assert.equal(fake.calls.dispose, 1)
})

// ---------------------------------------------------------------------------
// setup(ctx) against the REAL plugin factory (registration smoke, no host I/O)
// ---------------------------------------------------------------------------

test("real GoalPlugin loads under a fake v2 context and registers its tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-v2-adapter-"))
  const { ctx, state } = createFakeContext({ directory })
  ctx.options = { persistState: false }
  const dispose = await createV2Setup({ GoalPlugin })(ctx)

  const expectedTools = [
    "goal_status",
    "goal_set",
    "goal_pause",
    "goal_plan_get",
    "goal_plan_set",
    "set_goal",
    "update_goal",
    "clear_goal",
  ]
  for (const name of expectedTools) {
    assert.ok(state.addedTools.has(name), `${name} registered`)
    assert.equal(state.addedTools.get(name).input.type, "object")
  }
  assert.ok(state.toolHooks.has("execute.before"))
  assert.ok(state.toolHooks.has("execute.after"))
  assert.ok(state.sessionHooks.has("prompt"))
  assert.ok(state.sessionHooks.has("compaction"))
  assert.ok(state.sessionHooks.has("context"))
  assert.ok(state.agentDrafts.length >= 1)

  await dispose()
})
