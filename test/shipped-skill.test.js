// What the package ships FOR the installer: the skill, the bin, the bootstrap.
//
// These are packaging facts, so they are read off the working tree rather than
// re-stated: `files` decides what the tarball contains, and a skill whose
// frontmatter does not parse is invisible to OpenCode
// (packages/opencode/src/skill/index.ts:24, `OPENCODE_SKILL_PATTERN`, at
// opencode 1.18.29).
import assert from "node:assert/strict"
import test from "node:test"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { SKILL_NAME, SKILL_SOURCE_SEGMENTS } from "../scripts/install.mjs"

const repository = fileURLToPath(new URL("..", import.meta.url))
const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"))
const skillFile = join(repository, ...SKILL_SOURCE_SEGMENTS)

test("the shipped skill has usable frontmatter", async () => {
  const text = await readFile(skillFile, "utf8")
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(match, "SKILL.md must open with a YAML frontmatter block")
  const frontmatter = match[1]
  const name = /^name:\s*(.+)$/m.exec(frontmatter)
  const description = /^description:\s*(.+)$/m.exec(frontmatter)
  assert.ok(name, "the frontmatter must declare a name")
  assert.equal(name[1].trim(), SKILL_NAME)
  assert.ok(description, "the frontmatter must declare a description")
  assert.ok(description[1].replace(/^"|"$/g, "").trim().length > 40, "the description is what triggers the skill")
  assert.ok(text.slice(match[0].length).trim().length > 1000, "the body must be the real skill, not a stub")
})

test("the skill's description advertises every surface its body teaches", async () => {
  // The description is the WHOLE trigger surface: OpenCode matches a skill on its
  // frontmatter, never on its body, so a section the description does not name only
  // ever fires when something else in the description already did. v1.0.1 taught the
  // todo mirror in the body and left the 1.0.0 description byte-identical, which is
  // what this pairing catches: each row asserts the body still teaches the topic AND
  // that the description still says so.
  const text = await readFile(skillFile, "utf8")
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(match, "SKILL.md must open with a YAML frontmatter block")
  const description = /^description:\s*(.+)$/m.exec(match[1])[1]
  const body = text.slice(match[0].length)
  for (const [topic, taughtBy, advertisedBy] of [
    ["the todo mirror", /todowrite/, /todo/i],
    ["the plan tools", /goal_plan_set/, /goal_\*/],
    ["the evidence markers", /\[goal:evidence\]/, /\[goal:evidence\]/],
    ["the sidebar panel", /Goal panel/, /sidebar/i],
  ]) {
    assert.match(body, taughtBy, `the body must still teach ${topic}`)
    assert.match(description, advertisedBy, `the description must name ${topic}`)
  }
})

test("the shipped skill names no host, no path and no package", async () => {
  const text = await readFile(skillFile, "utf8")
  for (const forbidden of [/ferry/i, /\/Users\//, /opencode-goal-pro-max/i, /node_modules/]) {
    assert.equal(forbidden.test(text), false, `the skill must not mention ${forbidden}`)
  }
})

test("package.json ships the installer and the skill", async () => {
  for (const entry of ["skills", "scripts/cli.mjs", "scripts/install.mjs", "scripts/verify.mjs", "install.sh"]) {
    assert.ok(manifest.files.includes(entry), `package.json files must list ${entry}`)
  }
  assert.equal(manifest.bin[manifest.name], "./scripts/cli.mjs")
})

test("the bin and the bootstrap are executable scripts", async () => {
  const cli = join(repository, "scripts", "cli.mjs")
  const bootstrap = join(repository, "install.sh")
  const [cliText, bootstrapText] = await Promise.all([readFile(cli, "utf8"), readFile(bootstrap, "utf8")])
  assert.match(cliText, /^#!\/usr\/bin\/env node\n/)
  assert.match(bootstrapText, /^#!\/bin\/sh\n/)
  for (const file of [cli, bootstrap]) {
    const info = await stat(file)
    assert.equal(Boolean(info.mode & 0o111), true, `${file} must be executable`)
  }
  // The bootstrap must reach the same installer, and must not carry a bash-ism.
  assert.match(bootstrapText, /scripts\/cli\.mjs/)
  assert.match(bootstrapText, /npx -y "github:\$\{OWNER_REPO\}"/)
  assert.equal(/\[\[|\bfunction \w+\(\)|\blocal\b/.test(bootstrapText), false, "install.sh must stay POSIX sh")
})

test("the installer adds no runtime dependency", async () => {
  const sources = await Promise.all(
    ["scripts/cli.mjs", "scripts/install.mjs"].map((file) => readFile(join(repository, file), "utf8")),
  )
  const imports = sources.flatMap((source) => [...source.matchAll(/from "([^"]+)"/g)].map((hit) => hit[1]))
  assert.ok(imports.length > 0)
  for (const specifier of imports) {
    assert.ok(
      specifier.startsWith("node:") || specifier.startsWith("./"),
      `${specifier} would make "npx -y github:…" resolve a dependency at install time`,
    )
  }
})
