#!/usr/bin/env tsx
/**
 * scripts/market-pulse-simulator.ts   (npm run test:market-pulse)
 * ─────────────────────────────────────────────────────────────────────────────
 * MARKET PULSE — proves the seller-safe distillation: the sanitizer keeps well-formed insights, DROPS
 * unsafe/raw forum content (profanity, doom, Fair-Housing-adjacent), clamps lengths, falls back when
 * nothing usable survives; the prompt instructs seller-safe JSON; the week key is a stable Monday; the
 * fallback floor is honest + actionable. Pure: no I/O.
 */
import { sanitizeMarketPulse, marketPulseWeek, buildMarketPulsePrompt, FALLBACK_MARKET_PULSE } from "../lib/listings/market-pulse"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Sanitizer keeps good insights, drops unsafe ones]")
  const good = sanitizeMarketPulse({ headline: "What buyers want now", insights: [
    { priority: "Move-in ready", detail: "Buyers want little work.", sellerAngle: "Finish small touch-ups." },
    { priority: "This market is a SCAM", detail: "people are getting screwed", sellerAngle: "x" }, // unsafe → dropped
    { priority: "Energy efficiency", detail: "Lower bills draw buyers.", sellerAngle: "Highlight efficient systems." },
  ] }, "2026-06-22")
  check("returns a pulse when good insights exist", good !== null)
  check("drops the unsafe insight (scam/screwed)", good!.insights.length === 2)
  check("keeps the safe ones", good!.insights.map((i) => i.priority).join() === "Move-in ready,Energy efficiency")

  console.log("\n[All-unsafe / malformed → null (caller uses the fallback)]")
  check("all-unsafe → null", sanitizeMarketPulse({ headline: "x", insights: [{ priority: "fraud", detail: "lawsuit hell", sellerAngle: "z" }] }, "2026-06-22") === null)
  check("empty insights → null", sanitizeMarketPulse({ headline: "x", insights: [] }, "2026-06-22") === null)
  check("non-object → null", sanitizeMarketPulse("nope", "2026-06-22") === null)
  check("missing priority/detail dropped → null", sanitizeMarketPulse({ insights: [{ sellerAngle: "only angle" }] }, "2026-06-22") === null)

  console.log("\n[Clamping + week key + prompt + fallback]")
  const longIn = sanitizeMarketPulse({ headline: "h".repeat(200), insights: [{ priority: "p".repeat(100), detail: "d".repeat(300), sellerAngle: "" }] }, "2026-06-22")
  check("headline clamped to <=80", (longIn?.headline.length ?? 0) <= 80)
  check("priority clamped to <=40", (longIn?.insights[0].priority.length ?? 0) <= 40)
  check("missing sellerAngle gets a safe default", !!longIn?.insights[0].sellerAngle)
  check("week key is the Monday of the week", marketPulseWeek(new Date("2026-06-24T12:00:00Z")) === "2026-06-22")
  check("prompt instructs seller-safe + JSON + no Fair Housing", /SELLER-SAFE/.test(buildMarketPulsePrompt(["a"])) && /Fair Housing/.test(buildMarketPulsePrompt(["a"])) && /valid JSON/.test(buildMarketPulsePrompt(["a"])))
  check("fallback floor is honest + has 3 actionable insights", FALLBACK_MARKET_PULSE.insights.length === 3 && FALLBACK_MARKET_PULSE.insights.every((i) => i.priority && i.detail && i.sellerAngle))
  check("fallback is marked not-generated (it's the floor)", FALLBACK_MARKET_PULSE.generated === false)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MARKET_PULSE_FAIL"); process.exit(1) }
  console.log(" ✅ MARKET_PULSE_PASS — buyer sentiment distilled into a seller-safe, never-raw, actionable pulse")
}
main()
