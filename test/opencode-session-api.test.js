import assert from "node:assert/strict"
import test from "node:test"
import { createOpenCodeSessionApi } from "../src/opencode-session-api.js"

const operations = ["messages", "promptAsync", "prompt", "update", "get", "create", "delete", "abort", "children", "status", "summarize", "deleteMessage"]

function recordingClient(handler) {
  const calls = []
  return {
    calls,
    client: {
      session: Object.fromEntries(
        operations.map((operation) => [
          operation,
          async (input) => {
            calls.push({ operation, input })
            return handler(operation, input)
          },
        ]),
      ),
    },
  }
}

async function exercise(api) {
  return Promise.all([
    api.messages("s1", { limit: 4 }),
    api.promptAsync("s2", { parts: [{ type: "text", text: "continue" }] }),
    api.createChild("parent", { title: "child" }),
    api.prompt("s3", { parts: [] }),
    api.update("s4", { title: "renamed" }),
    api.delete("s4"),
    api.abort("s5"),
    api.get("s5"),
  ])
}

test("uses current flattened SDK inputs and normalizes data responses", async () => {
  const host = recordingClient((_operation, input) => ({ data: input }))
  const results = await exercise(createOpenCodeSessionApi(host.client))

  assert.deepEqual(host.calls.map(({ input }) => input), [
    { sessionID: "s1", limit: 4 },
    { sessionID: "s2", parts: [{ type: "text", text: "continue" }] },
    { title: "child", parentID: "parent" },
    { sessionID: "s3", parts: [] },
    { sessionID: "s4", title: "renamed" },
    { sessionID: "s4" },
    { sessionID: "s5" },
    { sessionID: "s5" },
  ])
  assert.deepEqual(results, host.calls.map(({ input }) => input))
})

test("falls back to legacy inputs and remembers read-only operation shapes", async () => {
  const host = recordingClient((_operation, input) => {
    if (!("path" in input) && !("body" in input)) {
      throw new TypeError("validation failed: required path or body")
    }
    return { data: input }
  })
  const api = createOpenCodeSessionApi(host.client)
  await Promise.all([
    api.messages("s1", { limit: 4 }),
    api.get("s5"),
  ])
  await api.messages("again", { limit: 1 })

  const legacyCalls = host.calls.filter(({ input }) => "path" in input || "body" in input)
  assert.deepEqual(legacyCalls.map(({ input }) => input), [
    { path: { id: "s1" }, query: { limit: 4 } },
    { path: { id: "s5" } },
    { path: { id: "again" }, query: { limit: 1 } },
  ])
  assert.equal(host.calls.filter(({ operation }) => operation === "messages").length, 3)
  assert.equal(host.calls.filter(({ operation }) => operation === "get").length, 2)
})

test("never replays mutating operations after an argument-shape TypeError", async () => {
  const mutatingCalls = [
    [
      "promptAsync",
      (api) => api.promptAsync("s1", { parts: [] }),
      { sessionID: "s1", parts: [] },
      { path: { id: "s1" }, body: { parts: [] } },
    ],
    [
      "create",
      (api) => api.createChild("parent", { title: "child" }),
      { title: "child", parentID: "parent" },
      { body: { title: "child", parentID: "parent" } },
    ],
    [
      "prompt",
      (api) => api.prompt("s2", { parts: [] }),
      { sessionID: "s2", parts: [] },
      { path: { id: "s2" }, body: { parts: [] } },
    ],
    [
      "update",
      (api) => api.update("s3", { title: "renamed" }),
      { sessionID: "s3", title: "renamed" },
      { path: { id: "s3" }, body: { title: "renamed" } },
    ],
    ["delete", (api) => api.delete("s3"), { sessionID: "s3" }, { path: { id: "s3" } }],
    ["abort", (api) => api.abort("s4"), { sessionID: "s4" }, { path: { id: "s4" } }],
  ]

  for (const preferredShape of ["flat", "legacy"]) {
    for (const [operation, call, flatInput, legacyInput] of mutatingCalls) {
      const host = recordingClient(() => {
        throw new TypeError("validation failed: required path or body")
      })
      const api = createOpenCodeSessionApi(host.client, { preferredShape })

      await assert.rejects(call(api), /validation failed/)
      assert.deepEqual(host.calls, [
        { operation, input: preferredShape === "flat" ? flatInput : legacyInput },
      ])
    }
  }
})

test("does not retry prompts after a real host or provider error", async () => {
  for (const error of [
    new Error("provider rate limit"),
    new TypeError("provider stream decoder crashed"),
  ]) {
    let calls = 0
    const client = { session: { promptAsync: async () => { calls += 1; throw error } } }
    const api = createOpenCodeSessionApi(client)
    await assert.rejects(api.promptAsync("s", { parts: [] }), (actual) => actual === error)
    assert.equal(calls, 1)
  }
})

