#!/usr/bin/env tsx
/**
 * scripts/kb-brain-injection-simulator.ts   (npm run test:kb-brain-injection)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE KNOWLEDGE BASE FEEDS THE BRAND-VOICE "BRAIN". Uploaded knowledge (articles
 * + help topics, embedded) is now injected into the AI's system prompt via RAG,
 * so the assistant answers from the brokerage's OWN facts — not generic
 * boilerplate. Proves: (1) loadBrandVoicePrompt retrieves KB for a query, scoped
 * to the brokerage, via ragSearch (NOT buildRAGContext — whose cookie-derived
 * scope is absent in webhook/cron contexts); (2) the inbound-email rail passes
 * the lead's message as the query; (3) create/update embed SYNCHRONOUSLY so the
 * KB is immediately retrievable (the embedding_queue has no cron drain).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the brand-voice brain retrieves the brokerage KB for the query ──")
{
  const bv = src("lib/ai-isa/brand-voice-prompt.ts")
  check("BrandVoicePromptContext gains an optional knowledgeQuery", /knowledgeQuery\?:\s*string/.test(bv))
  check("it retrieves via ragSearch (the param-scoped lib fn), NOT buildRAGContext",
    bv.includes("ragSearch") && !bv.includes("buildRAGContext"))
  check("retrieval is SCOPED to the brokerage (brokerageId passed to ragSearch)",
    /ragSearch\([\s\S]*?brokerageId:\s*ctx\.brokerageId/.test(bv))
  check("gated on knowledgeQuery being set (zero cost / no behavior change when omitted)",
    /if \(ctx\.knowledgeQuery\?\.trim\(\)\)/.test(bv))
  check("a 'Relevant knowledge' block is pushed into the systemBlock", bv.includes("Relevant knowledge from your brokerage"))
  check("best-effort — a KB outage never breaks brand voice (try/catch)",
    /try \{[\s\S]*?ragSearch[\s\S]*?\} catch/.test(bv))
}

console.log("\n── the inbound-email rail feeds the lead's message as the query ──")
{
  const email = src("app/actions/ai-isa/handle-inbound-email.ts")
  check("handle-inbound-email passes knowledgeQuery from the inbound message",
    /loadBrandVoicePrompt\([\s\S]*?knowledgeQuery:/.test(email) && email.includes("params.body"))
}

console.log("\n── uploads embed SYNCHRONOUSLY so the KB is immediately usable ──")
{
  const s = src("app/actions/knowledge/search.ts")
  check("createKnowledgeArticle embeds synchronously (updateArticleEmbedding) with a queue fallback",
    /updateArticleEmbedding\(data\.id\)[\s\S]*?catch[\s\S]*?queueForEmbedding\('knowledge_articles'/.test(s))
  check("createHelpTopic embeds synchronously (updateHelpTopicEmbedding) with a queue fallback",
    /updateHelpTopicEmbedding\(data\.id\)[\s\S]*?catch[\s\S]*?queueForEmbedding\('help_topics_kb'/.test(s))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ KB_BRAIN_INJECTION_FAIL"); process.exit(1) }
console.log(" ✅ KB_BRAIN_INJECTION_PASS — uploaded knowledge reaches the AI's brand-voice brain, scoped + grounded")
