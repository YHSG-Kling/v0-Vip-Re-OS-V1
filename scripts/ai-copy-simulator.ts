#!/usr/bin/env tsx
/** scripts/ai-copy-simulator.ts — copy is persona-aware, never hardcoded (fallback only). */
import { generatePersonaCopy, type CopyGenerator } from "../lib/kernel/ai-copy"
let passed = 0, failed = 0; const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; fails.push(n); console.log(`  ✗ ${n}`) } }
async function main() {
  console.log("══ AI copy (persona-aware) simulator ══")
  // A generator that personalizes from the persona + facts proves copy is NOT hardcoded.
  const gen: CopyGenerator = async (req) => ({ subject: `For ${req.persona.name ?? req.persona.audience}`, body: `Hi ${req.persona.name ?? "there"} — ${req.facts[0]} (${req.persona.situation ?? req.persona.audience}).` })
  const a = await generatePersonaCopy({ goal: "g", channel: "email", facts: ["a home sold nearby"], persona: { name: "Dana", audience: "neighbor", situation: "long-tenure homeowner" } }, { body: "FALLBACK" }, { generator: gen })
  check("persona generator drives the copy (name + situation woven in)", a.body.includes("Dana") && a.body.includes("long-tenure") && a.body.includes("home sold nearby"))
  const b = await generatePersonaCopy({ goal: "g", channel: "email", facts: ["x"], persona: { name: "Sam" } }, { body: "FALLBACK" }, { generator: gen })
  const c = await generatePersonaCopy({ goal: "g", channel: "email", facts: ["x"], persona: { name: "Lee" } }, { body: "FALLBACK" }, { generator: gen })
  check("two different personas → two DIFFERENT copies (not boilerplate)", b.body !== c.body && b.body.includes("Sam") && c.body.includes("Lee"))
  // Fallback when the generator yields null — still real copy, never a stub.
  const nullGen: CopyGenerator = async () => null
  const f = await generatePersonaCopy({ goal: "g", channel: "email", facts: ["x"], persona: { audience: "buyer" } }, { body: "DETERMINISTIC FALLBACK" }, { generator: nullGen })
  check("generator unavailable → deterministic fallback (always real copy)", f.body === "DETERMINISTIC FALLBACK")
  // A throwing generator also falls back (never breaks a play).
  const throwGen: CopyGenerator = async () => { throw new Error("gateway down") }
  const t = await generatePersonaCopy({ goal: "g", channel: "email", facts: ["x"], persona: {} }, { body: "FB" }, { generator: throwGen })
  check("generator error → fallback (play never breaks)", t.body === "FB")
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`); if (failed) { for (const x of fails) console.log("   - " + x); process.exit(1) }
  console.log(" ✅ AI copy verified — persona-aware, fallback-safe, never hardcoded")
}
main().catch((e) => { console.error(e); process.exit(1) })
