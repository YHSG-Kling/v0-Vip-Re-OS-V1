#!/usr/bin/env tsx
/**
 * scripts/video-lanes-audit-guard.ts   (npm run test:video-lanes-audit) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY VIDEO LANE HAS BOTH HALVES — A PRODUCER THAT FIRES ON ITS OWN AND A
 * COMPLETER THAT LANDS THE FILE — ACROSS EVERY ENGINE.
 *
 * Owner, 2026-09-07: "make sure that all remotion videos, did avatar, etc.
 * (more than just listing videos like education, persona based and/or videos
 * that can go viral but still pertaining to real estate; also need to take into
 * consideration videos for pulling in new customers to the platform itself) are
 * created correctly by using the skills."
 *
 * Proved:
 *  (1) HANDOFFS HAVE EMITTERS. Every `*_reel_handoff` / `*_creative_handoff`
 *      signal the registry routes to asset_manager is PUBLISHED somewhere in
 *      product code — the shape that was missing for contact_reel_handoff
 *      (handled since wave 41, emitted by nothing) and content_winner (w37).
 *  (2) PERSONA: the stale-contact re-engagement (ai_isa) delegates the
 *      situational reel to the Asset Manager on a successful re-engagement.
 *  (3) EDUCATION: the stage-matched lesson delivery also commissions the lesson
 *      as an avatar-led explainer reel through the ONE video door, idempotent
 *      per (contact, module), gated.
 *  (4) PLATFORM ACQUISITION: the product video draft queues its ProductPromoReel
 *      render through the ONE render registry, the post-render hook attaches
 *      the file to the draft, and a Monday cron drives the week's calendar +
 *      one video without a superadmin pressing anything — all still gated.
 *  (5) VIRAL: the script-share rule fires at the view threshold, not by hand.
 *  (6) D-ID: a video twin cannot reach D-ID without a recorded consent (428).
 *  (7) LISTING VOICEOVER: the route both queues a render and has a caller (w38).
 *  (8) Every Director situation kind maps to a registered composition.
 *
 * BLIND SPOTS (§2): static. Render success on Remotion Lambda and D-ID's
 * verification are provider round-trips this proof cannot make; the Monday cron
 * is registered, not observed firing.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (e === "node_modules" || e.startsWith(".")) continue
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}
const PRODUCT = [...walk("lib"), ...walk("app")].filter((p) => !p.includes("/lead-pipeline/") && !p.includes("/external/"))
const productCorpus = PRODUCT.map((p) => src(p)).join("\n")

/** An emitter of signal `sig`: `signalType: "sig"`, or `signalType = … ? "sig" : "…"` on one line. */
function emitterRegex(sig: string): RegExp {
  return new RegExp(`signalType\\s*[:=][^\\n;]*?['"]${sig}['"]`)
}

const REGISTRY = src("lib/kernel/signal-registry.ts")
const SIGNALS  = src("lib/kernel/manager-signals.ts")
const STALE    = src("app/api/cron/stale-contact-monitor/route.ts")
const EDU      = src("lib/agents/education-delivery-producer.ts")
const AUTO     = src("lib/platform/product-content-autopilot.ts")
const PCONTENT = src("app/actions/superadmin/platform-content.ts")
const RENDER   = src("app/api/internal/remotion/render-composition/route.ts")
const CRON     = src("lib/kernel/cron-dispatch.ts")
const MREG     = src("lib/kernel/manager-registry.ts")
const VIRAL    = src("app/actions/video-generation.ts")
const DIRECTOR = src("lib/video/video-director.ts")
const ROOT     = readFileSync("remotion/Root.tsx", "utf8")
const VOICEOVER = src("app/api/videos/listing-voiceover/route.ts")
const GENSCRIPT  = src("app/actions/video/generate-script.ts")
const EXPLAINER  = src("lib/video/avatar-explainer.ts")
const BVPROMPT   = src("lib/ai-isa/brand-voice-prompt.ts")
const APPROVALS_ACTION = src("app/actions/marketing-ai-approvals.ts")
const APPROVALS_CLIENT = src("app/dashboard/admin/marketing-approvals/marketing-approvals-client.tsx")

console.log("══════════════════════════════════════════════════")
console.log(" Video lanes — every engine, both halves")
console.log("══════════════════════════════════════════════════")

console.log("\n── 1 · every asset_manager handoff signal has an EMITTER ──")
const handoffs = Array.from(REGISTRY.matchAll(/^\s*([a-z_]+_(?:reel|creative)_handoff):\s*\{ consumers: \[([^\]]*)\]/gm))
  .filter((m) => m[2].includes("asset_manager")).map((m) => m[1])
