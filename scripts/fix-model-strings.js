const fs = require("fs")
const path = require("path")

const ROOT = "/vercel/share/v0-project"
console.log("ROOT:", ROOT)

const SKIP_PATTERNS = [
  "parse-intent.ts",
  "services-content.tsx",
  "resolve-model.ts",
  "models.ts",
  "fix-model-strings.js",
]

function walk(dir) {
  let results = []
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      let stat
      try { stat = fs.statSync(p) } catch { continue }
      if (stat.isDirectory()) {
        results = results.concat(walk(p))
      } else if (p.endsWith(".ts") || p.endsWith(".tsx")) {
        results.push(p)
      }
    }
  } catch (e) { console.log("walk error:", e.message) }
  return results
}

const checkDirs = [
  path.join(ROOT, "app/actions"),
  path.join(ROOT, "app/api"),
  path.join(ROOT, "lib"),
  path.join(ROOT, "services"),
]

for (const d of checkDirs) {
  console.log("exists?", d, fs.existsSync(d))
}

let fixed = 0
let skipped = 0

for (const dir of checkDirs) {
  if (!fs.existsSync(dir)) { console.log("SKIP (missing dir):", dir); continue }

  let files = walk(dir)
  console.log("Files in", dir.replace(ROOT,""), ":", files.length)

  for (const file of files) {
    if (SKIP_PATTERNS.some((p) => file.endsWith(p))) { skipped++; continue }

    let src
    try { src = fs.readFileSync(file, "utf-8") } catch { continue }

    if (!/from ["']ai["']/.test(src)) { skipped++; continue }
    if (!/model:\s+["'](openai|anthropic)\//.test(src)) { skipped++; continue }

    let modified = src

    if (!modified.includes(`from "@/lib/ai/resolve-model"`) && !modified.includes(`from '@/lib/ai/resolve-model'`)) {
      modified = modified.replace(
        /(import\s+\{[^}]+\}\s+from\s+["']ai["'])/,
        `$1\nimport { resolveModel } from "@/lib/ai/resolve-model"`
      )
    }

    modified = modified.replace(
      /(\bmodel:\s+)(["'])(openai\/[^"']+)(["'])/g,
      (_, prefix, q1, modelStr, q2) => `${prefix}resolveModel(${q1}${modelStr}${q2})`
    )
    modified = modified.replace(
      /(\bmodel:\s+)(["'])(anthropic\/[^"']+)(["'])/g,
      (_, prefix, q1, modelStr, q2) => `${prefix}resolveModel(${q1}${modelStr}${q2})`
    )

    modified = modified.replace(
      /resolveModel\(resolveModel\(([^)]+)\)\)/g,
      "resolveModel($1)"
    )

    if (modified !== src) {
      fs.writeFileSync(file, modified, "utf-8")
      console.log("[fix] " + file.replace(ROOT, ""))
      fixed++
    } else {
      skipped++
    }
  }
}

console.log("\nDone. Fixed: " + fixed + " files. Skipped: " + skipped + " files.")
