#!/usr/bin/env tsx
/**
 * scripts/topic-claim-office-scope-simulator.ts (npm run test:topic-claim-scope)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TOPICS POOL IS A CLAIM, AND THE CLAIM BELONGS TO AN OFFICE.
 *
 * OWNER'S CORRECTION, verbatim: "kb is the brain for the ai uploading articles
 * to help train the ai brain. topics pool is where the agent in the same office
 * can't write an article from the same topic (completely separate idea)."
 *
 * TWO SEPARATE CONCERNS, and this proof holds them apart:
 *   · knowledge_articles — the AI BRAIN's training corpus, carrying
 *     content_embedding for retrieval. Nothing to do with claiming.
 *   · content_topic_bank + content_topic_uses — the TOPICS POOL, whose whole
 *     job is that two agents in one office do not write the same article.
 *
 * WHAT WAS WRONG, and it was wrong in BOTH directions.
 *
 * 1. OVER-BLOCKING, ACROSS TENANTS. pickTopics(markUsed) set
 *    content_topic_bank.status='used' on the topic ROW. Rows with
 *    brokerage_id IS NULL are the PLATFORM-WIDE bank shared by every
 *    brokerage — so one agent at one brokerage consuming a topic removed it
 *    from every other brokerage's pool, permanently. Verified live: after
 *    brokerage ONE took the shared topic, brokerage TWO — a different tenant
 *    entirely — could see ZERO topics.
 *
 * 2. UNDER-BLOCKING, INSIDE THE OFFICE — the owner's actual rule. The claim
 *    ledger already existed (content_topic_uses records topic + brokerage +
 *    asset) and THE PICKER NEVER READ IT. The only de-duplication was that
 *    global row flag, which does not know which office claimed anything, and
 *    which callers set only when they happen to pass markUsed.
 *
 * m357 gives the claim an agent_id so it says WHO, and the picker now excludes
 * on the office-scoped ledger. Verified live on the same two rows: a second
 * agent in brokerage ONE is offered 0, brokerage TWO is offered 1.
 */
import { readFileSync, existsSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  existsSync(p)
    ? readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    : ""

const PICKER = "lib/content-intel/topic-bank.ts"
const LEDGER = "lib/content-intel/performance-aggregator.ts"
const picker = src(PICKER)
// topic-bank.ts is `server-only`, so the window is read from source rather than
// imported — importing it would drag a server module into this plain-node proof.
const OFFICE_CLAIM_WINDOW_DAYS = Number(
  /OFFICE_CLAIM_WINDOW_DAYS\s*=\s*(\d+)/.exec(picker)?.[1] ?? 0,
)
const ledger = src(LEDGER)

console.log("\n── the two ideas stay separate ──")
{
  // The KB brain is a retrieval corpus. If the picker ever reached into it, the
  // owner's "completely separate idea" would have been collapsed back together.
  check("the topic picker does not touch the KB brain",
    !/knowledge_articles/.test(picker))
  check("…and the claim ledger does not either",
    !/knowledge_articles/.test(ledger))
  check("the pool is its own pair of tables",
    /content_topic_bank/.test(picker) && /content_topic_uses/.test(ledger))
}

console.log("\n── the claim is read, not merely written ──")
{
  // THE DEFECT. The ledger existed and the picker ignored it.
  check("the picker reads the claim ledger", /from\("content_topic_uses"\)/.test(picker))
  check("…scoped to the asking office", /\.eq\("brokerage_id", args\.brokerageId\)/.test(picker))
  check("…within a window, so a topic is not burned forever",
    /\.gte\("used_at",/.test(picker) && OFFICE_CLAIM_WINDOW_DAYS > 0)
  check("…and the claimed topics are actually removed from the candidates",
    /rows = rows\.filter\(\(r\) => !taken\.has\(r\.id\)\)/.test(picker))

  // A lookup that fails must not silently mean "nothing is claimed" — that is
  // exactly how two agents in one office publish the same article.
  check("a failed claim lookup is reported, not swallowed into 'nothing claimed'",
    /claimErr/.test(picker) && /topics may repeat/.test(picker))
}

console.log("\n── one office can never drain another's bank ──")
{
  // Only a row the brokerage OWNS may be retired outright.
  check("markUsed retires only rows this brokerage owns",
    /scored\.filter\(\(t\) => t\.brokerage_id === args\.brokerageId\)/.test(picker))
  check("…and the update is itself brokerage-filtered, belt and braces",
    /\.update\(\{ status: "used" \}\)[\s\S]{0,160}?\.eq\("brokerage_id", args\.brokerageId\)/.test(picker))
  check("…while EVERY taken topic is claimed in the office ledger",
    /logTopicUses\(\{[\s\S]{0,200}?topicIds:\s*scored\.map/.test(picker))
  // The old behaviour, pinned out: a blanket update over every picked id.
  check("no blanket status update over every picked topic remains",
    !/\.update\(\{ status: "used" \}\)\s*\.in\("id", scored\.map/.test(picker))
}

console.log("\n── the claim says WHO (m357) ──")
{
  check("the picker accepts the claiming agent", /agentId\?:\s*string \| null/.test(picker))
  check("…and passes it to the ledger", /agentId:\s*args\.agentId/.test(picker))
  check("the ledger writes agent_id", /agent_id:\s*args\.agentId/.test(ledger))

  // supabase-js RESOLVES a rejected insert, so the old try/catch could never
  // fire — a lost claim looked identical to a recorded one.
  check("a failed claim insert is DETECTED, not left to an unreachable catch",
    /const \{ error \} = await svc\.from\("content_topic_uses"\)\.insert/.test(ledger) &&
    /topic claim NOT recorded/.test(ledger))
  check("…and the unreachable try/catch around it is gone",
    !/try \{\s*await svc\.from\("content_topic_uses"\)\.insert/.test(ledger))
}

console.log("\n── the pool's own vocabulary still matches the database ──")
{
  const status = CHECK_VOCABULARIES.content_topic_bank?.status ?? []
  if (status.length === 0) {
    check("content_topic_bank.status has no CHECK to drift from", true)
  } else {
    check("'fresh' and 'used' are both storable",
      status.includes("fresh") && status.includes("used"))
  }
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ TOPIC_CLAIM_SCOPE_FAIL"); process.exit(1) }
console.log(" ✅ TOPIC_CLAIM_SCOPE_PASS — the claim is office-scoped: same office blocked, other offices untouched")
