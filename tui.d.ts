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
  /** `true` only when the action is done AND its verdict is `pass`. */
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
  /** `3/7 actions verified`, otherwise empty. */
  progress: string
  actions: GoalPanelAction[]
  /** Actions beyond the panel's render cap. */
  hiddenActions: number
  notes: GoalPanelNote[]
}

/**
 * Validate and reduce a `session.metadata.goal` payload. Returns `null` when
 * there is no goal — including after `/goal clear`, which writes
 * `metadata.goal = null` — so the panel hides itself.
 */
export function goalPanelModel(raw: unknown): GoalPanelModel | null

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
