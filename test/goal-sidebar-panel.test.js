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

// >>> v101:T24 tests - the exception-list filter
// T24 units: 33, 34.
// <<< v101:T24



// >>> v101:T25 tests - the mirror suffix on the progress line
// T25 units: 35.
// <<< v101:T25



// >>> v101:T26 tests - the live drift check
// T26 units: 37.
// <<< v101:T26



// >>> v101:T27 tests - a v2 payload still renders as today
// T27 units: 36.
// <<< v101:T27



// >>> v101:T39 tests - the needs-evidence suffix on a panel action line
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
// <<< v101:T39



