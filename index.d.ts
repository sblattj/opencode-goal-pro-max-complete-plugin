/**
 * Type declarations for opencode-goal-pro-max-complete-plugin.
 *
 * These describe the plugin-level configuration object accepted in
 * `opencode.json` under `plugin: [["opencode-goal-pro-max-complete-plugin", { ... }]]`,
 * and the shape of the module's exports.
 */

/**
 * Verdict returned by a completion auditor (built-in or custom). See
 * {@link GoalPluginOptions.auditor} and {@link GoalPluginOptions.completionAudit}.
 */
export interface CompletionAuditVerdict {
  /** `true` to archive the goal as achieved; `false` to reject the completion. */
  approved: boolean
  /** Human-readable reason, surfaced in the goal's status when rejected. */
  reason?: string
}

/** A timestamped lifecycle entry retained with an active or archived goal. */
export interface GoalHistoryEntry {
  type: string
  detail: string
  timestamp: number
}

/** A bounded progress checkpoint retained with a goal. */
export interface GoalCheckpoint {
  summary: string
  timestamp: number
}

/** Normalized token and cost usage accumulated for the current goal run. */
export interface GoalUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  costKnown: boolean
}

/** Lifecycle state of a single action in a goal's verified action plan. */
export type GoalPlanActionStatus = "pending" | "in_progress" | "done" | "blocked"

/** Verdict recorded against an action's evidence. */
export type GoalPlanVerdict = "pass" | "fail"

/**
 * One action in the goal's plan, carrying its own Claim → Evidence → Verdict
 * ledger. An action only counts as verified when `status` is `"done"`, `claim`
 * and `evidence` are both non-empty, and `verdict` is `"pass"`.
 */
export interface GoalPlanAction {
  /** Stable identifier used by `goal_action_update`. Unique within the plan. */
  id: string
  title: string
  status: GoalPlanActionStatus
  /** What the work asserts is true. Doubles as the reason when `status` is `"blocked"`. */
  claim: string
  /** The observation that could have falsified the claim (command output, file content, HTTP response). */
  evidence: string
  verdict: GoalPlanVerdict | null
}

/** The ordered action plan stored alongside the goal in the plugin's JSON state. */
export interface GoalPlan {
  actions: GoalPlanAction[]
  /** Epoch milliseconds of the last plan mutation; `0` when never written. */
  updatedAt: number
}

/**
 * Structured goal status written to the OpenCode session's `metadata.goal` by
 * `PATCH /session/{id}`, so the sidebar carries more than the title string can.
 * See {@link GoalPluginOptions.sidebarStatus}.
 */
export interface GoalSidebarStatus {
  /**
   * Schema version of this payload. v2 (0.11.0) made {@link
   * GoalSidebarStatus.turns}`.max` nullable for an unlimited budget, added
   * {@link GoalSidebarStatus.durationMs} and {@link GoalSidebarStatus.context},
   * and redefined {@link GoalSidebarStatus.tokens}`.used` as cumulative token
   * spend rather than context size; v1 fields are all still written.
   */
  v: 2
  goalId: string
  /**
   * `completed` is the terminal state of an archived goal. A failure surfaces as
   * `blocked` (with `blockedReason`) or `paused` (with `stopReason`) rather than
   * as a distinct state, because a failed goal stays resumable.
   */
  state: "active" | "paused" | "blocked" | "completed"
  /** Short label derived from the objective's first line (or `--objective`). */
  objective: string
  /**
   * Auto-continue turns used and the ceiling. An unlimited turn budget
   * (`maxTurns: 0`) is `max: null` with `unlimited: true` — never `Infinity`,
   * which JSON serialises to `null` on its own and would be indistinguishable
   * from a missing field.
   */
  turns: { used: number; max: number | null; unlimited?: boolean }
  /**
   * Elapsed and limit in milliseconds — the precise duration field, added in
   * v2. The sidebar panel renders from this one, so the panel and the session
   * title agree even for a budget under a minute (`20s/20s`), which `minutes`
   * can only render as `0m/0m`.
   */
  durationMs: { used: number; max: number }
  /** The same duration in whole minutes, truncated. Kept for v1 consumers. */
  minutes: { used: number; max: number }
  /**
   * Cumulative token SPEND and its budget — `used` is
   * `input + output + reasoning + cacheRead + cacheWrite` summed over every
   * message the goal produced, and `max` is `maxTokens`. As of v2 this is
   * spend, not the size of the context; context has its own field.
   */
  tokens: { used: number; max: number }
  /**
   * Context pressure, added in v2: `used` is the peak single-message context
   * the goal has seen (reset to zero by a compaction) and `max` is the goal's
   * context ceiling — an explicit `contextWindowTokens`, or the window the
   * host reported for the model this goal runs on. Unlike
   * {@link GoalSidebarStatus.tokens}`.used`, this number can go down.
   *
   * OMITTED entirely when neither ceiling is known, because `max: 0` would
   * render as a budget of zero; a consumer must treat an absent `context` as
   * "no context ceiling" and drop the stat.
   */
  context?: { used: number; max: number }
  plan: {
    total: number
    verified: number
    blocked: number
    actions: Array<Pick<GoalPlanAction, "id" | "title" | "status" | "verdict">>
  }
  successCriteria?: string
  constraints?: string
  /** Present only for an ordered `/goal sequence` run. */
  sequence?: { ordered: true; position: number; total: number }
  stopReason?: string
  blockedReason?: string
  updatedAt: number
}

