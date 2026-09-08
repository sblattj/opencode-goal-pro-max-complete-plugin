// Unit tests for the TUI sidebar goal panel.
//
// `src/goal-sidebar-view.js` deliberately imports nothing, so the panel that
// opencode renders in a terminal can be driven here with a fake runtime
// standing in for `solid-js` and `@opentui/solid/jsx-runtime`. The fake `jsx`
// keeps the props object it is handed, so a value the panel captured eagerly
// renders stale on a second pass while a getter re-reads — which is what makes
// the reactivity test below able to fail.
import assert from "node:assert/strict"
import test from "node:test"
import {
  createGoalSidebar,
  formatPanelTokens,
  goalPanelModel,
  GOAL_PANEL_PAYLOAD_VERSION,
  GOAL_PANEL_TITLE,
} from "../src/goal-sidebar-view.js"
import { formatBudgetMinutes, formatTurnBudget, UNLIMITED_MARK } from "../src/goal-format.js"
// v1.0.1 wave-4 integration (unit 38): the SERVER half. The cross-half parity unit
// below builds a real goal, mirrors it through the real
// tool.execute hooks and publishes a real payload, so the number the panel prints is
// the number the server computed rather than one this file typed.
import { GoalPlugin, testInternals } from "../src/goal-plugin.js"

const THEME = {
  text: "text",
  textMuted: "muted",
  error: "error",
  warning: "warning",
  success: "success",
}

function fakeRuntime() {
  const Show = function Show() {}
  const For = function For() {}
  return {
    Show,
    For,
    createMemo: (fn) => fn,
    jsx: (type, props) => ({ type, props }),
  }
}

// Collapse a `text` element's children — a string, a nested `b`, or an array of
// either — into the single string a terminal row would show.
function flatten(value) {
  if (value === null || value === undefined || value === false || value === true) return ""
  if (Array.isArray(value)) return value.map(flatten).join("")
  if (typeof value === "object") return flatten(value.props?.children)
  return String(value)
}

// Walk the tree once and return the `text` ELEMENTS, not their current values.
// Holding the elements is what lets a test read them again after the session
// changed, which is the only way to tell a getter from a frozen string.
function collect(runtime, node) {
  if (node === null || node === undefined || node === false || node === true) return []
  if (Array.isArray(node)) return node.flatMap((item) => collect(runtime, item))
  if (typeof node !== "object") return []
  const { type, props } = node
  if (type === runtime.Show) return props.when ? collect(runtime, props.children) : []
  if (type === runtime.For) {
    return (props.each || []).flatMap((item, index) => collect(runtime, props.children(item, () => index)))
  }
  if (typeof type === "function") return collect(runtime, type(props))
  if (type === "text") return [node]
  return collect(runtime, props?.children)
}

function readLine(element) {
  return { fg: element.props.fg, text: flatten(element.props.children) }
}

function renderLines(runtime, node) {
  return collect(runtime, node).map(readLine)
}

function fakeApi(sessions, options = {}) {
  const registrations = []
  const logged = []
  return {
    registrations,
    logged,
    api: {
      slots: {
        register(view) {
          registrations.push(view)
        },
      },
      theme: { current: THEME },
      state: { session: { get: (id) => sessions.get(id) } },
      client: {
        app: {
          log: options.log ?? (async (input) => logged.push(input)),
        },
      },
    },
  }
}

function payload(overrides = {}) {
  return {
    v: GOAL_PANEL_PAYLOAD_VERSION,
    goalId: "goal_1",
    state: "active",
    objective: "ship the sidebar panel",
    turns: { used: 3, max: 10 },
    minutes: { used: 2, max: 30 },
    tokens: { used: 45_000, max: 200_000 },
    plan: { total: 0, verified: 0, blocked: 0, actions: [] },
    updatedAt: 1,
    ...overrides,
  }
}

test("no goal means no panel model at all", () => {
  for (const raw of [null, undefined, "", 0, false, [], "a goal"]) {
    assert.equal(goalPanelModel(raw), null, `${JSON.stringify(raw)} must not produce a panel`)
  }
  // `/goal clear` writes `metadata.goal = null`; a payload whose objective went
  // missing must hide too rather than render a headerless panel.
  assert.equal(goalPanelModel(payload({ objective: "" })), null)
  assert.equal(goalPanelModel(payload({ objective: "   " })), null)
  assert.equal(goalPanelModel(payload({ objective: 42 })), null)
})

test("a running goal reduces to its header, budgets, and nothing it was not given", () => {
  const model = goalPanelModel(payload())
  assert.equal(model.state, "active")
  assert.equal(model.icon, "▶")
  assert.equal(model.objective, "ship the sidebar panel")
  assert.deepEqual(model.stats, ["3/10 turns", "2m/30m", "45k/200k tokens"])
  assert.equal(model.sequence, "")
  assert.equal(model.progress, "")
  assert.deepEqual(model.actions, [])
  assert.equal(model.hiddenActions, 0)
  assert.deepEqual(model.notes, [])
})

test("the panel shows spend and peak context as separate stats, and survives a payload with neither", () => {
  // `tokens` is cumulative SPEND against the token budget; `context` is the
  // peak context against the model's window. Two quantities, two ceilings.
  const model = goalPanelModel(
    payload({
      tokens: { used: 2_400_000, max: 100_000_000 },
      context: { used: 147_000, max: 200_000 },
    }),
  )
  assert.deepEqual(model.stats, ["3/10 turns", "2m/30m", "2.4m/100m tokens", "147k/200k ctx"])

  // A payload written before `context` existed (any 0.10.x server half) simply
  // renders the three stats it does carry, rather than an empty or `0/0` one.
  assert.deepEqual(goalPanelModel(payload()).stats, ["3/10 turns", "2m/30m", "45k/200k tokens"])
  // ...and an absent ceiling drops the ctx stat the same way every other budget
  // is dropped.
  for (const context of [{ used: 10, max: null }, { used: 10, max: 0 }, { used: 10 }, "nope"]) {
    assert.deepEqual(
      goalPanelModel(payload({ context })).stats,
      ["3/10 turns", "2m/30m", "45k/200k tokens"],
      `context ${JSON.stringify(context)} must not render a ceiling-less stat`,
    )
  }
})

test("each state carries its own icon and an unknown one degrades to active", () => {
  assert.equal(goalPanelModel(payload({ state: "paused" })).icon, "⏸")
  assert.equal(goalPanelModel(payload({ state: "blocked" })).icon, "⛔")
  assert.equal(goalPanelModel(payload({ state: "completed" })).icon, "✓")
  const unknown = goalPanelModel(payload({ state: "exploded" }))
  assert.equal(unknown.state, "active")
  assert.equal(unknown.icon, "▶")
})

test("a budget with no ceiling is dropped, except the turn budget, which is unlimited", () => {
  // `minutes: undefined` and `tokens.max: null` are genuinely absent budgets:
  // there is no number to render, so the stat is dropped rather than shown as
  // `10/0`. `turns.max: 0` is NOT absent — 0 is how the whole package spells
  // "unlimited" (`DEFAULT_OPTIONS.maxTurns`, `--max-turns 0`), and this payload
  // arrives as arbitrary JSON from another process, so it renders `3/∞`
  // instead of making the turn count vanish.
  const model = goalPanelModel(
    payload({ turns: { used: 3, max: 0 }, minutes: undefined, tokens: { used: 10, max: null } }),
  )
  assert.deepEqual(model.stats, ["3/∞ turns"])

  // Every other spelling of no ceiling reads the same way, and a hostile
  // fractional ceiling degrades to unlimited rather than to a dropped stat.
  for (const turns of [{ used: 3, max: null }, { used: 3, max: -1 }, { used: 3 }, { used: 3, max: 0.5 }]) {
    assert.equal(
      goalPanelModel(payload({ turns, minutes: undefined, tokens: undefined })).stats[0],
      "3/∞ turns",
      `turns ${JSON.stringify(turns)} must render a ceiling, not disappear`,
    )
  }

  // Control: a real ceiling still renders as itself.
  assert.equal(goalPanelModel(payload({ turns: { used: 3, max: 10 } })).stats[0], "3/10 turns")
})

