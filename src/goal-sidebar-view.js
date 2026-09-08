// ---------------------------------------------------------------------------
// Sidebar goal panel (TUI half).
//
// MECHANISM (opencode 1.18.29). The session sidebar exposes plugin slots:
// packages/tui/src/routes/session/sidebar.tsx:85 renders
// `<pluginRuntime.Slot name="sidebar_content" session_id=… />`, alongside
// `sidebar_title` (single_winner, sidebar.tsx:49-51) and `sidebar_footer`
// (sidebar.tsx:90). Its props are exactly `{ session_id: string }`
// (packages/plugin/src/tui.ts, `TuiHostSlotMap.sidebar_content`). A TUI plugin
// registers a view for that slot exactly the way the builtin todo panel does
// (packages/tui/src/feature-plugins/sidebar/todo.tsx:33-42), reading reactive
// host state through `TuiPluginApi` — `state.session.get(id)` returns the live
// `Session` record (tui.ts:388), which is where the server half's
// `metadata.goal` payload arrives.
//
// `api.slots.register()` deliberately takes no `id`: the host rejects a
// registration without one (packages/tui/src/plugin/slots.tsx:19-23,
// `isHostSlotPlugin`) but injects the plugin's own id first
// (packages/opencode/src/plugin/tui/runtime.ts:603-609, `{ ...plugin, id }`),
// which is why the builtin panel passes only `{ order, slots }` too.
//
// A server module and a TUI module may not be the same FILE
// (packages/opencode/src/plugin/shared.ts:293-294 rejects a default export
// carrying both `server()` and `tui()`), but one PACKAGE may ship both: the
// entrypoint for each kind is resolved from `exports["./server"]` and
// `exports["./tui"]` (shared.ts:103-107, `resolvePackageEntrypoint`), the
// install manifest builds its target list from those same keys
// (packages/opencode/src/plugin/install.ts:145-166, `packageTargets`), and the
// TUI loads its entries with kind "tui"
// (packages/opencode/src/plugin/tui/runtime.ts:676-685, `PluginLoader
// .loadExternal({ kind: "tui" })` + `readV1Plugin(mod, spec, "tui")`).
//
// THE TWO HALVES ARE CONFIGURED SEPARATELY. `opencode.json`'s `plugin` array
// only ever produces SERVER plugins; the TUI reads its own list from
// `tui.json`/`tui.jsonc`. `TuiConfig` populates `plugin_origins` solely while
// folding tui config files (packages/opencode/src/config/tui.ts:157-168, over
// the file list built at tui.ts:183-210 from
// `ConfigPaths.fileInDirectory(dir, "tui")`, paths.ts:43-45), and the TUI
// runtime loads exactly that list
// (packages/opencode/src/plugin/tui/runtime.ts:1088,
// `config.plugin_origins ?? (await TuiConfig.pluginOrigins())`). Confirmed
// live: with the package only in `opencode.json`, the server half loaded and
// this panel never did; adding the same spec to `tui.json` loaded both. So a
// user installs this package in BOTH files — the README says so.
//
// This file holds everything except the two runtime imports, so the panel can
// be unit-tested without a terminal: the module that OpenCode actually loads
// (`src/goal-tui.js`) is a six-line adapter that hands the real `solid-js` and
// `@opentui/solid/jsx-runtime` to `createGoalSidebar`. Its only import is the
// relative `./goal-format.js`, which carries the budget strings the server
// half renders too; a relative import is inlined by the bundler even under
// `--packages external`, so it stays a pure, terminal-free module. Those
// specifiers are
// provided to plugins by the host at runtime — `@opentui/solid`'s
// `ensureRuntimePluginSupport` (called at tui/runtime.ts:47) registers
// `solid-js`, `solid-js/store`, `@opentui/solid`, `@opentui/solid/components`,
// `@opentui/solid/jsx-runtime`, and `@opentui/solid/jsx-dev-runtime` as runtime
// modules — so they must NOT be bundled: a second copy of Solid would have its
// own reactive graph and never update.
// ---------------------------------------------------------------------------

import {
  formatBudgetDuration,
  formatBudgetMinutes,
  formatTurnBudget,
  isUnlimitedTurnBudget,
} from "./goal-format.js"

export const GOAL_PANEL_TITLE = "Goal"

// The payload version this panel understands. `metadata.goal.v` is written by
// the server half; a future, larger version is rendered on a best-effort basis
// rather than hidden, because a blank sidebar is worse than a stale one. v2
// (0.11.0) made `turns.max` nullable and added `durationMs` and `context`,
// and redefined `tokens.used` as cumulative spend rather than context size.
export const GOAL_PANEL_PAYLOAD_VERSION = 2