check("the registry routes at least four reel/creative handoffs to asset_manager", handoffs.length >= 4, handoffs.join(", "))
for (const sig of handoffs) {
  const handled = new RegExp(`"asset_manager:${sig}"`).test(SIGNALS)
  // The emitter may spell the type as a literal (`signalType: "x"`) OR pick it in a
  // ternary on the same line (`const signalType = cond ? "x" : "y"` —
  // lib/kernel/manager-signals.ts:routeSavedHomeNudge does exactly that). The
  // first cut of this proof matched only the literal and reported
  // saved_home_reel_handoff as emitter-less while the emitter stood — a
  // duplicate emitter was then written before the survivor was found (§1.1).
  const emitted = emitterRegex(sig).test(productCorpus)
  check(`${sig}: handled AND emitted (a handler with no emitter is the orphan shape)`, handled && emitted, `handled=${handled} emitted=${emitted}`)
}
check("content_winner (w37) is emitted too", /signalType: "content_winner"/.test(productCorpus))

console.log("\n── 2 · persona: re-engagement delegates the situational reel ──")
check("the stale-contact monitor publishes contact_reel_handoff ai_isa → asset_manager on a SUCCESSFUL re-engagement",
  /if \(result\.success\) \{[\s\S]{0,700}signalType: 'contact_reel_handoff'/.test(STALE) && /fromManager: 'ai_isa'[\s\S]{0,60}toManager: 'asset_manager'/.test(STALE))
check("…keyed on the contact (entityType contact, contactId) so the bus dedupes per open signal", /entityType: 'contact',\s*entityId: contact\.id,\s*contactId: contact\.id/.test(STALE))
check("…and a publish failure is logged, never fatal to the sweep", /contact_reel_handoff publish failed/.test(STALE))

console.log("\n── 3 · education: the lesson is also a gated explainer reel ──")
check("the delivery commissions through the ONE video door (commissionVideo), after the written proposal succeeded",
  /if \(!res\.ok\) return \{ proposed: false, reason: res\.error \}[\s\S]{0,1500}commissionVideo\(/.test(EDU))
check("…as the informational reel situation (Director kind explainer → video_type education)", /buildInformationalReelSituation\(\{[\s\S]{0,200}topicTitle: chosen\.title/.test(EDU) && /case "explainer":\s*return "education"/.test(DIRECTOR))
check("…idempotent per (contact, module) and fronted by the assigned agent", /idempotencyDiscriminator: `education_module:\$\{chosen\.id\}`/.test(EDU) && /resolveContactPresenterUserId\(supabase, contactId, brokerageId\)/.test(EDU))
check("…and a reel failure leaves the lesson proposal standing", /lesson reel commission failed \(lesson proposal stands\)/.test(EDU))

console.log("\n── 4 · platform acquisition: the product video renders itself, weekly, gated ──")
check("the video draft action queues the render through the one registry instead of a CLI paste", /queueProductVideoRender\(svc, \{ draftId: \(data as any\)\.id, requestedVia: "manual" \}\)/.test(PCONTENT))
check("…and the calendar action delegates to the shared writer (one body for button and cron)", /writeWeeklyProductCalendar\(svc, \{ startDateIso, createdBy: auth\.userId \}\)/.test(PCONTENT) && !/buildWeeklyProductCalendar\(/.test(PCONTENT))
check("the autopilot queues ProductPromoReel via recordRenderQueued with entity_type platform_social_draft, idempotent per draft",
  /recordRenderQueued\(\{[\s\S]{0,300}entityType: PLATFORM_SOCIAL_DRAFT_ENTITY/.test(AUTO) && /PLATFORM_SOCIAL_DRAFT_ENTITY = "platform_social_draft"/.test(AUTO) && /render already queued/.test(AUTO))
check("…under the platform's house tenant (renders need a brokerage row; DEMO_CONFIG.BROKERAGE_ID is the seeded one)", /PLATFORM_HOUSE_BROKERAGE_ID = DEMO_CONFIG\.BROKERAGE_ID/.test(AUTO))
check("the post-render hook attaches video_url to the draft and COUNTS the update (§3)", /entity_type === "platform_social_draft"[\s\S]{0,600}\.select\("id"\)[\s\S]{0,400}matched no row/.test(RENDER))
check("the Monday cron is registered and owned", /"\/api\/cron\/platform-product-autopilot"\s*,\s*schedule: "0 13 \* \* 1"/.test(CRON) && /"\/api\/cron\/platform-product-autopilot": "campaign_orchestrator"/.test(MREG)) // m618: survivor of the retired marketing_agent seat
check("…drafts stay gated: nothing here posts (status draft only, no permalink written)", /status: "draft"/.test(AUTO) && !/status: "posted"|permalink/.test(AUTO))
check("…the reel is the registered composition (remotion-best-practices: one renderer)", /ProductPromoReel/.test(ROOT) && /compositionId: spec\.compositionId/.test(AUTO))

console.log("\n── 5 · viral: the share rule fires at the view threshold ──")
check("shareViralScriptWithBrokerage is called from the view-tracking path, not a button", /shareViralScriptWithBrokerage\(tracking\.video_project_id\)/.test(VIRAL))

console.log("\n── 6 · D-ID: consent before any twin ──")
const CREATE_AVATAR = src("app/api/did/create-avatar/route.ts")
check("create-avatar refuses a video twin without a recorded consent (428)", /428/.test(CREATE_AVATAR) && /consent/i.test(CREATE_AVATAR))

console.log("\n── 7 · listing voiceover has both halves (w38) ──")
check("the route queues a render through the registry", /recordRenderQueued\(/.test(VOICEOVER) && /PhotoWalkthroughReel/.test(VOICEOVER))
check("…and a caller POSTs it", /\/api\/videos\/listing-voiceover/.test(src("app/dashboard/videos/create/video-create-client.tsx")))

console.log("\n── 8 · every Director situation kind maps to a registered composition ──")
const kindBlock = DIRECTOR.slice(DIRECTOR.indexOf("export type SituationKind ="), DIRECTOR.indexOf("\n\n", DIRECTOR.indexOf("export type SituationKind =")))
const kinds = Array.from(kindBlock.matchAll(/\|\s*"([a-z_]+)"/g)).map((m) => m[1])
const compIds = Array.from(ROOT.matchAll(/id="([A-Za-z0-9_-]+)"/g)).map((m) => m[1])
check("the Root registers the compositions the Director names", compIds.length >= 30 && ["AgentExplainerReel", "ExplainerAnimReel", "PhotoWalkthroughReel", "ProductPromoReel", "TestimonialReel", "MarketUpdateReel"].every((id) => compIds.includes(id)))
check("videoTypeForSituation is TOTAL over the situation kinds (no kind falls out of the vocabulary)",
  kinds.length >= 10 && kinds.every((k) => new RegExp(`case "${k}":`).test(DIRECTOR)), kinds.filter((k) => !new RegExp(`case "${k}":`).test(DIRECTOR)).join(", "))

console.log("\n── 9 · owner ruling 2026-09-08: no video nudges for under contract ──")
const REACTOR = src("lib/kernel/event-reactor.ts")
const NUDGE   = src("lib/ai-isa/saved-home-nudge.ts")
check("the reactor never auto-dispatches the under_contract promo video",
  /if \(eventType !== "under_contract"\) \{[\s\S]{0,300}dispatchListingPromoVideo\(/.test(REACTOR))
check("…while the saved-home path can still note it (a portal message, never a reel): the classifier rules under_contract non-avatar",
  /NO_VIDEO_NUDGE_KINDS[^=]*=\s*\["under_contract"\]/.test(NUDGE) && /NO_VIDEO_NUDGE_KINDS as readonly string\[\]\)\.includes\(nudge\.kind\)\) return \{ \.\.\.nudge, avatarWorthy: false \}/.test(NUDGE))
check("…and routeSavedHomeNudge picks the bus from that flag alone", /const toManager = nudge\.avatarWorthy \? "asset_manager" : "campaign_orchestrator"/.test(SIGNALS))

console.log("\n── 10 · brand-voice cascade: one vocabulary across the video lane (§6, wave 60E) ──")
// BEFORE this lane: generate-script.ts's tone came only from
// buildComplianceSystemBlocks → script-compliance.ts's OWN brand_voice_profile
// read; avatar-explainer.ts had a second, private brand_voice_profile read;
// video-director.ts's hook drafted with no brand-voice input at all and both
// insert sites wrote brand_voice_context: {}. AFTER: all three call the ONE
// cascade (lib/ai-isa/brand-voice-prompt.ts:73 loadBrandVoicePrompt).
const emptyContextWrites =
  (GENSCRIPT.match(/brand_voice_context:\s*\{\}/g) ?? []).length +
  (EXPLAINER.match(/brand_voice_context:\s*\{\}/g) ?? []).length +
  (DIRECTOR.match(/brand_voice_context:\s*\{\}/g) ?? []).length
console.log(`  (before this wave: 3 empty brand_voice_context: {} writes across avatar-explainer.ts + video-director.ts x2 — after: ${emptyContextWrites})`)
check("generate-script.ts calls the ONE cascade for its tone/system-block", /loadBrandVoicePrompt\(\{\s*brokerageId/.test(GENSCRIPT))
check("…and no longer reads brand_voice_profile directly (script-compliance.ts's shared compliance-tone read is untouched, out of this lane's scope)",
  !/\.from\(\s*["']brand_voice_profile["']\s*\)/.test(GENSCRIPT))
check("avatar-explainer.ts calls the cascade instead of its own private brand_voice_profile read", /loadBrandVoicePrompt\(\{\s*brokerageId/.test(EXPLAINER))
check("…and no longer reads brand_voice_profile directly", !/\.from\(\s*["']brand_voice_profile["']\s*\)/.test(EXPLAINER))
check("video-director.ts loads the cascade before drafting a hook (both commission paths)",
  (DIRECTOR.match(/loadBrandVoicePrompt\(\{/g) ?? []).length >= 2)
check("NEITHER remaining video writer stamps an empty brand_voice_context (avatar-explainer + video-director x2)", emptyContextWrites === 0, `${emptyContextWrites} empty writes remain`)
check("the survivor exports the ONE video-context shaper both writers call", /export function brandVoiceContextForVideo/.test(BVPROMPT))
check("…called by all three writers (generate-script has no brand_voice_context column, so 2 is correct: avatar-explainer + video-director)",
  (EXPLAINER.match(/brandVoiceContextForVideo\(/g) ?? []).length >= 1 && (DIRECTOR.match(/brandVoiceContextForVideo\(/g) ?? []).length >= 2)
console.log("\n── 11 · the reader: brand_voice_context is now READ, not write-only ──")
check("the marketing-approvals queue selects brand_voice_context off ai_video_projects",
  /\.from\("ai_video_projects"\)[\s\S]{0,300}brand_voice_context/.test(APPROVALS_ACTION))
check("…and maps it onto the row the client renders (PendingAssetRow.brand_voice)", /brand_voice:\s*\(\(\)\s*=>/.test(APPROVALS_ACTION))
check("…and the review card actually displays tone/tagline to the human approver", /r\.brand_voice\.tone/.test(APPROVALS_CLIENT) && /r\.brand_voice\.tagline/.test(APPROVALS_CLIENT))

console.log("\n── CONTROLS ──")
check("POSITIVE CONTROL: the brand_voice_profile scanner still catches a direct read (a tombstone naming it must not un-catch it)",
  /\.from\(\s*["']brand_voice_profile["']\s*\)/.test('  const { data } = await supabase\n    .from("brand_voice_profile")\n    .select("tone")')
  && !/\.from\(\s*["']brand_voice_profile["']\s*\)/.test(stripComments('  // .from("brand_voice_profile") — TOMBSTONE, merged onto loadBrandVoicePrompt\n')))
check("POSITIVE CONTROL: the empty-context scanner still catches the old defect shape",
  (("brand_voice_context: {},".match(/brand_voice_context:\s*\{\}/g) ?? []).length === 1))
check("POSITIVE CONTROL: the emitter finder catches a literal publish, a same-line ternary, and ignores a comment",
  emitterRegex("x_reel_handoff").test('publishManagerSignal({ signalType: "x_reel_handoff" })')
  && emitterRegex("x_reel_handoff").test('const signalType = nudge.avatarWorthy ? "x_reel_handoff" : "x_message"')
  && emitterRegex("x_message").test('const signalType = nudge.avatarWorthy ? "x_reel_handoff" : "x_message"')
  && !emitterRegex("x_reel_handoff").test('const signalType = "other"\nconst x = "x_reel_handoff"')
  && !emitterRegex("x_reel_handoff").test(stripComments('// signalType: "x_reel_handoff"\n')))
check("BLINDNESS CONTROL: scans read comment-STRIPPED source", !stripComments("// recordRenderQueued(\n").includes("recordRenderQueued"))

console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS (§2): static; provider round-trips (Remotion render, D-ID verification) and the cron firing are not observed here.")
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(`\n RESULT: ${pass} passed, ${fails.length} failed`)
if (fails.length > 0) { console.log(" ❌ VIDEO_LANES_AUDIT_FAIL"); process.exit(1) }
console.log(" ✅ VIDEO_LANES_AUDIT_PASS — persona, education, platform-acquisition, viral, D-ID and listing lanes each have a producer and a completer")