test("token counts are abbreviated the way the session title abbreviates them", () => {
  assert.equal(formatPanelTokens(0), "0")
  assert.equal(formatPanelTokens(999), "999")
  assert.equal(formatPanelTokens(1000), "1k")
  assert.equal(formatPanelTokens(1500), "1.5k")
  assert.equal(formatPanelTokens(12_345), "12k")
  assert.equal(formatPanelTokens(1_500_000), "1.5m")
  assert.equal(formatPanelTokens(12_000_000), "12m")
  assert.equal(formatPanelTokens(-5), "0")
  assert.equal(formatPanelTokens("nope"), "0")
})

test("an ordered sequence shows its position and an unordered one shows nothing", () => {
  assert.equal(goalPanelModel(payload({ sequence: { ordered: true, position: 2, total: 4 } })).sequence, "step 2/4")
  assert.equal(goalPanelModel(payload({ sequence: { ordered: true, position: 0, total: 0 } })).sequence, "")
  assert.equal(goalPanelModel(payload({ sequence: undefined })).sequence, "")
})

test("actions carry a status mark and a done action without a pass verdict is not verified", () => {
  const model = goalPanelModel(
    payload({
      plan: {
        total: 4,
        verified: 1,
        blocked: 1,
        actions: [
          { id: "a1", title: "reproduce", status: "done", verdict: "pass" },
          { id: "a2", title: "claim it works", status: "done", verdict: null },
          { id: "a3", title: "measure", status: "in_progress", verdict: "fail" },
          { id: "a4", title: "waiting", status: "blocked", verdict: undefined },
        ],
      },
    }),
  )
  assert.equal(model.progress, "1/4 actions verified, 1 blocked")
  assert.deepEqual(
    model.actions.map((action) => [action.mark, action.title, action.verdict, action.verified]),
    [
      ["●", "reproduce", "pass", true],
      ["●", "claim it works", null, false],
      ["◐", "measure", "fail", false],
      ["⛔", "waiting", null, false],
    ],
  )
})

test("a plan with no blocked actions omits the blocked clause", () => {
  const model = goalPanelModel(payload({ plan: { total: 3, verified: 2, blocked: 0, actions: [] } }))
  assert.equal(model.progress, "2/3 actions verified")
  assert.equal(model.hiddenActions, 3)
})

test("a long plan is capped and the remainder is counted, not dropped silently", () => {
  const actions = Array.from({ length: 40 }, (_, index) => ({
    id: `a${index}`,
    title: `action ${index}`,
    status: "pending",
    verdict: null,
  }))
  const model = goalPanelModel(payload({ plan: { total: 40, verified: 0, blocked: 0, actions } }))
  assert.equal(model.actions.length, 12)
  assert.equal(model.hiddenActions, 28)
  assert.equal(model.actions.at(-1).title, "action 11")
})

test("junk inside the plan is discarded rather than rendered", () => {
  const model = goalPanelModel(
    payload({
      plan: {
        total: 3,
        actions: [null, "nope", { title: "" }, { title: "real", status: "sideways", verdict: "maybe" }],
      },
    }),
  )
  assert.equal(model.actions.length, 1)
  assert.deepEqual(
    { ...model.actions[0], id: model.actions[0].id },
    { id: "real", title: "real", status: "pending", verdict: null, mark: "○", verified: false },
  )
})

test("why it stopped comes before what it was asked to satisfy", () => {
  const model = goalPanelModel(
    payload({
      state: "blocked",
      blockedReason: "the build is red",
      stopReason: "max turns reached",
      successCriteria: "tests pass",
      constraints: "do not touch prod",
    }),
  )
  assert.deepEqual(model.notes, [
    { label: "Blocked", text: "the build is red", tone: "error" },
    { label: "Success", text: "tests pass", tone: "muted" },
    { label: "Constraints", text: "do not touch prod", tone: "muted" },
  ])
})

test("a stop reason is shown only when nothing is blocking", () => {
  const model = goalPanelModel(payload({ state: "paused", stopReason: "max turns reached" }))
  assert.deepEqual(model.notes, [{ label: "Stopped", text: "max turns reached", tone: "warning" }])
})

test("an overlong objective is truncated so it cannot push the sidebar apart", () => {
  const model = goalPanelModel(payload({ objective: "x".repeat(400) }))
  assert.equal(model.objective.length, 120)
  assert.ok(model.objective.endsWith("…"))
})

test("the panel registers a sidebar_content view and logs that it did", async () => {
  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const { api, registrations, logged } = fakeApi(new Map())

  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })

  assert.equal(registrations.length, 1)
  assert.equal(typeof registrations[0].order, "number")
  assert.deepEqual(Object.keys(registrations[0].slots), ["sidebar_content"])
  assert.equal(logged.length, 1)
  assert.equal(logged[0].body.service, "opencode-goal-plugin")
})

test("a log that rejects does not take the TUI down with it", async () => {
  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const { api, registrations } = fakeApi(new Map(), {
    log: async () => {
      throw new Error("host refused")
    },
  })

  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })
  assert.equal(registrations.length, 1)
})

test("the registered view renders the whole goal for its session", async () => {
  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const sessions = new Map([
    [
      "ses_goal",
      {
        id: "ses_goal",
        metadata: {
          goal: payload({
            sequence: { ordered: true, position: 2, total: 4 },
            plan: {
              total: 14,
              verified: 1,
              blocked: 1,
              actions: [
                { id: "a1", title: "reproduce", status: "done", verdict: "pass" },
                { id: "a2", title: "waiting", status: "blocked", verdict: null },
              ],
            },
            successCriteria: "tests pass",
            constraints: "do not touch prod",
          }),
        },
      },
    ],
  ])
  const { api, registrations } = fakeApi(sessions)
  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })

  const node = registrations[0].slots.sidebar_content({}, { session_id: "ses_goal" })
  const lines = renderLines(runtime, node)

  assert.deepEqual(
    lines.map((line) => line.text),
    [
      GOAL_PANEL_TITLE,
      "▶ ship the sidebar panel",
      "3/10 turns · 2m/30m · 45k/200k tokens",
      "step 2/4",
      "1/14 actions verified, 1 blocked",
      "● reproduce [pass]",
      "⛔ waiting",
      "+12 more",
      "Success: tests pass",
      "Constraints: do not touch prod",
    ],
  )
})

test("the panel colours by state: blocked is an error, completed is a success", async () => {
  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const sessions = new Map([
    ["ses_blocked", { id: "ses_blocked", metadata: { goal: payload({ state: "blocked" }) } }],
    ["ses_done", { id: "ses_done", metadata: { goal: payload({ state: "completed" }) } }],
    ["ses_paused", { id: "ses_paused", metadata: { goal: payload({ state: "paused" }) } }],
  ])
  const { api, registrations } = fakeApi(sessions)
  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })

  const headline = (sessionID) => {
    const node = registrations[0].slots.sidebar_content({}, { session_id: sessionID })
    return renderLines(runtime, node)[1]
  }

  assert.deepEqual(headline("ses_blocked"), { fg: THEME.error, text: "⛔ ship the sidebar panel" })
  assert.deepEqual(headline("ses_done"), { fg: THEME.success, text: "✓ ship the sidebar panel" })
  assert.deepEqual(headline("ses_paused"), { fg: THEME.warning, text: "⏸ ship the sidebar panel" })
})