const STATE_ICONS = {
  active: "▶",
  paused: "⏸",
  blocked: "⛔",
  completed: "✓",
}

const ACTION_MARKS = {
  pending: "○",
  in_progress: "◐",
  done: "●",
  blocked: "⛔",
}

// A long plan must not push the rest of the sidebar off screen.
const MAX_PANEL_ACTIONS = 12
const MAX_LINE_LENGTH = 160

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedText(value, limit = MAX_LINE_LENGTH) {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  if (!trimmed) return ""
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, Math.max(1, limit - 1))}…`
}

function wholeNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

function budget(raw) {
  if (!isRecord(raw)) return null
  const max = wholeNumber(raw.max)
  if (!max) return null
  return { used: wholeNumber(raw.used), max }
}

// The turn budget is the one budget that has a legitimate "no ceiling" state,
// carried as `{ used, max: null, unlimited: true }`. It must survive the
// no-ceiling drop above and render `used/∞` instead of disappearing.
//
// `max: 0` gets the same treatment: this payload is arbitrary JSON from
// another process, and `0` is how the rest of the package spells "unlimited"
// (`DEFAULT_OPTIONS.maxTurns`, the `--max-turns 0` flag, `isUnlimitedTurnBudget`).
// Whatever spelling arrives, the stat renders rather than vanishing.
function turnsBudget(raw) {
  if (!isRecord(raw)) return null
  const used = wholeNumber(raw.used)
  if (raw.unlimited === true || isUnlimitedTurnBudget(raw.max)) {
    return { used, max: null, unlimited: true }
  }
  const max = wholeNumber(raw.max)
  if (!max) return { used, max: null, unlimited: true }
  return { used, max, unlimited: false }
}

// Matches the abbreviation the session title uses, so the panel and the title
// never disagree about the same number.
export function formatPanelTokens(value) {
  const count = wholeNumber(value)
  if (count < 1000) return String(count)
  if (count < 1_000_000) {
    const thousands = count / 1000
    return `${thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`
  }
  const millions = count / 1_000_000
  return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}m`
}

function normalizeAction(raw) {
  if (!isRecord(raw)) return null
  const title = boundedText(raw.title, 80)
  if (!title) return null
  const status = ACTION_MARKS[raw.status] ? raw.status : "pending"
  const verdict = raw.verdict === "pass" || raw.verdict === "fail" ? raw.verdict : null
  return {
    id: boundedText(raw.id, 32) || title,
    title,
    status,
    verdict,
    mark: ACTION_MARKS[status],
    // A `done` action without a passing verdict is exactly the unsubstantiated
    // completion the CEV gate exists to catch, so it must not read as finished.
    verified: status === "done" && verdict === "pass",
  }
}

// >>> v101:T24 exception-list filter for the mirrored action list (G2)
// The exception list. While the native Todo section is drawing this plan, the panel stops
// repeating rows that section already shows and keeps only what it cannot express: a
// completion with no passing verdict, then a blocker, then the work in flight. `pending`
// and verified-`done` rows are dropped, so a clean plan renders zero rows and the progress
// line carries the whole story.
//
// The groups are listed in the order a human has to act on them, and each group keeps plan
// order internally, so the list is stable from render to render.
const PANEL_EXCEPTION_GROUPS = [
  (action) => action.status === "done" && !action.verified,
  (action) => action.status === "blocked",
  (action) => action.status === "in_progress",
]

// Filtering is a decision about THIS plugin's own mirror mode, never a belief about what
// another panel currently shows. A v2 payload carries no `plan.mirror` at all, and an `off`
// mirror means the plugin never touched the Todo list; both render every action, exactly as
// they did before v1.0.1. The payload is arbitrary JSON from another process, so a
// non-object `mirror` is treated as absent rather than trusted.
function mirrorFiltersPanelActions(mirror) {
  return isRecord(mirror) && mirror.state !== "off"
}

function panelExceptionList(actions) {
  return PANEL_EXCEPTION_GROUPS.flatMap((inGroup) => actions.filter(inGroup))
}
// <<< v101:T24



// >>> v101:T25 mirror suffix on the progress line
// Reserved. T25 adds the ` · todo mirror fresh (n)` / ` · todo list stale` suffix and the
// `{ liveTodoCount }` options argument.
// <<< v101:T25



// >>> v101:T26 live drift check
// Reserved. T26 reads the live todo count in `GoalPanel` and renders the drift suffix.
// <<< v101:T26