/** Read-only goal snapshot passed to custom completion auditors. */
export interface GoalAuditSnapshot {
  goalId: string
  runId: string
  /** The full objective text, including any multi-line handoff body. */
  condition: string
  /** Short label derived from the objective's first line (or `--objective`). */
  objectiveLabel: string
  successCriteria: string
  constraints: string
  mode: "normal" | "ordered"
  sessionID: string
  turnCount: number
  startedAt: number
  pausedAt: number
  /**
   * Peak single-message context size seen by this goal, reset to zero by a
   * compaction. Named `totalTokens` before 0.11.0, where it was mistaken for
   * cumulative spend; spend is `usage` (see {@link GoalUsage}).
   */
  peakContextTokens: number
  /**
   * The context window the host reported for the model this goal is running
   * on, or `0` when it could not say. Used as the goal's context ceiling only
   * while {@link GoalPluginOptions.contextWindowTokens} is `0` (auto), which
   * is the default; an explicit option or `--context-window` always wins.
   */
  modelContextTokens: number
  /** `<providerID>/<modelID>` the window above was read for, or `""`. */
  modelKey: string
  usage: Readonly<GoalUsage>
  options: Readonly<GoalPluginOptions>
  lastStatus: string
  blockedReason: string
  stopped: boolean
  stopReason: string
  history: readonly Readonly<GoalHistoryEntry>[]
  checkpoints: readonly Readonly<GoalCheckpoint>[]
  lastCheckpoint: Readonly<GoalCheckpoint> | null
  /** The verified action plan; `actions` is empty until `goal_plan_set` runs. */
  plan: Readonly<GoalPlan>
}

/** Arguments passed to a custom {@link GoalPluginOptions.auditor} function. */
export interface CompletionAuditContext {
  /** The goal being audited (objective, budget usage, checkpoints, etc.). */
  goal: Readonly<GoalAuditSnapshot>
  /** The OpenCode session ID the goal belongs to. */
  sessionID: string
  /** The assistant's latest response text, containing the `[goal:evidence]`/`[goal:complete]` claim. */
  latestText: string
}

/** Options for the built-in child-session completion auditor (`completionAudit: true`). */
export interface CompletionAuditorOptions {
  /**
   * How long, in milliseconds, the built-in auditor waits for a verdict from
   * its child OpenCode session. A timeout rejects the audit and pauses the
   * goal. Operational failures follow {@link failurePolicy}.
   * @default 120000
   */
  timeoutMs?: number

  /**
   * Result used when the child-session API is unavailable, malformed, throws,
   * or times out. Semantic rejection or an invalid verdict always rejects.
   * `"approve"` is an explicit compatibility escape hatch.
   * @default "reject"
   */
  failurePolicy?: "reject" | "approve"
}

/**
 * Configuration options for opencode-goal-pro-max-complete-plugin. All fields are optional;
 * unset fields fall back to the plugin's built-in defaults. These act as
 * the default limits for every goal set in a session, and most of the
 * budget/behavior fields can be overridden per-goal via `/goal` command
 * flags (e.g. `--max-turns`, `--success`, `--mode`).
 */
