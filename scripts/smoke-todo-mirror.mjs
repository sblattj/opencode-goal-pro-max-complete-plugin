// Real-host smoke for the Todo mirror (design 5.4, script 1).
//
// This is the run the in-tree suite cannot do: the production plugin loader,
// the AI SDK's SSE decode, the host's own `todowrite` implementation, the
// permission check and the real SQLite write. Nothing here is faked except the
// model, which is a mock OpenAI-compatible endpoint on localhost.
//
// Requires the `opencode` binary on PATH and a bundled `dist/` (`npm run bundle`)
// — the installer copies `dist/`, so a stale bundle smokes the OLD code. It is
// deliberately NOT part of `release:check`: the binary is not a dev dependency.
//
// Usage: npm run smoke:todo-mirror
//
// Arms:
//   A  mirrorTodos default ("plan")   -> the plan is redrawn over a divergent list
//   B  CONTROL 1, mirrorTodos "off"   -> the same run returns what the model sent
//   C  CONTROL 2, no goal (in arm A)  -> the same list comes back untouched
// Plus the persistence observable: SQLite row order, and survival across a
// restart of the serve process.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { promisify } from "node:util"

import {
  MOCK_MODEL_ID,
  MOCK_MODEL_REF,
  MOCK_PROVIDER_ID,
  MOCK_TODOS_MODEL_ID,
  MOCK_TODOS_MODEL_REF,
  bootHost,
  findDatabase,
  promptSession,
  readHostLog,
  routeByModel,
  runGoalCommand,
  scriptedResponder,
  waitForTodos,
} from "./lib/todo-smoke-host.mjs"

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scratch = process.env.SMOKE_TODO_MIRROR_DIR || path.join(process.env.TMPDIR || "/tmp", "opencode-goal-todo-mirror-smoke")

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

const ID_SEPARATOR = " · "
const EVIDENCE_SUFFIX = " — needs claim/evidence/verdict"

// a2 is recorded `done` with no claim, no evidence and no verdict: the
// unsubstantiated completion the mirror must refuse to render as finished.
const PLAN_ACTIONS = [
  { id: "a1", title: "Read the mirror contract" },
  { id: "a2", title: "Prove the divergent list is redrawn", status: "done" },
  { id: "a3", title: "Record the verdict" },
]

const MODEL_ROWS = [
  { content: "Sketch the mock provider", status: "in_progress", priority: "high" },
  { content: "Wire the SSE decode", status: "pending", priority: "medium" },
]

// The divergent list: the model laundering a2 to `completed`, plus two rows of
// its own wording that have nothing to do with the plan.
const LAUNDERED_ROW = {
  content: `a2${ID_SEPARATOR}Prove the divergent list is redrawn`,
  status: "completed",
  priority: "high",
}
const DIVERGENT_TODOS = [LAUNDERED_ROW, ...MODEL_ROWS]

const GOAL_ARGUMENTS = "prove the todo mirror end to end --max-turns 3"

function goalScript() {
  return scriptedResponder({
    steps: [
      { tool: "goal_plan_set", args: { actions: PLAN_ACTIONS } },
      { tool: "todowrite", args: { todos: DIVERGENT_TODOS } },
    ],
    finalText: "Plan recorded; the todo list has been refreshed.",
  })
}

function todosOnlyScript() {
  return scriptedResponder({
    steps: [{ tool: "todowrite", args: { todos: DIVERGENT_TODOS } }],
    finalText: "Todo list written.",
  })
}

function mockRoutes() {
  return routeByModel({
    [MOCK_MODEL_ID]: goalScript(),
    [MOCK_TODOS_MODEL_ID]: todosOnlyScript(),
  })
}

// ---------------------------------------------------------------------------
// Result recorder — one PASS/FAIL line per observable, non-zero exit on any FAIL
// ---------------------------------------------------------------------------

const results = []

function check(label, body) {
  try {
    body()
    results.push({ label, ok: true })
    console.log(`PASS  ${label}`)
  } catch (error) {
    results.push({ label, ok: false, error })
    console.log(`FAIL  ${label}: ${error.message}`)
  }
}

function observe(label, detail) {
  console.log(`OBSERVED  ${label}: ${detail}`)
}