test("a verified action reads as success and a failed verdict reads as an error", async () => {
  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const sessions = new Map([
    [
      "ses_plan",
      {
        id: "ses_plan",
        metadata: {
          goal: payload({
            turns: undefined,
            minutes: undefined,
            tokens: undefined,
            plan: {
              total: 3,
              verified: 1,
              blocked: 0,
              actions: [
                { id: "a1", title: "proved", status: "done", verdict: "pass" },
                { id: "a2", title: "broke", status: "in_progress", verdict: "fail" },
                { id: "a3", title: "later", status: "pending", verdict: null },
              ],
            },
          }),
        },
      },
    ],
  ])
  const { api, registrations } = fakeApi(sessions)
  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })

  const node = registrations[0].slots.sidebar_content({}, { session_id: "ses_plan" })
  const lines = renderLines(runtime, node)
  assert.deepEqual(lines.slice(2), [
    { fg: THEME.textMuted, text: "1/3 actions verified" },
    { fg: THEME.success, text: "● proved [pass]" },
    { fg: THEME.error, text: "◐ broke [fail]" },
    { fg: THEME.textMuted, text: "○ later" },
  ])
})

test("the panel is hidden for a cleared goal, an unknown session, and a session with no metadata", async () => {
  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const sessions = new Map([
    ["ses_cleared", { id: "ses_cleared", metadata: { goal: null } }],
    ["ses_bare", { id: "ses_bare" }],
    ["ses_other", { id: "ses_other", metadata: { somethingElse: true } }],
  ])
  const { api, registrations } = fakeApi(sessions)
  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })

  for (const sessionID of ["ses_cleared", "ses_bare", "ses_other", "ses_missing", "", undefined]) {
    const node = registrations[0].slots.sidebar_content({}, { session_id: sessionID })
    assert.deepEqual(renderLines(runtime, node), [], `${sessionID} must render nothing`)
  }
})

test("the panel re-reads the session instead of freezing the values it first saw", async () => {
  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const session = { id: "ses_live", metadata: { goal: payload() } }
  const sessions = new Map([["ses_live", session]])
  const { api, registrations } = fakeApi(sessions)
  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })

  // Mount ONCE: the component body and every element in the tree are built a
  // single time, exactly as the host builds them. Everything the panel shows is
  // passed as a getter, so re-reading these same elements after the host
  // replaces the session record must show the new values.
  const node = registrations[0].slots.sidebar_content({}, { session_id: "ses_live" })
  const mounted = node.type(node.props)
  const lines = collect(runtime, mounted)
  assert.equal(mounted.props.when, true)
  assert.deepEqual(readLine(lines[1]), { fg: THEME.text, text: "▶ ship the sidebar panel" })
  assert.equal(readLine(lines[2]).text, "3/10 turns · 2m/30m · 45k/200k tokens")

  session.metadata = { goal: payload({ state: "completed", turns: { used: 7, max: 10 } }) }
  assert.deepEqual(readLine(lines[1]), { fg: THEME.success, text: "✓ ship the sidebar panel" })
  assert.equal(readLine(lines[2]).text, "7/10 turns · 2m/30m · 45k/200k tokens")

  // And a cleared goal collapses the branch the panel lives in rather than
  // leaving a header with nothing under it.
  session.metadata = { goal: null }
  assert.equal(mounted.props.when, false)
  assert.deepEqual(renderLines(runtime, node), [])
})

test("an unlimited turn budget renders ∞ instead of vanishing from the stats line", () => {
  // The server half writes `{ used, max: null, unlimited: true }` for
  // `maxTurns: 0`. A null ceiling must NOT be dropped the way a genuinely
  // absent budget is — the count still matters, only the limit is gone.
  const model = goalPanelModel(
    payload({ turns: { used: 3, max: null, unlimited: true }, minutes: { used: 1, max: 480 } }),
  )
  assert.deepEqual(model.stats, ["3/∞ turns", "1m/8h", "45k/200k tokens"])
  assert.equal(UNLIMITED_MARK, "\u221e")

  // A payload that carries only the null ceiling (no flag) reads the same way,
  // because `Infinity` serialises to null and older writers may do just that.
  assert.equal(goalPanelModel(payload({ turns: { used: 3, max: null } })).stats[0], "3/∞ turns")

  // Control: a bounded budget still renders its real ceiling.
  assert.equal(goalPanelModel(payload({ turns: { used: 3, max: 10 } })).stats[0], "3/10 turns")
})

test("the shipped 8-hour window renders in hours, and the elapsed clock follows it in", () => {
  const stats = (used, max) => goalPanelModel(payload({ minutes: { used, max } })).stats[1]
  assert.equal(stats(0, 480), "0m/8h")
  assert.equal(stats(45, 480), "45m/8h")
  assert.equal(stats(60, 480), "1h/8h")
  assert.equal(stats(90, 480), "1.5h/8h")
  assert.equal(stats(480, 480), "8h/8h")
  // Truncated, so the panel does not read `8h/8h` three minutes before the
  // goal can stop: 477 minutes is 7.95 h.
  assert.equal(stats(477, 480), "7.9h/8h")
  assert.equal(stats(479, 480), "7.9h/8h")
})

test("the panel prefers the v2 durationMs field and falls back to v1 minutes", () => {
  // v2: milliseconds, the same field the session title formats, so a young
  // goal reads in seconds instead of collapsing to `0m`.
  const young = goalPanelModel(payload({ durationMs: { used: 45_000, max: 28_800_000 }, minutes: { used: 0, max: 480 } }))
  assert.equal(young.stats[1], "45s/8h")

  // A budget under a minute: `minutes` can only say `0m/0m`, and a max of 0
  // made the no-ceiling drop remove the duration stat from the panel entirely.
  const short = goalPanelModel(payload({ durationMs: { used: 5_000, max: 20_000 }, minutes: { used: 0, max: 0 } }))
  assert.equal(short.stats[1], "5s/20s")
  assert.equal(goalPanelModel(payload({ minutes: { used: 0, max: 0 } })).stats.length, 2, "v1 alone still drops it")

  // A v1 payload — no durationMs at all — still renders from minutes.
  assert.equal(goalPanelModel(payload({ minutes: { used: 90, max: 480 } })).stats[1], "1.5h/8h")

  // A hostile durationMs degrades to the v1 field rather than throwing.
  assert.equal(goalPanelModel(payload({ durationMs: "soon", minutes: { used: 2, max: 30 } })).stats[1], "2m/30m")
  assert.equal(goalPanelModel(payload({ durationMs: { used: "x", max: null }, minutes: { used: 2, max: 30 } })).stats[1], "2m/30m")
})