export interface GoalPluginOptions {
  /**
   * OpenCode session SDK argument shape. PluginInput currently supplies the
   * legacy generated client; set `"flat"` when embedding with the v2 SDK.
   * The compatibility adapter remembers the successful shape per operation.
   * @default "legacy"
   */
  sdkShape?: "legacy" | "flat"

  /**
   * Maximum number of auto-continue turns sent toward a goal before it is
   * stopped for exceeding limits. `0` means **unlimited** and is the default:
   * an arbitrary turn count stops a healthy long run for no reason. The
   * no-tool-call and no-progress pauses catch a loop that has stopped doing
   * anything, but neither catches a loop that keeps calling tools — for that
   * run the 8-hour window is the brake. Overridable per-goal with
   * `--max-turns`, which also accepts `unlimited`, `none`, `inf`, `infinite`,
   * `infinity`, and `∞`.
   * @default 0
   */
  maxTurns?: number

  /**
   * Maximum wall-clock duration, in milliseconds, a goal may run before it
   * is stopped for exceeding limits. Defaults to 8 hours (28,800,000 ms).
   * Overridable per-goal with `--max-duration-ms` or `--max-minutes`.
   * @default 28800000
   */
  maxDurationMs?: number

  /**
   * Maximum cumulative token SPEND a goal may consume before it is stopped for
   * exceeding limits — every token the goal has been billed for, summed over
   * every message it produced:
   * `usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite`.
   * Cache reads are in the sum because they are billed. Defaults to
   * 100,000,000, a reachable ceiling for an 8-hour unattended run: the token
   * brake, the token warning, and the token dimension of the budget wrap-up
   * all fire against it.
   * Context pressure is a different quantity with its own guard — see
   * {@link GoalPluginOptions.contextWindowTokens}.
   * Overridable per-goal with `--max-tokens` or the `--budget` shorthand
   * (accepts a `k`/`m` suffix, e.g. `100k`, `1.5m`).
   * @default 100000000
   */
  maxTokens?: number

  /**
   * The model's context window, in tokens: the ceiling for the goal's PEAK
   * single-message context (`input + output + reasoning + cache` on one
   * message, kept as a high-water mark and reset by a compaction). Distinct
   * from {@link GoalPluginOptions.maxTokens}, which bounds cumulative spend
   * and only ever grows. At `budgetWrapupRatio` of the ceiling the goal is sent
   * the wrap-up handoff (which PAUSES it), at `ceiling - warnTokensRemaining`
   * it is warned, and at the ceiling it pauses with stop reason
   * `context window reached`.
   *
   * `0` — the default — means AUTO: the ceiling is the window of the model the
   * goal is running on, read once from the host's provider catalog
   * (`client.config.providers()` → `models[id].limit.context`). Any positive
   * value overrides that and skips the lookup. When neither is available the
   * goal has NO context ceiling: the guard stays off rather than pausing a
   * healthy run against a guessed number, `/goal status` renders the peak
   * against `∞`, the continuation prompt reports
   * `context_remaining: unlimited`, and
   * {@link GoalSidebarStatus.context} is omitted.
   *
   * Overridable per-goal with `--context-window` (accepts a `k`/`m` suffix,
   * e.g. `400k`, `1m`).
   * @default 0
   */
  contextWindowTokens?: number

  /**
   * Minimum delay, in milliseconds, enforced between consecutive
   * auto-continue prompts. Overridable per-goal with `--cooldown-ms`.
   * @default 1500
   */
  minDelayMs?: number

  /**
   * How many recent session messages to scan when looking for the latest
   * assistant turn before auto-continuing. This is the visibility window the
   * turn is reconstructed from: OpenCode writes one assistant message per LLM
   * step, so a single turn can be many messages and a narrow window can hide
   * its tool-bearing head behind a text-only summary. Higher values make long,
   * tool-heavy sessions less likely to lose part of the most recent turn; the
   * host serves any limit with the same two queries, so a wider window costs
   * rows, not round trips.
   * @default 200
   */
  maxRecentMessages?: number

  /**
   * Output token floor below which a turn is considered "low-output" for
   * no-progress detection. Overridable per-goal with
   * `--no-progress-threshold`.
   * @default 50
   */
  noProgressTokenThreshold?: number