function contents(rows) {
  return rows.map((row) => row.content)
}

// ---------------------------------------------------------------------------
// Arm A — mirrorTodos default ("plan")
// ---------------------------------------------------------------------------

async function mirrorArm() {
  const host = await bootHost({
    repoRoot,
    root: path.join(scratch, "plan"),
    respond: mockRoutes(),
    logPath: path.join(scratch, "plan-serve.log"),
  })
  try {
    check("the production loader registered the plugin's tools", () => {
      assert.ok(host.toolIDs.includes("goal_plan_set"), "goal_plan_set missing from /experimental/tool/ids")
      assert.ok(host.toolIDs.includes("todowrite"), "todowrite missing from /experimental/tool/ids")
    })

    // --- the mirroring session -------------------------------------------
    const session = await host.api.post("/session", { body: { title: "todo mirror smoke" } })
    await runGoalCommand(host.api, session.id, GOAL_ARGUMENTS, {
      model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
    })
    // The host runs the whole tool loop inside the command's turn, so the two
    // scripted calls have usually landed already. Prompt only if they have not:
    // an unnecessary prompt pauses the goal as "user intervention".
    let rows = await waitForTodos(host.api, session.id, (list) => list.length >= 5, { timeoutMs: 15_000 })
    if (rows.length < 5) {
      await promptSession(host.api, session.id, "continue", { model: MOCK_MODEL_REF })
      rows = await waitForTodos(host.api, session.id, (list) => list.length >= 5, { timeoutMs: 15_000 })
    }

    check("the first three rows carry the plan's action ids", () => {
      assert.ok(rows.length >= 3, `expected at least 3 rows, saw ${rows.length}: ${JSON.stringify(contents(rows))}`)
      for (const [index, action] of PLAN_ACTIONS.entries()) {
        assert.ok(
          rows[index].content.startsWith(`${action.id}${ID_SEPARATOR}`),
          `row ${index} is ${JSON.stringify(rows[index].content)}, expected it to start with ${action.id}${ID_SEPARATOR}`,
        )
      }
    })

    check("the falsely-completed action comes back in_progress with the evidence suffix", () => {
      const a2 = rows[1]
      assert.equal(a2.status, "in_progress", `a2 status is ${a2.status}`)
      assert.ok(a2.content.endsWith(EVIDENCE_SUFFIX), `a2 content is ${JSON.stringify(a2.content)}`)
      assert.notEqual(
        a2.status,
        LAUNDERED_ROW.status,
        "a2 came back exactly as the model wrote it — the mirror did not run",
      )
    })

    check("the model's own rows survive, unprefixed, below the plan", () => {
      const extras = rows.slice(PLAN_ACTIONS.length)
      assert.deepEqual(contents(extras), contents(MODEL_ROWS))
      for (const row of extras) {
        assert.ok(!/^a\d+ · /.test(row.content), `extra row was given a plan prefix: ${row.content}`)
      }
    })

    const info = await host.api.get(`/session/${session.id}`)
    const mirror = info?.metadata?.goal?.plan?.mirror
    check("the sidebar payload reports a fresh mirror", () => {
      assert.ok(mirror, `no plan.mirror in the payload: ${JSON.stringify(info?.metadata?.goal?.plan)}`)
      assert.equal(mirror.state, "fresh")
      assert.equal(mirror.rows, rows.length)
      assert.equal(mirror.extra, MODEL_ROWS.length)
    })

    // --- CONTROL 2: the same divergent list in a session with NO goal ------
    const bare = await host.api.post("/session", { body: { title: "no goal" } })
    await promptSession(host.api, bare.id, "write the todo list", { model: MOCK_TODOS_MODEL_REF })
    const bareRows = await waitForTodos(host.api, bare.id, (list) => list.length > 0, { timeoutMs: 30_000 })
    check("CONTROL 2 — with no goal the same list comes back untouched", () => {
      assert.deepEqual(
        bareRows.map((row) => ({ content: row.content, status: row.status, priority: row.priority })),
        DIVERGENT_TODOS,
      )
    })

    // --- the persistence observable --------------------------------------
    const database = findDatabase(host.iso)
    let dbRows = []
    if (!database) {
      check("SQLite holds the mirrored rows in plan order", () => {
        assert.fail(`no opencode.db under ${host.iso.data}`)
      })
    } else {
      const { stdout } = await execFileAsync("sqlite3", [
        database,
        `select position,content,status from todo where session_id = '${session.id}' order by position`,
      ])
      dbRows = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [position, content, status] = line.split("|")
          return { position: Number(position), content, status }
        })
      check("SQLite holds the mirrored rows in plan order", () => {
        assert.deepEqual(
          dbRows.map((row) => row.position),
          rows.map((_, index) => index),
        )
        assert.deepEqual(
          dbRows.map((row) => row.content),
          contents(rows),
        )
        // Asserted against the PLAN, not against whatever the API returned:
        // comparing the table to the route alone would still pass with the
        // mirror off, and the claim here is that `position` carries plan order.
        for (const [index, action] of PLAN_ACTIONS.entries()) {
          assert.equal(dbRows[index]?.position, index)
          assert.ok(
            dbRows[index]?.content.startsWith(`${action.id}${ID_SEPARATOR}`),
            `todo row at position ${index} is ${JSON.stringify(dbRows[index]?.content)}`,
          )
        }
      })
    }

    // --- F17: which todowrite implementation executed ---------------------
    const definitions = await host.api.get("/experimental/tool", {
      query: { provider: MOCK_PROVIDER_ID, model: MOCK_MODEL_ID },
    })
    const todowrite = (Array.isArray(definitions) ? definitions : []).find((entry) => entry.id === "todowrite")
    observe(
      "todowrite implementation",
      todowrite
        ? `host builtin, decorated by the plugin (description ${todowrite.description.length} chars, GOAL PLUGIN paragraph ${
            todowrite.description.includes("GOAL PLUGIN:") ? "present" : "ABSENT"
          }); the plugin registers ${host.toolIDs.filter((id) => id.startsWith("goal_") || id.endsWith("_goal")).length} goal_* tools and no todowrite of its own`
        : "not reported by /experimental/tool",
    )
    observe(
      "todowrite registration path",
      "no plugin registers a todowrite tool, so the implementation that executed is the host builtin " +
        "(packages/opencode/src/tool/todo.ts:15, `TodoWriteTool`); the plugin reaches it only through " +
        "tool.execute.before / tool.execute.after / tool.definition, and the rows landed in the host's own `todo` table",
    )

    // --- restart survival --------------------------------------------------
    const restarted = await host.restart()
    try {
      const afterRestart = await waitForTodos(restarted.api, session.id, (list) => list.length > 0, {
        timeoutMs: 30_000,
      })
      check("the mirrored rows survive a restart of the serve process", () => {
        assert.deepEqual(
          afterRestart.map((row) => ({ content: row.content, status: row.status })),
          rows.map((row) => ({ content: row.content, status: row.status })),
        )
      })
    } finally {
      await restarted.serve.stop()
    }

    // Read after both serve processes have exited, and polled: OpenCode buffers
    // `$XDG_DATA_HOME/opencode/log/opencode.log` and SIGTERM does not flush it,
    // so a plain read reports "not logged" for lines that were in fact written.
    const logLines = `${await readHostLog(host.iso, { marker: "llm runtime selected" })}\n${host.serve.logText()}`.split(
      "\n",
    )
    observe(
      "the model call went through the real provider stack",
      `${host.mock.requests.length} requests reached the mock endpoint; ` +
        (logLines.find((line) => line.includes("llm runtime selected"))?.trim() ??
          "the host's `llm runtime selected` line had not flushed at read time"),
    )
    observe(
      "host log — todowrite mentions",
      logLines
        .filter((line) => line.includes("todowrite"))
        .slice(0, 3)
        .join(" | ") || "none (OpenCode logs no tool-registration line at INFO)",
    )

    return { rows, mirror, dbRows }
  } finally {
    await host.stop()
  }
}