test("the shared budget formatters are the ones the panel and the title both use", () => {
  // One decimal, trailing .0 dropped, and TRUNCATED rather than rounded.
  // 481 minutes is 8.016 h, which truncates to 8.0 and renders "8h", not "8.0h";
  // 477 is 7.95 h and must render "7.9h" rather than reaching "8h" early.
  assert.equal(formatBudgetMinutes(0), "0m")
  assert.equal(formatBudgetMinutes(45), "45m")
  assert.equal(formatBudgetMinutes(59), "59m")
  assert.equal(formatBudgetMinutes(60), "1h")
  assert.equal(formatBudgetMinutes(90), "1.5h")
  assert.equal(formatBudgetMinutes(480), "8h")
  assert.equal(formatBudgetMinutes(481), "8h")
  assert.equal(formatBudgetMinutes(477), "7.9h")
  assert.equal(formatBudgetMinutes(500), "8.3h")
  assert.equal(formatBudgetMinutes(-5), "0m")
  assert.equal(formatBudgetMinutes("nope"), "0m")

  assert.equal(formatTurnBudget(3, 10), "3/10")
  assert.equal(formatTurnBudget(3, 0), "3/∞")
  assert.equal(formatTurnBudget(3, null), "3/∞")
})

// Tests - the exception-list filter
// T24 units: 33, 34.

// A `plan.mirror` record shaped like the one `buildSidebarMetadata` publishes in v3.
function mirror(state, overrides = {}) {
  return { state, rows: 5, extra: 0, at: 1_757_280_000, ...overrides }
}

test("a fresh mirror renders only the actions that need attention", () => {
  // Plan order deliberately interleaves the groups, so an implementation that merely
  // dropped `pending` rows without regrouping would render a different order.
  const actions = [
    { id: "a1", title: "pending work", status: "pending", verdict: null },
    { id: "a2", title: "in flight", status: "in_progress", verdict: null },
    { id: "a3", title: "claimed done", status: "done", verdict: null },
    { id: "a4", title: "waiting on review", status: "blocked", verdict: null },
    { id: "a5", title: "proven done", status: "done", verdict: "pass" },
    { id: "a6", title: "done, verdict fail", status: "done", verdict: "fail" },
  ]
  const plan = { total: 6, verified: 1, blocked: 1, mirror: mirror("fresh"), actions }

  const model = goalPanelModel(payload({ plan }))
  assert.deepEqual(
    model.actions.map((action) => action.title),
    ["claimed done", "done, verdict fail", "waiting on review", "in flight"],
  )
  // The two rows the Todo section can express on its own are the ones dropped: an
  // untouched `pending` action and a completion that already carries its verdict.
  assert.deepEqual(
    model.actions.map((action) => action.mark),
    ["●", "●", "⛔", "◐"],
  )
  assert.equal(model.hiddenActions, 0)
  // The progress line still counts the WHOLE plan, so nothing is lost by filtering rows.
  // A fresh mirror now also carries the progress-line suffix (unit 35's
  // sibling unit); this test predates T25, so the expectation is extended, not the model.
  assert.equal(model.progress, "1/6 actions verified, 1 blocked · todo mirror fresh (5)")

  // A stale mirror is still a mirror: the Todo section holds an older copy of these rows,
  // so the panel keeps filtering rather than duplicating the list.
  assert.deepEqual(
    goalPanelModel(payload({ plan: { ...plan, mirror: mirror("stale") } })).actions.map((a) => a.title),
    ["claimed done", "done, verdict fail", "waiting on review", "in flight"],
  )

  // Controls that must come out DIFFERENT: `off` is the plugin's own statement that it
  // never touched the Todo list, and a non-object `mirror` is junk from another process.
  // Both fall back to today's rendering — every action, in plan order.
  for (const junk of [mirror("off"), "fresh", 3, null, undefined, ["fresh"]]) {
    assert.deepEqual(
      goalPanelModel(payload({ plan: { ...plan, mirror: junk } })).actions.map((a) => a.title),
      actions.map((action) => action.title),
      `mirror ${JSON.stringify(junk)} must render every action`,
    )
  }
})

test("a fully verified plan renders the progress line and no rows", () => {
  const actions = Array.from({ length: 4 }, (_, index) => ({
    id: `a${index}`,
    title: `action ${index}`,
    status: "done",
    verdict: "pass",
  }))
  const plan = { total: 4, verified: 4, blocked: 0, mirror: mirror("fresh"), actions }

  const model = goalPanelModel(payload({ plan }))
  assert.deepEqual(model.actions, [])
  // Zero rows must not resurrect the `+N more` line: there is nothing more to show.
  assert.equal(model.hiddenActions, 0)
  // Extended for the new fresh-mirror suffix (see the note above).
  assert.equal(model.progress, "4/4 actions verified · todo mirror fresh (5)")

  // The same plan with the mirror off is the control: it still renders all four rows.
  const off = goalPanelModel(payload({ plan: { ...plan, mirror: mirror("off") } }))
  assert.equal(off.actions.length, 4)
  assert.equal(off.progress, "4/4 actions verified")
})

test("the exception list keeps plan order within each group and caps at MAX_PANEL_ACTIONS", () => {
  // 24 actions, one of each status in turn: 6 pending, 6 done-unverified, 6 blocked,
  // 6 in_progress. The exception list is 18 rows, which the cap trims to 12.
  const shape = [
    { status: "pending", verdict: null },
    { status: "done", verdict: null },
    { status: "blocked", verdict: null },
    { status: "in_progress", verdict: null },
  ]
  const actions = Array.from({ length: 24 }, (_, index) => ({
    id: `a${index}`,
    title: `action ${index}`,
    ...shape[index % shape.length],
  }))
  const model = goalPanelModel(
    payload({ plan: { total: 24, verified: 0, blocked: 6, mirror: mirror("fresh"), actions } }),
  )

  assert.equal(model.actions.length, 12)
  assert.deepEqual(
    model.actions.map((action) => action.title),
    [
      // every done-unverified action, in plan order...
      "action 1",
      "action 5",
      "action 9",
      "action 13",
      "action 17",
      "action 21",
      // ...then the blocked ones, also in plan order, until the cap bites.
      "action 2",
      "action 6",
      "action 10",
      "action 14",
      "action 18",
      "action 22",
    ],
  )
  // 18 exceptions less the 12 shown. `plan.total` is 24, so counting against the plan
  // rather than the filtered list would promise 12 rows that the panel would never show.
  assert.equal(model.hiddenActions, 6)
})

// Tests - the mirror suffix on the progress line
// T25 units: 35 ("mirror off renders every action, exactly as v2 did" — design §5.2 line 725;
// the task brief's own gloss on this unit, "under \"off\" the model's action list, progress
// line and every field equal the v2 rendering of the same plan", is what the assertions below
// prove, but the design-assigned NAME is kept verbatim per CONTRACTS ("33-38 as listed in
// design §5.2") since that string, not the brief's paraphrase, is the one other seats/anchors
// can cite), plus "the progress line names a fresh mirror with the live count and a stale one
// without it" (new for T25, not in design §5.2's numbered list).

test("mirror off renders every action, exactly as v2 did", () => {
  const actions = [
    { id: "a1", title: "pending work", status: "pending", verdict: null },
    { id: "a2", title: "in flight", status: "in_progress", verdict: null },
    { id: "a3", title: "claimed done", status: "done", verdict: null },
  ]
  const planWithOff = { total: 3, verified: 1, blocked: 0, mirror: mirror("off"), actions }
  const planNoMirrorKey = { total: 3, verified: 1, blocked: 0, actions } // v2: no `mirror` key at all

  const withOff = goalPanelModel(payload({ plan: planWithOff }))
  const v2 = goalPanelModel(payload({ plan: planNoMirrorKey }))
  assert.deepEqual(withOff, v2)
  assert.ok(!("mirror" in withOff), "an off mirror must not leak a `mirror` key onto the model")
  assert.equal(withOff.actions.length, 3)
  assert.equal(withOff.progress, "1/3 actions verified")

  // A `liveTodoCount` is ignored outright while the mirror is off: still byte-equal to v2.
  const withOffAndLive = goalPanelModel(payload({ plan: planWithOff }), { liveTodoCount: 99 })
  assert.deepEqual(withOffAndLive, v2)
})