  /**
   * Grace window for low-output stalls: the goal is paused only after this
   * many consecutive stalled low-output turns, rather than on the first
   * one. Output tokens are summed over the whole turn (every assistant
   * message answering one prompt). Overridable per-goal with
   * `--no-progress-turns`.
   * @default 2
   */
  noProgressTurnsBeforePause?: number

  /**
   * Grace window for tool-free continuation turns (a "talk only" turn in
   * which none of the turn's assistant messages called a tool). Complements
   * the no-progress check by catching self-chat loops that still produce
   * output. Judging a run purely on tool calls is blunt, so the default is
   * ten consecutive tool-free turns. Overridable per-goal with
   * `--no-tool-turns`. Set the plugin option to `0` to disable this heuristic.
   * @default 10
   */
  noToolCallTurnsBeforePause?: number

  /**
   * When `true`, a new human message does not pause an active goal: the goal
   * loop keeps running and the message steers the next continuation instead of
   * stopping with `stopReason: "user intervention"`. Plugin-owned command and
   * continuation messages are never treated as interventions either way.
   * @default false
   */
  noInterruptOnUserMessage?: boolean

  /**
   * When `true`, auto-continue is deferred while the session has active child
   * sessions (subagents or background tasks), so the goal loop does not prompt
   * the orchestrator over work a child is already doing. The goal stays
   * running and the next idle event continues once the children are done.
   * Hosts that cannot report children/status fail open (continuation proceeds).
   * @default false
   */
  noContinueWhileChildrenActive?: boolean

  /**
   * Fraction (between 0 and 1, exclusive) of a budget at which the plugin
   * sends a one-time "wrap up" prompt nudging the model to finish before the
   * hard limit is hit. Applied to the three budgets that can actually be
   * reached — cumulative token spend, peak context, and the wall clock —
   * whichever arrives first. The turn budget is excluded: it is unlimited by
   * default, and a bounded one already gets a final handoff at its ceiling.
   * @default 0.8
   */
  budgetWrapupRatio?: number

  /**
   * Number of remaining auto-continue turns at which a limit-approaching
   * warning is included in status output.
   * @default 3
   */
  warnTurnsRemaining?: number

  /**
   * Remaining duration, in milliseconds, at which a limit-approaching
   * warning is included in status output. Ten minutes, scaled to the 8-hour
   * default window; the old 60-second threshold was 0.2 % of it.
   * @default 600000
   */
  warnDurationMsRemaining?: number

  /**
   * Remaining tokens at which a limit-approaching warning is included in
   * status output. Applied twice, to two different quantities: to the token
   * budget (`maxTokens - spend`) and to the context window
   * (`contextWindowTokens - peak context`), so a goal can be warned about
   * either without setting a second threshold.
   * @default 25000
   */
  warnTokensRemaining?: number

  /**
   * Maximum number of consecutive prompt failures (e.g. transport errors
   * sending the auto-continue prompt, or repeated missing-evidence /
   * missing-blocker format violations) tolerated before the goal is
   * stopped.
   * @default 3
   */
  maxPromptFailures?: number

  /**
   * Whether to persist active/backgrounded goals and recent goal results
   * to disk so they survive a restart. Recovered active goals are loaded
   * in a paused state. Set to `false` for purely in-memory behavior (this
   * also disables the lifecycle ledger).
   * @default true
   */
  persistState?: boolean

  /**
   * Root filesystem path for persisted session-shard state when
   * `persistState` is enabled. Each session is written below
   * `<stateFilePath>.sessions/<sha256(sessionID)>/state.json`. Overrides both
   * the project-local default and the `OPENCODE_GOAL_STATE_PATH` environment
   * variable.
   * @default "<cwd>/.opencode/goals/state.json"
   */
  stateFilePath?: string

  /**
   * Legacy aggregate filesystem path for the append-only lifecycle ledger.
   * During migration, events are partitioned into per-session shard ledgers;
   * new writes use `<shard>/state.json.ledger.jsonl`.
   * @default "<stateFilePath>.ledger.jsonl"
   */
  ledgerFilePath?: string

  /** Maximum bytes in one lifecycle-ledger generation. @default 2097152 */
  ledgerMaxBytes?: number

  /** Number of rotated lifecycle-ledger generations to retain (0-10). @default 3 */
  ledgerRetentionFiles?: number

  /**
   * How long, in milliseconds, a completed goal's summary remains
   * available through `/goal status` after the goal leaves active memory.
   * @default 604800000
   */
  resultRetentionMs?: number

