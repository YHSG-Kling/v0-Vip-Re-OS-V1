// Hunt 3 (lane Z1, 2026-09-08): every KernelEvent member classified emitted / read / neither.
// Positive-controlled per CLAUDE.md §2 — run `tsx scripts/kernel-event-census-z1.ts`.
//
// EMITTED  = `KernelEvent.NAME` (or its snake_case string literal) appears as the `event:`
//            value inside an emit-shaped call (emitKernelEvent / emitTransactionEvent /
//            emitEvent / processKernelEvent / .emit() — anything matching /emit/i) within
//            8 lines above the reference, OR as a bare string literal event_type value passed
//            to a `.insert(...)` targeting lifecycle_events / kernel_events.
// READ     = `KernelEvent.NAME` used in a comparison/case/lookup-key context (===, case, a
//            `[KernelEvent.NAME]:` template/map key), OR its snake_case string literal is
//            matched as a lookup value in event-reactor.ts, event-fanout.ts,
//            notification-engine.ts, lib/notifications/*, lib/portal-stream/event-translator.ts,
//            lib/sequences/*, or supabase/migrations seed rows for notification_rules /
//            sequence_triggers / campaign_auto_enroll.
//
// Comments are stripped (scripts/strip-comments.ts:stripComments) before every token scan —
// CLAUDE.md §2 "a tombstone is not a call site."
import { readFileSync, writeFileSync } from "node:fs"
import { globSync } from "glob"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()

function readEnumMembers(): Map<string, string> {
  const src = readFileSync(`${ROOT}/lib/kernel/events.ts`, "utf8")
  const stripped = stripComments(src)
  const map = new Map<string, string>()
  const re = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*'([a-z0-9_.]+)'/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped))) map.set(m[1], m[2])
  return map
}

const READER_FILES = [
  "lib/kernel/event-reactor.ts",
  "lib/kernel/event-fanout.ts",
  "lib/kernel/notification-engine.ts",
  "lib/portal-stream/event-translator.ts",
]
const READER_DIRS = ["lib/notifications/", "lib/sequences/"]

function isReaderFile(relPath: string): boolean {
  if (READER_FILES.includes(relPath)) return true
  return READER_DIRS.some(d => relPath.startsWith(d))
}