test("the progress line names a fresh mirror with the live count and a stale one without it", () => {
  const plan = { total: 2, verified: 1, blocked: 0, mirror: mirror("fresh", { rows: 5 }), actions: [] }

  // No live count supplied: the suffix falls back to the payload's own `mirror.rows`.
  const noLive = goalPanelModel(payload({ plan }))
  assert.equal(noLive.progress, "1/2 actions verified · todo mirror fresh (5)")
  assert.deepEqual(noLive.mirror, { state: "fresh", rows: 5, extra: 0, liveTodoCount: null, drift: false })

  // A finite live count that agrees with the payload names the live number instead — they
  // happen to be equal here, which also proves this is not double-counting anything.
  const liveAgrees = goalPanelModel(payload({ plan }), { liveTodoCount: 5 })
  assert.equal(liveAgrees.progress, "1/2 actions verified · todo mirror fresh (5)")
  assert.equal(liveAgrees.mirror.liveTodoCount, 5)
  assert.equal(liveAgrees.mirror.drift, false)

  // Stale carries NO count at all: the payload's row count is a snapshot the panel does not
  // want to imply is still accurate once the mirror has gone stale.
  const stalePlan = { ...plan, mirror: mirror("stale", { rows: 5 }) }
  const stale = goalPanelModel(payload({ plan: stalePlan }))
  assert.equal(stale.progress, "1/2 actions verified · todo list stale")
  assert.deepEqual(stale.mirror, { state: "stale", rows: 5, extra: 0, liveTodoCount: null, drift: false })

  // A live count that disagrees overrides BOTH the fresh and the stale suffix with drift —
  // proved here from `goalPanelModel`'s side alone; T26 owns supplying the real live count.
  const freshDrift = goalPanelModel(payload({ plan }), { liveTodoCount: 7 })
  assert.equal(freshDrift.progress, "1/2 actions verified · mirror drift (7≠5)")
  assert.equal(freshDrift.mirror.drift, true)

  const staleDrift = goalPanelModel(payload({ plan: stalePlan }), { liveTodoCount: 7 })
  assert.equal(staleDrift.progress, "1/2 actions verified · mirror drift (7≠5)")
  assert.equal(staleDrift.mirror.drift, true)

  // The NEVER-MIRRORED stale case, `rows: 0` — the shape a host that denies
  // `todowrite` produces, which docs/compatibility.md hazard 3 describes. Drift
  // still wins, so the suffix that hazard promises is only the one you see when
  // the session's own native list is empty too.
  const neverMirrored = { ...plan, mirror: mirror("stale", { rows: 0 }) }
  assert.equal(
    goalPanelModel(payload({ plan: neverMirrored }), { liveTodoCount: 0 }).progress,
    "1/2 actions verified · todo list stale",
  )
  assert.equal(
    goalPanelModel(payload({ plan: neverMirrored }), { liveTodoCount: 3 }).progress,
    "1/2 actions verified · mirror drift (3≠0)",
  )

  // Non-finite live counts behave exactly like "no live count was supplied".
  for (const junk of [undefined, NaN, "5", null]) {
    const model = goalPanelModel(payload({ plan }), { liveTodoCount: junk })
    assert.equal(model.progress, "1/2 actions verified · todo mirror fresh (5)", `liveTodoCount ${String(junk)}`)
  }
})

// Tests - the live drift check
// T26 units: 37, plus "a live count that matches the payload renders as fresh" and
// "GoalPanel tolerates a host without a todo state reader" (the latter two are new for T26 and
// are not in design 5.2's numbered list). Unit 37's NAME is design 5.2's verbatim string, per
// CONTRACTS ("33-38 as listed in design 5.2"); the brief's paraphrase of what it has to prove -
// `goalPanelModel(payloadWithRows5, { liveTodoCount: 7 })` renders `mirror drift (7 vs 5)` and
// NOT "fresh" - is asserted inside it.
//
// These drive the WHOLE panel, not just `goalPanelModel`. T25 already proved the model half from
// an argument someone else supplied; what is unproven until here is that `GoalPanel` goes and
// GETS that argument off the host, and that it survives a host that cannot answer.

// Find the progress line by its content rather than by row index, so an extra line elsewhere in
// the panel (a note, a sequence line) cannot silently re-point these assertions at another row.
function panelProgress(runtime, node) {
  return renderLines(runtime, node)
    .map((entry) => entry.text)
    .find((text) => text.includes("actions verified"))
}

function todoRows(count) {
  return Array.from({ length: count }, (_, index) => ({ content: `row ${index}`, status: "pending" }))
}

// Mount the real `GoalPanel` over one session whose plan carries a mirror of 5 rows, with `todo`
// installed on the fake host at exactly the place the real adapter puts it
// (packages/tui/src/plugin/adapters.tsx:131 `todo`). Passing `undefined` installs NOTHING, which
// is what a host older than that surface looks like from inside the panel.
async function mountMirrorPanel(todo, planOverrides = {}) {
  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const plan = {
    total: 2,
    verified: 1,
    blocked: 0,
    mirror: mirror("fresh", { rows: 5 }),
    actions: [],
    ...planOverrides,
  }
  const sessions = new Map([["ses_mirror", { id: "ses_mirror", metadata: { goal: payload({ plan }) } }]])
  const { api, registrations } = fakeApi(sessions)
  if (todo !== undefined) api.state.session.todo = todo
  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })
  const render = (sessionID = "ses_mirror") =>
    panelProgress(runtime, registrations[0].slots.sidebar_content({}, { session_id: sessionID }))
  return { render, api }
}

test("a live todo count that disagrees with the payload renders as drift, not agreement", async () => {
  // The model half, in the brief's exact shape: 5 rows in the payload, 7 live.
  const payloadWithRows5 = payload({
    plan: { total: 2, verified: 1, blocked: 0, mirror: mirror("fresh", { rows: 5 }), actions: [] },
  })
  const drifted = goalPanelModel(payloadWithRows5, { liveTodoCount: 7 })
  assert.equal(drifted.progress, "1/2 actions verified · mirror drift (7≠5)")
  assert.ok(!drifted.progress.includes("fresh"), "drift REPLACES the fresh suffix, it never sits beside it")
  assert.equal(drifted.mirror.drift, true)
  assert.equal(drifted.mirror.liveTodoCount, 7)

  // The panel half: same numbers, but nobody hands `GoalPanel` the 7 - it has to read it off the
  // host. This is the assertion the model-level test above cannot make.
  const seven = await mountMirrorPanel(() => todoRows(7))
  assert.equal(seven.render(), "1/2 actions verified · mirror drift (7≠5)")

  // The control that must come out DIFFERENT: identical panel, identical payload, a host whose
  // list agrees. A `GoalPanel` that ignored the host and echoed `mirror.rows` would read "fresh"
  // for both, so this pair is what makes the drift claim falsifiable.
  const five = await mountMirrorPanel(() => todoRows(5))
  assert.equal(five.render(), "1/2 actions verified · todo mirror fresh (5)")

  // An EMPTY host list is a live count of 0, not "no live count": the case a truthiness guard
  // would silently swallow, and the one that matters most (the user cleared their Todo list).
  const calls = []
  const empty = await mountMirrorPanel((sessionID) => {
    calls.push(sessionID)
    return []
  })
  assert.equal(empty.render(), "1/2 actions verified · mirror drift (0≠5)")
  // The panel asks about ITS OWN session, never some other one.
  assert.ok(calls.length > 0, "the panel must actually call the host's todo reader")
  assert.deepEqual([...new Set(calls)], ["ses_mirror"])

  // Drift overrides a STALE mirror too, and keeps the drift wording rather than "todo list stale".
  const staleDrift = await mountMirrorPanel(() => todoRows(7), { mirror: mirror("stale", { rows: 5 }) })
  assert.equal(staleDrift.render(), "1/2 actions verified · mirror drift (7≠5)")
})

