#!/usr/bin/env tsx
/**
 * scripts/delivery-format-simulator.ts   (npm run test:delivery-format)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves DELIVERY FORMAT is baked into the business process: the MATERIAL picks the format (not every
 * lesson is a video), a format the CONTACT STATED then wins (wave 145, owner ruling 18 — never their age
 * group; the band matrix is tombstoned), and the VOICE follows the audience (agent's own voice for a
 * client, assistant voice for an agent). Pure.
 *
 * PURE:   resolveMaterialFormat + channelsForFormat + voiceForAudience + resolveContactDeliveryFormat.
 * SOURCE: the three education authors set channels from the material format (not hardcoded article).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveMaterialFormat, channelsForFormat, voiceForAudience, resolveContactDeliveryFormat, isVideoFormat } from "../lib/education/delivery-format"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[resolveMaterialFormat · pure — not everything is a video]")
  check("an emotional/complex explainer → video (under-contract next steps)", resolveMaterialFormat({ topicKey: "client:buyer:offer_accepted" }) === "video" || resolveMaterialFormat({ topicKey: "buyer_offer_accepted" }) === "video")
  check("the platform tour → video (orientation)", resolveMaterialFormat({ topicKey: "platform_tour" }) === "video")
  check("a procedural step-list → checklist (first-30-days)", resolveMaterialFormat({ topicKey: "buyer_closed" }) === "checklist")
  check("everything else → guide (default, not video)", resolveMaterialFormat({ topicKey: "guidance_essentials" }) === "guide" && resolveMaterialFormat({ topicKey: "objection:price" }) === "guide")
  check("channelsForFormat: only video renders on the video channel", channelsForFormat("video")[0] === "video" && channelsForFormat("guide")[0] === "article" && channelsForFormat("checklist")[0] === "article")
  check("isVideoFormat guards the render pipeline", isVideoFormat("video") && !isVideoFormat("guide"))

  console.log("\n[voiceForAudience · pure — whose voice]")
  check("a CONTACT-facing video speaks in the AGENT's own voice", voiceForAudience(["customer"]) === "agent_own")
  check("an AGENT-facing video speaks in the ASSISTANT voice", voiceForAudience(["agent"]) === "assistant" && voiceForAudience(["broker"]) === "assistant")

  // WAVE 145 (lane 145H, owner ruling 18 — 2026-10-27): RE-ASSERTED AS THE RULE. This block pinned "gauged by age
  // group" (a video explainer became a checklist for a 65+ contact). Ruling 18: what the PERSON stated, never an age.
  console.log("\n[resolveContactDeliveryFormat · pure — what the person STATED, else the material's own (never an age)]")
  check("nothing stated → the material keeps its own format (a video explainer stays video)", resolveContactDeliveryFormat(null, "video") === "video")
  check("…and a guide stays a guide", resolveContactDeliveryFormat(undefined, "guide") === "guide")
  check("POSITIVE CONTROL — a format the PERSON stated wins (prefers a checklist → checklist)", resolveContactDeliveryFormat("checklist", "video") === "checklist")
  check("the resolver takes no age: its first parameter is a stated FORMAT", !/AgeSegment/.test(readFileSync(join(process.cwd(), "lib/education/delivery-format.ts"), "utf8").split("export function resolveContactDeliveryFormat")[1]?.split("\n")[0] ?? "AgeSegment"))
}

function sourceLayer() {
  console.log("\n[wiring — authors set channels by material format, not hardcoded article]")
  for (const f of ["lib/education/curriculum-author.ts", "lib/education/onboarding-authoring.ts", "lib/education/client-education-authoring.ts"]) {
    const s = src(f)
    check(`${f.split("/").pop()} sets channels from the material format`, /channels: channelsForFormat\(resolveMaterialFormat\(/.test(s) && !/channels: \["article"\]/.test(s))
  }
  const setting = src("app/actions/settings/revenue-share-setting.ts")
  check("solo agent can toggle revenue share (not just broker/admin)", /plan_tier === "solo_agent"/.test(setting) && /isSolo/.test(setting))
  const lm = src("app/actions/learning-modules.ts")
  check("module→video publish records the voice by audience (agent-own vs assistant)", /voiceForAudience\(mod\.audience_roles/.test(lm) && /voice: voiceKind/.test(lm))
}

function main() {
  pureLayer()
  sourceLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ DELIVERY_FORMAT_FAIL"); process.exit(1) }
  console.log(" ✅ DELIVERY_FORMAT_PASS — the material picks the format, a stated preference wins (never an age); voice follows the audience")
}
main()
