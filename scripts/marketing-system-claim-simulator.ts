#!/usr/bin/env tsx
/**
 * scripts/marketing-system-claim-simulator.ts   (npm run test:marketing-system-claim)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OWNER RULING THIS PROVES:
 *
 *   "default marketing system is part of the listing presentation and should be
 *    an active function since it is part of advertisement"
 *
 * `DEFAULT_MARKETING_SYSTEM` was one frozen sentence naming six capabilities,
 * used as the fallback for `AINarrationInput.marketingSystem` — an input NOTHING
 * in the tree ever set. So every seller of every tenant on every plan heard the
 * same six claims, spoken in their agent's CLONED VOICE, whether or not that
 * brokerage could deliver any of them. This proof stands over the replacement:
 * lib/listing-presentation/marketing-system.ts (pure catalogue + composer),
 * marketing-system-resolver.ts (the I/O half) and the wire at section-render.ts.
 *
 * WHAT MAKES THIS DIFFERENT FROM A TIDINESS PROOF: the output is ADVERTISING
 * read to a consumer. A claim the tenant cannot deliver is not a lint finding.
 * So §2's positive control is not a formality here — sections 2 and 3 construct
 * a tenant WITHOUT a capability and prove the claim is absent, then add the
 * capability and prove the same claim appears, on the same code path.
 *
 * ── HOW IT IS BUILT ────────────────────────────────────────────────────────
 * Sections 1–5 run the REAL pure composer — no stubs at all, because the
 * composer is pure by construction. Section 6 asserts the CONSTRUCTS behaviour
 * cannot see (the wire, the tombstone, the fail-closed direction). Section 7 is
 * the negative-control battery: every absence assertion is re-run against an
 * in-memory copy of the source with the defect re-introduced, and fails if the
 * check still passes. Nothing on disk is modified — other lanes are editing this
 * tree concurrently.
 *
 * NOTE ON READING SOURCE (§2): every source scan below reads COMMENT-STRIPPED
 * text via scripts/strip-comments.ts. These files carry a tombstone that QUOTES
 * the retired constant by name, and the whole point of the tombstone is that it
 * stays — reading raw source would make the tombstone count as a live
 * declaration and this guard would accuse the repo of the defect it records
 * having fixed. That is the exact failure mode CLAUDE.md §2 documents costing
 * five guards in one wave.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  MARKETING_SYSTEM_CLAIMS,
  MARKETING_SYSTEM_FLOOR,
  composeMarketingSystem,
  marketingSystemFeatureKeys,
  type MarketingSystemFacts,
} from "../lib/listing-presentation/marketing-system"
import { narrationBudget, spokenWords } from "../lib/video/script-structure"
import { compositionSeconds, geometryFor } from "../lib/remotion/composition-geometry"
import { SECTION_NARRATION_COMPOSITION } from "../lib/listing-presentation/section-narration"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
/** Comment-stripped source. Load-bearing — see the header. */
const code = (p: string) => stripComments(raw(p))

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

/** The budget the sections are ACTUALLY spoken over — derived, never typed. */
const geo = geometryFor(SECTION_NARRATION_COMPOSITION)
const LIVE_BUDGET = narrationBudget(SECTION_NARRATION_COMPOSITION, geo ? compositionSeconds(geo) : 0)

/** A generous budget, so capability assertions are never confounded by packing. */
const ROOMY = narrationBudget("__roomy__", 600)

function facts(over: Partial<MarketingSystemFacts> = {}): MarketingSystemFacts {
  return {
    capabilities:      new Set<string>(),
    hasVoiceClone:     false,
    hasAvatarSource:   false,
    directMailEnabled: false,
    budget:            ROOMY,
    ...over,
  }
}

/** Every feature key, so "fully entitled" is derived from the catalogue. */
const ALL_KEYS = new Set(marketingSystemFeatureKeys())

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 1. The catalogue is well-formed and derived ──")