test("supports an explicit legacy preference without probing", async () => {
  const host = recordingClient((_operation, input) => input)
  const api = createOpenCodeSessionApi(host.client, { preferredShape: "legacy" })
  await api.get("known")
  assert.deepEqual(host.calls[0].input, { path: { id: "known" } })
})

test("children and status use the shape adapter and are replay-safe", async () => {
  const host = recordingClient((_operation, input) => ({ data: input }))
  const api = createOpenCodeSessionApi(host.client)
  assert.deepEqual(await api.children("s1"), { sessionID: "s1" })
  assert.deepEqual(await api.status(), {})

  const legacy = recordingClient((_operation, input) => {
    if (!("path" in input)) throw new TypeError("validation failed: required path")
    return { data: input }
  })
  const apiLegacy = createOpenCodeSessionApi(legacy.client)
  await apiLegacy.children("s2")
  await apiLegacy.status()
  assert.deepEqual(
    legacy.calls.map(({ input }) => input),
    [
      { sessionID: "s2" },
      { path: { id: "s2" } },
      {},
      { path: {} },
    ],
  )
})

test("summarize sends the flat shape and the legacy shape", async () => {
  const model = { providerID: "anthropic", modelID: "claude-x" }
  const flat = recordingClient(() => ({ data: true }))
  assert.equal(await createOpenCodeSessionApi(flat.client).summarize("s1", model), true)
  assert.deepEqual(flat.calls, [{ operation: "summarize", input: { sessionID: "s1", ...model } }])

  const legacy = recordingClient(() => ({ data: true }))
  await createOpenCodeSessionApi(legacy.client, { preferredShape: "legacy" }).summarize("s1", model)
  assert.deepEqual(legacy.calls, [
    { operation: "summarize", input: { path: { id: "s1" }, body: model } },
  ])
})

test("deleteMessage sends the flat shape and the legacy shape", async () => {
  const flat = recordingClient(() => ({ data: true }))
  assert.equal(await createOpenCodeSessionApi(flat.client).deleteMessage("s1", "m1"), true)
  assert.deepEqual(flat.calls, [{ operation: "deleteMessage", input: { sessionID: "s1", messageID: "m1" } }])

  const legacy = recordingClient(() => ({ data: true }))
  await createOpenCodeSessionApi(legacy.client, { preferredShape: "legacy" }).deleteMessage("s1", "m1")
  assert.deepEqual(legacy.calls, [
    { operation: "deleteMessage", input: { path: { id: "s1", messageID: "m1" } } },
  ])
})

test("deleteMessage falls back to the generated v1 client's transport", async () => {
  // The shape of the v1 SDK's Session class: no deleteMessage method, a `_client`.
  const calls = []
  const client = {
    session: {
      _client: {
        delete: async (input) => {
          calls.push(input)
          return { data: true }
        },
      },
    },
  }
  assert.equal(await createOpenCodeSessionApi(client).deleteMessage("s1", "m1"), true)
  assert.deepEqual(calls, [
    { url: "/session/{id}/message/{messageID}", path: { id: "s1", messageID: "m1" } },
  ])
})

test("deleteMessage throws when the host has no way to do it", async () => {
  const api = createOpenCodeSessionApi({ session: {} })
  await assert.rejects(api.deleteMessage("s1", "m1"), /deleteMessage is not available/)
})

test("deleteMessage throws on the SDK's resolved { error }, through either path", async () => {
  const refusal = { error: { name: "Session.BusyError", data: { message: "session is busy" } } }
  const method = recordingClient(() => refusal)
  await assert.rejects(createOpenCodeSessionApi(method.client).deleteMessage("s1", "m1"), /session is busy/)
  const transport = createOpenCodeSessionApi({ session: { _client: { delete: async () => refusal } } })
  await assert.rejects(transport.deleteMessage("s1", "m1"), /session is busy/)
})

test("deleteMessage is never replayed after a transport or shape failure", async () => {
  for (const preferredShape of ["flat", "legacy"]) {
    for (const error of [
      new TypeError("validation failed: required path or body"),
      new TypeError("fetch failed"),
    ]) {
      const host = recordingClient(() => {
        throw error
      })
      const api = createOpenCodeSessionApi(host.client, { preferredShape })
      await assert.rejects(api.deleteMessage("s1", "m1"), (actual) => actual === error)
      assert.equal(host.calls.length, 1)
    }
  }
})

test("summarize is never replayed after a transport or shape failure", async () => {
  for (const preferredShape of ["flat", "legacy"]) {
    for (const error of [
      new TypeError("validation failed: required path or body"),
      new TypeError("fetch failed"),
    ]) {
      const host = recordingClient(() => {
        throw error
      })
      const api = createOpenCodeSessionApi(host.client, { preferredShape })
      await assert.rejects(
        api.summarize("s1", { providerID: "p", modelID: "m" }),
        (actual) => actual === error,
      )
      assert.equal(host.calls.length, 1)
    }
  }
})
