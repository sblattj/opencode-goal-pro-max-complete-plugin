/**
 * Type declarations for the TUI half of opencode-goal-pro-max-complete-plugin
 * (`opencode-goal-pro-max-complete-plugin/tui`), which OpenCode loads as the package's `./tui`
 * target and which registers the goal panel in the session sidebar.
 *
 * These are declared structurally rather than by importing
 * `@opencode-ai/plugin/tui`, so a consumer that only installs this package
 * still typechecks. The shapes are the subset this module actually uses; the
 * host's own `TuiPlugin` is assignable to `GoalTuiPlugin`.
 */

/** The panel's view of a single action in the goal's verified plan. */
export interface GoalPanelAction {
  id: string
  title: string
  status: "pending" | "in_progress" | "done" | "blocked"
  verdict: "pass" | "fail" | null
  /** Status glyph: `○` pending, `◐` in progress, `●` done, `⛔` blocked. */
  mark: string
  /**
   * `true` only when the action is `done` AND the server said it is verified.
   * A v3 payload publishes `plan.actions[].verified`, the server's own CEV
   * gate (claim, evidence and a passing verdict), and that boolean is used
   * verbatim. A v2 payload has no such key, so it falls back to
   * `verdict === "pass"` — the strongest statement that wire supports.
   */
  verified: boolean
}

/** A supporting line under the budgets: blocker, stop reason, criteria. */
export interface GoalPanelNote {
  label: string
  text: string
  tone: "error" | "warning" | "muted"
}

/** Everything the sidebar panel renders, derived from `session.metadata.goal`. */
export interface GoalPanelModel {
  state: "active" | "paused" | "blocked" | "completed"
  /** Status glyph for {@link state}: `▶`, `⏸`, `⛔`, or `✓`. */
  icon: string
  objective: string
  /**
   * Budget summaries, e.g.
   * `["3/∞ turns", "2m/8h", "147k/100m tokens", "45k/200k ctx"]`.
   * `… tokens` is cumulative token SPEND against the goal's token budget;
   * `… ctx` is the peak context size against the goal's context ceiling. The
   * `ctx` stat is present only when the payload carries a `context` budget: a
   * v1 payload never does, and a v2 payload omits it whenever no ceiling is
   * known — `contextWindowTokens` is `0` (auto) and the host could not name the
   * model's window — so a panel must render the first three in both cases
   * rather than showing a budget of zero.
   * An unlimited turn budget (`turns.max === null`, `turns.max === 0`, or
   * `turns.unlimited`) renders its ceiling as `∞`. Durations render from the
   * v2 `durationMs` field when present and fall back to v1 `minutes`: under a
   * minute in whole seconds (`20s`), then minutes, then hours with one decimal
   * and no trailing `.0`. Every duration is truncated, never rounded up, so
   * elapsed never reaches the limit's own rendering early.
   */
  stats: string[]
  /** `step 2/4` for an ordered `/goal sequence`, otherwise empty. */
  sequence: string
  /**
   * `3/7 actions verified`, otherwise empty. When the payload carries a v3
   * `plan.mirror` whose `state` is one this release knows, one of three
   * suffixes is appended (see {@link mirror}): `" · todo mirror fresh (5)"`,
   * `" · todo list stale"`, or `" · mirror drift (7≠5)"`. No suffix is
   * appended for a v2 payload (no `plan.mirror`), for a `mirror.state` of
   * `"off"`, or for a state this release does not recognise — the line
   * renders exactly as it did before v1.0.1.
   */
  progress: string
  /**
   * Under an active mirror ({@link mirror} present), this is the EXCEPTION
   * list — only actions that need attention, in order: a `done` action with
   * no passing verdict, then `blocked`, then `in_progress`; `pending` and a
   * verified `done` are omitted entirely (the native Todo section already
   * shows plan work, so the panel repeats only what that section cannot
   * express). Without an active mirror (v2 payload, or `mirror.state ===
   * "off"`), this is every action, exactly as before v1.0.1.
   */
  actions: GoalPanelAction[]
  /**
   * Actions beyond the panel's render cap (`MAX_PANEL_ACTIONS`). Under an
   * active mirror this counts over the FILTERED exception list, not the
   * full plan — a plan with 40 pending actions and one exception renders
   * `hiddenActions: 0`, because none of the omitted rows were exceptions.
   * The count is also taken over the plan actions the server already
   * capped to 20 (`SIDEBAR_METADATA_MAX_ACTIONS`), so it cannot see
   * exceptions beyond that server-side cap either.
   */
  hiddenActions: number
  notes: GoalPanelNote[]
  /**
   * Todo-mirror facts for the current payload, present only when the
   * payload carries a v3 `plan.mirror` and its `state` is not `"off"` — a
   * v2 payload (no `plan.mirror` at all) and an `"off"` mirror both omit
   * this key entirely, they do not set it to `undefined`.
   */
  mirror?: {
    /**
     * The payload's `plan.mirror.state`, forwarded verbatim. This plugin's own
     * server writes exactly `"fresh"`, `"stale"` or `"off"` (the union on
     * `GoalSidebarStatus["plan"]["mirror"]` in the server types), and an
     * `"off"` mirror omits this whole key rather than appearing here — but the
     * payload is JSON written by whichever server version the host is running,
     * so a panel from an older release can be handed a state it has never heard
     * of. It keeps such a mirror ACTIVE, because {@link actions} filters out only
     * an `"off"` mirror rather than filtering in a known state, and reports it
     * here unchanged while standing down both the {@link progress} suffix and
     * {@link drift}. Hence `string`: an exhaustive `switch` over two literals
     * would be a claim about the server that this side cannot make.
     */
    state: string
    /** `plan.mirror.rows` from the payload, coerced to a non-negative integer. */
    rows: number
    /** `plan.mirror.extra` from the payload, coerced to a non-negative integer. */
    extra: number
    /**
     * The `liveTodoCount` this model was built with, or `null` when none was
     * supplied or it was not a finite number. Distinct from `0`, a real
     * answer meaning the host's live Todo list is empty right now.
     */
    liveTodoCount: number | null
    /**
     * `true` only when `liveTodoCount` is a finite number that disagrees
     * with `rows` while `state` is `"fresh"` or `"stale"`. `false` whenever
     * `liveTodoCount` is `null` (no live read available) — a missing live
     * count is never treated as drift.
     */
    drift: boolean
  }
}