test("a live count that matches the payload renders as fresh", async () => {
  // Agreement renders the SAME bytes as "no live count at all", so the rendered string alone
  // cannot tell the two apart - a panel that never asked the host would pass on it. The spy is
  // what gives this test polarity: the count on screen has to have been READ, not assumed.
  const asked = []
  const fresh = await mountMirrorPanel((sessionID) => {
    asked.push(sessionID)
    return todoRows(5)
  })
  assert.equal(fresh.render(), "1/2 actions verified · todo mirror fresh (5)")
  assert.ok(asked.length > 0, "the fresh count must come from the host, not from the payload")
  assert.deepEqual([...new Set(asked)], ["ses_mirror"])

  // A stale mirror whose live count agrees is still stale: agreement on the COUNT is not
  // freshness, and the panel must not upgrade the server's own verdict.
  const stale = await mountMirrorPanel(() => todoRows(5), { mirror: mirror("stale", { rows: 5 }) })
  assert.equal(stale.render(), "1/2 actions verified · todo list stale")

  // With the mirror `off` the live count is not consulted for anything, even when it disagrees
  // loudly: the plugin never touched the Todo list, so it has no claim to make about it.
  const off = await mountMirrorPanel(() => todoRows(9), { mirror: mirror("off", { rows: 5 }) })
  assert.equal(off.render(), "1/2 actions verified")

  // A v2 payload has no `mirror` key at all; a live count must not conjure a suffix onto it.
  const v2 = await mountMirrorPanel(() => todoRows(9), { mirror: undefined })
  assert.equal(v2.render(), "1/2 actions verified")
})

test("GoalPanel tolerates a host without a todo state reader", async () => {
  // With no live count the suffix falls back to the payload's own row count.
  const fallback = "1/2 actions verified · todo mirror fresh (5)"

  // No reader at all. `fakeApi` publishes only `state.session.get`, which is exactly the shape of
  // a host that predates the todo surface - and of every other panel test in this file.
  const bare = await mountMirrorPanel(undefined)
  assert.equal(bare.api.state.session.todo, undefined, "this case is only meaningful with no reader present")
  assert.equal(bare.render(), fallback)

  // A reader that throws must not take the sidebar down with it; the panel renders without the
  // live count rather than not rendering.
  const thrower = await mountMirrorPanel(() => {
    throw new Error("host refused")
  })
  assert.equal(thrower.render(), fallback)

  // Anything that is not an array is not a row count, however number-ish or length-ish it looks.
  for (const junk of [undefined, null, 7, "12345", { length: 7 }, new Set([1, 2, 3]), NaN]) {
    const odd = await mountMirrorPanel(() => junk)
    assert.equal(odd.render(), fallback, `todo() -> ${String(junk)} must not produce a live count`)
  }

  // A `todo` that is not callable is never called. Swapping it on a MOUNTED panel also proves the
  // read is live: the same element tree answers differently after the host object changed.
  const swapped = await mountMirrorPanel(() => todoRows(7))
  assert.equal(swapped.render(), "1/2 actions verified · mirror drift (7≠5)")
  for (const notCallable of ["nope", 42, null, {}, [], undefined]) {
    swapped.api.state.session.todo = notCallable
    assert.equal(swapped.render(), fallback, `a ${String(notCallable)} todo must not be called`)
  }
  swapped.api.state.session.todo = () => todoRows(7)
  assert.equal(swapped.render(), "1/2 actions verified · mirror drift (7≠5)", "and back again")

  // No session id: the panel is hidden outright, and the reader is not consulted for a session
  // the panel does not have.
  const unasked = []
  const nameless = await mountMirrorPanel((sessionID) => {
    unasked.push(sessionID)
    return todoRows(7)
  })
  assert.equal(nameless.render(""), undefined, "an empty session id renders no panel at all")
  assert.deepEqual(unasked, [])
})

// Tests - a v2 payload still renders as today
// T27 units: 36.
test("a v2 payload with no mirror key renders the actions", () => {
  // A payload shaped exactly like v1.0.0's `buildSidebarMetadata` output: `v:
  // GOAL_PANEL_PAYLOAD_VERSION` (2), a `plan` object that carries no `mirror`
  // key at all. Waves 4+ add mirror-aware exception-list filtering (T24) and
  // a progress-line suffix (T25/T26) to `goalPanelModel`, both gated on
  // `plan.mirror` existing and not being `"off"` — this unit is the
  // regression this back-compat guarantee exists to catch if either lands
  // ungated and starts firing on a plan that never had a mirror.
  const v2Payload = payload({
    goalId: "goal_v2back",
    objective: "ship the v2 back-compat check",
    turns: { used: 4, max: 12 },
    minutes: { used: 6, max: 60 },
    tokens: { used: 12_000, max: 50_000 },
    plan: {
      total: 5,
      verified: 1,
      blocked: 1,
      actions: [
        { id: "a1", title: "first, pending", status: "pending", verdict: null },
        { id: "a2", title: "second, in progress", status: "in_progress", verdict: null },
        { id: "a3", title: "third, done and verified", status: "done", verdict: "pass" },
        { id: "a4", title: "fourth, done unverified", status: "done", verdict: null },
        { id: "a5", title: "fifth, blocked", status: "blocked", verdict: "fail" },
      ],
    },
  })
  assert.equal("mirror" in v2Payload.plan, false, "fixture must not carry a mirror key")

  // Captured by actually running `goalPanelModel(v2Payload)` at base SHA
  // 8954b6f (v1.0.1 integrate wave 3), before T24/T25/T26/T39 fill their
  // reserved regions in src/goal-sidebar-view.js — so this literal is
  // byte-identical to what the code produced before any mirror-aware panel
  // logic existed, rather than a hand-typed guess at what it should produce.
  const expected = {
    state: "active",
    icon: "▶",
    objective: "ship the v2 back-compat check",
    stats: ["4/12 turns", "6m/1h", "12k/50k tokens"],
    sequence: "",
    progress: "1/5 actions verified, 1 blocked",
    actions: [
      { id: "a1", title: "first, pending", status: "pending", verdict: null, mark: "○", verified: false },
      { id: "a2", title: "second, in progress", status: "in_progress", verdict: null, mark: "◐", verified: false },
      { id: "a3", title: "third, done and verified", status: "done", verdict: "pass", mark: "●", verified: true },
      { id: "a4", title: "fourth, done unverified", status: "done", verdict: null, mark: "●", verified: false },
      { id: "a5", title: "fifth, blocked", status: "blocked", verdict: "fail", mark: "⛔", verified: false },
    ],
    hiddenActions: 0,
    notes: [],
  }

  const model = goalPanelModel(v2Payload)
  assert.deepEqual(model, expected)

  // The unit's own claim, named explicitly rather than left implicit in the
  // snapshot: every action rendered, in plan order, ...
  assert.deepEqual(model.actions.map((action) => action.id), ["a1", "a2", "a3", "a4", "a5"])
  // ...and no mirror suffix anywhere on the progress line.
  assert.equal(/todo mirror|todo list stale|mirror drift/.test(model.progress), false)
})

