#!/usr/bin/env tsx
/**
 * scripts/repurpose-shorts-simulator.ts   (npm run test:repurpose-shorts)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AUTONOMOUS, MANAGED repurpose loop — repurposing moved off the manual snippets/
 * repurpose UI onto the manager bus. When a BROADCAST reel completes, the Campaign Orchestrator
 * hands off to the Asset Manager, which cuts platform shorts for the social channels the primary
 * didn't cover — via the Director/commissionVideo pipeline (real render + bookends + QR + gating).
 *
 * PURE core (this file): the DECISION layer —
 *   • isRepurposableVideo: broadcast marketing only; NOT a 1:1 lead/contact reel; NOT an
 *     already-repurposed variant (recursion guard via the director_key ':repurpose:' marker).
 *   • planRepurposeChannels: the short channels the primary didn't cover (no wasted render).
 *   • repurposeDiscriminator: makes each variant a DISTINCT commission (not a dedupe).
 * The signal (repurpose_shorts_handoff) is catalogued + handler-backed (test:signal-integrity),
 * and commissionVideo's render/gate path is covered by test:video-director.
 */
import { isRepurposableVideo, planRepurposeChannels, repurposeDiscriminator, SHORT_CHANNELS } from "../lib/video/repurpose-planner"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[isRepurposableVideo — broadcast marketing only]")
  check("a horizontal youtube broadcast reel IS repurposable", isRepurposableVideo({ directorKey: "director:just_listed:L1", targetChannels: ["youtube", "facebook"], audience: null }))
  check("a tiktok/instagram broadcast reel IS repurposable (has broadcast channels)", isRepurposableVideo({ directorKey: "director:just_sold:L1", targetChannels: ["tiktok", "instagram"], audience: null }))
  check("a 1:1 LEAD reel is NOT repurposable", !isRepurposableVideo({ directorKey: "director:lead_intro:LD1", targetChannels: ["email"], audience: "lead" }))
  check("an email/portal-only reel is NOT repurposable (not broadcast)", !isRepurposableVideo({ directorKey: "director:anniversary:C1", targetChannels: ["email", "portal"], audience: null }))
  check("a video with no director_key is NOT repurposable", !isRepurposableVideo({ directorKey: null, targetChannels: ["tiktok"], audience: null }))

  console.log("\n[recursion guard — a repurpose VARIANT never repurposes again]")
  check("a variant (director_key carries :repurpose:) is NOT repurposable", !isRepurposableVideo({ directorKey: "director:just_listed:L1:repurpose:tiktok", targetChannels: ["tiktok"], audience: null }))

  console.log("\n[planRepurposeChannels — only the uncovered short channels]")
  check("youtube/facebook horizontal → cut tiktok + instagram", JSON.stringify(planRepurposeChannels({ directorKey: "d", targetChannels: ["youtube", "facebook"], audience: null })) === JSON.stringify(["tiktok", "instagram"]))
  check("already covers tiktok → cut only instagram", JSON.stringify(planRepurposeChannels({ directorKey: "d", targetChannels: ["youtube", "tiktok"], audience: null })) === JSON.stringify(["instagram"]))
  check("already covers both short channels → cut NOTHING (no wasted render)", planRepurposeChannels({ directorKey: "d", targetChannels: ["tiktok", "instagram"], audience: null }).length === 0)

  console.log("\n[repurposeDiscriminator — distinct commission per channel]")
  check("tiktok → 'repurpose:tiktok'", repurposeDiscriminator("tiktok") === "repurpose:tiktok")
  check("instagram → 'repurpose:instagram'", repurposeDiscriminator("instagram") === "repurpose:instagram")
  check("discriminator makes the variant director_key carry :repurpose: (feeds the recursion guard)", `director:k:e:${repurposeDiscriminator("tiktok")}`.includes(":repurpose:"))

  console.log("\n[invariants]")
  check("SHORT_CHANNELS are the vertical social channels", JSON.stringify([...SHORT_CHANNELS]) === JSON.stringify(["tiktok", "instagram"]))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ REPURPOSE_SHORTS_FAIL"); process.exit(1) }
  console.log(" ✅ REPURPOSE_SHORTS_PASS — managers autonomously cut platform shorts from broadcast reels; no manual UI, no recursion")
}
main()