  /**
   * Maximum number of completed-goal summaries retained in process memory
   * before the oldest ones are evicted.
   * @default 200
   */
  maxStoredResults?: number

  /**
   * The slash command the plugin owns. Set to e.g. `"objective"` to drive
   * the workflow with `/objective` instead of `/goal`; a leading slash is
   * tolerated and stripped. Remember to register the matching command
   * name in your OpenCode `command` config.
   * @default "goal"
   */
  commandName?: string

  /**
   * Whether the plugin installs its `command.execute.before` hook at all.
   * Set to `false` if you only want the auto-continue/persistence
   * behavior driven programmatically (e.g. via {@link registerTools})
   * and don't want the plugin to own a slash command.
   * @default true
   */
  registerCommand?: boolean

  /**
   * Whether the plugin registers the agent-facing goal tools
   * (canonical `goal_status`, `goal_set`, `goal_pause`, `goal_resume`,
   * `goal_block`, `goal_complete`, the plan tools `goal_plan_get`,
   * `goal_plan_set`, `goal_action_update`, plus legacy `get_goal`,
   * `get_goal_history`, `set_goal`, `update_goal`, `clear_goal`).
   * Canonical tools return versioned JSON envelopes. The tools are registered
   * by default from dependencies included with this package; set this to
   * `false` to omit the tool surface.
   * @default true
   */
  registerTools?: boolean

  /** Register collision-safe native `goal` and `goal-verify` agents through OpenCode's config hook. */
  registerAgents?: boolean

  /**
   * Mirror live goal status into the OpenCode sidebar. The plugin writes the
   * session title, which the TUI's sidebar renders
   * (e.g. `▶ ship the release · 2/4 · 3/∞ · 2m/8h · 147k/100m · 3/7✓`), plus a
   * structured {@link GoalSidebarStatus} payload under the session's
   * `metadata.goal`. Both go through `PATCH /session/{id}`.
   *
   * The session's original title is captured before the first overwrite and
   * restored by `/goal clear`, which also clears `metadata.goal`. Sidebar
   * updates are cosmetic and idempotent: an unchanged render costs no request,
   * and a failure is logged at debug level without interrupting the goal loop.
   * Set `false`, or set `OPENCODE_GOAL_SIDEBAR=0` in the environment, to
   * disable.
   * @default true
   */
  sidebarStatus?: boolean

  /**
   * Pre-0.10.0 spelling of {@link sidebarStatus}. Still honored when
   * `sidebarStatus` is unset.
   * @deprecated Use {@link sidebarStatus}.
   */
  sessionTitleStatus?: boolean

  /**
   * Agent names treated as planning-only. A goal created while one of these
   * agents is active is recorded but held paused instead of starting, and
   * auto-continue stays suppressed while one is active. Matching is
   * case-insensitive. Pass `[]` to release the restriction entirely.
   * @default ["plan"]
   */
  restrictedAgents?: string[]

  /**
   * Opt out of the planning-only restriction, allowing goals to be created and
   * auto-continued while a {@link restrictedAgents} agent is active.
   * @default false
   */
  allowGoalExecutionFromPlan?: boolean

  /** Name of the native primary goal agent. @default "goal" */
  goalAgentName?: string

  /** Name of the native read-only verifier subagent. @default "goal-verify" */
  verifierAgentName?: string

  /**
   * Enables the built-in child-session completion auditor: before a
   * `[goal:complete]` is archived, the plugin spawns an independent
   * OpenCode session to verify the completion against the goal and
   * workspace. Ignored if {@link auditor} is also set (the custom
   * auditor takes precedence). Tune the built-in auditor with
   * {@link auditorOptions}.
   * @default false
   */
  completionAudit?: boolean

  /**
   * Supply a custom completion auditor instead of the built-in
   * child-session one. Takes precedence over `completionAudit: true`.
   * A verdict of `{ approved: false }` pauses the goal (stop reason
   * `"audit rejected"`) instead of archiving it. A thrown error is
   * treated as a rejection (fail closed).
   */
  auditor?: (context: CompletionAuditContext) => Promise<CompletionAuditVerdict>

  /**
   * Tuning options for the built-in child-session auditor. Ignored when
   * a custom {@link auditor} is supplied.
   */
  auditorOptions?: CompletionAuditorOptions

