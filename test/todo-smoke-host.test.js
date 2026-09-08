// Units for the shared real-host smoke harness (`scripts/lib/todo-smoke-host.mjs`),
// which both `smoke:todo-mirror` and the safety smoke drive.
//
// Only the parts a live smoke CANNOT tell you about are covered here: the mock
// model's state machine. A wrong answer there does not fail the smoke loudly —
// it replays a step, or answers a title request with a tool call, and the run
// hangs or asserts on the wrong turn. The SSE wire shape and the provider block
// are ports of OpenCode's own harness and are proven by the live run, not here.
import assert from "node:assert/strict"
import test from "node:test"

import {
  MOCK_MODEL_ID,
  MOCK_TODOS_MODEL_ID,
  completedCallIDs,
  completedToolNames,
  conversationText,
  routeByConversation,
  routeByModel,
  scriptedResponder,
  stepResponder,
  testProviderBlock,
  toolCallTurn,
} from "../scripts/lib/todo-smoke-host.mjs"

const TOOLS = [{ type: "function", function: { name: "todowrite" } }]

function assistantCall(id, name) {
  return { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] }
}

function toolResult(id, content = "ok") {
  return { role: "tool", tool_call_id: id, content }
}

test("completedToolNames counts a tool only once its RESULT is in the conversation", () => {
  const pending = [{ role: "user", content: "go" }, assistantCall("c1", "goal_plan_set")]
  assert.deepEqual([...completedToolNames(pending)], [])
  const settled = [...pending, toolResult("c1")]
  assert.deepEqual([...completedToolNames(settled)], ["goal_plan_set"])
})

test("completedToolNames ignores a result whose call id it never saw", () => {
  assert.deepEqual([...completedToolNames([toolResult("orphan")])], [])
  assert.deepEqual([...completedToolNames(undefined)], [])
})

test("the scripted responder replays the first step whose result has not landed", () => {
  const respond = scriptedResponder({
    steps: [
      { tool: "goal_plan_set", args: { actions: [] } },
      { tool: "todowrite", args: { todos: [] } },
    ],
    finalText: "done",
  })
  const names = (lines) =>
    lines.flatMap((line) => (line === "[DONE]" ? [] : (line.choices?.[0]?.delta?.tool_calls ?? []))).map(
      (call) => call.function?.name,
    )

  assert.deepEqual(names(respond({ tools: TOOLS, messages: [] })), ["goal_plan_set", undefined])

  const afterPlan = [assistantCall("c1", "goal_plan_set"), toolResult("c1")]
  assert.deepEqual(names(respond({ tools: TOOLS, messages: afterPlan })), ["todowrite", undefined])

  const afterTodos = [...afterPlan, assistantCall("c2", "todowrite"), toolResult("c2")]
  const finished = respond({ tools: TOOLS, messages: afterTodos })
  assert.deepEqual(names(finished), [])
  assert.equal(finished[1].choices[0].delta.content, "done")
  assert.equal(finished[finished.length - 2].choices[0].finish_reason, "stop")
})

test("a request with no tools always gets plain text", () => {
  // OpenCode's session-title and summary calls carry no tools; replaying a tool
  // call into one of those would hang the turn rather than fail it.
  const respond = scriptedResponder({ steps: [{ tool: "todowrite", args: { todos: [] } }] })
  const lines = respond({ tools: [], messages: [] })
  assert.equal(lines.some((line) => line !== "[DONE]" && line.choices[0].delta.tool_calls), false)
})

test("routeByModel dispatches on the request's model id", () => {
  const respond = routeByModel({
    [MOCK_MODEL_ID]: () => toolCallTurn("c", "goal_plan_set", {}),
    [MOCK_TODOS_MODEL_ID]: () => toolCallTurn("c", "todowrite", {}),
  })
  const named = (body) => respond(body)[1].choices[0].delta.tool_calls[0].function.name
  assert.equal(named({ model: MOCK_MODEL_ID }), "goal_plan_set")
  assert.equal(named({ model: MOCK_TODOS_MODEL_ID }), "todowrite")
  assert.equal(respond({ model: "unknown" })[1].choices[0].delta.content, "ok")
})

test("a tool call is streamed as an empty-argument start plus an argument delta", () => {
  // The shape the AI SDK's openai-compatible decoder expects: the name arrives
  // with `arguments: ""`, the JSON follows in a later chunk keyed only by index.
  const [role, start, args, finish, done] = toolCallTurn("call_1", "todowrite", { todos: [] })
  assert.equal(role.choices[0].delta.role, "assistant")
  assert.deepEqual(start.choices[0].delta.tool_calls[0], {
    index: 0,
    id: "call_1",
    type: "function",
    function: { name: "todowrite", arguments: "" },
  })
  assert.deepEqual(args.choices[0].delta.tool_calls[0], {
    index: 0,
    function: { arguments: '{"todos":[]}' },
  })
  assert.equal(finish.choices[0].finish_reason, "tool_calls")
  assert.equal(done, "[DONE]")
})