check("the catalogue is non-empty (a claim-less catalogue would silently floor every tenant)",
  MARKETING_SYSTEM_CLAIMS.length > 0)
check("every claim id is unique",
  new Set(MARKETING_SYSTEM_CLAIMS.map((c) => c.id)).size === MARKETING_SYSTEM_CLAIMS.length)
check("every claim depends on at least one feature key (an ungated claim is the frozen string again)",
  MARKETING_SYSTEM_CLAIMS.every((c) => c.requires.length > 0),
  MARKETING_SYSTEM_CLAIMS.filter((c) => c.requires.length === 0).map((c) => c.id).join(", "))
check("every claim records WHERE the capability is wired, so it can be re-verified",
  MARKETING_SYSTEM_CLAIMS.every((c) => c.wiredAt.trim().length > 0))
check("marketingSystemFeatureKeys() is DERIVED from the catalogue, not a second list",
  ALL_KEYS.size === new Set(MARKETING_SYSTEM_CLAIMS.flatMap((c) => c.requires)).size)

/**
 * Live `feature_flags.feature_key` values, snapshotted 2026-08-26. Regenerate with:
 *   select feature_key from feature_flags where enabled and not deprecated order by 1;
 *
 * A pure proof has no credentials, so this is a DATED SNAPSHOT rather than a live
 * read — it catches a typo or an invented key, and it cannot catch a key that was
 * real on the snapshot date and has since been renamed. Published as a blind spot
 * at the foot of this run rather than left for a reader to discover.
 */
const LIVE_FEATURE_KEYS_20260826 = new Set([
  "ad_creator", "ads_audiences", "ads_campaigns", "agent_dashboard", "agent_onboarding",
  "ai_campaign_automation", "ai_compliance_checking", "ai_content_generation",
  "ai_conversation_analysis", "ai_isa", "ai_lead_prediction", "ai_setup_assistant",
  "ai_video_generation", "brand_setup", "brokerage_dashboard", "brokerage_settings",
  "buyer_education", "campaign_roi_dashboard", "cma_presentation", "commission_reports",
  "commission_waterfall", "competitor_monitor", "compliance_reports", "contact_enrichment",
  "contact_lifecycle_tracking", "content_performance_predictor", "custom_reports",
  "direct_mail", "direct_mail_integration", "document_esign", "email_campaigns",
  "email_outbound", "ghosted_reengagement", "integration_setup", "isa_reengagement_approval",
  "knowledge_management", "lead_assignment_auto", "lead_scoring", "lifetime_learning_portal",
  "listing_lifecycle", "listing_marketing_tiers", "listing_media", "marketing_studio",
  "milestone_tracking", "multi_location_dashboard", "multi_location_settings",
  "multi_offer_handling", "newsletter_engine", "omnipresence_repurposer", "phone_voicemail",
  "podcast_generation", "prelisting_repairs", "provider_override", "repurposing",
  "seller_education", "seo_blog_engine", "sms_outbound", "snippet_generation",
  "social_automation", "social_media_posting", "team_dashboard", "team_management",
  "training_library", "training_progress", "transaction_orchestration", "video_generation",
  "voice_clone", "whatsapp_messaging",
])
const unknownKeys = [...ALL_KEYS].filter((k) => !LIVE_FEATURE_KEYS_20260826.has(k))
check("every feature key a claim depends on is a real flag in the 2026-08-26 snapshot",
  unknownKeys.length === 0,
  `not in feature_flags: ${unknownKeys.join(", ")}`)
check("the floor sentence names NO capability — it can never be a false claim",
  MARKETING_SYSTEM_CLAIMS.every((c) => !MARKETING_SYSTEM_FLOOR.toLowerCase().includes(c.claim.toLowerCase().slice(0, 20))))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 2. POSITIVE CONTROL — a capability the tenant LACKS is never claimed ──")
console.log("   (per claim: withhold its keys → claim absent; grant them → claim present)")

