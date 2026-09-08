import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repository = new URL("..", import.meta.url)
const repositoryPath = fileURLToPath(repository)
// The published package name comes from the manifest, never a literal: a
// rename that missed this line would leave the contract probing a name
// nothing publishes, and the failure would look like a broken host.
const { name: packageName } = JSON.parse(
  await readFile(new URL("package.json", repository), "utf8"),
)
const root = await mkdtemp(join(tmpdir(), `${packageName}-types-`))
const packDirectory = join(root, "pack")
const consumerDirectory = join(root, "consumer")
const cacheDirectory = join(root, "npm-cache")
const npmEnvironment = { ...process.env, npm_config_cache: cacheDirectory }
const tsc = join(repositoryPath, "node_modules", "typescript", "bin", "tsc")

function execNpm(args, options) {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options)
  }
  if (process.platform === "win32") {
    return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], options)
  }
  return execFileSync("npm", args, options)
}

const fixture = `
import goalPlugin, {
  GoalPlugin,
  type CompletionAuditContext,
  type GoalPluginHooks,
  type GoalPluginOptions,
  type GoalSidebarStatus,
} from "${packageName}"
import serverPlugin from "${packageName}/server"
import tuiPlugin, {
  createGoalSidebar,
  formatPanelTokens,
  goalPanelModel,
  tui,
  type GoalPanelModel,
  type GoalSidebarRuntime,
  type GoalTuiPlugin,
} from "${packageName}/tui"

const options = {
  sdkShape: "flat",
  maxTurns: 12,
  maxDurationMs: 60_000,
  maxTokens: 50_000,
  minDelayMs: 10,
  maxRecentMessages: 30,
  noProgressTokenThreshold: 25,
  noProgressTurnsBeforePause: 3,
  noToolCallTurnsBeforePause: 0,
  budgetWrapupRatio: 0.75,
  warnTurnsRemaining: 2,
  warnDurationMsRemaining: 10_000,
  warnTokensRemaining: 5_000,
  maxPromptFailures: 2,
  persistState: false,
  stateFilePath: "/tmp/goals.json",
  ledgerFilePath: "/tmp/goals.ledger.jsonl",
  ledgerMaxBytes: 1_000_000,
  ledgerRetentionFiles: 2,
  resultRetentionMs: 10_000,
  maxStoredResults: 20,
  commandName: "objective",
  registerCommand: true,
  registerTools: true,
  registerAgents: true,
  mirrorTodos: "plan",
  goalAgentName: "objective",
  verifierAgentName: "objective-check",
  completionAudit: true,
  auditorOptions: { timeoutMs: 5_000, failurePolicy: "reject" },
  auditMessages: true,
  auditMessenger: (_sessionID, _text) => {},
  lifecycleMessages: true,
  lifecycleMessenger: (_sessionID, _text) => {},
  auditor: async ({ goal, sessionID, latestText }: CompletionAuditContext) => {
    const mode: "normal" | "ordered" = goal.mode
    return {
      approved: goal.sessionID === sessionID && latestText.length > 0,
      reason: goal.lastCheckpoint?.summary || mode,
    }
  },
} satisfies GoalPluginOptions

// @ts-expect-error lifecycleMessages must be boolean
const invalidLifecycleMessages: GoalPluginOptions = { lifecycleMessages: "yes" }
void invalidLifecycleMessages

// @ts-expect-error mirrorTodos must be "plan" or "off"
const invalidMirrorTodos: GoalPluginOptions = { mirrorTodos: "auto" }
void invalidMirrorTodos

const hooks: GoalPluginHooks = await GoalPlugin({ client: {}, directory: "/tmp" }, options)
hooks.config({})
hooks.event({})
hooks["chat.params"]({})
hooks["chat.message"]({}, {})
hooks["experimental.chat.system.transform"]({}, {})
hooks["tool.execute.before"]({}, {})
hooks["tool.execute.after"]({}, {})
hooks["tool.definition"]({}, {})
hooks["experimental.compaction.autocontinue"]({}, {})
hooks["experimental.session.compacting"]({}, {})
await hooks.dispose()

declare const status: GoalSidebarStatus
const mirrorState: "fresh" | "stale" | "off" = status.plan.mirror.state
const mirrorRows: number = status.plan.mirror.rows
void mirrorState
void mirrorRows

const sameServer: typeof GoalPlugin = goalPlugin.server
const sameExport: typeof goalPlugin = serverPlugin
void sameServer
void sameExport

// The ./tui target is a separate plugin module: it carries tui() and, per
// readV1Plugin, must NOT also carry server().
const sidebarRuntime: GoalSidebarRuntime = {
  createMemo: (fn) => fn,
  For: () => {},
  Show: () => {},
  jsx: (type, props) => ({ type, props }),
}
const sidebar = createGoalSidebar(sidebarRuntime)
const sameTui: GoalTuiPlugin = sidebar.tui
const entryTui: GoalTuiPlugin = tuiPlugin.tui
const exportedTui: GoalTuiPlugin = tui
const panel: GoalPanelModel | null = goalPanelModel({ objective: "ship it" })
const panelWithLiveCount: GoalPanelModel | null = goalPanelModel({ objective: "ship it" }, { liveTodoCount: 3 })
const marks: string[] = (panel?.actions ?? []).map((action) => action.mark)
const budget: string = formatPanelTokens(1234)
// The panel forwards the payload's plan.mirror.state verbatim, so the model can
// carry a state this release has never heard of. A consumer must be able to put
// an arbitrary string back into that field; a two-literal union here rejects this
// line and lies about what the panel can hand out.
declare const someServerMirrorState: string
const forwardedMirrorState: NonNullable<GoalPanelModel["mirror"]>["state"] = someServerMirrorState
void sameTui
void entryTui
void exportedTui
void marks
void budget
void panelWithLiveCount
void forwardedMirrorState

// @ts-expect-error the tui target must not also export server()
tuiPlugin.server
// @ts-expect-error the panel model is nullable when there is no goal
const nonNullPanel: GoalPanelModel = goalPanelModel(null)
void nonNullPanel

// @ts-expect-error unknown hooks must not be hidden by an index signature
hooks["experimental.missing.hook"]
// @ts-expect-error invalid SDK shapes must be rejected by consumers
const invalid: GoalPluginOptions = { sdkShape: "automatic" }
void invalid
`

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(consumerDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
  ])
  await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }))
  await writeFile(join(consumerDirectory, "contract.ts"), fixture)

  // `npm pack --json` can print lifecycle or notice output ahead of the JSON
  // (it printed the Bun build's "Bundled N modules …" until the `prepack` build
  // was removed in 0.10.1), so the whole stream is not necessarily valid JSON.
  // Parse from the first `[` instead of the first byte.
  const packOutput = execNpm(
    ["pack", "--json", "--pack-destination", packDirectory],
    { cwd: repository, encoding: "utf8", env: npmEnvironment },
  )
  const jsonStart = packOutput.indexOf("[")
  assert.notEqual(jsonStart, -1, `npm pack --json produced no JSON array:\n${packOutput}`)
  const packResult = JSON.parse(packOutput.slice(jsonStart))
  assert.equal(packResult.length, 1)
  const tarball = join(packDirectory, packResult[0].filename)
  execNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--cache", cacheDirectory, tarball],
    { cwd: consumerDirectory, stdio: "pipe", env: npmEnvironment },
  )

  const common = ["--strict", "--noEmit", "--target", "ES2022", "--skipLibCheck", "false", "contract.ts"]
  execFileSync(process.execPath, [tsc, "--module", "NodeNext", "--moduleResolution", "NodeNext", ...common], {
    cwd: consumerDirectory,
    stdio: "pipe",
  })
  execFileSync(process.execPath, [tsc, "--module", "ESNext", "--moduleResolution", "Bundler", ...common], {
    cwd: consumerDirectory,
    stdio: "pipe",
  })
  console.log(`type contract passed (NodeNext + Bundler; ${packResult[0].filename})`)
} finally {
  await rm(root, { recursive: true, force: true })
}