// >>> v101:T39 the needs-evidence suffix on a panel action line (A3)
// Reserved. T39 appends ` — needs claim/evidence/verdict` in `actionLine` for a done action
// with no passing verdict.
// <<< v101:T39



/**
 * Turn a `session.metadata.goal` payload into everything the panel renders.
 * Returns `null` when there is no goal — including after `/goal clear`, which
 * writes `metadata.goal = null` — so the panel hides itself entirely.
 *
 * The payload crosses a process boundary as arbitrary JSON, so every field is
 * validated here rather than trusted.
 */
export function goalPanelModel(raw) {
  if (!isRecord(raw)) return null
  const objective = boundedText(raw.objective, 120)
  if (!objective) return null

  const state = STATE_ICONS[raw.state] ? raw.state : "active"
  const turns = turnsBudget(raw.turns)
  // v2 carries the duration in milliseconds, which is what the session title
  // renders from; `minutes` is the v1 fallback and cannot express a budget
  // under a minute. Preferring `durationMs` keeps panel and title byte-equal.
  const durationMs = budget(raw.durationMs)
  const minutes = budget(raw.minutes)
  // `tokens` is cumulative SPEND against the token budget; `context` is the
  // peak context size against the model's window. They are different
  // quantities and each has its own ceiling, so the panel shows both.
  const tokens = budget(raw.tokens)
  const context = budget(raw.context)

  const stats = []
  if (turns) stats.push(`${formatTurnBudget(turns.used, turns.max)} turns`)
  if (durationMs) {
    stats.push(`${formatBudgetDuration(durationMs.used)}/${formatBudgetDuration(durationMs.max)}`)
  } else if (minutes) {
    stats.push(`${formatBudgetMinutes(minutes.used)}/${formatBudgetMinutes(minutes.max)}`)
  }
  if (tokens) stats.push(`${formatPanelTokens(tokens.used)}/${formatPanelTokens(tokens.max)} tokens`)
  if (context) stats.push(`${formatPanelTokens(context.used)}/${formatPanelTokens(context.max)} ctx`)

  const sequence =
    isRecord(raw.sequence) && wholeNumber(raw.sequence.total) > 0
      ? `step ${wholeNumber(raw.sequence.position)}/${wholeNumber(raw.sequence.total)}`
      : ""

  const plan = isRecord(raw.plan) ? raw.plan : {}
  const planTotal = wholeNumber(plan.total)
  const listed = (Array.isArray(plan.actions) ? plan.actions : []).map(normalizeAction).filter(Boolean)
  const filtered = mirrorFiltersPanelActions(plan.mirror)
  const shortlist = filtered ? panelExceptionList(listed) : listed
  const actions = shortlist.slice(0, MAX_PANEL_ACTIONS)
  // Under the exception list the `+N more` count is over the FILTERED list: it promises the
  // rows the cap dropped, never the `pending` actions the Todo section is already showing.
  const hiddenActions = Math.max(0, (filtered ? shortlist.length : planTotal) - actions.length)
  const progress = planTotal
    ? `${wholeNumber(plan.verified)}/${planTotal} actions verified${
        wholeNumber(plan.blocked) ? `, ${wholeNumber(plan.blocked)} blocked` : ""
      }`
    : ""

  // Ordered by what a human needs first when they glance at a stuck run: why it
  // stopped, then what it was told to satisfy.
  const notes = []
  const blockedReason = boundedText(raw.blockedReason)
  const stopReason = boundedText(raw.stopReason)
  if (blockedReason) notes.push({ label: "Blocked", text: blockedReason, tone: "error" })
  else if (stopReason) notes.push({ label: "Stopped", text: stopReason, tone: "warning" })
  const successCriteria = boundedText(raw.successCriteria)
  if (successCriteria) notes.push({ label: "Success", text: successCriteria, tone: "muted" })
  const constraints = boundedText(raw.constraints)
  if (constraints) notes.push({ label: "Constraints", text: constraints, tone: "muted" })

  return {
    state,
    icon: STATE_ICONS[state],
    objective,
    stats,
    sequence,
    progress,
    actions,
    hiddenActions,
    notes,
  }
}

function stateColor(theme, state) {
  if (state === "blocked") return theme.error
  if (state === "completed") return theme.success
  if (state === "paused") return theme.warning
  return theme.text
}

function noteColor(theme, tone) {
  if (tone === "error") return theme.error
  if (tone === "warning") return theme.warning
  return theme.textMuted
}

function actionColor(theme, action) {
  if (action.status === "blocked" || action.verdict === "fail") return theme.error
  if (action.verified) return theme.success
  if (action.status === "in_progress") return theme.text
  return theme.textMuted
}

