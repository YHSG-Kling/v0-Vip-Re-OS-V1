#!/usr/bin/env tsx
/**
 * scripts/lead-magnet-copy-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves LEAD-MAGNET + LANDING COPY — the AI writes the capture page AND the deliverable the user
 * gets for filling out the form (the missing piece: a magnet that actually DELIVERS something). The
 * deterministic copy is REAL content (never a stub) and Fair-Housing-safe; the gate seam can block.
 *
 * Layer 1 (shell, pure): landing copy per magnet type, deliverable content, FH-safety, the gate. No
 * mocks. (The delivery runner's DB record is exercised by the live wiring in captureFormSubmission.)
 *
 * Run: npx tsx scripts/lead-magnet-copy-simulator.ts   (npm run test:lead-magnet-copy)
 */
import { landingPageCopy, magnetDeliverableCopy, magnetHasDeliverable, prepareMagnetDeliverable, type MagnetType } from "../lib/marketing/lead-magnet-copy"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Lead-magnet copy verified — landing + deliverable written, Fair-Housing-safe, gate-able.")
  console.log(" LEAD_MAGNET_COPY_PASS")
  process.exit(0)
}

const ALL: MagnetType[] = ["home_valuation", "buyer_guide", "seller_guide", "market_report", "listing_alert", "open_house", "generic_form"]
// Fair-Housing / steering terms that must NEVER appear in marketing copy.
const FH_BANNED = /\b(family|families|kids|children|safe neighborhood|perfect for|christian|church|no kids|adults only|ideal for (a )?famil|exclusive neighborhood|great for retirees)\b/i

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lead-magnet + landing copy simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[landing copy — every magnet type]")
  for (const m of ALL) {
    const c = landingPageCopy(m, { area: "Austin", brand: "Acme Realty" })
    check(`${m}: headline + subhead + CTA + bullets`, !!c.headline && !!c.subhead && !!c.cta && c.bullets.length >= 1)
  }
  const hv = landingPageCopy("home_valuation", { area: "Austin", brand: "Acme Realty" })
  check("landing copy localizes area + brand", /Austin/.test(hv.subhead) && /Acme Realty/.test(hv.subhead))

  console.log("\n[deliverable content — the thing the user receives]")
  check("a buyer_guide has REAL deliverable content (not a stub)", magnetDeliverableCopy("buyer_guide").body.length > 120 && /pre-approved/.test(magnetDeliverableCopy("buyer_guide").body))
  check("home_valuation deliverable offers a precise CMA", /CMA|comparative market/i.test(magnetDeliverableCopy("home_valuation").body))
  check("generic_form ships no downloadable deliverable", !magnetHasDeliverable("generic_form"))
  check("open_house IS event info (has a deliverable)", magnetHasDeliverable("open_house"))

  console.log("\n[Fair-Housing safety — across ALL copy]")
  const allText = ALL.flatMap((m) => {
    const l = landingPageCopy(m, { area: "Austin" })
    const d = magnetHasDeliverable(m) ? magnetDeliverableCopy(m) : { subject: "", title: "", body: "" }
    return [l.headline, l.subhead, ...l.bullets, d.subject, d.title, d.body]
  }).join("  ")
  check("no Fair-Housing / steering language in any copy", !FH_BANNED.test(allText), allText.match(FH_BANNED)?.[0])

  console.log("\n[prepare deliverable — gated]")
  const prepared = await prepareMagnetDeliverable("seller_guide", { brand: "Acme" }, {})
  check("prepares the deliverable with the deterministic copy", !!prepared && /pricing strategy/i.test(prepared.body) && /Acme/.test(prepared.body))
  const blocked = await prepareMagnetDeliverable("seller_guide", undefined, { gate: async () => ({ allowed: false, violations: ["test block"] }) })
  check("a failing gate blocks delivery (returns null)", blocked === null)
  const noDeliverable = await prepareMagnetDeliverable("generic_form", undefined, {})
  check("generic_form prepares no deliverable", noDeliverable === null)

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
