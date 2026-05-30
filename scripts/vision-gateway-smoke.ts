/**
 * scripts/vision-gateway-smoke.ts
 *
 * One-shot smoke test for the Vision → Vercel AI Gateway path. The code-review flagged that the
 * URL-image content shape (`{type:"image_url", image_url:{url}}`) depends on the gateway's
 * OpenAI→Anthropic translator for Claude routes and there's no local way to verify it without a
 * real key. This script makes one cheap Haiku call against a known-public test image and prints
 * the structured response so you can confirm the path end-to-end on YOUR env before relying on it.
 *
 * Run: `npx tsx scripts/vision-gateway-smoke.ts`
 * Requires: AI_GATEWAY_API_KEY (skips cleanly with a clear message when unset).
 */
import { scorePropertyImage } from "../lib/external/vision-property"

const TEST_IMAGE_URL = process.env.VISION_SMOKE_IMAGE_URL
  ?? "https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=512"  // small public house photo

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.log("⏭  Skip: AI_GATEWAY_API_KEY is not set in this env.")
    console.log("   Set it and re-run to verify the Vision → AI-Gateway path end-to-end.")
    process.exit(0)
  }
  console.log(`▶  Calling scorePropertyImage on ${TEST_IMAGE_URL}`)
  console.log(`   model = ${process.env.VISION_PROPERTY_MODEL ?? "anthropic/claude-haiku-4-5-20251001"}`)
  console.log("")

  const t0 = Date.now()
  const r = await scorePropertyImage({ imageUrl: TEST_IMAGE_URL, context: "smoke test — generic stock house photo" })
  const ms = Date.now() - t0

  if (r.error) {
    console.error(`✗ FAIL after ${ms}ms — ${r.error}`)
    console.error("  Likely causes:")
    console.error("    • Gateway can't translate URL images for this model slug → try a different model or use base64 data URLs")
    console.error("    • AI_GATEWAY_API_KEY invalid / not authorized for this model")
    console.error("    • Network egress blocked")
    process.exit(1)
  }

  console.log(`✓ OK in ${ms}ms`)
  console.log(`  motivationBoost = ${r.motivationBoost}`)
  console.log(`  conditionScore  = ${r.conditionScore}`)
  console.log(`  stagingScore    = ${r.stagingScore}`)
  console.log(`  signals         = ${JSON.stringify(r.signals)}`)
  console.log(`  rationale       = ${r.rationale}`)
  console.log("")
  console.log(`✓ Vision-via-Gateway path is healthy on this env.`)
  process.exit(0)
}

main().catch((e) => { console.error("THREW:", e); process.exit(2) })