// Tests - the needs-evidence suffix on a panel action line
// T39 units: A3 ("a done action without a passing verdict carries the needs-evidence suffix on its panel line").
test("a done action without a passing verdict carries the needs-evidence suffix on its panel line", async () => {
  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const sessions = new Map([
    [
      "ses_plan",
      {
        id: "ses_plan",
        metadata: {
          goal: payload({
            turns: undefined,
            minutes: undefined,
            tokens: undefined,
            plan: {
              total: 2,
              verified: 0,
              blocked: 0,
              actions: [
                { id: "a1", title: "claim it works", status: "done", verdict: null },
                { id: "a2", title: "broke it", status: "done", verdict: "fail" },
              ],
            },
          }),
        },
      },
    ],
  ])
  const { api, registrations } = fakeApi(sessions)
  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })

  const node = registrations[0].slots.sidebar_content({}, { session_id: "ses_plan" })
  const lines = renderLines(runtime, node)
  assert.deepEqual(lines.slice(2), [
    { fg: THEME.textMuted, text: "0/2 actions verified" },
    { fg: THEME.textMuted, text: "● claim it works — needs claim/evidence/verdict" },
    { fg: THEME.error, text: "● broke it [fail] — needs claim/evidence/verdict" },
  ])
})

test("a verified done action carries no suffix", async () => {
  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const sessions = new Map([
    [
      "ses_plan",
      {
        id: "ses_plan",
        metadata: {
          goal: payload({
            turns: undefined,
            minutes: undefined,
            tokens: undefined,
            plan: {
              total: 1,
              verified: 1,
              blocked: 0,
              actions: [{ id: "a1", title: "proved", status: "done", verdict: "pass" }],
            },
          }),
        },
      },
    ],
  ])
  const { api, registrations } = fakeApi(sessions)
  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })

  const node = registrations[0].slots.sidebar_content({}, { session_id: "ses_plan" })
  const lines = renderLines(runtime, node)
  assert.deepEqual(lines.slice(2), [
    { fg: THEME.textMuted, text: "1/1 actions verified" },
    { fg: THEME.success, text: "● proved [pass]" },
  ])
})

// Wave-4 integration - the cross-half seam no single seat could test
// Written by the wave-4 integrator, not by a seat. Unit 38 is design §5.2's
// "cross-half parity" unit, and it is the one unit in this wave that no seat could
// write: T23 (wave 3) proved the SERVER publishes `plan.mirror.rows`, and T25/T26
// proved the PANEL renders whatever number a hand-built payload carries — but every
// panel seat fed `goalPanelModel` a fixture it typed itself, so nothing yet asserted
// that the number the server puts on the wire is the number the panel prints.
//
// This unit closes that: one real goal, mirrored through the real
// `tool.execute.before` / `tool.execute.after` hooks, its payload built by the real
// `buildSidebarMetadata`, and that payload — never a fixture — handed to
// `goalPanelModel` and to a mounted `GoalPanel`. Every count asserted here is read
// back from the run, so a divergence between the two halves cannot be typed away.
function int4Client() {
  return {
    app: { log: async () => {} },
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async () => ({}),
      abort: async () => ({}),
    },
  }
}

test("the server's v3 payload and the panel agree on the mirrored count", async () => {
  // 1. A real goal and a real plan, through the server half's own tool handlers.
  //    Statuses are set through `goal_plan_set` so the plan carries a
  //    done-without-a-verdict action (a1), an in_progress one (a2) and a pending
  //    one (a3) — the three cases the panel's exception list has to tell apart.
  const hooks = await GoalPlugin({ client: int4Client() }, { persistState: false })
  const handlers = testInternals.buildAgentToolHandlers({
    defaultGoalOptions: testInternals.normalizeOptions(),
    persist: async () => {},
  })
  const sid = "ses_int4_parity"
  await handlers.setGoal(sid, { objective: "ship the todo mirror" })
  await handlers.setPlan(sid, {
    actions: [
      { id: "a1", title: "write the code", status: "done", claim: "it compiles", evidence: "node -c" },
      { id: "a2", title: "verify the code", status: "in_progress" },
      { id: "a3", title: "ship it", status: "pending" },
    ],
  })
  const goal = testInternals.currentGoal(sid)
  // Fixture self-check: fail loud if the plan did not come out as intended, rather
  // than quietly asserting the parity of the wrong shape.
  assert.deepEqual(
    goal.plan.actions.map((action) => `${action.id}:${action.status}:${action.verdict}`),
    ["a1:done:null", "a2:in_progress:null", "a3:pending:null"],
  )

  // 2. The mirror really runs: two rows of the model's own go in, three plan rows
  //    plus those two come out, and the after-hook stamps the result.
  const call = {
    args: {
      todos: [
        { content: "buy milk", status: "pending", priority: "medium" },
        { content: "call mom", status: "pending", priority: "low" },
      ],
    },
  }
  await hooks["tool.execute.before"]({ tool: "todowrite", sessionID: sid, callID: "int4-1" }, call)
  // `hostTodos` is the array the HOST would now be showing — the before-hook replaced
  // the model's two rows with this. Every "5" below is derived from it.
  const hostTodos = call.args.todos
  assert.equal(hostTodos.length, 5, "3 plan rows + 2 kept extras")
  await hooks["tool.execute.after"](
    { tool: "todowrite", sessionID: sid, callID: "int4-1", args: call.args },
    { title: "todowrite", output: "ok", metadata: {} },
  )

  // 3. The payload the panel actually receives, from the real publisher.
  const wire = testInternals.buildSidebarMetadata(goal, 1_700_000_000_000, { mirrorMode: "plan" })
  assert.equal(wire.v, 3)
  assert.equal(wire.plan.mirror.state, "fresh")
  assert.equal(wire.plan.mirror.rows, hostTodos.length, "the server counts the rows it actually wrote")
  assert.equal(wire.plan.mirror.extra, 2)

  // 4. THE PARITY CLAIM: the panel prints the server's own number. `liveTodoCount`
  //    is `hostTodos.length`, i.e. what a host showing exactly those rows would
  //    report, so agreement here is agreement between the two halves and not
  //    between two hand-typed constants.
  const agree = goalPanelModel(wire, { liveTodoCount: hostTodos.length })
  assert.equal(agree.progress, "0/3 actions verified · todo mirror fresh (5)")
  assert.equal(agree.mirror.rows, wire.plan.mirror.rows)
  assert.equal(agree.mirror.extra, wire.plan.mirror.extra)
  assert.equal(agree.mirror.liveTodoCount, hostTodos.length)
  assert.equal(agree.mirror.drift, false)

  // 5. The control that gives 4 polarity: one row more on the host and the SAME
  //    payload renders drift, naming both numbers, with the fresh wording gone.
  const drifted = goalPanelModel(wire, { liveTodoCount: hostTodos.length + 2 })
  assert.equal(drifted.progress, "0/3 actions verified · mirror drift (7≠5)")
  assert.equal(drifted.mirror.drift, true)
  assert.ok(!drifted.progress.includes("fresh"), "drift replaces the fresh suffix, never sits beside it")

  // 6. Through the mounted panel, where nobody hands `GoalPanel` a number: it reads
  //    the host's list itself, and the host's list IS the array the before-hook wrote.
  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const sessions = new Map([[sid, { id: sid, metadata: { goal: wire } }]])
  const { api, registrations } = fakeApi(sessions)
  const asked = []
  api.state.session.todo = (sessionID) => {
    asked.push(sessionID)
    return hostTodos
  }
  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })
  const lines = renderLines(runtime, registrations[0].slots.sidebar_content({}, { session_id: sid }))
  const texts = lines.map((line) => line.text)
  assert.deepEqual([...new Set(asked)], [sid], "the panel asks the host about its own session")
  assert.ok(
    texts.includes("0/3 actions verified · todo mirror fresh (5)"),
    `progress line missing from ${JSON.stringify(texts)}`,
  )

  // 7. T24's exception list over a REAL payload: the pending action is hidden and
  //    the two that need attention render, done-unverified before in_progress.
  assert.deepEqual(agree.actions.map((action) => action.id), ["a1", "a2"])
  assert.equal(agree.hiddenActions, 0)
  assert.deepEqual(texts.slice(-2), [
    "● write the code — needs claim/evidence/verdict",
    "◐ verify the code",
  ])

  // 8. The two halves spell the needs-evidence suffix the same way: T1's
  //    `mirrorRowSuffix` writes it into the mirrored todo row, T39's
  //    `actionNeedsEvidenceSuffix` writes it onto the panel line. Both bytes come
  //    out of this one run, so a drift in either would be caught here.
  assert.equal(hostTodos[0].content, "a1 · write the code — needs claim/evidence/verdict")
  assert.ok(hostTodos[0].content.endsWith(" — needs claim/evidence/verdict"))
  assert.ok(texts.at(-2).endsWith(" — needs claim/evidence/verdict"))
})

