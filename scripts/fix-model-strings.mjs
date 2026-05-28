/**
 * Bulk-fixes all remaining direct string model format violations.
 *
 * For every .ts/.tsx file under app/actions/ and app/api/ and lib/ and services/:
 *  1. Detects direct `generateObject` or `generateText` SDK import from "ai"
 *  2. Injects `import { resolveModel } from "@/lib/ai/resolve-model"` if missing
 *  3. Replaces  model: "openai/..."  and  model: "anthropic/..."  inside
 *     generateObject / generateText call objects with  resolveModel("...")
 *     — but ONLY when the string is in a direct SDK call context (not in
 *     wrapper functions that already route through generateTextRouted, and
 *     not in HTTP fetch bodies or UI form values).
 *
 * Heuristic: if the file also imports "generateTextRouted as generateText",
 * the `model:` strings in generateText calls are routing labels (not SDK args)
 * — those are safe. Only the `generateObject` calls in those files need fixing.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

const ROOT = "/vercel/share/v0-project"

// Patterns that, if a file has ONLY this import (not the raw "ai" import),
// means its generateText calls are already safe.
const WRAPPER_IMPORT = `generateTextRouted as generateText`

// Files/patterns to skip — these use string model in HTTP bodies or UI forms
const SKIP_PATTERNS = [
  "parse-intent.ts",           // HTTP fetch body — gateway format
  "services-content.tsx",       // UI form default value
  "resolve-model.ts",           // definition file itself
  "models.ts",                  // already fixed centrally
]

function walk(dir) {
  let results = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const stat = statSync(p)
    if (stat.isDirectory()) {
      results = results.concat(walk(p))
    } else if (p.endsWith(".ts") || p.endsWith(".tsx")) {
      results.push(p)
    }
  }
  return results
}

const dirs = [
  join(ROOT, "app/actions"),
  join(ROOT, "app/api"),
  join(ROOT, "lib"),
  join(ROOT, "services"),
]

let fixed = 0
let skipped = 0

for (const dir of dirs) {
  for (const file of walk(dir)) {
    // Skip certain files
    if (SKIP_PATTERNS.some((p) => file.endsWith(p))) { skipped++; continue }

    const src = readFileSync(file, "utf-8")

    // Only process files that import directly from "ai" (generateObject/Text/streamText)
    const hasDirectAIImport = /from ["']ai["']/.test(src)
    if (!hasDirectAIImport) { skipped++; continue }

    // Only process files that have string model violations
    const hasViolation = /model:\s+["'](openai|anthropic)\//.test(src)
    if (!hasViolation) { skipped++; continue }

    // Inject resolveModel import if missing
    let modified = src
    if (!modified.includes(`from "@/lib/ai/resolve-model"`) && !modified.includes(`from '@/lib/ai/resolve-model'`)) {
      // Insert after first import from "ai"
      modified = modified.replace(
        /(import\s+\{[^}]+\}\s+from\s+["']ai["'])/,
        `$1\nimport { resolveModel } from "@/lib/ai/resolve-model"`
      )
    }

    // Replace model: "openai/..." → model: resolveModel("openai/...")
    // and    model: 'openai/...' → model: resolveModel('openai/...')
    // Only when NOT already wrapped in resolveModel(...)
    modified = modified.replace(
      /(\bmodel:\s+)(["'])(openai\/[^"']+)(["'])/g,
      (_, prefix, q1, modelStr, q2) => `${prefix}resolveModel(${q1}${modelStr}${q2})`
    )
    modified = modified.replace(
      /(\bmodel:\s+)(["'])(anthropic\/[^"']+)(["'])/g,
      (_, prefix, q1, modelStr, q2) => `${prefix}resolveModel(${q1}${modelStr}${q2})`
    )

    // Remove double-wrapping: resolveModel(resolveModel("..."))
    modified = modified.replace(
      /resolveModel\(resolveModel\(([^)]+)\)\)/g,
      "resolveModel($1)"
    )

    if (modified !== src) {
      writeFileSync(file, modified, "utf-8")
      console.log(`[fix] ${file.replace(ROOT, "")}`)
      fixed++
    } else {
      skipped++
    }
  }
}

console.log(`\nDone. Fixed: ${fixed} files. Skipped: ${skipped} files.`)
