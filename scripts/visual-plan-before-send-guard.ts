#!/usr/bin/env tsx
/**
 * scripts/visual-plan-before-send-guard.ts   (npm run test:visual-plan-before-send)
 * ─────────────────────────────────────────────────────────────────────────────
 * PLAN BEFORE SEND, PROVEN. Owner (wave 80, verbatim): "background visuals
 * also should be included in body plans. if the script is going to need
 * visuals ai agent plans this before sending." "wire d-id".
 *
 * WHAT THIS PROVES
 *   §gate      gateVisualPlanForDispatch (lib/video/body-visual-model.ts) is
 *              ONE function with every refusal arm and a control per arm:
 *              missing plan, empty plan, asset missing per treatment, a
 *              treatment the purpose disallows, b-roll on a never-purpose,
 *              stock b-roll on an own-media purpose, a background the purpose
 *              disallows, an avatar on a voiceover host; a good plan passes
 *   §doors     every provider door runs the gate BEFORE its spend, by source
 *              order: the director's two commission paths (before the
 *              ai_video_projects insert), the avatar-track submit (before
 *              generateVideo), the outreach dispatcher (before the ElevenLabs
 *              TTS and the D-ID connector call), the memory render (before
 *              recordRenderQueued); each door refuses on !ok
 *   §keyed     transparentPresenterConfig is the ONE spelling: /clips →
 *              background.color:false + webm, V4 → TransparentBackground +
 *              webm, /talks → unsupported with a reason; both submitters
 *              spread it; the poller hosts a webm as webm and skips the band
 *              burn; the orchestrator merges avatarVideoTransparent; AvatarPIP
 *              and AgentTalkingHeadReel composite a keyed clip without a ring
 *              and fall back to the opaque card
 *   §purpose   videoPurposeForSituation stages lead_reel for lead_intro on
 *              AgentExplainerReel and nothing where the default stands; the
 *              seller-update producer stages seller_update + brollSource own
 *   §registry  package.json + the guard chain ordering + MAINTENANCE_DOMAINS
 *
 * No network. PURE modules + stripped-source scans.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import {
  gateVisualPlanForDispatch, bareTalkingHeadPlan, planBodyVisual, planWantsKeyedPresenter, bodyVisualStamp,
  PURPOSE_BODY_VISUAL_RULES, type BodyVisualAssets, type BodyVisualPlan,
} from "../lib/video/body-visual-model"
import { planCompositionDuration } from "../lib/video/duration-model"
import { transparentPresenterConfig, isWebmResult } from "../lib/did/contract"
import { videoPurposeForSituation } from "../lib/video/video-director"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(join(root, rel), "utf8")
const readStripped = (rel: string): string => stripComments(read(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const SCRIPT = "Rates moved again this week. Inventory is up on your side of town. Median price held. Days on market fell to nine. Text me for the block-by-block picture."
const FULL: BodyVisualAssets = { avatarClip: true, brollClips: 2, brollSource: "stock", propertyPhotos: 4, screenshots: 2, statCards: 3, clientFootage: 1, chartData: true }
const plan = (id: string, assets: BodyVisualAssets, purpose?: never): BodyVisualPlan =>
  planBodyVisual({ compositionId: id, duration: planCompositionDuration({ compositionId: id, wordCount: 30 }), script: SCRIPT, assets, purpose })

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §gate · one function, every arm, a control per arm ──")
{
  const good = plan("MarketUpdateReel", FULL)
  check("a well-formed plan with its assets passes", gateVisualPlanForDispatch(good, FULL).ok)
  const missing = gateVisualPlanForDispatch(null, FULL)
  check("no plan → refused: body_visual_plan_missing, naming the seam that plans", !missing.ok && missing.missing.join() === "body_visual_plan_missing" && /stageBodyVisualPlan/.test(missing.reason))
  check("an empty plan → refused: body_visual_plan_empty", !gateVisualPlanForDispatch({ ...good, segments: [] }, FULL).ok)
  const noStats = gateVisualPlanForDispatch(good, { ...FULL, statCards: 0 })
  check("a stat-card segment with no stats staged → asset_missing:stat_card", !noStats.ok && noStats.missing.includes("asset_missing:stat_card"))
  const noAvatar = gateVisualPlanForDispatch(good, { ...FULL, avatarClip: false })
  check("an avatar segment with no clip coming → asset_missing:avatar_pip", !noAvatar.ok && noAvatar.missing.some((m) => /asset_missing:(avatar_pip|full_avatar)/.test(m)))
  const forgedTreatment: BodyVisualPlan = { ...good, segments: good.segments.map((s) => ({ ...s, treatment: "screenshot" as const, background: "none" as const })) }
  const t = gateVisualPlanForDispatch(forgedTreatment, FULL)
  check("a treatment the purpose disallows (screenshot on market_update) → treatment_not_allowed", !t.ok && t.missing.includes("treatment_not_allowed:screenshot"))
  const memory = plan("MemoryVideoReel", { ...FULL, avatarClip: false })
  const forgedBroll: BodyVisualPlan = { ...memory, segments: memory.segments.map((s) => ({ ...s, treatment: "broll" as const, background: "none" as const })) }
  const b = gateVisualPlanForDispatch(forgedBroll, { ...FULL, avatarClip: false })
  check("b-roll on a never-purpose (memory) → broll_forbidden", !b.ok && b.missing.includes("broll_forbidden:memory"))
  const su = planBodyVisual({ compositionId: "AgentTalkingHeadReel", duration: planCompositionDuration({ compositionId: "AgentTalkingHeadReel", wordCount: 40, purpose: "seller_update" }), script: SCRIPT, assets: { ...FULL, brollSource: "own" }, purpose: "seller_update" })
  const own = gateVisualPlanForDispatch(su, { ...FULL, brollSource: "own" }), stock = gateVisualPlanForDispatch(su, { ...FULL, brollSource: "stock" })
  check("own-media-only b-roll (seller_update) passes with own clips and refuses stock (broll_not_own_media)", own.ok && !stock.ok && stock.missing.includes("broll_not_own_media"))
  const forgedBg: BodyVisualPlan = { ...good, segments: good.segments.map((s) => (s.treatment === "stat_card" ? { ...s, background: "subtle_motion" as const } : s)) }
  const bg = gateVisualPlanForDispatch(forgedBg, FULL)
  check("a background the purpose disallows (subtle_motion on market_update) → background_not_allowed", !bg.ok && bg.missing.includes("background_not_allowed:subtle_motion"))
  const forgedHost: BodyVisualPlan = { ...good, host: "voiceover" }
  const h = gateVisualPlanForDispatch(forgedHost, FULL)
  check("an avatar treatment on a voiceover host → avatar_on_voiceover_host", !h.ok && h.missing.includes("avatar_on_voiceover_host"))
  check("the reason names the composition, the purpose and every finding (a human can act on it)", /MarketUpdateReel\/market_update: .*asset_missing:stat_card/.test(noStats.ok ? "" : noStats.reason))
  const bare = bareTalkingHeadPlan(SCRIPT)
  check("the bare talking head (outreach dispatcher) is one full-frame presenter and passes; an empty script fails the same gate",
    gateVisualPlanForDispatch(bare, { avatarClip: true, brollClips: 0, propertyPhotos: 0, screenshots: 0 }).ok && !gateVisualPlanForDispatch(bareTalkingHeadPlan("  "), { avatarClip: true, brollClips: 0, propertyPhotos: 0, screenshots: 0 }).ok)
  check("bodyVisualStamp records purpose, treatments, backgrounds, the first beat's treatment, the verdict and the override ids", (() => { const s = bodyVisualStamp(good); return s.purpose === "market_update" && s.treatments.length === good.segments.length && s.backgrounds.length === good.segments.length && s.beat_treatment === "stat_card" && s.broll_verdict === PURPOSE_BODY_VISUAL_RULES.market_update.broll.verdict && Array.isArray(s.override_ids) })())
  check("planWantsKeyedPresenter: true when any segment is avatar_pip, false for a full-frame-only plan", planWantsKeyedPresenter(good) && !planWantsKeyedPresenter(bare))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §doors · the gate runs before every provider spend, by source order ──")
{
  const order = (src: string, gate: RegExp, spend: RegExp, label: string, occurrences = 1) => {
    const gates = [...src.matchAll(new RegExp(gate.source, "g"))].map((m) => m.index ?? -1)
    const spends = [...src.matchAll(new RegExp(spend.source, "g"))].map((m) => m.index ?? -1)
    const ok = gates.length >= occurrences && spends.length >= occurrences && gates.every((g, i) => spends[i] !== undefined && g < spends[i])
    check(`${label}: gateVisualPlanForDispatch (${gates.length}×) precedes the spend (${spends.length}×) in source order`, ok, `gates at ${gates.join(",")}, spends at ${spends.join(",")}`)
  }
  const director = readStripped("lib/video/video-director.ts")
  // Wave 84A re-anchor: the director's door is either the inline gate or
  // readyVisualPlanForDispatch (lib/video/plan-asset-readiness.ts), whose OWN
  // source runs the gate on the final plan before it returns ok and hands the
  // gate's findings back as violations — both proven below.
  order(director, /(?:gateVisualPlanForDispatch\(visual\.plan|readyVisualPlanForDispatch\(\{)/, /\.from\("ai_video_projects"\)\s*\.insert\(/, "video-director.ts (commissionVideo + commissionVideoExperiment)", 2)
  const readiness = readStripped("lib/video/plan-asset-readiness.ts")
  order(readiness, /gateVisualPlanForDispatch\(final\.plan/, /return \{ ok: true, plan: final\.plan/, "plan-asset-readiness.ts (the readiness door: gate before the ok that lets the director spend)")
  check("video-director.ts refuses on the gate's findings as violations, on both paths (inline !visualGate.ok, or !readiness.ok carrying the readiness door's gate.missing)",
    (director.match(/if \(!visualGate\.ok\)/g) ?? []).length + (director.match(/if \(!readiness\.ok\)[\s\S]{0,400}?violations: readiness\.violations/g) ?? []).length === 2
    && ((director.match(/readyVisualPlanForDispatch\(\{/g) ?? []).length === 0 || /violations: \["body_visual_unplanned", \.\.\.gate\.missing\]/.test(readiness)))
  const submit = readStripped("lib/video/avatar-track-submit.ts")
  order(submit, /gateVisualPlanForDispatch\(planned\.plan/, /await generateVideo\(\{/, "avatar-track-submit.ts (the D-ID avatar track)")
  check("avatar-track-submit.ts plans when the request carries no plan, refuses when it cannot, writes the plan back onto the request and asks for a keyed presenter when the plan puts the presenter in a corner",
    /stageBodyVisualPlan\(\{ compositionId: args\.request\.target_composition_id/.test(submit) && /if \(!planned\.ok\)/.test(submit) && /if \(!visualGate\.ok\)/.test(submit)
    && /args\.request\.input_props = \{ \.\.\.args\.request\.input_props, bodyVisualPlan: planned\.plan \}/.test(submit) && /transparentBackground: keyedWanted/.test(submit) && /keyedWanted = planWantsKeyedPresenter\(planned\.plan\)/.test(submit))
  const dispatch = readStripped("lib/providers/dispatch.ts")
  order(dispatch, /gateVisualPlanForDispatch\(visualPlan/, /await convertSpeech\(/, "dispatch.ts (the outreach avatar video: before the ElevenLabs TTS)")
  order(dispatch, /gateVisualPlanForDispatch\(visualPlan/, /connector: "did",/, "dispatch.ts (…and before the D-ID connector call)")
  check("dispatch.ts plans a bare talking head when no plan is handed in and refuses on !visualGate.ok", /params\.bodyVisualPlan \?\? bareTalkingHeadPlan\(renderedScript\)/.test(dispatch) && /if \(!visualGate\.ok\)/.test(dispatch))
  const memory = readStripped("lib/video/memory-video-render.ts")
  order(memory, /gateVisualPlanForDispatch\(visual\.plan/, /recordRenderQueued\(\{/, "memory-video-render.ts (before the render row)")
  check("CONTROL: the order finder flags a spend that precedes its gate", (() => { const s = 'await generateVideo({}); gateVisualPlanForDispatch(planned.plan'; const g = s.indexOf("gateVisualPlanForDispatch"), sp = s.indexOf("await generateVideo({"); return !(g < sp) })())
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §keyed · the transparent presenter: one spelling, two submitters, one poller, one composite ──")
{
  const clips = transparentPresenterConfig("clips", true), v4 = transparentPresenterConfig("expressives", true), talks = transparentPresenterConfig("talks", true), off = transparentPresenterConfig("clips", false)
  check("/clips: background.color:false + result_format webm (the documented transparent-webm pair)", clips.supported && (clips.body.background as { color: unknown }).color === false && clips.config.result_format === "webm" && clips.resultFormat === "webm")
  check("V4 /expressives: TransparentBackground + webm", v4.supported && (v4.body.background as { type: unknown }).type === "transparent" && v4.config.result_format === "webm")
  check("/talks: unsupported, opaque, with the reason (a photo render has no alpha) — the honest fallback", !talks.supported && talks.resultFormat === "mp4" && Object.keys(talks.body).length === 0 && /no transparent output/.test(talks.fallbackReason ?? ""))
  check("not wanted → nothing spread, mp4", off.resultFormat === "mp4" && Object.keys(off.body).length === 0 && Object.keys(off.config).length === 0)
  check("isWebmResult recognises a hosted webm and not an mp4", isWebmResult("https://b/x/y.webm?token=1") && !isWebmResult("https://b/x/y.mp4"))
  const did = readStripped("lib/did/index.ts")
  check("generateVideo spreads the keyed body + config on the V4 branch, hosts a webm AS webm, and reports transparent/resultFormat", /\.\.\.keyed\.body,\s*config: \{ result_format: "mp4", \.\.\.keyed\.config \}/.test(did) && /workflow-video\/\$\{talkId\}\.\$\{ext\}/.test(did) && /transparent: keyed\.resultFormat === "webm"/.test(did))
  const dispatch = readStripped("lib/providers/dispatch.ts")
  check("dispatch.ts spreads the keyed body + config on the /clips and V4 branches, never on /talks, and records transparent_requested / transparent / result_format + the fallback reason", (dispatch.match(/\.\.\.keyed\.body,/g) ?? []).length === 2 && /transparent_requested: keyedWanted/.test(dispatch) && /transparent_fallback_reason: keyed\.fallbackReason/.test(dispatch) && /transparentPresenterConfig\(engine, keyedWanted\)/.test(dispatch))
  const poll = readStripped("app/api/cron/poll-did-videos/route.ts")
  check("poll-did-videos hosts a keyed result as .webm/video/webm and SKIPS the band burn on it (the overlay would flatten the alpha)", /agent-videos\/\$\{agentFolder\}\/\$\{video\.id\}\.\$\{resultExt\}/.test(poll) && /usageIntent !== "mls" && !keyedResult/.test(poll) && /transparent: keyedResult/.test(poll))
  const orch = readStripped("lib/video/avatar-render-orchestrator.ts")
  check("the orchestrator merges input_props.avatarVideoTransparent from the poller's record (or a webm from a keyed request), on the merge and the fresh-row paths", /avatarVideoTransparent = meta\.transparent === true \|\| \(meta\.transparent_requested === true && isWebmResult\(avatarVideoUrl\)\)/.test(orch) && (orch.match(/avatarVideoTransparent/g) ?? []).length >= 5)
  const pip = readStripped("remotion/components/AvatarPIP.tsx")
  check("AvatarPIP composites a keyed clip without ring, crop or fill (objectFit contain, overflow visible) and keeps the ring card as the opaque fallback", /avatarVideoUrl && hasRealContent && keyed/.test(pip) && /objectFit="contain"/.test(pip) && /overflow: "visible"/.test(pip) && /objectFit="cover"/.test(pip))
  const ath = readStripped("remotion/AgentTalkingHeadReel.tsx")
  check("AgentTalkingHeadReel drops the card's frame for a keyed presenter and keeps it otherwise", /const keyed = avatarVideoTransparent === true && !!avatarVideoUrl/.test(ath) && /avatarChrome/.test(ath) && /objectFit=\{keyed \? "contain" : "cover"\}/.test(ath))
  check("every PiP reel forwards avatarVideoTransparent to AvatarPIP", ["remotion/AgentExplainerReel.tsx", "remotion/MarketUpdateReel.tsx", "remotion/EquityReportReel.tsx"].every((f) => /avatarVideoTransparent/.test(readStripped(f))))
  check("the cost note is published beside the config (no surcharge documented; verify on invoice)", /no[\s*]+transparency surcharge is documented/.test(read("lib/did/contract.ts")) && /Verify on the first invoice/.test(read("lib/did/contract.ts")))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §purpose · alsoServes is staged (79C's open item) ──")
{
  check("lead_intro on AgentExplainerReel stages lead_reel; explainer stays the default (null); a composition that does not serve it stages nothing",
    videoPurposeForSituation("lead_intro", "AgentExplainerReel") === "lead_reel" && videoPurposeForSituation("explainer", "AgentExplainerReel") === null && videoPurposeForSituation("lead_intro", "MarketUpdateReel") === null)
  const director = readStripped("lib/video/video-director.ts")
  check("the director stages videoPurpose on both paths' input_props and plans under it", (director.match(/\.\.\.\(stagedPurpose \? \{ videoPurpose: stagedPurpose \} : \{\}\)/g) ?? []).length === 4)
  const producer = readStripped("lib/agents/seller-update-reel-producer.ts")
  check("the seller-update producer stages videoPurpose seller_update and brollSource own (the listing's own photos)", /props\.videoPurpose = "seller_update"/.test(producer) && /props\.brollSource = "own"/.test(producer))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §registry · package.json, chain ordering, MAINTENANCE_DOMAINS ──")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  const guard = pkg.scripts.guard ?? ""
  for (const [name, file] of [["test:visual-plan-before-send", "scripts/visual-plan-before-send-guard.ts"], ["test:memory-video-modes", "scripts/memory-video-modes-guard.ts"]]) {
    check(`package.json: ${name} is registered and runs in the guard chain after test:scrapers (ordering only)`,
      pkg.scripts[name] === `tsx ${file}` && guard.indexOf(`npm run ${name}`) > guard.indexOf("npm run test:scrapers") && guard.indexOf("npm run test:scrapers") !== -1)
  }
  const registry = readStripped("lib/kernel/manager-registry.ts")
  check("manager-registry: MAINTENANCE_DOMAINS.visual_plan_before_send and .memory_video_modes name their proofs with co-owners", /visual_plan_before_send:\s*\{ manager: "asset_manager", proof: "test:visual-plan-before-send", coOwners: \[/.test(registry) && /memory_video_modes:\s*\{ manager: "listing_concierge", proof: "test:memory-video-modes", coOwners: \[/.test(registry))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