// Tests - the CEV gate crosses the wire (v1.0.1 fix, review finding D-F1)
//
// The panel used to re-derive "verified" from `status` and `verdict` alone. That
// is WEAKER than the server's gate, which also demands a claim and evidence, and
// the two disagree on a reachable state: `goal_plan_set` records an action's
// status and verdict with no ledger at all (only `goal_action_update` enforces
// the gate), so `{status: "done", verdict: "pass"}` with empty claim/evidence is
// something a model can write in one call. The server called that action
// unverified everywhere - the progress count, the mirrored todo row's
// ` — needs claim/evidence/verdict` suffix, the completion blockers - while the
// panel called it verified and therefore dropped it from the exception list
// entirely. The payload now carries the server's own boolean and the panel uses
// it, so this unit fails on any re-derivation.
test("a done action with a passing verdict but no ledger is an exception on the panel, as it is on the wire", async () => {
  const hooks = await GoalPlugin({ client: int4Client() }, { persistState: false })
  const handlers = testInternals.buildAgentToolHandlers({
    defaultGoalOptions: testInternals.normalizeOptions(),
    persist: async () => {},
  })
  const sid = "ses_cev_parity"
  await handlers.setGoal(sid, { objective: "prove the CEV gate crosses the wire" })
  // a1 is the finding: done, verdict pass, no claim and no evidence. a2 is the
  // control that must come out different: the same status and verdict WITH the
  // ledger the gate asks for.
  await handlers.setPlan(sid, {
    actions: [
      { id: "a1", title: "ship it", status: "done", verdict: "pass" },
      {
        id: "a2",
        title: "prove it",
        status: "done",
        verdict: "pass",
        claim: "the suite is green",
        evidence: "tests 655, fail 0",
      },
    ],
  })
  const goal = testInternals.currentGoal(sid)
  // Fixture self-check: fail loud if `goal_plan_set` refused the ledger-less
  // action rather than quietly asserting parity on a plan that never held it.
  assert.deepEqual(
    goal.plan.actions.map((action) => `${action.id}:${action.status}:${action.verdict}:${action.claim}`),
    ["a1:done:pass:", "a2:done:pass:the suite is green"],
  )

  // The real mirror, so the todo row and the panel line come out of one run.
  const call = { args: { todos: [] } }
  await hooks["tool.execute.before"]({ tool: "todowrite", sessionID: sid, callID: "cev-1" }, call)
  await hooks["tool.execute.after"](
    { tool: "todowrite", sessionID: sid, callID: "cev-1", args: call.args },
    { title: "todowrite", output: "ok", metadata: {} },
  )
  const hostTodos = call.args.todos
  assert.deepEqual(hostTodos.map((row) => [row.content, row.status]), [
    ["a1 · ship it — needs claim/evidence/verdict", "in_progress"],
    ["a2 · prove it", "completed"],
  ])

  // The wire: the server publishes its own verdict on each action.
  const wire = testInternals.buildSidebarMetadata(goal, 1_700_000_000_000, { mirrorMode: "plan" })
  assert.equal(wire.plan.verified, 1, "the server counts one of the two as verified")
  assert.deepEqual(
    wire.plan.actions.map((action) => [action.id, action.status, action.verdict, action.verified]),
    [
      ["a1", "done", "pass", false],
      ["a2", "done", "pass", true],
    ],
  )

  // The panel: a1 is the exception, a2 is not, and the two halves spell the
  // suffix the same way.
  const model = goalPanelModel(wire, { liveTodoCount: hostTodos.length })
  assert.equal(model.progress, "1/2 actions verified · todo mirror fresh (2)")
  assert.deepEqual(model.actions.map((action) => [action.id, action.verified]), [["a1", false]])
  assert.equal(model.hiddenActions, 0)

  const runtime = fakeRuntime()
  const { tui } = createGoalSidebar(runtime)
  const sessions = new Map([[sid, { id: sid, metadata: { goal: wire } }]])
  const { api, registrations } = fakeApi(sessions)
  api.state.session.todo = () => hostTodos
  await tui(api, {}, { spec: "opencode-goal-pro-max-complete-plugin" })
  const texts = renderLines(runtime, registrations[0].slots.sidebar_content({}, { session_id: sid })).map(
    (line) => line.text,
  )
  // The rendered line keeps the recorded verdict AND names the missing ledger,
  // which is the whole point: `[pass]` alone read as finished.
  assert.equal(texts.at(-1), "● ship it [pass] — needs claim/evidence/verdict")
  // The two halves spell the suffix identically, both bytes from this one run.
  const suffix = hostTodos[0].content.slice("a1 · ship it".length)
  assert.equal(suffix, " — needs claim/evidence/verdict")
  assert.ok(texts.at(-1).endsWith(suffix))
  assert.ok(
    !texts.some((line) => line.includes("prove it")),
    `the verified action must not be repeated: ${JSON.stringify(texts)}`,
  )

  // THE CONTROL that gives every assertion above its polarity, and the T27
  // guarantee in the same breath: strip the v3 key from this very payload and
  // the panel falls back to the pre-1.0.1 derivation, which calls a1 verified
  // and hides it. So the difference above is the published boolean and nothing
  // else, and a v2 payload still renders exactly as it did in 1.0.0.
  const v2 = JSON.parse(JSON.stringify(wire))
  for (const action of v2.plan.actions) delete action.verified
  const v2Model = goalPanelModel(v2, { liveTodoCount: hostTodos.length })
  assert.deepEqual(v2Model.actions, [], "without the key the panel cannot see the missing ledger")
  assert.equal(v2Model.progress, model.progress, "the progress line is the server's count either way")

  // And a payload that lies about the key in the other direction is still bound
  // by the mark the same record renders: `verified` never contradicts `status`.
  const lying = JSON.parse(JSON.stringify(wire))
  lying.plan.actions[0].status = "in_progress"
  lying.plan.actions[0].verified = true
  assert.equal(goalPanelModel(lying).actions.find((action) => action.id === "a1").verified, false)
})
