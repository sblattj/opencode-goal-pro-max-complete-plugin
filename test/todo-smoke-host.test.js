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
  completedToolNames,
  routeByModel,
  scriptedResponder,
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
