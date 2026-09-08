// The installer through its real entry point — the package bin, run as a child
// process from the package as it sits on disk, with the repository itself as
// the source of the copy. The unit tests in test/install.test.js drive the
// module directly against fixtures; this file proves the bin, the argument
// parsing and the documented exit codes.
import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const repository = fileURLToPath(new URL("..", import.meta.url))
const cli = join(repository, "scripts", "cli.mjs")
const { name: packageName, version } = JSON.parse(await readFile(join(repository, "package.json"), "utf8"))

async function cliRun(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], options)
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }
  }
}

async function scratch(label) {
  const root = await mkdtemp(join(tmpdir(), `goal-installer-cli-${label}-`))
  return {
    root,
    configDir: join(root, "cfg", "opencode"),
    dataDir: join(root, "data", packageName),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function missing(file) {
  try {
    await stat(file)
    return false
  } catch {
    return true
  }
}

test("no arguments prints the usage, exit 0", async () => {
  const result = await cliRun([])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /npx -y github:sblattj\/opencode-goal-pro-max-complete-plugin install/)
  assert.match(result.stdout, /Exit codes: 0 ok, 1 failed, 2 usage error, 3 refused/)
  assert.equal((await cliRun(["--version"])).stdout.trim(), version)
})

test("an unknown option is a usage error, exit 2", async () => {
  const result = await cliRun(["install", "--frobnicate"])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /unknown option --frobnicate/)
  const unknownCommand = await cliRun(["frobnicate"])
  assert.equal(unknownCommand.code, 2)
})

test("a destination containing ':' is refused, exit 3", async () => {
  const s = await scratch("colon")
  try {
    const result = await cliRun([
      "install",
      "--config-dir",
      s.configDir,
      "--data-dir",
      join(s.root, "bad:dir", packageName),
    ])
    assert.equal(result.code, 3)
    assert.match(result.stderr, /refusing to install/)
    assert.match(result.stderr, /TUI/)
    assert.ok(await missing(join(s.configDir, "opencode.json")))
  } finally {
    await s.cleanup()
  }
})

test("--dry-run --json describes the work and writes nothing", async () => {
  const s = await scratch("dryrun")
  try {
    const result = await cliRun(["install", "--config-dir", s.configDir, "--data-dir", s.dataDir, "--dry-run", "--json"])
    assert.equal(result.code, 0)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.dryRun, true)
    assert.equal(parsed.spec, pathToFileURL(s.dataDir).href)
    assert.equal(parsed.serverConfigFile, join(s.configDir, "opencode.json"))
    assert.equal(parsed.tuiConfigFile, join(s.configDir, "tui.json"))
    assert.ok(parsed.actions.length >= 4)
    assert.ok(await missing(join(s.configDir, "opencode.json")))
    assert.ok(await missing(s.dataDir))
  } finally {
    await s.cleanup()
  }
})

test("install, status and uninstall round-trip through the bin", async () => {
  const s = await scratch("roundtrip")
  const where = ["--config-dir", s.configDir, "--data-dir", s.dataDir]
  try {
    const installed = await cliRun(["install", ...where])
    assert.equal(installed.code, 0, installed.stderr)
    assert.match(installed.stdout, /Restart opencode to load it\./)

    // The bytes that landed are the repository's own.
    for (const relative of ["package.json", "dist/goal-plugin.js", "dist/goal-tui.js"]) {
      const [from, to] = await Promise.all([
        readFile(join(repository, relative)),
        readFile(join(s.dataDir, relative)),
      ])
      assert.ok(from.equals(to), `${relative} must be copied byte for byte`)
    }
    const [shippedSkill, installedSkill] = await Promise.all([
      readFile(join(repository, "skills", "using-the-goal-plugin", "SKILL.md")),
      readFile(join(s.configDir, "skill", "using-the-goal-plugin", "SKILL.md")),
    ])
    assert.ok(shippedSkill.equals(installedSkill))

    const status = JSON.parse((await cliRun(["status", ...where, "--json"])).stdout)
    assert.equal(status.serverWired, true)
    assert.equal(status.tuiWired, true)
    assert.equal(status.installedVersion, version)
    assert.equal(status.skill.current, true)

    const again = await cliRun(["install", ...where])
    assert.match(again.stdout, /Already installed/)

    const removed = await cliRun(["uninstall", ...where])
    assert.equal(removed.code, 0, removed.stderr)
    assert.ok(await missing(s.dataDir))
    const gone = JSON.parse((await cliRun(["status", ...where, "--json"])).stdout)
    assert.equal(gone.serverWired, false)
    assert.equal(gone.tuiWired, false)
    assert.equal(gone.skill.present, false)
    assert.deepEqual(JSON.parse(await readFile(join(s.configDir, "opencode.json"), "utf8")).plugin, [])
  } finally {
    await s.cleanup()
  }
})

test("verify is delegated to the shipped verifier", async () => {
  const result = await cliRun(["verify"], { cwd: repository })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /installation verification/)
  assert.match(result.stdout, /is installed correctly/)
})

test("a flag value that looks like a flag is a usage error, not a directory", async () => {
  const s = await scratch("flagvalue")
  try {
    // `--data-dir --dry-run` used to swallow the flag as the directory: a real
    // install into a directory literally named "--dry-run", exit 0, "Restart
    // opencode to load it."
    for (const argv of [
      ["install", "--config-dir", s.configDir, "--data-dir", "--dry-run"],
      ["install", "--data-dir", s.dataDir, "--config-dir", "--json"],
    ]) {
      const result = await cliRun(argv, { cwd: s.root })
      assert.equal(result.code, 2, `${argv.join(" ")} must be a usage error, got ${result.code}`)
      assert.match(result.stderr, /needs a directory, but the next argument is/)
      assert.equal(result.stdout, "", "a usage error must not report work it did not do")
    }
    assert.ok(await missing(join(s.root, "--dry-run")), "nothing may be created under the swallowed flag's name")
    assert.ok(await missing(join(s.configDir, "opencode.json")))

    // Control: the same value bound with `=` is taken literally, and a real
    // directory after the flag still works.
    const inline = await cliRun([
      "install",
      `--config-dir=${s.configDir}`,
      `--data-dir=${s.dataDir}`,
      "--dry-run",
      "--json",
    ])
    assert.equal(inline.code, 0, inline.stderr)
    assert.equal(JSON.parse(inline.stdout).dataDir, s.dataDir)
  } finally {
    await s.cleanup()
  }
})