  /**
   * Whether the plugin announces applied goal-state transitions such as
   * creation, pause/resume, recovery, promotion, and clearing. Routine
   * idle/checkpoint activity is not announced. Completion/block uses the
   * audit-result channel when enabled and this lifecycle channel only as its
   * disabled fallback.
   * @default true
   */
  lifecycleMessages?: boolean

  /**
   * Custom sink for bounded lifecycle notices. Defaults to routing through
   * OpenCode's structured log (`client.app.log`) and TUI toast when those host
   * APIs are available. Delivery is advisory and does not make model calls.
   */
  lifecycleMessenger?: (sessionID: string, text: string) => Promise<void> | void

  /**
   * Whether the plugin announces completion/blocked audits (an
   * audit-start and an audit-result message) instead of running silently.
   * @default true
   */
  auditMessages?: boolean

  /**
   * Custom sink for audit announcements. Defaults to routing through
   * OpenCode's structured log (`client.app.log`) and TUI toast when those
   * host APIs are available. Provide this to route audit messages elsewhere.
   */
  auditMessenger?: (sessionID: string, text: string) => Promise<void> | void
}

/**
 * OpenCode plugin hook map returned by the plugin's `server` factory.
 * Matches OpenCode's plugin hook contract; kept loose (`unknown`
 * input/output) since hook payload shapes are defined by OpenCode itself,
 * not by this package.
 */
export interface GoalPluginHooks {
  /** Registers collision-safe native goal and verifier agents. */
  config: (config: unknown) => Promise<void>
  /** Remembers the initiating agent, model, and variant for later continuation turns. */
  "chat.params": (input: unknown) => Promise<void>
  /** Distinguishes real user input from plugin-generated command and continuation messages. */
  "chat.message": (input: unknown, output: unknown) => Promise<void>
  /**
   * Handles the configured OpenCode custom command by replacing its retained
   * prompt parts in place. OpenCode still submits those parts as a model turn
   * rather than rendering the hook result directly; handled control results
   * include a self-contained reporting frame. Omitted entirely when
   * {@link GoalPluginOptions.registerCommand} is `false`.
   */
  "command.execute.before"?: (input: unknown, output: unknown) => Promise<void>
  /** Blocks tool execution while an already-handled control-command result is being reported. */
  "tool.execute.before": (input: unknown, output: unknown) => Promise<void>
  event: (input: unknown) => Promise<void>
  "experimental.chat.system.transform": (input: unknown, output: unknown) => Promise<void>
  "experimental.compaction.autocontinue": (input: unknown, output: unknown) => Promise<void>
  "experimental.session.compacting": (input: unknown, output: unknown) => Promise<void>
  /**
   * Agent-facing tool definitions, present only when
   * {@link GoalPluginOptions.registerTools} is enabled (default).
   */
  tool?: Record<string, unknown>
  /** Cancels pending continuation work and releases this plugin instance. */
  dispose: () => Promise<void>
}

/**
 * The plugin's `server` factory. OpenCode calls this with a client bound
 * to the running session and the resolved plugin options from
 * `opencode.json`.
 */
export function GoalPlugin(
  context: {
    client: unknown
    /** OpenCode's resolved project directory for this plugin instance. */
    directory?: string
    /** OpenCode's resolved worktree directory for this plugin instance. */
    worktree?: string
  },
  options?: GoalPluginOptions,
): Promise<GoalPluginHooks>

/** Internal diagnostic/test helpers. Not covered by semantic-version compatibility guarantees. */
export const testInternals: Readonly<Record<string, unknown>>

/**
 * Default export consumed by OpenCode's plugin loader. An install spec names the
 * PACKAGE (`opencode-goal-pro-max-complete-plugin@<source>` in `opencode.json`);
 * OpenCode resolves that package's entrypoint and calls `server` to obtain the
 * plugin's hooks. `id` below is the plugin's WIRE identifier and is deliberately
 * held at the historical `"opencode-goal-plugin"` so a session, its persisted
 * state and its part metadata survive the package rename — see the "Identifier
 * policy" section of `docs/reference.md` and the "WIRE IDENTIFIER, NOT THE PACKAGE NAME"
 * comment in `src/goal-plugin.js`.
 */
declare const goalPlugin: {
  id: "opencode-goal-plugin"
  server: typeof GoalPlugin
}

export default goalPlugin