function actionLine(action) {
  const verdict = action.verdict ? ` [${action.verdict}]` : ""
  return `${action.mark} ${action.title}${verdict}`
}

/**
 * Build the panel and the `tui()` entrypoint from the host-provided runtime.
 * `runtime` is `{ createMemo, Show, For, jsx }` — `solid-js` and
 * `@opentui/solid/jsx-runtime` in production, fakes in the unit tests.
 *
 * Every dynamic value is passed as a getter, which is what the Solid JSX
 * transform emits and what `spread()` reads inside a render effect
 * (@opentui/solid `spreadExpression`), so the panel updates in place as the
 * session record changes instead of rendering once and freezing.
 */
export function createGoalSidebar(runtime) {
  const { createMemo, Show, For, jsx } = runtime

  function readGoalPayload(api, sessionID) {
    if (!sessionID) return null
    const session = api?.state?.session?.get?.(sessionID)
    if (!isRecord(session)) return null
    const metadata = session.metadata
    return isRecord(metadata) ? metadata.goal : null
  }

  function line(color, children) {
    return jsx("text", {
      get fg() {
        return color()
      },
      get children() {
        return children()
      },
    })
  }

  function GoalPanel(props) {
    const theme = () => props.api.theme.current
    const model = createMemo(() => goalPanelModel(readGoalPayload(props.api, props.session_id)))
    // Every accessor below can run after the goal is cleared, between the model
    // going null and Show tearing the branch down, so each one falls back.
    const read = (pick, fallback = "") => () => {
      const current = model()
      return current ? pick(current) : fallback
    }

    return jsx(Show, {
      get when() {
        return model() !== null
      },
      get children() {
        return jsx("box", {
          get children() {
            return [
              line(
                () => theme().text,
                () => jsx("b", { children: GOAL_PANEL_TITLE }),
              ),
              line(
                () => stateColor(theme(), read((m) => m.state, "active")()),
                read((m) => `${m.icon} ${m.objective}`),
              ),
              jsx(Show, {
                get when() {
                  return read((m) => m.stats.length > 0, false)()
                },
                get children() {
                  return line(
                    () => theme().textMuted,
                    read((m) => m.stats.join(" · ")),
                  )
                },
              }),
              jsx(Show, {
                get when() {
                  return read((m) => Boolean(m.sequence), false)()
                },
                get children() {
                  return line(
                    () => theme().textMuted,
                    read((m) => m.sequence),
                  )
                },
              }),
              jsx(Show, {
                get when() {
                  return read((m) => Boolean(m.progress), false)()
                },
                get children() {
                  return line(
                    () => theme().textMuted,
                    read((m) => m.progress),
                  )
                },
              }),
              jsx(For, {
                get each() {
                  return read((m) => m.actions, [])()
                },
                children: (action) =>
                  line(
                    () => actionColor(theme(), action),
                    () => actionLine(action),
                  ),
              }),
              jsx(Show, {
                get when() {
                  return read((m) => m.hiddenActions > 0, false)()
                },
                get children() {
                  return line(
                    () => theme().textMuted,
                    read((m) => `+${m.hiddenActions} more`),
                  )
                },
              }),
              jsx(For, {
                get each() {
                  return read((m) => m.notes, [])()
                },
                children: (note) =>
                  line(
                    () => noteColor(theme(), note.tone),
                    () => `${note.label}: ${note.text}`,
                  ),
              }),
            ]
          },
        })
      },
    })
  }

  // Diagnostics only. A panel that silently fails to appear is the hardest
  // thing to debug about a TUI plugin, so registration is recorded once in
  // opencode's own log rather than printed to the terminal the TUI owns.
  async function logRegistration(api) {
    const log = api?.client?.app?.log
    if (typeof log !== "function") return
    const body = {
      service: "opencode-goal-plugin",
      level: "debug",
      message: "Registered the goal sidebar_content panel",
    }
    try {
      await log({ body })
    } catch {
      try {
        await log(body)
      } catch {
        // Diagnostics must never break the TUI.
      }
    }
  }

  /**
   * `TuiPlugin`: registers the sidebar panel. Ordered just after the builtin
   * todo panel (order 400 in feature-plugins/sidebar/todo.tsx) so an active
   * goal reads as context for the todos below it.
   */
  const tui = async (api) => {
    api.slots.register({
      order: 450,
      slots: {
        sidebar_content(_context, props) {
          return jsx(GoalPanel, { api, session_id: props.session_id })
        },
      },
    })
    await logRegistration(api)
  }

  return { GoalPanel, tui }
}
