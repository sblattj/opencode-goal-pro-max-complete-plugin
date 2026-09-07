// TUI half of opencode-goal-pro-max-complete-plugin: the sidebar goal panel.
//
// Loaded by OpenCode as the package's `./tui` target
// (packages/opencode/src/plugin/shared.ts:103-107 resolves
// `exports["./tui"]`; packages/opencode/src/plugin/tui/runtime.ts:676-685
// loads it with kind "tui"). A module may export `server()` or `tui()`, never
// both (shared.ts:293-294), which is why this is a separate file from
// src/goal-plugin.js — the two ship in one package.
//
// It is reached only through a `tui.json` `plugin` entry, NOT through
// `opencode.json`'s (packages/opencode/src/config/tui.ts:157-168 and :183-210;
// packages/opencode/src/plugin/tui/runtime.ts:1088). See the mechanism note in
// ./goal-sidebar-view.js.
//
// `solid-js` and `@opentui/solid/jsx-runtime` are provided by the host at
// runtime and must stay external in the bundle; see the mechanism note in
// ./goal-sidebar-view.js, which holds all of the logic so it can be tested
// without a terminal.
import { createMemo, For, Show } from "solid-js"
import { jsx } from "@opentui/solid/jsx-runtime"
import { createGoalSidebar } from "./goal-sidebar-view.js"

const { tui } = createGoalSidebar({ createMemo, For, Show, jsx })

export { tui }
// Re-exported so the panel's pure model is usable (and typed) without a
// terminal — the same functions the unit tests drive directly from source.
export {
  createGoalSidebar,
  formatPanelTokens,
  goalPanelModel,
  GOAL_PANEL_PAYLOAD_VERSION,
  GOAL_PANEL_TITLE,
} from "./goal-sidebar-view.js"

export default {
  id: "opencode-goal-plugin",
  tui,
}
