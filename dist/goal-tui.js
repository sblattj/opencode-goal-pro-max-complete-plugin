// src/goal-tui.js
import { createMemo, For, Show } from "solid-js";
import { jsx } from "@opentui/solid/jsx-runtime";

// src/goal-format.js
var UNLIMITED_MARK = "∞";
function isUnlimitedTurnBudget(max) {
  const parsed = Number(max);
  return !(Number.isFinite(parsed) && parsed > 0);
}
function formatTurnLimit(max) {
  return isUnlimitedTurnBudget(max) ? UNLIMITED_MARK : String(Math.floor(Number(max)));
}
function formatTurnBudget(used, max) {
  const parsed = Number(used);
  const count = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  return `${count}/${formatTurnLimit(max)}`;
}
function formatBudgetMinutes(minutes) {
  const parsed = Number(minutes);
  const whole = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  if (whole < 60)
    return `${whole}m`;
  const hours = Math.floor(whole * 10 / 60) / 10;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}
function formatBudgetDuration(ms) {
  const parsed = Number(ms);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  if (value < 60000)
    return `${Math.floor(value / 1000)}s`;
  return formatBudgetMinutes(value / 60000);
}

// src/goal-sidebar-view.js
var GOAL_PANEL_TITLE = "Goal";
var GOAL_PANEL_PAYLOAD_VERSION = 2;
var STATE_ICONS = {
  active: "▶",
  paused: "⏸",
  blocked: "⛔",
  completed: "✓"
};
var ACTION_MARKS = {
  pending: "○",
  in_progress: "◐",
  done: "●",
  blocked: "⛔"
};
var MAX_PANEL_ACTIONS = 12;
var MAX_LINE_LENGTH = 160;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedText(value, limit = MAX_LINE_LENGTH) {
  if (typeof value !== "string")
    return "";
  const trimmed = value.trim();
  if (!trimmed)
    return "";
  if (trimmed.length <= limit)
    return trimmed;
  return `${trimmed.slice(0, Math.max(1, limit - 1))}…`;
}
function wholeNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return 0;
  return Math.floor(value);
}
function budget(raw) {
  if (!isRecord(raw))
    return null;
  const max = wholeNumber(raw.max);
  if (!max)
    return null;
  return { used: wholeNumber(raw.used), max };
}
function turnsBudget(raw) {
  if (!isRecord(raw))
    return null;
  const used = wholeNumber(raw.used);
  if (raw.unlimited === true || isUnlimitedTurnBudget(raw.max)) {
    return { used, max: null, unlimited: true };
  }
  const max = wholeNumber(raw.max);
  if (!max)
    return { used, max: null, unlimited: true };
  return { used, max, unlimited: false };
}
function formatPanelTokens(value) {
  const count = wholeNumber(value);
  if (count < 1000)
    return String(count);
  if (count < 1e6) {
    const thousands = count / 1000;
    return `${thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
  }
  const millions = count / 1e6;
  return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}m`;
}
function normalizeAction(raw) {
  if (!isRecord(raw))
    return null;
  const title = boundedText(raw.title, 80);
  if (!title)
    return null;
  const status = ACTION_MARKS[raw.status] ? raw.status : "pending";
  const verdict = raw.verdict === "pass" || raw.verdict === "fail" ? raw.verdict : null;
  return {
    id: boundedText(raw.id, 32) || title,
    title,
    status,
    verdict,
    mark: ACTION_MARKS[status],
    verified: status === "done" && verdict === "pass"
  };
}
function goalPanelModel(raw) {
  if (!isRecord(raw))
    return null;
  const objective = boundedText(raw.objective, 120);
  if (!objective)
    return null;
  const state = STATE_ICONS[raw.state] ? raw.state : "active";
  const turns = turnsBudget(raw.turns);
  const durationMs = budget(raw.durationMs);
  const minutes = budget(raw.minutes);
  const tokens = budget(raw.tokens);
  const context = budget(raw.context);
  const stats = [];
  if (turns)
    stats.push(`${formatTurnBudget(turns.used, turns.max)} turns`);
  if (durationMs) {
    stats.push(`${formatBudgetDuration(durationMs.used)}/${formatBudgetDuration(durationMs.max)}`);
  } else if (minutes) {
    stats.push(`${formatBudgetMinutes(minutes.used)}/${formatBudgetMinutes(minutes.max)}`);
  }
  if (tokens)
    stats.push(`${formatPanelTokens(tokens.used)}/${formatPanelTokens(tokens.max)} tokens`);
  if (context)
    stats.push(`${formatPanelTokens(context.used)}/${formatPanelTokens(context.max)} ctx`);
  const sequence = isRecord(raw.sequence) && wholeNumber(raw.sequence.total) > 0 ? `step ${wholeNumber(raw.sequence.position)}/${wholeNumber(raw.sequence.total)}` : "";
  const plan = isRecord(raw.plan) ? raw.plan : {};
  const planTotal = wholeNumber(plan.total);
  const actions = (Array.isArray(plan.actions) ? plan.actions : []).map(normalizeAction).filter(Boolean).slice(0, MAX_PANEL_ACTIONS);
  const hiddenActions = Math.max(0, planTotal - actions.length);
  const progress = planTotal ? `${wholeNumber(plan.verified)}/${planTotal} actions verified${wholeNumber(plan.blocked) ? `, ${wholeNumber(plan.blocked)} blocked` : ""}` : "";
  const notes = [];
  const blockedReason = boundedText(raw.blockedReason);
  const stopReason = boundedText(raw.stopReason);
  if (blockedReason)
    notes.push({ label: "Blocked", text: blockedReason, tone: "error" });
  else if (stopReason)
    notes.push({ label: "Stopped", text: stopReason, tone: "warning" });
  const successCriteria = boundedText(raw.successCriteria);
  if (successCriteria)
    notes.push({ label: "Success", text: successCriteria, tone: "muted" });
  const constraints = boundedText(raw.constraints);
  if (constraints)
    notes.push({ label: "Constraints", text: constraints, tone: "muted" });
  return {
    state,
    icon: STATE_ICONS[state],
    objective,
    stats,
    sequence,
    progress,
    actions,
    hiddenActions,
    notes
  };
}
function stateColor(theme, state) {
  if (state === "blocked")
    return theme.error;
  if (state === "completed")
    return theme.success;
  if (state === "paused")
    return theme.warning;
  return theme.text;
}
function noteColor(theme, tone) {
  if (tone === "error")
    return theme.error;
  if (tone === "warning")
    return theme.warning;
  return theme.textMuted;
}
function actionColor(theme, action) {
  if (action.status === "blocked" || action.verdict === "fail")
    return theme.error;
  if (action.verified)
    return theme.success;
  if (action.status === "in_progress")
    return theme.text;
  return theme.textMuted;
}
function actionLine(action) {
  const verdict = action.verdict ? ` [${action.verdict}]` : "";
  return `${action.mark} ${action.title}${verdict}`;
}
function createGoalSidebar(runtime) {
  const { createMemo, Show, For, jsx } = runtime;
  function readGoalPayload(api, sessionID) {
    if (!sessionID)
      return null;
    const session = api?.state?.session?.get?.(sessionID);
    if (!isRecord(session))
      return null;
    const metadata = session.metadata;
    return isRecord(metadata) ? metadata.goal : null;
  }
  function line(color, children) {
    return jsx("text", {
      get fg() {
        return color();
      },
      get children() {
        return children();
      }
    });
  }
  function GoalPanel(props) {
    const theme = () => props.api.theme.current;
    const model = createMemo(() => goalPanelModel(readGoalPayload(props.api, props.session_id)));
    const read = (pick, fallback = "") => () => {
      const current = model();
      return current ? pick(current) : fallback;
    };
    return jsx(Show, {
      get when() {
        return model() !== null;
      },
      get children() {
        return jsx("box", {
          get children() {
            return [
              line(() => theme().text, () => jsx("b", { children: GOAL_PANEL_TITLE })),
              line(() => stateColor(theme(), read((m) => m.state, "active")()), read((m) => `${m.icon} ${m.objective}`)),
              jsx(Show, {
                get when() {
                  return read((m) => m.stats.length > 0, false)();
                },
                get children() {
                  return line(() => theme().textMuted, read((m) => m.stats.join(" · ")));
                }
              }),
              jsx(Show, {
                get when() {
                  return read((m) => Boolean(m.sequence), false)();
                },
                get children() {
                  return line(() => theme().textMuted, read((m) => m.sequence));
                }
              }),
              jsx(Show, {
                get when() {
                  return read((m) => Boolean(m.progress), false)();
                },
                get children() {
                  return line(() => theme().textMuted, read((m) => m.progress));
                }
              }),
              jsx(For, {
                get each() {
                  return read((m) => m.actions, [])();
                },
                children: (action) => line(() => actionColor(theme(), action), () => actionLine(action))
              }),
              jsx(Show, {
                get when() {
                  return read((m) => m.hiddenActions > 0, false)();
                },
                get children() {
                  return line(() => theme().textMuted, read((m) => `+${m.hiddenActions} more`));
                }
              }),
              jsx(For, {
                get each() {
                  return read((m) => m.notes, [])();
                },
                children: (note) => line(() => noteColor(theme(), note.tone), () => `${note.label}: ${note.text}`)
              })
            ];
          }
        });
      }
    });
  }
  async function logRegistration(api) {
    const log = api?.client?.app?.log;
    if (typeof log !== "function")
      return;
    const body = {
      service: "opencode-goal-plugin",
      level: "debug",
      message: "Registered the goal sidebar_content panel"
    };
    try {
      await log({ body });
    } catch {
      try {
        await log(body);
      } catch {}
    }
  }
  const tui = async (api) => {
    api.slots.register({
      order: 450,
      slots: {
        sidebar_content(_context, props) {
          return jsx(GoalPanel, { api, session_id: props.session_id });
        }
      }
    });
    await logRegistration(api);
  };
  return { GoalPanel, tui };
}

// src/goal-tui.js
var { tui } = createGoalSidebar({ createMemo, For, Show, jsx });
var goal_tui_default = {
  id: "opencode-goal-plugin",
  tui
};
export {
  tui,
  goalPanelModel,
  formatPanelTokens,
  goal_tui_default as default,
  createGoalSidebar,
  GOAL_PANEL_TITLE,
  GOAL_PANEL_PAYLOAD_VERSION
};
