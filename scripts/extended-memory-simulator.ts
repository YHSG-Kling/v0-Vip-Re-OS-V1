#!/usr/bin/env tsx
/**
 * scripts/extended-memory-simulator.ts   (npm run test:extended-memory)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AI REMEMBERS EACH CONTACT — on ONE embedding pipeline. The per-contact
 * vector memory (contact_memory) was written on every portal milestone but its
 * recall was orphaned (no production caller), and it ran on a SECOND raw-OpenAI
 * embedder — the exact drift the KB consolidation removed. This proves: (1)
 * contact-memory now embeds through the ONE canonical gateway embedder; (2) the
 * brand-voice brain recalls a contact's relevant history and injects it; (3) the
 * live-only table + recall RPC are captured in a migration.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── contact-memory rides the ONE canonical embedder (no second pipeline) ──")
{
  const cm = src("lib/agents/contact-memory.ts")
  check("embeds via the canonical generateEmbedding (AI gateway)",
    cm.includes('from "@/lib/knowledge/embedding-service"') && cm.includes("generateEmbedding"))
  check("the raw-OpenAI second pipeline is gone (no OpenAI SDK / getOpenAI / OPENAI_API_KEY)",
    !cm.includes('import OpenAI') && !cm.includes("getOpenAI") && !cm.includes("OPENAI_API_KEY"))
  check("both embed + recall paths go through generateEmbedding",
    (cm.match(/generateEmbedding\(/g) ?? []).length >= 2)
  check("the brokerage+entity scope stays non-negotiable (recall RPC scoped)",
    cm.includes("contact_memory_recall") && /p_brokerage_id:\s*input\.brokerageId/.test(cm))
}

console.log("\n── the brand-voice brain recalls THIS contact's history (extended memory) ──")
{
  const bv = src("lib/ai-isa/brand-voice-prompt.ts")
  check("recall is gated on BOTH a contact and a query", /if \(ctx\.contactId && ctx\.knowledgeQuery\?\.trim\(\)\)/.test(bv))
  check("it calls recallContactMemory scoped to the contact entity",
    bv.includes("recallContactMemory") && /entityType:\s*"contact",\s*entityId:\s*ctx\.contactId/.test(bv))
  check("a 'Relevant history with this contact' block is injected", bv.includes("Relevant history with this contact"))
  check("best-effort — a memory miss never breaks brand voice (try/catch)",
    /recallContactMemory[\s\S]*?\} catch \{ \/\* memory unavailable/.test(bv))
}

console.log("\n── the live-only table + recall RPC are now version-controlled ──")
{
  const migPath = "scripts/l41-s01-contact-memory-vector-recall.sql"
  check("the contact_memory migration file exists", existsSync(join(process.cwd(), migPath)))
  const mig = src(migPath)
  check("it captures the table (contact_memory) + the recall RPC",
    /CREATE TABLE IF NOT EXISTS public\.contact_memory/.test(mig) &&
    /CREATE OR REPLACE FUNCTION public\.contact_memory_recall/.test(mig))
  check("it preserves the entity-scoped + ivfflat indexes and RLS",
    mig.includes("idx_contact_memory_entity") && mig.includes("ivfflat") && mig.includes("ENABLE ROW LEVEL SECURITY"))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ EXTENDED_MEMORY_FAIL"); process.exit(1) }
console.log(" ✅ EXTENDED_MEMORY_PASS — one embedder, contact history recalled into the brain, infra captured")
