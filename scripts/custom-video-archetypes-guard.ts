#!/usr/bin/env tsx
/**
 * scripts/custom-video-archetypes-guard.ts   (npm run test:custom-video-archetypes)
 * ─────────────────────────────────────────────────────────────────────────────
 * ANY TYPE OF VIDEO, PROVEN. Owner (wave 81, verbatim): "make sure user can
 * create any type of video to use with real estate not just the ones we listed."
 *
 * WHAT THIS PROVES
 *   §registry   seven archetypes, each inheriting a REAL purpose (a row in
 *               PURPOSE_DURATION_RULES and PURPOSE_BODY_VISUAL_RULES), hosts,
 *               needs, cues, a storable video_type (an existing CHECK literal),
 *               a reason and sources — never a duration or treatment of its own
 *   §classify   a described video lands on the archetype its cues and assets
 *               say (seven fixtures, one per archetype); a description that
 *               maps to none FAILS LOUDLY with the reason (no cue, unmet
 *               needs, no ready twin, unknown hint) — POSITIVE CONTROLS
 *   §derive     planCustomVideo derives the band FROM the purpose's rule (the
 *               wish clamped into it), the body-visual rule FROM
 *               resolvePurposeRule (overrides honoured), the composition FROM
 *               COMPOSITION_DURATION_RULES on the host, the cuts FROM the cut
 *               registry — by rule, never a hand table; a purpose no
 *               composition serves on that host refuses
 *   §director   SituationKind "custom" reads facts.customPlan (no plan →
 *               throws), commissionCustomVideo rides the ONE rail, the content
 *               resolver stages the brief's content, the manager door
 *               (direct_video kind custom) and the studio door (server action
 *               + card) exist and the action resolves the tenant from the
 *               SESSION; the card mounts both actions (no orphan)
 *   §registered package.json + ordering + MAINTENANCE_DOMAINS
 *
 * No network. PURE modules + stripped-source scans (CLAUDE.md §2).
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import {
  CUSTOM_VIDEO_ARCHETYPES, CUSTOM_ARCHETYPE_REGISTRY, classifyCustomVideoBrief, planCustomVideo, compositionsForPurposeAndHost, clampLengthWish, archetypeHosts,
  type CustomVideoBrief, type CustomVideoArchetype,
} from "../lib/video/custom-video-archetypes"
import { PURPOSE_DURATION_RULES, COMPOSITION_DURATION_RULES, type HostKind } from "../lib/video/duration-model"
import { PURPOSE_BODY_VISUAL_RULES, resolvePurposeRule, type BodyVisualAssets } from "../lib/video/body-visual-model"
import { selectVideoFormat, videoPurposeForSituation } from "../lib/video/video-director"
import { cutsForComposition } from "../lib/video/render-cut"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(join(root, rel), "utf8")
const readStripped = (rel: string): string => stripComments(read(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const NONE: BodyVisualAssets = { avatarClip: false, brollClips: 0, propertyPhotos: 0, screenshots: 0, statCards: 0, clientFootage: 0, chartData: false }
const brief = (goal: string, host: HostKind, assets: Partial<BodyVisualAssets> = {}, extra: Partial<CustomVideoBrief> = {}): CustomVideoBrief =>
  ({ audience: "people in Naples", goal, host, assets: { ...NONE, ...assets }, ...extra })

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §registry · eight archetypes, every one inherits a real purpose ──")
{
  const vocab = read("scripts/check-vocabularies.ts")
  const videoTypes = (vocab.match(/video_type: \[([^\]]+)\]/)?.[1] ?? "").split(",").map((s) => s.trim().replace(/"/g, ""))
  // Wave 83B: + voiceover_explainer (the needs-free shape for an agent with no ready twin).
  check("CUSTOM_VIDEO_ARCHETYPES is the closed set of eight", CUSTOM_VIDEO_ARCHETYPES.length === 8 && CUSTOM_VIDEO_ARCHETYPES.join() === "talking_head_message,photo_story,screen_demo,data_update,testimonial_story,event_promo,education_explainer,voiceover_explainer")
  // RULE (not a count): every host that carries narration has at least one NEEDS-FREE archetype,
  // so a brief with nothing but a voice (or a twin) can always plan — the 82C gap, closed.
  const needsFree = CUSTOM_VIDEO_ARCHETYPES.filter((a) => Object.keys(CUSTOM_ARCHETYPE_REGISTRY[a].needs).length === 0)
  for (const h of ["voiceover", "avatar"] as HostKind[]) {
    check(`host ${h}: a needs-free archetype is carried (${needsFree.filter((a) => archetypeHosts(a).includes(h)).join(", ") || "none"})`, needsFree.some((a) => archetypeHosts(a).includes(h)))
  }
  check("the explainer twins never compete: education_explainer is avatar-only, voiceover_explainer voiceover-only (derived)",
    archetypeHosts("education_explainer").join() === "avatar" && archetypeHosts("voiceover_explainer").join() === "voiceover")
  for (const id of CUSTOM_VIDEO_ARCHETYPES) {
    const s = CUSTOM_ARCHETYPE_REGISTRY[id]
    const hosts = archetypeHosts(id)
    check(`${id}: inherits purpose ${s.basePurpose} (a duration rule AND a body-visual rule), hosts DERIVED from the registry [${hosts.join("/")}], ${s.cues.length} cues, video_type ${s.videoType} in the live CHECK, a reason + sources`,
      s.id === id && s.basePurpose in PURPOSE_DURATION_RULES && s.basePurpose in PURPOSE_BODY_VISUAL_RULES && hosts.length > 0 && s.cues.length >= 5 && videoTypes.includes(s.videoType) && s.why.length > 20 && s.sources.length >= 1)
    check(`${id}: every derived host has a registered narration composition for ${s.basePurpose} (the plan can always land) and every registered host is derived`,
      hosts.every((h) => compositionsForPurposeAndHost(s.basePurpose, h).length > 0) && (["voiceover", "avatar", "silent"] as HostKind[]).every((h) => hosts.includes(h) === (compositionsForPurposeAndHost(s.basePurpose, h).length > 0)))
  }
  const src = readStripped("lib/video/custom-video-archetypes.ts")
  check("no hand table: the module declares no minSeconds / maxSeconds / allowed / prefer / hosts of its own (bands, rules and hosts come from the survivors)", !/minSeconds:\s*\d|maxSeconds:\s*\d|allowed:\s*\[|prefer:\s*\{|hosts:\s*\[/.test(src))
  check("CONTROL: a purpose no narration composition serves on a host derives no host (silent has no talking-head composition)", !archetypeHosts("talking_head_message").includes("silent") && archetypeHosts("talking_head_message").includes("avatar"))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §classify · one fixture per archetype; refusals name the reason ──")
{
  const cases: Array<[string, CustomVideoBrief, CustomVideoArchetype]> = [
    ["agent intro", brief("Introduce myself to new leads who do not know me yet", "avatar", { avatarClip: true }), "talking_head_message"],
    ["before/after photo story", brief("Show the renovation of the kitchen, before and after, from the photos", "voiceover", { propertyPhotos: 6 }), "photo_story"],
    ["portal how-to", brief("A demo of how to use the client portal to book a showing", "voiceover", { screenshots: 2 }), "screen_demo"],
    ["quarterly recap", brief("Quarterly market recap: median price, days on market and inventory", "avatar", { avatarClip: true, statCards: 3 }), "data_update"],
    ["closing-day story", brief("A client story from closing day in their own words", "voiceover", { clientFootage: 1 }), "testimonial_story"],
    ["seminar invite", brief("Invite past clients to our Saturday first-time buyer workshop, RSVP by Friday", "voiceover", { propertyPhotos: 1 }), "event_promo"],
    ["closing costs", brief("Explain closing costs in three steps for first-time buyers", "avatar", { avatarClip: true }), "education_explainer"],
    ["closing costs, no twin", brief("Explain closing costs in three steps for first-time buyers", "voiceover"), "voiceover_explainer"],
  ]
  for (const [label, b, want] of cases) {
    const r = classifyCustomVideoBrief(b)
    check(`${label} → ${want}`, r.ok && r.archetype === want, r.ok ? `got ${r.archetype}` : r.reason)
  }
  const holiday = classifyCustomVideoBrief(brief("A holiday greeting and thank-you to my clients for the year", "avatar", { avatarClip: true }))
  const recruit = classifyCustomVideoBrief(brief("Recruit experienced agents to join our team", "avatar", { avatarClip: true }))
  const vendor = classifyCustomVideoBrief(brief("A vendor spotlight on our stager, in her own words", "voiceover", { clientFootage: 1 }))
  const buys = classifyCustomVideoBrief(brief("What $500K buys in Naples this month — three price points", "avatar", { avatarClip: true, statCards: 3 }))
  const landed = (label: string, r: ReturnType<typeof classifyCustomVideoBrief>, want: CustomVideoArchetype) =>
    check(`a type nobody listed still lands: ${label} → ${want}`, r.ok && r.archetype === want, r.ok ? `got ${r.archetype}` : r.reason)
  landed("holiday greeting", holiday, "talking_head_message")
  landed("recruiting pitch", recruit, "talking_head_message")
  landed("vendor spotlight", vendor, "testimonial_story")
  landed("'what $500K buys'", buys, "data_update")
  // POSITIVE CONTROLS — the refusals.
  const noCue = classifyCustomVideoBrief(brief("asdf qwerty", "voiceover"))
  check("CONTROL: a description with no shape is refused naming the archetypes and what to say", !noCue.ok && /names no video shape/.test(noCue.reason) && CUSTOM_VIDEO_ARCHETYPES.every((a) => noCue.reason.includes(a)))
  const noShots = classifyCustomVideoBrief(brief("A demo of the dashboard", "voiceover"))
  check("CONTROL: a screen demo with no screenshots is refused naming the missing screenshots", !noShots.ok && /screen_demo/.test(noShots.reason) && /screenshots/.test(noShots.reason))
  const noTwin = classifyCustomVideoBrief(brief("Introduce myself to new leads", "avatar", { avatarClip: false }))
  check("CONTROL: an avatar host with no ready twin is refused naming the twin", !noTwin.ok && /twin/.test(noTwin.reason))
  const badHint = classifyCustomVideoBrief(brief("Introduce myself", "avatar", { avatarClip: true }, { archetypeHint: "sizzle_reel" as never }))
  check("CONTROL: an unknown archetype hint is refused", !badHint.ok && /not one of/.test(badHint.reason))
  const hintUnmet = classifyCustomVideoBrief(brief("Introduce myself", "avatar", { avatarClip: true }, { archetypeHint: "photo_story" }))
  check("CONTROL: a named archetype whose needs are unmet is refused (photo_story on an avatar host with no photos)", !hintUnmet.ok && /photo_story/.test(hintUnmet.reason))
  const hinted = classifyCustomVideoBrief(brief("Introduce myself", "voiceover", { propertyPhotos: 4 }, { archetypeHint: "photo_story" }))
  check("a valid hint wins over the cues", hinted.ok && hinted.archetype === "photo_story" && /named by the brief/.test(hinted.reason))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §derive · band, rule, composition, cuts — all from the survivors ──")
{
  const b = brief("Explain closing costs in three steps", "avatar", { avatarClip: true }, { lengthWishSeconds: 500 })
  const r = planCustomVideo(b)
  check("plans", r.ok, r.ok ? undefined : r.reason)
  if (r.ok) {
    const p = r.plan
    const rule = PURPOSE_DURATION_RULES[p.purpose]
    check("the band IS the purpose's rule with the wish clamped INTO it (500 s → max)", p.purpose === "explainer" && p.band.minSeconds === rule.minSeconds && p.band.maxSeconds === rule.maxSeconds && p.band.targetSeconds === rule.maxSeconds && p.band.clampedFrom === 500)
    check("the body-visual rule IS resolvePurposeRule(purpose)", JSON.stringify(p.rule) === JSON.stringify(resolvePurposeRule("explainer", null)))
    check("the composition is the first registered narration composition serving the purpose on the host", p.compositionId === compositionsForPurposeAndHost("explainer", "avatar")[0] && COMPOSITION_DURATION_RULES[p.compositionId].host === "avatar")
    const again = planCustomVideo(b)
    check("video_type is the archetype's CHECK literal; no listing → ads cut only; the key is stable", p.videoType === "education" && p.cuts.join() === "ads" && again.ok && again.plan.key === p.key && /^custom:education_explainer:[0-9a-f]+$/.test(p.key))
  }
  check("a wish of 5 s clamps to the min; no wish → the ideal", clampLengthWish(PURPOSE_DURATION_RULES.explainer, 5).targetSeconds === PURPOSE_DURATION_RULES.explainer.minSeconds && clampLengthWish(PURPOSE_DURATION_RULES.explainer, null).targetSeconds === PURPOSE_DURATION_RULES.explainer.idealSeconds && clampLengthWish(PURPOSE_DURATION_RULES.explainer, 60).clampedFrom === null)
  const overridden = planCustomVideo(b, { overrides: [{ id: "o1", purpose: "explainer", change: { kind: "prefer_treatment", segmentKind: "beat", treatment: "kinetic_text" }, why: "test", sample: 40, source: "human", appliedAt: "2026-09-24T00:00:00Z" }] })
  check("live rule overrides are honoured in the derived rule (a beat preference reorders, never widens)", overridden.ok && overridden.plan.rule.prefer.beat[0] === "kinetic_text" && overridden.plan.rule.prefer.beat.length === resolvePurposeRule("explainer", null).prefer.beat.length)
  const listing = planCustomVideo(brief("Tour the renovation of 12 Oak St from the photos", "voiceover", { propertyPhotos: 8 }, { listingId: "11111111-1111-4111-8111-111111111111" }))
  check("a photo story about a listing derives PhotoWalkthroughReel and BOTH cuts (the MLS cut from the cut registry)", listing.ok && listing.plan.compositionId === "PhotoWalkthroughReel" && listing.plan.cuts.join() === cutsForComposition("PhotoWalkthroughReel").join() && listing.plan.cuts.includes("mls"))
  const silent = planCustomVideo(brief("Introduce myself to new leads", "silent"))
  check("CONTROL: an archetype with no composition on the chosen host refuses naming the registry (talking head on a silent host)", !silent.ok && /no archetype|no registered composition/.test(silent.reason))
  check("CONTROL: an empty goal refuses", !planCustomVideo({ audience: "x", goal: "", host: "voiceover", assets: NONE }).ok)
  check("CONTROL: a bad host refuses", !planCustomVideo({ audience: "x", goal: "explain closing costs", host: "hologram" as never, assets: NONE }).ok)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §director · the custom kind rides the ONE rail ──")
{
  const d = readStripped("lib/video/video-director.ts")
  check("SituationKind declares \"custom\"", /\|\s*"custom"/.test(d))
  const planned = planCustomVideo(brief("Quarterly market recap with the numbers", "avatar", { avatarClip: true, statCards: 3 }))
  if (planned.ok) {
    const f = selectVideoFormat({ kind: "custom", tier: "solo_agent", targetChannel: "instagram", facts: { customPlan: planned.plan } })
    check("selectVideoFormat(custom) returns the PLAN's composition with the host's avatar need", f.compositionId === planned.plan.compositionId && f.needsAvatar === true)
    check("videoPurposeForSituation stages the archetype's purpose only when the composition alsoServes it (default purpose → null)", videoPurposeForSituation("custom", planned.plan.compositionId, planned.plan.purpose) === null && videoPurposeForSituation("custom", "AgentExplainerReel", "lead_reel") === "lead_reel")
  }
  let threw = false
  try { selectVideoFormat({ kind: "custom", tier: "solo_agent", targetChannel: "instagram" }) } catch (e) { threw = /planCustomVideo/.test((e as Error).message) }
  check("CONTROL: a custom situation with NO plan fails loudly, naming the planner", threw)
  check("commissionCustomVideo: plans (overrides loaded), refuses custom_video_unplanned, stages the plan on facts.customPlan, and commissions the MLS cut when the plan names one",
    /export async function commissionCustomVideo\(/.test(d) && /planCustomVideo\(brief, \{ overrides \}\)/.test(d) && /violations: \["custom_video_unplanned"\]/.test(d) && /facts: \{ customPlan: plan,/.test(d) && /plan\.cuts\.includes\("mls"\)/.test(d))
  check("videoTypeForSituation(custom) is the archetype's CHECK literal from the plan", /case "custom":\s*return \(situation && customPlanOf\(situation\)\?\.videoType\) \?\? "social_reel"/.test(d))
  const dc = readStripped("lib/video/director-content.ts")
  check("director-content stages the brief's own content under the brand block for a custom situation (nothing authored)", /if \(situation\.kind === "custom"\) \{/.test(dc) && /\.\.\.content \}/.test(dc))
  const ama = readStripped("lib/agents/asset-manager-actions.ts")
  check("the manager door: direct_video kind 'custom' takes input.brief through commissionCustomVideo (same door, autonomous)", /if \(kind === "custom"\) \{/.test(ama) && /commissionCustomVideo\(brief,/.test(ama))
  const action = read("app/actions/custom-video.ts")
  const actionStripped = stripComments(action)
  // Re-anchored wave 82C: the RULE is "every export is async" (a use-server file has no private helpers), not a count of two — 82C added the topic-pool and guide actions.
  check("app/actions/custom-video.ts is a \"use server\" file whose exports are ALL async and resolve the tenant from the SESSION (never input.brokerageId)",
    /^"use server"/.test(action) && (actionStripped.match(/^export async function/gm) ?? []).length >= 2 && (actionStripped.match(/^export function/gm) ?? []).length === 0 && /supabase\.auth\.getUser\(\)/.test(actionStripped) && !/input\.brokerageId|input\.agentUserId/.test(actionStripped))
  check("the action refuses a bad host / hint / goal before planning and previews the plan without staging", /previewDescribedVideoAction/.test(actionStripped) && /planCustomVideo\(b\.brief\)/.test(actionStripped) && /host must be one of/.test(actionStripped))
  const card = readStripped("app/dashboard/videos/create/describe-video-card.tsx")
  const client = readStripped("app/dashboard/videos/create/video-create-client.tsx")
  check("the studio's 'Describe a video' card imports BOTH actions (no orphan) and is mounted beside the teammate card", /previewDescribedVideoAction, createDescribedVideoAction/.test(card) && /<DescribeVideoCard \/>/.test(client) && /import \{ DescribeVideoCard \} from "\.\/describe-video-card"/.test(client))
  check("the card offers the closed archetype set as an optional hint (the rule decides when blank)", /CUSTOM_VIDEO_ARCHETYPES\.map/.test(card) && /<option value="">/.test(card)) // re-anchored 82C: the blank option (the rule decides), not its wording
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §registered · package.json, ordering, MAINTENANCE_DOMAINS ──")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  const guard = pkg.scripts.guard ?? ""
  check("package.json: test:custom-video-archetypes runs this file and sits in the guard chain after test:scrapers (ordering only)",
    pkg.scripts["test:custom-video-archetypes"] === "tsx scripts/custom-video-archetypes-guard.ts" && guard.indexOf("npm run test:scrapers") !== -1 && guard.indexOf("npm run test:custom-video-archetypes") > guard.indexOf("npm run test:scrapers"))
  const registry = readStripped("lib/kernel/manager-registry.ts")
  check("manager-registry: MAINTENANCE_DOMAINS.custom_video_archetypes names asset_manager with campaign_orchestrator / compliance_officer / listing_concierge co-owners", /custom_video_archetypes:\s*\{ manager: "asset_manager", proof: "test:custom-video-archetypes", coOwners: \["campaign_orchestrator", "compliance_officer", "listing_concierge"\]/.test(registry))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