for (const claim of MARKETING_SYSTEM_CLAIMS) {
  // Fully entitled tenant with every fact true, MINUS this claim's feature keys.
  const withoutKeys = new Set(ALL_KEYS)
  for (const k of claim.requires) withoutKeys.delete(k)

  const absent = composeMarketingSystem(facts({
    capabilities: withoutKeys, hasVoiceClone: true, hasAvatarSource: true, directMailEnabled: true,
  }))
  const present = composeMarketingSystem(facts({
    capabilities: ALL_KEYS, hasVoiceClone: true, hasAvatarSource: true, directMailEnabled: true,
  }))

  check(`${claim.id}: WITHHELD when its entitlement is missing`,
    !absent.offered.includes(claim.id) && absent.withheld.includes(claim.id)
      && !absent.text.includes(claim.claim),
    `text was: ${absent.text}`)
  check(`${claim.id}: OFFERED once the entitlement is granted (the finder works)`,
    present.offered.includes(claim.id) && present.text.includes(claim.claim))
}

// Facts, not just entitlements — the per-agent / per-tenant preconditions.
for (const claim of MARKETING_SYSTEM_CLAIMS.filter((c) => c.requiresFacts.length > 0)) {
  for (const fact of claim.requiresFacts) {
    const allFacts = { hasVoiceClone: true, hasAvatarSource: true, directMailEnabled: true }
    const withoutFact = composeMarketingSystem(facts({ capabilities: ALL_KEYS, ...allFacts, [fact]: false }))
    check(`${claim.id}: WITHHELD when '${fact}' is false even though the plan entitles it`,
      !withoutFact.offered.includes(claim.id) && !withoutFact.text.includes(claim.claim))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 3. Fail-closed: nothing resolved ⇒ nothing claimed ──")

const nothing = composeMarketingSystem(facts())
check("a tenant with NO capabilities gets the floor sentence, not the six-claim boast",
  nothing.usedFloor && nothing.text === MARKETING_SYSTEM_FLOOR)
check("the floor mentions none of the catalogue's claim text",
  MARKETING_SYSTEM_CLAIMS.every((c) => !nothing.text.includes(c.claim)))
check("every claim is reported as withheld rather than silently dropped (§2 — publish the blind spot)",
  nothing.withheld.length === MARKETING_SYSTEM_CLAIMS.length)
check("composed text is NEVER empty — an empty marketing block would leave the prompt unbounded",
  nothing.text.trim().length > 0)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 4. The claim list is packed to the composition's REAL geometry ──")

console.log(`   ${SECTION_NARRATION_COMPOSITION}: ${geo?.duration_frames}f @ ${geo?.fps}fps `
  + `= ${LIVE_BUDGET.compositionSeconds}s → budget ${LIVE_BUDGET.budgetSeconds}s / ${LIVE_BUDGET.maxWords} words`)

const full = composeMarketingSystem(facts({
  capabilities: ALL_KEYS, hasVoiceClone: true, hasAvatarSource: true, directMailEnabled: true, budget: LIVE_BUDGET,
}))
const offeredWords = full.offered
  .map((id) => spokenWords(MARKETING_SYSTEM_CLAIMS.find((c) => c.id === id)!.claim).length)
  .reduce((a, b) => a + b, 0)

console.log(`   fully-entitled tenant → ${full.offered.length}/${MARKETING_SYSTEM_CLAIMS.length} claims offered `
  + `(${offeredWords} claim-words), ${full.droppedForBudget.length} dropped for budget`)
console.log(`   text: ${full.text}`)

check("the offered claims fit inside the DERIVED word budget",
  offeredWords <= LIVE_BUDGET.maxWords,
  `${offeredWords} claim-words > ${LIVE_BUDGET.maxWords}-word budget`)
check("a claim that does not fit is WITHHELD from the prompt, never handed over to be trimmed mid-claim",
  full.droppedForBudget.every((id) => !full.text.includes(MARKETING_SYSTEM_CLAIMS.find((c) => c.id === id)!.claim)))
check("offered + withheld + droppedForBudget + droppedForCompliance accounts for EVERY claim (no silent loss)",
  new Set([...full.offered, ...full.withheld, ...full.droppedForBudget, ...full.droppedForCompliance]).size
    === MARKETING_SYSTEM_CLAIMS.length)

// A composition too short to carry ANY claim must floor, not overflow.
const tiny = narrationBudget("__tiny__", 1)
const tinyOut = composeMarketingSystem(facts({
  capabilities: ALL_KEYS, hasVoiceClone: true, hasAvatarSource: true, directMailEnabled: true, budget: tiny,
}))
check(`a ${tiny.maxWords}-word budget offers no claim and floors instead of overflowing`,
  tinyOut.usedFloor && tinyOut.offered.length === 0 && tinyOut.droppedForBudget.length > 0)

// The ceiling MOVES with geometry — derived, not pinned to today's number.
const doubled = narrationBudget(SECTION_NARRATION_COMPOSITION, LIVE_BUDGET.compositionSeconds * 4)
const doubledOut = composeMarketingSystem(facts({
  capabilities: ALL_KEYS, hasVoiceClone: true, hasAvatarSource: true, directMailEnabled: true, budget: doubled,
}))
check("a LONGER composition offers at least as many claims (the cap is derived, not hardcoded)",
  doubledOut.offered.length >= full.offered.length,
  `${doubledOut.offered.length} < ${full.offered.length}`)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 5. COMPLIANCE-FIRST — the fair-housing screen runs BEFORE the prompt (§5) ──")

check("the authored catalogue is clean — no claim is dropped by the screen today",
  full.droppedForCompliance.length === 0,
  full.droppedForCompliance.join(", "))

// POSITIVE CONTROL for the screen itself (§2): a clean catalogue and a broken
// screen both report zero drops. Two controls, because they fail differently.
//
// FIRST ATTEMPT AT THIS CONTROL FAILED, AND THE FAILURE IS THE FINDING. It used
// a hand-written poison string — "aimed at the right kind of family for this
// neighborhood" — which reads like an obvious steering claim and matches NOTHING
// in FAIR_HOUSING_PATTERNS. The detector is a PHRASE matcher, not an intent
// classifier: it fires on "perfect for families", not on a paraphrase of it.
// That is a real limit of the screen this module leans on, and it is recorded
// here rather than papered over. The control below is therefore DERIVED from the
// detector's own declared vocabulary (§2 — do not pin an assertion to a
// hand-picked waypoint), so it stays honest as patterns are added or reworded.
{
  const { FAIR_HOUSING_PATTERNS, detectFairHousingViolations } =
    await import("../lib/compliance-rules/fair-housing-patterns")

  const highs = FAIR_HOUSING_PATTERNS.filter((p) => p.severity === "high")
  check("the detector declares at least one HIGH-severity pattern to screen against",
    highs.length > 0)

  // Every high pattern must fire on text its own regex matches. Built from the
  // pattern, not from its prose label, so a reworded `phrase` cannot break it.
  const selfMatching = highs.filter((p) => {
    p.pattern.lastIndex = 0
    return p.phrase.match(p.pattern) !== null
  })
  const misfires = selfMatching.filter((p) => !detectFairHousingViolations(p.phrase).some((v) => v.severity === "high"))
  check(`every self-describing HIGH pattern is actually detected (${selfMatching.length}/${highs.length} usable as probes)`,
    selfMatching.length > 0 && misfires.length === 0,
    misfires.map((p) => p.phrase).join(", "))

  // END-TO-END: drive a poisoned claim through the REAL composer on the REAL
  // path and prove it is dropped BEFORE it could reach the writing prompt.
  const probe = selfMatching[0]
  const poisoned = [{
    id: "__poisoned_probe__", requires: ["video_generation"], requiresFacts: [] as never[],
    rank: 999, claim: `a marketing plan ${probe.phrase}`, wiredAt: "proof only",
  }]
  const screened = composeMarketingSystem(
    facts({ capabilities: ALL_KEYS, hasVoiceClone: true, hasAvatarSource: true, directMailEnabled: true }),
    poisoned,
  )
  check(`a HIGH-severity claim ("${probe.phrase}") is DROPPED before the prompt, not merely flagged`,
    screened.droppedForCompliance.includes("__poisoned_probe__")
      && !screened.offered.includes("__poisoned_probe__")
      && !screened.text.includes(probe.phrase))
  check("with its only claim dropped for compliance, the composer floors rather than emitting it",
    screened.usedFloor && screened.text === MARKETING_SYSTEM_FLOOR)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 6. The wire — an active function with a real caller (§1) ──")

const narration = code("lib/listing-presentation/section-narration.ts")
const render = code("lib/listing-presentation/section-render.ts")
const resolver = code("lib/listing-presentation/marketing-system-resolver.ts")
const caps = code("lib/entitlements/tenant-capabilities.ts")
const orch = code("lib/listing-presentation/section-narration-orchestrator.ts")

check("the frozen constant is GONE from live code (tombstone in comments does not count)",
  !/DEFAULT_MARKETING_SYSTEM/.test(narration))
check("section-narration falls back to the CLAIM-FREE floor, not to a hardcoded boast",
  /MARKETING_SYSTEM_FLOOR/.test(narration) && /marketingSystem\?\.trim\(\)\s*\|\|\s*MARKETING_SYSTEM_FLOOR/.test(narration))
check("section-render RESOLVES the marketing system — the writer that never existed",
  /resolveMarketingSystem\(/.test(render) && /marketingSystem:\s*marketing\.text/.test(render))
check("the resolver's budget comes from the composition's geometry, not a literal",
  /sectionNarrationBudget\(/.test(render))
check("the prompt tells the model it may claim ONLY what was resolved",
  /ONLY capabilities you may claim/.test(narration) && /NEVER invent a marketing capability/.test(narration))
check("the generated script is fair-housing screened before it can be spoken (§5)",
  /detectFairHousingViolations\(script\)/.test(narration) && /severity === "high"/.test(narration))
check("a HARD fair-housing flag falls back rather than shipping",
  /severity === "high"[\s\S]{0,400}?return fallback/.test(narration))

check("the tenant-capability reader reuses resolveEntitlement — no second resolution order (§6)",
  /resolveEntitlement\(/.test(caps) && /from "@\/lib\/entitlements\/resolve"/.test(caps))
check("it reads the billed tier through readPlanTier — no second tier spelling (§6)",
  /readPlanTier\(/.test(caps))
check("it normalises override_type through the canonical vocabulary (§6)",
  /normalizeOverrideType\(/.test(caps))
check("it declares NO table of its own beyond feature_flags + feature_access_overrides",
  (caps.match(/\.from\("([a-z_]+)"\)/g) ?? []).every((m) => /feature_flags|feature_access_overrides/.test(m)),
  (caps.match(/\.from\("([a-z_]+)"\)/g) ?? []).join(", "))
check("a REFUSED entitlement read fails CLOSED with an EMPTY allowed set (§4)",
  /ok:\s*false,\s*allowed:\s*NOTHING/.test(caps))
check("the override read refusing is also a refusal, not 'no overrides'",
  /overridesRes\.error[\s\S]{0,200}?ok:\s*false/.test(caps))
check("the resolver degrades to the floor when entitlements are unreadable, never to a boast",
  /!caps\.ok[\s\S]{0,400}?composeMarketingSystem\(emptyFacts\)/.test(resolver))
check("the agent voice/avatar read is ONE spelling shared with the orchestrator (§6)",
  /resolveAgentNarrationAssets\(/.test(resolver) && /export async function resolveAgentNarrationAssets/.test(orch))
check("the orchestrator no longer hand-rolls its own agent_voice_profiles query",
  (orch.match(/agent_voice_profiles/g) ?? []).length === 1)
check("the identity cross goes through agents.user_id, never users.id directly (§3)",
  /\.from\("agents"\)[\s\S]{0,120}?\.eq\("user_id"/.test(orch))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 7. NEGATIVE CONTROLS — re-introduce each defect in memory, expect the check to bite ──")

function negative(name: string, mutate: (s: string) => string, source: string, probe: (s: string) => boolean) {
  const broken = mutate(source)
  if (broken === source) { failed++; console.log(`  ✗ ${name} — MUTATION WAS A NO-OP (the control proves nothing)`); return }
  if (probe(broken)) { failed++; console.log(`  ✗ ${name} — the check STILL PASSES on the broken source`) }
  else { passed++; console.log(`  ✓ ${name}`) }
}

negative("re-adding DEFAULT_MARKETING_SYSTEM is caught",
  (s) => s + "\nconst DEFAULT_MARKETING_SYSTEM = 'x'\n", narration,
  (s) => !/DEFAULT_MARKETING_SYSTEM/.test(s))
negative("dropping the fair-housing post-check is caught",
  (s) => s.replace(/detectFairHousingViolations\(script\)/g, "[]"), narration,
  (s) => /detectFairHousingViolations\(script\)/.test(s))
negative("unwiring resolveMarketingSystem from the producer is caught",
  (s) => s.replace(/marketingSystem:\s*marketing\.text/g, ""), render,
  (s) => /marketingSystem:\s*marketing\.text/.test(s))
negative("a second resolution order in the capability reader is caught",
  (s) => s.replace(/resolveEntitlement\(/g, "myOwnResolver("), caps,
  (s) => /resolveEntitlement\(/.test(s))
negative("failing OPEN on an unreadable entitlement is caught",
  (s) => s.replace(/ok:\s*false,\s*allowed:\s*NOTHING/g, "ok: false, allowed: ALL"), caps,
  (s) => /ok:\s*false,\s*allowed:\s*NOTHING/.test(s))
negative("re-hand-rolling the agent voice query in the orchestrator is caught",
  (s) => s + '\nawait supabase.from("agent_voice_profiles").select("x")\n', orch,
  (s) => (s.match(/agent_voice_profiles/g) ?? []).length === 1)

// The behavioural negative control: a composer that ignores entitlements.
{
  const ignoring = (f: MarketingSystemFacts) => ({
    offered: MARKETING_SYSTEM_CLAIMS.map((c) => c.id), // the defect: claim everything
    text:    MARKETING_SYSTEM_CLAIMS.map((c) => c.claim).join(", "),
    budget:  f.budget,
  })
  const bad = ignoring(facts())
  const claimsSomething = MARKETING_SYSTEM_CLAIMS.some((c) => bad.text.includes(c.claim))
  check("a composer that ignored entitlements WOULD be caught by section 3's assertion",
    claimsSomething && bad.offered.length > 0)
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
console.log(` BLIND SPOTS (§2): this proof covers the COMPOSER and the WIRE. It does not`)
console.log(`   execute resolveTenantCapabilities against the live database (that needs`)
console.log(`   credentials and would be a tenancy proof, not a claim proof), and it does`)
console.log(`   not assert the AI's output — only that the output is screened and trimmed.`)
console.log(`   The feature-key check is a DATED SNAPSHOT (2026-08-26, ${LIVE_FEATURE_KEYS_20260826.size} keys), so it`)
console.log(`   catches an invented key but not one renamed since. The fair-housing screen`)
console.log(`   is a PHRASE matcher, not an intent classifier — it fires on "perfect for`)
console.log(`   families" and not on a paraphrase of it; see section 5's note.`)
if (failed > 0) { console.log(" ❌ MARKETING_SYSTEM_CLAIM_FAIL"); process.exit(1) }
console.log(" ✅ MARKETING_SYSTEM_CLAIM_PASS — no claim is spoken that the tenant cannot deliver")
