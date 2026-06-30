#!/usr/bin/env tsx
/**
 * scripts/client-testimonial-simulator.ts   (npm run test:client-testimonial)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the in-app testimonial validation: a TEXT testimonial needs real words (trimmed + clamped); a
 * VIDEO testimonial needs a valid uploaded URL; empties/garbage are rejected with a friendly reason.
 * Pure: no I/O.
 */
import { validateTestimonialSubmission } from "../lib/testimonials/testimonial-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[text testimonial]")
  const good = validateTestimonialSubmission({ kind: "text", body: "  Best agent we've ever worked with — made it easy.  " })
  check("real words → ok, trimmed", good.ok && good.cleanBody === "Best agent we've ever worked with — made it easy.")
  check("too short → rejected with a reason", validateTestimonialSubmission({ kind: "text", body: "great" }).ok === false)
  check("empty → rejected", validateTestimonialSubmission({ kind: "text", body: "   " }).ok === false)
  const long = validateTestimonialSubmission({ kind: "text", body: "x".repeat(3000) })
  check("very long body clamped to <=1500", (long.cleanBody?.length ?? 0) <= 1500)

  console.log("\n[video testimonial]")
  check("valid https video url → ok (no text body)", (() => { const r = validateTestimonialSubmission({ kind: "video", videoUrl: "https://blob.example.com/t/abc.mp4" }); return r.ok && r.cleanBody === null })())
  check("missing video url → rejected", validateTestimonialSubmission({ kind: "video", videoUrl: "" }).ok === false)
  check("non-url string → rejected", validateTestimonialSubmission({ kind: "video", videoUrl: "not-a-url" }).ok === false)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CLIENT_TESTIMONIAL_FAIL"); process.exit(1) }
  console.log(" ✅ CLIENT_TESTIMONIAL_PASS — text + video testimonials validated; garbage rejected kindly")
}
main()