// ---------------------------------------------------------------------------
// Arm B — CONTROL 1: mirrorTodos "off"
// ---------------------------------------------------------------------------

async function offArm() {
  // Options travel as the second element of the plugin entry
  // (`docs/reference.md`, "Options reference"); `configureHost` rewrites the
  // installer's string entry into that tuple form.
  const host = await bootHost({
    repoRoot,
    root: path.join(scratch, "off"),
    respond: mockRoutes(),
    pluginOptions: { mirrorTodos: "off" },
    logPath: path.join(scratch, "off-serve.log"),
  })
  try {
    const session = await host.api.post("/session", { body: { title: "todo mirror control" } })
    await runGoalCommand(host.api, session.id, GOAL_ARGUMENTS, {
      model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
    })
    let rows = await waitForTodos(host.api, session.id, (list) => list.length > 0, { timeoutMs: 15_000 })
    if (rows.length === 0) {
      await promptSession(host.api, session.id, "continue", { model: MOCK_MODEL_REF })
      rows = await waitForTodos(host.api, session.id, (list) => list.length > 0, { timeoutMs: 15_000 })
    }
    check('CONTROL 1 — mirrorTodos "off" returns exactly what the model sent', () => {
      assert.deepEqual(
        rows.map((row) => ({ content: row.content, status: row.status, priority: row.priority })),
        DIVERGENT_TODOS,
      )
    })
    check('CONTROL 1 — the laundered row is still "completed" with mirrorTodos "off"', () => {
      assert.equal(rows[0].status, "completed")
      assert.ok(!rows[0].content.endsWith(EVIDENCE_SUFFIX))
    })
    const info = await host.api.get(`/session/${session.id}`)
    check('CONTROL 1 — the payload reports the mirror as "off"', () => {
      const mirror = info?.metadata?.goal?.plan?.mirror
      assert.ok(mirror, "no plan.mirror in the payload")
      assert.equal(mirror.state, "off")
    })
    return rows
  } finally {
    await host.stop()
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const { version } = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"))
  const host = await execFileAsync("opencode", ["--version"]).then(
    (out) => out.stdout.trim(),
    () => "MISSING",
  )
  if (host === "MISSING") {
    console.error("FAIL  the `opencode` binary is not on PATH; this smoke needs the real host")
    process.exitCode = 1
    return
  }
  console.log(`todo mirror smoke — plugin ${version}, opencode ${host}, scratch ${scratch}`)

  // The installer copies `dist/`, so an unbundled tree smokes the OLD code and
  // every observable below would be a claim about the last build.
  const [sourceStat, bundleStat] = await Promise.all([
    stat(path.join(repoRoot, "src", "goal-plugin.js")),
    stat(path.join(repoRoot, "dist", "goal-plugin.js")).catch(() => null),
  ])
  if (!bundleStat) {
    console.error("FAIL  dist/goal-plugin.js is missing; run `npm run bundle` first")
    process.exitCode = 1
    return
  }
  if (bundleStat.mtimeMs < sourceStat.mtimeMs) {
    console.error("FAIL  dist/goal-plugin.js is older than src/goal-plugin.js; run `npm run bundle` first")
    process.exitCode = 1
    return
  }
  // mtime alone is not enough: `git checkout -- dist` restores an OLD bundle
  // with a NEW mtime, and every observable below would then be a claim about
  // v1.0.0. A bundle that cannot produce the suffix cannot mirror.
  const bundle = await readFile(path.join(repoRoot, "dist", "goal-plugin.js"), "utf8")
  if (!bundle.includes(EVIDENCE_SUFFIX)) {
    console.error("FAIL  dist/goal-plugin.js carries no todo-mirror code; run `npm run bundle` first")
    process.exitCode = 1
    return
  }

  const arm = await mirrorArm()
  const control = await offArm()

  // The control must come out DIFFERENT, or arm A proved only that something
  // wrote todos.
  check("the two arms disagree — the mirror, not the host, produced arm A's rows", () => {
    assert.notDeepEqual(contents(arm.rows), contents(control))
    assert.equal(control.length, DIVERGENT_TODOS.length)
    assert.equal(arm.rows.length, PLAN_ACTIONS.length + MODEL_ROWS.length)
  })

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} observables passed`)
  if (failed.length) {
    for (const result of failed) console.error(`FAILED: ${result.label}\n${result.error.stack}`)
    process.exitCode = 1
    return
  }
  console.log("todo mirror host smoke passed")
}

await main()
