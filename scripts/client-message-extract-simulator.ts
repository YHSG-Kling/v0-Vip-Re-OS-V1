#!/usr/bin/env tsx
/**
 * scripts/client-message-extract-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 47 — proves EVERY client-facing manager's output is extracted into the
 * governed client-message gate, regardless of each manager's field names. Pure →
 * runs in CI. (The send path is covered by client-message-gate-simulator.)
 *
 * Run: npx tsx scripts/client-message-extract-simulator.ts  (npm run test:client-extract)
 */
import { extractClientMessages, GATED_CLIENT_MANAGERS } from "../lib/agents/extract-client-messages"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Client-message extractor simulator (all 5 managers → one gate)")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[gated set]")
  for (const k of ["listing_concierge", "deal_coordinator", "shopping_agent", "sphere_of_influence", "campaign_orchestrator"])
    check(`${k} is gated`, GATED_CLIENT_MANAGERS.has(k))
  check("marketing_agent is NOT gated (internal resolutions only)", !GATED_CLIENT_MANAGERS.has("marketing_agent"))

  console.log("\n[per-manager extraction]")
  const lc = extractClientMessages({ seller_update: "Your home got 12 showings this week." })
  check("listing_concierge → 1 seller message", lc.length === 1 && lc[0].audience === "seller")

  const dc = extractClientMessages({ seller_update: "Seller note", buyer_update: "Buyer note" })
  check("deal_coordinator → seller + buyer", dc.length === 2 && dc.some(d => d.audience === "seller") && dc.some(d => d.audience === "buyer"))

  const sa = extractClientMessages({ buyer_digest: "3 new homes match your search." })
  check("shopping_agent buyer_digest → buyer message", sa.length === 1 && sa[0].audience === "buyer")

  const sphere = extractClientMessages({ opportunities: [
    { contact_id: "c1", draft_message: "It's been a year since your purchase — happy anniversary!" },
    { contact_id: "c2", message: "Rates dropped — worth a refi look?" },
    { contact_id: "c3" }, // no draft → skipped
  ] })
  check("sphere opportunities[] → one message per draft (empty skipped)", sphere.length === 2 && sphere.every(d => d.audience === "lead" && !!d.recipientContactId))

  const camp = extractClientMessages({ campaigns: [
    { contact_id: "c4", channel: "email", draft_subject: "Spring market update", draft_body: "Here's what's happening locally." },
    { contact_id: "c5", channel: "sms", body: "Quick market note for you." },
  ] })
  check("campaign campaigns[] → one message per draft with subject/contact/channel", camp.length === 2 && camp[0].subject === "Spring market update" && camp[0].recipientContactId === "c4" && camp[1].channel === "sms")

  console.log("\n[safety]")
  check("no parsed object → no drafts (plain text handled by webhook fallback)", extractClientMessages(null).length === 0)
  check("internal-only fields (agent_briefing) are NOT extracted", extractClientMessages({ agent_briefing: "internal note" }).length === 0)
  check("empty strings are not proposed", extractClientMessages({ seller_update: "   " }).length === 0)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ All 5 client-facing managers route every client message through the one gate")
}
main()