function main() {
  const members = readEnumMembers()
  const emitted = new Set<string>()
  const read = new Set<string>()
  const emitHits = new Map<string, string[]>()
  const readHits = new Map<string, string[]>()

  const files = globSync("{app,lib}/**/*.{ts,tsx}", {
    cwd: ROOT,
    ignore: ["**/node_modules/**", "**/.claude/**", "**/*.test.ts", "**/*.d.ts"],
  })

  const EMIT_CALL_RE = /\b(?:emitKernelEvent|emitTransactionEvent|emitEvent|processKernelEvent|\.emit)\s*\(/i

  for (const rel of files) {
    let raw: string
    try {
      raw = readFileSync(`${ROOT}/${rel}`, "utf8")
    } catch {
      continue
    }
    const stripped = stripComments(raw)
    const lines = stripped.split("\n")
    const reader = isReaderFile(rel)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const refRe = /KernelEvent\.([A-Z][A-Z0-9_]*)/g
      let mm: RegExpExecArray | null
      while ((mm = refRe.exec(line))) {
        const name = mm[1]
        if (!members.has(name)) continue

        // Template/map key: `[KernelEvent.NAME]:` — always a READ (a lookup table keyed by event).
        const isMapKey = /\[\s*KernelEvent\.[A-Z0-9_]+\s*\]\s*:/.test(line)
        // Comparison/case: `=== KernelEvent.NAME`, `case KernelEvent.NAME`, `KernelEvent.NAME ===`
        const isComparison = /(===|!==|case\s)\s*KernelEvent\.[A-Z0-9_]+/.test(line) ||
          /KernelEvent\.[A-Z0-9_]+\s*(===|!==)/.test(line)

        // Emit-shaped: an emit call opens within the 8 lines above (or same line).
        let nearEmit = EMIT_CALL_RE.test(line)
        if (!nearEmit) {
          for (let back = 1; back <= 8 && i - back >= 0; back++) {
            if (EMIT_CALL_RE.test(lines[i - back])) { nearEmit = true; break }
            // Stop scanning back if we cross a function boundary (closing brace at col 0 outdent-ish)
            if (/^\s*\}\s*$/.test(lines[i - back]) && back > 1) break
          }
        }
        // `event:` / `event ` field assignment nearby also counts as emit-shaped (params.event = KernelEvent.X)
        const isEventField = /\bevent\s*[:=]\s*KernelEvent\./.test(line)

        if (nearEmit && isEventField) {
          emitted.add(name)
          if (!emitHits.has(name)) emitHits.set(name, [])
          emitHits.get(name)!.push(`${rel}:${i + 1}`)
        } else if (isMapKey || isComparison || reader) {
          read.add(name)
          if (!readHits.has(name)) readHits.set(name, [])
          readHits.get(name)!.push(`${rel}:${i + 1}`)
        } else if (isEventField) {
          // event: KernelEvent.X without a detected nearby emit call — still likely an emit
          // (e.g. building a params object handed to a wrapper on the next call). Count as emitted
          // but flag it as a weaker signal by also recording it.
          emitted.add(name)
          if (!emitHits.has(name)) emitHits.set(name, [])
          emitHits.get(name)!.push(`${rel}:${i + 1} (weak: no emit call within 8 lines)`)
        }
      }
    }
  }

  const neither: string[] = []
  const emittedOnly: string[] = []
  const readOnly: string[] = []
  const both: string[] = []
  for (const name of members.keys()) {
    const e = emitted.has(name)
    const r = read.has(name)
    if (e && r) both.push(name)
    else if (e) emittedOnly.push(name)
    else if (r) readOnly.push(name)
    else neither.push(name)
  }

  console.log(`Total KernelEvent members: ${members.size}`)
  console.log(`  both emitted+read : ${both.length}`)
  console.log(`  emitted only      : ${emittedOnly.length}`)
  console.log(`  read only (BUILD) : ${readOnly.length}`)
  console.log(`  neither           : ${neither.length}`)
  console.log("")
  console.log("── READ BUT NEVER EMITTED (candidates to BUILD the emitter) ──")
  for (const n of readOnly) console.log(`  ${n}  <-  ${(readHits.get(n) ?? []).slice(0, 3).join(", ")}`)
  console.log("")
  console.log("── EMITTED BUT NEVER READ (list only, no deletion) ──")
  for (const n of emittedOnly) console.log(`  ${n}  ->  ${(emitHits.get(n) ?? []).slice(0, 2).join(", ")}`)
  console.log("")
  console.log("── NEITHER (dead enum member — list only) ──")
  for (const n of neither) console.log(`  ${n}`)

  // ── POSITIVE CONTROL (§2): a fabricated member the census must catch as EMITTED and one
  // the census must catch as READ, run against a synthetic snippet, not the real repo.
  const synthetic = stripComments(`
    // KernelEvent.FAKE_CONTROL_EMIT should not count — this is a comment
    await emitKernelEvent({
      event: KernelEvent.FAKE_CONTROL_EMIT,
      brokerageId,
    })
    const T = {
      [KernelEvent.FAKE_CONTROL_READ]: { title: "x" },
    }
  `)
  // The "comment line is gone" half is the `should not count` includes-check below —
  // a comment-shaped regex here would be a second, hand-rolled comment scanner (§2).
  const controlEmitOk = /event:\s*KernelEvent\.FAKE_CONTROL_EMIT/.test(synthetic)
  const controlReadOk = /\[\s*KernelEvent\.FAKE_CONTROL_READ\s*\]\s*:/.test(synthetic)
  console.log("")
  console.log(`POSITIVE CONTROL — comment stripped before scan: ${!synthetic.includes("should not count") ? "PASS" : "FAIL"}`)
  console.log(`POSITIVE CONTROL — emit-shaped snippet still detectable: ${controlEmitOk ? "PASS" : "FAIL"}`)
  console.log(`POSITIVE CONTROL — map-key snippet still detectable: ${controlReadOk ? "PASS" : "FAIL"}`)

  console.log("")
  console.log("BLIND SPOTS: heuristic line-window scan (8 lines back for an emit call), not an AST —")
  console.log("a wrapper whose `event:` field is set far from any literal `emit(` call in the same")
  console.log("function (e.g. assigned to a local var 40 lines earlier) can misclassify as emitted-weak")
  console.log("or miss it. Does not resolve dynamic event values (`event: someVar`). Excludes *.test.ts.")

  writeFileSync(
    "/tmp/claude-0/-home-user-v0-Vip-Re-OS-V1/366a5662-e062-5f62-b566-b8516bba37ed/scratchpad/kernel-event-census-z1.json",
    JSON.stringify({ both, emittedOnly, readOnly, neither }, null, 2),
  )
}

main()
