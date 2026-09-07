// Git-install contract.
//
// OpenCode installs a plugin from a git spec by reifying it in-process with
// `@npmcli/arborist` (packages/core/src/npm.ts:83-101 in opencode 1.18.29).
// For a git dependency, pacote's GitFetcher decides whether to run a
// "preparation" step by looking at nothing but the package's own manifest
// (pacote/lib/git.js:152-190, `#prepareDir`):
//
//     if (!mani.workspaces && (!scripts || !(
//         scripts.postinstall || scripts.build || scripts.preinstall ||
//         scripts.install || scripts.prepack || scripts.prepare))) return
//
// If ANY of those six script names exists — or the manifest declares
// `workspaces` — preparation runs, and it runs by SPAWNING `npmBin`. Inside
// opencode's bun single-file binary `npmBin` is derived from
// `fileURLToPath(new URL("..", import.meta.url))`
// (packages/core/src/npm-config.ts:10), which resolves under `/$bunfs/`; the
// path does not exist, the child exits non-zero, and pacote rejects the whole
// install with `git dep preparation failed`. Arborist rolls the tree back and
// the plugin is dropped. `ignoreScripts: true` does NOT prevent this: only
// pacote's DirFetcher consults that flag, never GitFetcher's prepare step.
//
// That is why v0.9.0 installed from a git spec and v0.9.1 and v0.10.0 could
// not: v0.9.1 introduced `build` and `prepack`. This package therefore ships
// NO lifecycle script in that set, and the bundles in dist/ are committed
// rather than built at install time — which is only safe if the committed
// bundles are actually current, so this contract checks that too.
//
// Both halves are polarity-checkable: rename `bundle` back to `build` and the
// first assertion fails; edit a source file without rebuilding and the second
// does.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))

// pacote/lib/git.js:156-162, verbatim.
const PREPARE_TRIGGERS = ["postinstall", "build", "preinstall", "install", "prepack", "prepare"]

const scripts = manifest.scripts ?? {}
const offenders = PREPARE_TRIGGERS.filter((name) => scripts[name] !== undefined)
assert.deepEqual(
  offenders,
  [],
  `package.json scripts ${offenders.map((name) => `"${name}"`).join(", ")} make pacote's GitFetcher ` +
    "run a preparation step, which fails inside opencode's bundled binary with " +
    '"git dep preparation failed" and silently drops the plugin. Rename them (e.g. "bundle").',
)

assert.equal(
  manifest.workspaces,
  undefined,
  'a "workspaces" field also forces GitFetcher preparation (pacote/lib/git.js:156)',
)

// The bundles must be committed AND current, because nothing rebuilds them at
// install time any more.
const targets = [
  { file: "dist/goal-plugin.js", source: "src/goal-plugin.js", flags: ["--target", "node"] },
  { file: "dist/goal-tui.js", source: "src/goal-tui.js", flags: ["--target", "node", "--packages", "external"] },
]

assert.ok(manifest.files?.includes("dist"), "the committed bundles must be packed")

function bunVersion() {
  try {
    return execFileSync("bun", ["--version"], { encoding: "utf8" }).trim()
  } catch {
    return undefined
  }
}

const bun = bunVersion()
assert.ok(
  bun,
  "bun is required to prove the committed bundles are current; install bun or run this contract on a host that has it",
)

const scratch = await mkdtemp(join(tmpdir(), "opencode-goal-pro-max-complete-plugin-dist-freshness-"))
function sha(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

try {
  for (const target of targets) {
    const rebuilt = join(scratch, target.file.replace("dist/", ""))
    execFileSync("bun", ["build", join(root, target.source), "--outfile", rebuilt, ...target.flags], {
      cwd: root,
      stdio: "pipe",
    })
    const [committed, fresh] = await Promise.all([readFile(join(root, target.file)), readFile(rebuilt)])
    assert.equal(
      sha(committed),
      sha(fresh),
      `${target.file} is stale: it does not match a fresh bundle of ${target.source}. ` +
        'Run "npm run bundle" and commit the result — nothing rebuilds it at install time.',
    )
  }

  console.log(
    `git install contract passed (no ${PREPARE_TRIGGERS.join("/")} script, no workspaces; ` +
      `${targets.map((target) => target.file).join(" and ")} match a fresh bun ${bun} bundle)`,
  )
} finally {
  await rm(scratch, { recursive: true, force: true })
}