/**
 * Validate and reduce a `session.metadata.goal` payload. Returns `null` when
 * there is no goal — including after `/goal clear`, which writes
 * `metadata.goal = null` — so the panel hides itself.
 *
 * `options.liveTodoCount`, when supplied, is the host's own live Todo row
 * count (read separately from `api.state.session.todo(sessionID)` by the
 * caller — this function never reads the host itself) used to compute
 * {@link GoalPanelModel.mirror}`.drift`. Omit it, or pass a non-finite
 * value, to render the mirror facts without a drift comparison.
 */
export function goalPanelModel(
  raw: unknown,
  options?: { liveTodoCount?: number },
): GoalPanelModel | null

/** Abbreviate a token count the way the session title does (`45k`, `1.5m`). */
export function formatPanelTokens(value: number): string

/** Heading rendered above the panel. */
export const GOAL_PANEL_TITLE: string

/**
 * Schema version of the `metadata.goal` payload this panel understands (2 as
 * of 0.11.0: nullable `turns.max`, plus `durationMs`). A larger version is
 * rendered on a best-effort basis rather than hidden.
 */
export const GOAL_PANEL_PAYLOAD_VERSION: number

/**
 * The host runtime handed to {@link createGoalSidebar}: `solid-js`'s
 * `createMemo`, `For`, and `Show`, plus `jsx` from
 * `@opentui/solid/jsx-runtime`. Both are provided by OpenCode at runtime and
 * must not be bundled.
 */
export interface GoalSidebarRuntime {
  createMemo: (fn: () => any) => () => any
  For: unknown
  Show: unknown
  jsx: (type: unknown, props?: Record<string, unknown>) => unknown
}

/** `TuiPlugin`: called by OpenCode's TUI plugin runtime with its plugin API. */
export type GoalTuiPlugin = (api: any, options?: unknown, meta?: unknown) => Promise<void>

/** Build the panel component and the `tui()` entrypoint from a host runtime. */
export function createGoalSidebar(runtime: GoalSidebarRuntime): {
  GoalPanel: (props: { api: unknown; session_id: string }) => unknown
  tui: GoalTuiPlugin
}

export const tui: GoalTuiPlugin

/**
 * Default export consumed by OpenCode's TUI plugin loader. A plugin module may
 * export `server()` or `tui()`, never both, which is why this is a separate
 * entrypoint from the package's default (server) export.
 */
declare const goalTuiPlugin: {
  id: "opencode-goal-plugin"
  tui: GoalTuiPlugin
}

export default goalTuiPlugin