test("completedCallIDs keys on the call id, so a script may call one tool twice", () => {
  // `completedToolNames` collapses both `todowrite` calls of the safety script
  // into one step, which would make the second one unreachable.
  const messages = [assistantCall("call_a", "todowrite"), toolResult("call_a")]
  assert.deepEqual([...completedToolNames(messages)], ["todowrite"])
  assert.deepEqual([...completedCallIDs(messages)], ["call_a"])
  assert.deepEqual([...completedCallIDs([assistantCall("call_a", "todowrite")])], [])
  assert.deepEqual([...completedCallIDs(undefined)], [])
})

test("conversationText reads both string content and part-array content", () => {
  assert.equal(
    conversationText([
      { role: "user", content: "first" },
      { role: "system", content: [{ type: "text", text: "second" }, { type: "image" }] },
      { role: "assistant", content: null },
    ]),
    "first\nsecond",
  )
  assert.equal(conversationText(undefined), "")
})

test("stepResponder replays each step once, keyed on its own call id", () => {
  const respond = stepResponder({
    steps: [
      { id: "one", tool: "todowrite", args: { todos: [{ content: "a" }] } },
      { id: "two", tool: "todowrite", args: { todos: [] } },
    ],
    finalText: "done",
  })
  const call = (messages) => respond({ tools: TOOLS, messages })[1].choices[0].delta.tool_calls[0]

  const first = call([])
  assert.equal(first.id, "call_one")
  const afterFirst = [assistantCall("call_one", "todowrite"), toolResult("call_one")]
  const second = call(afterFirst)
  assert.equal(second.id, "call_two")
  assert.equal(second.function.name, "todowrite")

  const afterBoth = [...afterFirst, assistantCall("call_two", "todowrite"), toolResult("call_two")]
  const finished = respond({ tools: TOOLS, messages: afterBoth })
  assert.equal(finished[1].choices[0].delta.content, "done")
})

test("stepResponder skips a gated step until its trigger reaches the conversation", () => {
  const respond = stepResponder({
    steps: [
      { id: "mirror", tool: "todowrite", args: { todos: [{ content: "a" }] } },
      { id: "empty", tool: "todowrite", args: { todos: [] }, when: ({ text }) => text.includes("GO") },
    ],
    finalText: "waiting",
  })
  const landed = [assistantCall("call_mirror", "todowrite"), toolResult("call_mirror")]

  // Gate closed: the step is skipped, not blocked, so the mock still answers.
  const held = respond({ tools: TOOLS, messages: landed })
  assert.equal(held[1].choices[0].delta.content, "waiting")

  const opened = respond({ tools: TOOLS, messages: [...landed, { role: "user", content: "GO now" }] })
  assert.equal(opened[1].choices[0].delta.tool_calls[0].id, "call_empty")

  // A request with no tools is still plain text, gate or no gate.
  assert.equal(respond({ tools: [], messages: [{ role: "user", content: "GO" }] })[1].choices[0].delta.content, "ok")
})

test("stepResponder refuses a script with a duplicate step id", () => {
  assert.throws(
    () => stepResponder({ steps: [{ id: "x", tool: "bash" }, { id: "x", tool: "bash" }] }),
    /duplicate step id "x"/,
  )
})

test("routeByConversation dispatches on the first token present in the conversation", () => {
  const respond = routeByConversation({
    "arm-a": () => toolCallTurn("c", "goal_plan_set", {}),
    "arm-b": () => toolCallTurn("c", "bash", {}),
  })
  const named = (text) => respond({ messages: [{ role: "user", content: text }] })[1].choices[0].delta.tool_calls[0]
  assert.equal(named("please arm-a now").function.name, "goal_plan_set")
  assert.equal(named("please arm-b now").function.name, "bash")
  assert.equal(respond({ messages: [{ role: "user", content: "neither" }] })[1].choices[0].delta.content, "ok")
})

test("the provider block declares every model as tool-calling and free", () => {
  const block = testProviderBlock("http://127.0.0.1:1/v1")
  assert.equal(block.test.npm, "@ai-sdk/openai-compatible")
  assert.equal(block.test.options.baseURL, "http://127.0.0.1:1/v1")
  assert.deepEqual(Object.keys(block.test.models), [MOCK_MODEL_ID, MOCK_TODOS_MODEL_ID])
  for (const model of Object.values(block.test.models)) {
    assert.equal(model.tool_call, true)
    assert.deepEqual(model.cost, { input: 0, output: 0 })
  }
})
