// Syntax check for the shipped sources, run by `bun run check`.
// Replaces `node -c`: Bun's transpiler throws on any syntax error, and this
// script exits 1 with the file name and message when it does.
import { readFileSync } from "node:fs"

if (typeof Bun === "undefined") {
  console.error("scripts/check-syntax.mjs must run under Bun: use `bun run check`")
  process.exit(2)
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error("usage: bun scripts/check-syntax.mjs <file...>")
  process.exit(2)
}

const transpiler = new Bun.Transpiler({ loader: "js" })
let failed = 0
for (const file of files) {
  try {
    transpiler.transformSync(readFileSync(file, "utf8"))
    console.log(`syntax ok: ${file}`)
  } catch (error) {
    failed += 1
    console.error(`syntax error: ${file}`)
    console.error(String(error?.message ?? error))
  }
}
process.exit(failed === 0 ? 0 : 1)
