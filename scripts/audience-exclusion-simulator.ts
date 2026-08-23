#!/usr/bin/env tsx
/**
 * scripts/audience-exclusion-simulator.ts  (npm run test:audience-exclusion)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE. No DB, no network. The one Supabase-shaped thing here is a hand-written
 * stub whose whole job is to return a REFUSAL on demand, because "the gate could
 * not read the audiences" is one of the cases that must fail closed.
 *
 * ── THE OWNER RULING UNDER TEST ─────────────────────────────────────────────
 * VERBATIM: "capability is vital to this os to have not exclude."
 *
 * The OS must HAVE the capability — so that it does NOT exclude protected
 * people. Every assertion below is one of those two halves:
 *   · the capability EXISTS   — a campaign can declare which audiences it
 *     suppresses, that declaration reaches the Meta payload, and it is recorded
 *     on the audience (m538). Without this, an operator did it in Meta's own
 *     Exclude box, outside anything this product could see;
 *   · the capability REFUSES  — every audience placed in that slot passes
 *     `personaAdsEligibility(persona, "exclusion")`, so a protected-characteristic
 *     persona audience CANNOT be a suppression list (Fair Housing Act,
 *     42 U.S.C. § 3604(c); HUD's 2019-2022 actions against Meta).
 *
 * ── WHY EVERY GATE ASSERTION IS TWO-SIDED (CLAUDE.md §2) ────────────────────
 * A gate that refuses everything and a gate that refuses the right thing both
 * report "refused" on the case you wrote first. So each refusal here is paired
 * with an ADMISSION that must survive: a non-protected persona audience, a
 * pipeline audience and a lifetime-customer audience must all still be usable as
 * exclusions, because suppressing people you are already in conversation with is
 * ordinary ad hygiene and refusing it would be a broken product, not a safe one.
 * The INCLUSION arm is asserted untouched on the very same audiences — that is
 * the owner's 2026-08-23 them-first ruling and this lane must not disturb it.
 *
 * ── AND WHY THERE ARE MUTATION TESTS (§7) ───────────────────────────────────
 * Section 8 re-implements three specific weakenings of the real code and shows
 * the assertions above going RED under each. An assertion that has never been
 * shown to fail is not evidence.
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  EXCLUDED_AUDIENCE_IDS_KEY,
  INCLUDED_AUDIENCE_IDS_KEY,
  excludedAudienceIdsIn,
  includedAudienceIdsIn,
  resolveExclusionSlot,
  verifyExclusionSlot,
  recordSuppressionUse,
  type AudienceReader,
  type ExclusionAudienceRow,
  type ExclusionSlotVerdict,
} from "../lib/ads/audience-exclusion"
import {
  personaAdsEligibility,
  resolveAudiencePersonaBasis,
  assertAudiencePersonaBasis,
  EXCLUSION_INELIGIBLE_PERSONAS,
  PERSONA_SEGMENT_TYPE,
} from "../lib/ads/audience-persona-basis"
import { audienceUseOf } from "../lib/ads/audience-source-rules"
import { CAMPAIGN_PERSONAS, type CampaignPersona } from "../lib/campaigns/contact-sources"
import { FB_AUDIENCE_TEMPLATES, templateAudienceUse } from "../lib/ads/fb-audience-templates"
import { validateAdReadiness, buildMetaAdStructure, type AdBuildInput } from "../lib/ads/connectors/ad-payload"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { blankComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
/** Source with COMMENTS BLANKED — CLAUDE.md §2: never hand-roll a stripper, and
 *  never let a file's own prose satisfy a source assertion about it. */
const code = (p: string) => blankComments(readFileSync(join(root, p), "utf8"))
const raw = (p: string) => readFileSync(join(root, p), "utf8")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ─── THE AUDIENCE FIXTURE ─────────────────────────────────────────────────────
// Eight audiences in one brokerage. Four are persona audiences on the four
// personas the owner ruled IN for inclusion and that remain protected
// characteristics for exclusion; two are persona audiences on ordinary
// situations; two are behaviour/lifecycle audiences. The fixture exists because
// the live tenant holds ZERO audiences — at that size every gate "passes".

const AUD: Record<string, ExclusionAudienceRow> = {
  senior:   { id: "a-senior",   audience_name: "Persona — Senior Transition", source_rule: { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["senior"] } }, external_audience_id: "fb-1", status: "synced" },
  probate:  { id: "a-probate",  audience_name: "Persona — Probate",           source_rule: { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["probate"] } }, external_audience_id: "fb-2", status: "synced" },
  divorce:  { id: "a-divorce",  audience_name: "Persona — Divorce",           source_rule: { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["divorce"] } }, external_audience_id: "fb-3", status: "synced" },
  military: { id: "a-military", audience_name: "Persona — Military / VA",     source_rule: { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["military"] } }, external_audience_id: "fb-4", status: "synced" },
  fsbo:     { id: "a-fsbo",     audience_name: "Persona — FSBO",              source_rule: { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["fsbo"] } }, external_audience_id: "fb-5", status: "synced" },
  upsize:   { id: "a-upsize",   audience_name: "Persona — Upsizing",          source_rule: { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["upsize"] } }, external_audience_id: "fb-6", status: "synced" },
  pipeline: { id: "a-pipeline", audience_name: "Exclude — Active Pipeline",   source_rule: { type: "exclusion_active_pipeline", filters: {} }, external_audience_id: "fb-7", status: "synced" },
  lifetime: { id: "a-lifetime", audience_name: "Lifetime Customers",          source_rule: { type: "lifetime_customers", filters: {} }, external_audience_id: "fb-8", status: "synced" },
  // Protected class smuggled somewhere OTHER than the personas key. The persona
  // gate never sees this one — the token gate is what refuses it.
  tagged:   { id: "a-tagged",   audience_name: "55+ Owners",                  source_rule: { type: "contact_list", filters: { contact_tags: ["seniors-55plus"] } }, external_audience_id: "fb-9", status: "synced" },
  // Never synced: no platform id, so the launch door cannot apply it.
  unsynced: { id: "a-unsynced", audience_name: "Investors",                   source_rule: { type: "investor_contacts", filters: {} }, external_audience_id: null, status: "approved" },
  // A rule this product cannot resolve. Refused rather than guessed.
  garbage:  { id: "a-garbage",  audience_name: "Legacy import",               source_rule: { type: "everyone_please" }, external_audience_id: "fb-10", status: "synced" },
}
const ALL_ROWS = Object.values(AUD)

const PROTECTED_AUDS = ["senior", "probate", "divorce", "military"] as const
const ORDINARY_AUDS = ["fsbo", "upsize", "pipeline", "lifetime"] as const

const targeting = (excluded: string[] = [], included: string[] = []) => ({
  locations: [{ city: "Austin", state: "TX" }],
  [INCLUDED_AUDIENCE_IDS_KEY]: included,
  [EXCLUDED_AUDIENCE_IDS_KEY]: excluded,
})

/**
 * A supabase-shaped stub: `from().select().eq().in()` resolving to ONE answer.
 * Its whole purpose is the refusal cases — "the gate could not read the
 * audiences" has to be reproducible, and a mock that can only succeed would
 * leave the fail-closed arms untested.
 */
interface StubAnswer { data: unknown; error: { message: string } | null }
interface StubChain {
  select: () => StubChain
  update: (v: Record<string, unknown>) => StubChain
  eq: () => StubChain
  in: () => Promise<StubAnswer>
}
function stubClient(answer: StubAnswer): { client: AudienceReader } {
  const chain: StubChain = {
    select: () => chain,
    update: () => chain,
    eq: () => chain,
    in: () => Promise.resolve(answer),
  }
  return { client: { from: () => chain } }
}

async function main() {
  console.log("\n══════════════════════════════════════════════════")
  console.log(" AUDIENCE EXCLUSION — the OS can SEE an exclusion, so it can REFUSE one")
  console.log("══════════════════════════════════════════════════")

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[1 · THE CAPABILITY EXISTS — a campaign can DECLARE what it suppresses]")

  check("TargetingConfig (kernel) carries an excluded-audience field",
    new RegExp(`${EXCLUDED_AUDIENCE_IDS_KEY}\\?:\\s*string\\[\\]`).test(code("lib/kernel/ads.ts")))
  check("TargetingConfig (ad-creator) carries it too, and REQUIRED — a writer must say what it suppresses",
    new RegExp(`${EXCLUDED_AUDIENCE_IDS_KEY}:\\s*string\\[\\]`).test(code("lib/ads/ad-creator-types.ts")))
  check("POSITIVE CONTROL — those scanners report ABSENCE on a file that has no such field",
    !new RegExp(`${EXCLUDED_AUDIENCE_IDS_KEY}`).test(code("lib/ads/connectors/registry.ts")))
  check("the slot reader accepts a clean list and de-duplicates it",
    JSON.stringify(excludedAudienceIdsIn(targeting(["a-1", "a-2", "a-1"]))) === JSON.stringify(["a-1", "a-2"]))
  check("…and reads the INCLUDE slot with the same rules",
    JSON.stringify(includedAudienceIdsIn(targeting([], ["a-9"]))) === JSON.stringify(["a-9"]))
  // The malformed shapes are proven THROUGH THE DOOR in section 5 — the check is
  // module-private on purpose, because asking "is this slot malformed?" without
  // then refusing on the answer is the shape this module exists to remove.
  check("the three writers that emitted custom_audience_ids: [] now declare the exclusion slot too",
    [
      "app/dashboard/campaigns/ads/ads-dashboard-client.tsx",
      "lib/wizard-staging/content-staging.ts",
      "lib/workflow/adapters/ad-campaign.ts",
    ].every((p) => new RegExp(`${EXCLUDED_AUDIENCE_IDS_KEY}|EXCLUDED_AUDIENCE_IDS_KEY`).test(code(p))))
  check("the ads dashboard gives an operator a CONTROL for it (declared in the product, not in Meta's UI)",
    /excludedAudienceIds/.test(code("app/dashboard/campaigns/ads/ads-dashboard-client.tsx"))
    && /Audiences to exclude/.test(raw("app/dashboard/campaigns/ads/ads-dashboard-client.tsx")))
  check("…and that control EXPLAINS a refusal before the operator saves, using the same pure gate",
    /resolveExclusionSlot\s*\(/.test(code("app/dashboard/campaigns/ads/ads-dashboard-client.tsx"))
    && /Cannot be used as an exclusion/.test(raw("app/dashboard/campaigns/ads/ads-dashboard-client.tsx")))
  check("…while the ENFORCEMENT stays server-side (the client cannot be the gate, §4)",
    /verifyExclusionSlot\s*\(/.test(code("lib/ads/ad-creator.ts"))
    && !/verifyExclusionSlot\s*\(/.test(code("app/dashboard/campaigns/ads/ads-dashboard-client.tsx")))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[2 · THE CAPABILITY REFUSES — a protected characteristic may not SUPPRESS]")

  for (const key of PROTECTED_AUDS) {
    const row = AUD[key]
    const v = resolveExclusionSlot([row.id], ALL_ROWS, "Prospecting — Spring")
    check(`"${row.audience_name}" in the EXCLUDE slot → REFUSED (protected_characteristic)`,
      !v.ok && v.refusalKind === "protected_characteristic",
      v.ok ? "ADMITTED — this is the HUD v. Meta shape" : `kind=${v.refusalKind}`)
    check(`…and the refusal names the audience and the fix, not a bare code`,
      !v.ok && v.refusal.includes(row.audience_name!) && v.refusal.length > 120)
  }
  check("the refusal comes from the ARM THAT ALREADY EXISTED — personaAdsEligibility(persona,'exclusion')",
    PROTECTED_AUDS.every((k) => {
      const persona = (AUD[k].source_rule as { filters: { personas: string[] } }).filters.personas[0]
      const verdict = personaAdsEligibility(persona as CampaignPersona, "exclusion")
      return !verdict.eligible && verdict.refusalKind === "protected_characteristic"
    }))
  check("…and the module does NOT re-implement it (no second protected-class list here, §6)",
    !/PROTECTED_CLASS_TOKENS|senior.*probate.*divorce/.test(code("lib/ads/audience-exclusion.ts")))
  check("EXCLUSION_INELIGIBLE_PERSONAS is exactly the set that refuses in the slot",
    CAMPAIGN_PERSONAS.every((p) => {
      const rule = { type: PERSONA_SEGMENT_TYPE, filters: { personas: [p] } }
      const v = resolveExclusionSlot(["x"], [{ id: "x", audience_name: p, source_rule: rule }], "C")
      return v.ok !== EXCLUSION_INELIGIBLE_PERSONAS.includes(p)
    }), EXCLUSION_INELIGIBLE_PERSONAS.join(","))
  check("a protected class smuggled OUTSIDE the personas key is refused by the token gate arm",
    (() => {
      const v = resolveExclusionSlot([AUD.tagged.id], ALL_ROWS, "C")
      return !v.ok && v.refusalKind === "protected_segmentation"
    })())

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[3 · THE OTHER SIDE — this is NOT refuse-every-exclusion]")
  console.log("     (a gate that refuses everything is not a gate, it is an outage)")

  for (const key of ORDINARY_AUDS) {
    const row = AUD[key]
    const v = resolveExclusionSlot([row.id], ALL_ROWS, "Prospecting — Spring")
    check(`"${row.audience_name}" in the EXCLUDE slot → ADMITTED (ordinary ad hygiene)`,
      v.ok, v.ok ? "" : v.refusal.slice(0, 120))
  }
  check("several ordinary audiences can be excluded at once, and all are reported governed",
    (() => {
      const ids = ORDINARY_AUDS.map((k) => AUD[k].id)
      const v = resolveExclusionSlot(ids, ALL_ROWS, "C")
      return v.ok && v.governed.length === ids.length
        && v.governed.every((g) => ids.includes(g.audienceId) && g.ruleType.length > 0)
    })())
  check("an EMPTY slot is admitted and governs nothing (no exclusion declared is not an error)",
    (() => { const v = resolveExclusionSlot([], ALL_ROWS, "C"); return v.ok && v.governed.length === 0 })())

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[4 · THE INCLUSION ARM IS UNTOUCHED — the owner's them-first ruling]")
  console.log("     (\"that is how we show them info or ads that is worded to their situation\")")

  for (const key of PROTECTED_AUDS) {
    const rule = AUD[key].source_rule
    check(`"${AUD[key].audience_name}" is still a valid TARGETING basis`,
      resolveAudiencePersonaBasis(rule).ok
      && ((): boolean => { try { assertAudiencePersonaBasis(rule, "x"); return true } catch { return false } })())
  }
  check("…and the same four audiences pass when named in the INCLUDE slot (only the exclude slot gates)",
    (() => {
      const ids = PROTECTED_AUDS.map((k) => AUD[k].id)
      const t = targeting([], ids)
      return excludedAudienceIdsIn(t).length === 0 && includedAudienceIdsIn(t).length === 4
        && resolveExclusionSlot(excludedAudienceIdsIn(t), ALL_ROWS, "C").ok
    })())
  check("the ESCALATION is what makes the difference — the same rule, two operations, two verdicts",
    resolveAudiencePersonaBasis(AUD.senior.source_rule).ok
    && !resolveAudiencePersonaBasis(AUD.senior.source_rule, "exclusion").ok)
  check("…and the escalation cannot be used to WIDEN (its only value is 'exclusion')",
    /escalateTo\?:\s*"exclusion"/.test(code("lib/ads/audience-persona-basis.ts")))
  check("POSITIVE CONTROL — that scanner would see a two-way parameter if one existed",
    /escalateTo\?:\s*"exclusion"/.test('function f(rule: unknown, escalateTo?: "exclusion") {}')
    && !/escalateTo\?:\s*"exclusion"/.test('function f(rule: unknown, use?: AudienceUse) {}'))
  check("an audience whose OWN RULE declares exclusion still reads that way (audienceUseOf unchanged)",
    audienceUseOf(AUD.pipeline.source_rule) === "exclusion"
    && audienceUseOf(AUD.senior.source_rule) === "inclusion")

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[5 · FAIL CLOSED — every path that cannot verify REFUSES (CLAUDE.md §4)]")

  const failClosed: Array<[string, ExclusionSlotVerdict, string]> = [
    ["an id with NO audience row in this tenant (also the cross-tenant id shape)",
      resolveExclusionSlot(["a-not-mine"], ALL_ROWS, "C"), "unknown_audience"],
    ["an audience whose source rule names an unresolvable type",
      resolveExclusionSlot([AUD.garbage.id], ALL_ROWS, "C"), "unresolvable_rule"],
    ["an audience with a NULL source rule",
      resolveExclusionSlot(["n"], [{ id: "n", audience_name: "no rule", source_rule: null }], "C"), "unresolvable_rule"],
    ["a persona audience whose basis is the catch-all `other`",
      resolveExclusionSlot(["o"], [{ id: "o", audience_name: "Other", source_rule: { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["other"] } } }], "C"), "no_basis"],
    ["a persona audience with an EMPTY persona list",
      resolveExclusionSlot(["e"], [{ id: "e", audience_name: "Empty", source_rule: { type: PERSONA_SEGMENT_TYPE, filters: { personas: [] } } }], "C"), "unresolvable_basis"],
  ]
  for (const [label, verdict, kind] of failClosed) {
    check(`${label} → REFUSED (${kind})`,
      !verdict.ok && verdict.refusalKind === kind,
      verdict.ok ? "ADMITTED" : `kind=${verdict.refusalKind}`)
  }

  // The async door: a read that fails is not "no rows, therefore nothing to check".
  const readRefusal = stubClient({ data: null, error: { message: "permission denied for table facebook_custom_audiences" } })
  const noTenant = stubClient({ data: [], error: null })
  const okRead = stubClient({ data: [AUD.senior], error: null })
  const asyncVerdicts = await Promise.all([
    verifyExclusionSlot({ supabase: readRefusal.client, brokerageId: "b1", targeting: targeting(["a-senior"]), campaignLabel: "C" }),
    verifyExclusionSlot({ supabase: noTenant.client, brokerageId: "", targeting: targeting(["a-senior"]), campaignLabel: "C" }),
    verifyExclusionSlot({ supabase: okRead.client, brokerageId: "b1", targeting: { [EXCLUDED_AUDIENCE_IDS_KEY]: "a-senior" }, campaignLabel: "C" }),
    verifyExclusionSlot({ supabase: okRead.client, brokerageId: "b1", targeting: { [EXCLUDED_AUDIENCE_IDS_KEY]: [{ id: "a-senior" }] }, campaignLabel: "C" }),
    verifyExclusionSlot({ supabase: okRead.client, brokerageId: "b1", targeting: { [EXCLUDED_AUDIENCE_IDS_KEY]: ["  "] }, campaignLabel: "C" }),
    verifyExclusionSlot({ supabase: okRead.client, brokerageId: "b1", targeting: targeting(["a-senior"]), campaignLabel: "C" }),
    verifyExclusionSlot({ supabase: noTenant.client, brokerageId: "b1", targeting: targeting([]), campaignLabel: "C" }),
    recordSuppressionUse({ supabase: stubClient({ data: null, error: { message: "PGRST204 column not found" } }).client, brokerageId: "b1", campaignId: "c1", governed: [{ audienceId: "a-lifetime", audienceName: "L", ruleType: "lifetime_customers" }] }),
  ])
  {
    const [refused, tenantless, malformed, malformedObj, malformedBlank, gated, empty, audit] = asyncVerdicts
    check("a supabase READ REFUSAL fails the gate closed (a swallowed refusal is CLAUDE.md §3's trap)",
      !refused.ok && refused.refusalKind === "gate_unavailable")
    check("a call carrying NO TENANT refuses rather than reading every brokerage's audiences (§4)",
      !tenantless.ok && tenantless.refusalKind === "gate_unavailable")
    check("a MALFORMED slot refuses at the door — a bare string, a list of objects, a blank id",
      !malformed.ok && malformed.refusalKind === "malformed_slot"
      && !malformedObj.ok && malformedObj.refusalKind === "malformed_slot"
      && !malformedBlank.ok && malformedBlank.refusalKind === "malformed_slot")
    check("…and the same door ADMITS nothing it should not: the senior audience is still refused through it",
      !gated.ok && gated.refusalKind === "protected_characteristic")
    check("POSITIVE CONTROL — with an empty slot the door returns ok WITHOUT reading anything",
      empty.ok && empty.audienceIds.length === 0)
    check("the m538 audit write SURFACES its refusal instead of swallowing it (PGRST204 until applied)",
      audit.recorded === 0 && !!audit.error && audit.error.includes("m538"))
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[6 · ALL FOUR DOORS onto a campaign's targeting carry the gate]")

  const doors: Array<[string, string]> = [
    ["lib/kernel/ads.ts — createAdCampaign + updateAdCampaign", "lib/kernel/ads.ts"],
    ["lib/ads/ad-creator.ts — the door the dashboard, staging and workflows use", "lib/ads/ad-creator.ts"],
    ["lib/ads/launch-assembler.ts — the last door before the platform", "lib/ads/launch-assembler.ts"],
  ]
  for (const [label, path] of doors) {
    check(`${label} calls verifyExclusionSlot`, /verifyExclusionSlot\s*\(/.test(code(path)))
  }
  check("the kernel gates BOTH of its commands (define AND rewrite — a rewrite could swap a clean config)",
    (code("lib/kernel/ads.ts").match(/verifyExclusionSlot\s*\(/g) ?? []).length >= 2)
  check("POSITIVE CONTROL — the door scanner reports ABSENCE on a file that has no such call",
    !/verifyExclusionSlot\s*\(/.test(code("lib/ads/audience-source-rules.ts")))
  check("every door takes its tenant from the SESSION/ctx, never from the targeting config (§4)",
    /brokerageId:\s*ctx\.brokerageId/.test(code("lib/kernel/ads.ts"))
    && /brokerageId,\n/.test(code("lib/ads/ad-creator.ts"))
    && /brokerageId:\s*campaign\.brokerage_id/.test(code("lib/ads/launch-assembler.ts")))
  check("the m538 audit stamp is written by the define doors and its error is READ, never swallowed",
    /recordSuppressionUse\s*\(/.test(code("lib/kernel/ads.ts"))
    && /recordSuppressionUse\s*\(/.test(code("lib/ads/ad-creator.ts"))
    && /suppressionAuditWarning/.test(code("lib/kernel/ads.ts")))
  check("…and it reaches the OPERATOR — 'not yet auditable' is shown, not dropped on the floor",
    /suppressionAuditWarning/.test(code("app/dashboard/campaigns/ads/ads-dashboard-client.tsx")))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[7 · THE EXCLUSION REACHES THE PLATFORM — and only when it was gated]")

  const baseInput = (exclusion: string[], governed: boolean): AdBuildInput => ({
    platform: "facebook", objective: "leads", campaignName: "Spring", dailyBudgetUsd: 50,
    pageId: "p1", leadFormId: "f1",
    creative: { headline: "h", primaryText: "t", mediaAssetUrl: "https://x/y.jpg" },
    targeting: {
      locations: [{ city: "Austin" }],
      audienceExternalIds: ["fb-8"],
      excludedAudienceExternalIds: exclusion,
      ...(governed ? { exclusionGovernance: "gated" as const } : {}),
    },
    specialAdCategory: "HOUSING",
  })
  check("a GATED exclusion list is ready to launch",
    validateAdReadiness(baseInput(["fb-1"], true)).ready)
  check("an UNGATED exclusion list is a VIOLATION — 'nobody checked' is not 'checked and fine'",
    (() => {
      const v = validateAdReadiness(baseInput(["fb-1"], false))
      return !v.ready && v.violations.some((x) => x.includes("never gated"))
    })())
  check("POSITIVE CONTROL — a campaign with NO exclusion list needs no governance flag and is ready",
    validateAdReadiness(baseInput([], false)).ready)
  const meta = buildMetaAdStructure(baseInput(["fb-1", "fb-7"], true))
  const metaTargeting = (meta.adSet as { targeting: Record<string, unknown> }).targeting
  check("the Meta ad set carries excluded_custom_audiences (Meta's own Exclude field)",
    JSON.stringify(metaTargeting.excluded_custom_audiences) === JSON.stringify([{ id: "fb-1" }, { id: "fb-7" }]))
  check("…and custom_audiences, which is the READER custom_audience_ids never had (§1)",
    JSON.stringify(metaTargeting.custom_audiences) === JSON.stringify([{ id: "fb-8" }]))
  check("a campaign that declares NEITHER slot emits neither key (no empty arrays sent to Meta)",
    (() => {
      const t = (buildMetaAdStructure({ ...baseInput([], true), targeting: { locations: [{ city: "Austin" }] } }).adSet as { targeting: Record<string, unknown> }).targeting
      return !("custom_audiences" in t) && !("excluded_custom_audiences" in t)
    })())
  check("the launch assembler READS both slots (the missing half custom_audience_ids never had)",
    /includedAudienceIdsIn\s*\(/.test(code("lib/ads/launch-assembler.ts"))
    && /excludedAudienceIdsIn\s*\(/.test(code("lib/ads/launch-assembler.ts")))
  check("…and REFUSES to launch when a named audience never synced (a vanished exclusion shows the ad to the excluded)",
    /never synced to the platform/.test(raw("lib/ads/launch-assembler.ts")))
  check("exclusionGovernance is set in exactly ONE place, from the verdict (not asserted by hand)",
    (code("lib/ads/launch-assembler.ts").match(/exclusionGovernance:/g) ?? []).length === 1
    && (code("lib/ads/connectors/ad-payload.ts").match(/exclusionGovernance\s*!==/g) ?? []).length === 1)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[8 · ONE VOCABULARY — `category: \"exclusion\"` is gone (CLAUDE.md §6)]")

  const templatesSrc = code("lib/ads/fb-audience-templates.ts")
  check("the AudienceTemplate category union no longer carries an `exclusion` member",
    !/category:\s*"remarketing"[^\n]*"exclusion"/.test(templatesSrc))
  check("POSITIVE CONTROL — that scanner recognises the member when it is present",
    /category:\s*"remarketing"[^\n]*"exclusion"/.test('  category: "remarketing" | "lookalike" | "exclusion" | "geo"'))
  check("NO shipped template declares that category any more",
    !FB_AUDIENCE_TEMPLATES.some((t) => (t.category as string) === "exclusion"))
  check("the SURVIVOR is rule-derived and still identifies the subtracting template",
    FB_AUDIENCE_TEMPLATES.some((t) => templateAudienceUse(t) === "exclusion")
    && FB_AUDIENCE_TEMPLATES.filter((t) => templateAudienceUse(t) === "exclusion")
      .every((t) => t.sourceRule.type.startsWith("exclusion_")))
  check("the drifted duplicate is DELETED and its tombstone names the survivor at file:line",
    !FB_AUDIENCE_TEMPLATES.some((t) => t.id === "exclude_lifetime_customers")
    && /TOMBSTONE/.test(raw("lib/ads/fb-audience-templates.ts"))
    && /lib\/ads\/fb-audience-templates\.ts:\d+/.test(raw("lib/ads/fb-audience-templates.ts")))
  check("…and the survivor absorbed what it was for (excluding past clients from prospecting)",
    (() => {
      const t = FB_AUDIENCE_TEMPLATES.find((x) => x.id === "lifetime_customers")
      return !!t && t.recommendedFor.some((r) => /exclude/i.test(r))
    })())
  check("no template combines an exclusion rule type with a persona basis (the catalog cannot express one)",
    FB_AUDIENCE_TEMPLATES.every((t) => !(templateAudienceUse(t) === "exclusion" && "personas" in (t.sourceRule.filters ?? {}))))
  check("the dashboard badge is derived from the rule, not from the shelf label",
    /templateAudienceUse\s*\(/.test(code("app/dashboard/campaigns/ads/ads-dashboard-client.tsx")))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[9 · THE AUDIT RECORD (m538) — the fact outlives the campaign]")

  const migration = "supabase/migrations/m538-an-audience-used-as-a-suppression-list-left-no-trace-on-the-audience.sql"
  check("m538 exists and is the number reserved for this lane",
    existsSync(join(root, migration)))
  const mig = raw(migration)
  check("…and adds BOTH audit columns to facebook_custom_audiences",
    /add column if not exists used_as_suppression_at timestamptz/.test(mig)
    && /add column if not exists used_as_suppression_by_campaign_id uuid/.test(mig))
  check("…with ON DELETE SET NULL on the campaign pointer (the fact survives the campaign, m535's lesson applied)",
    /on delete set null/.test(mig) && /used_as_suppression_at.{0,2} deliberately survives/.test(mig))
  check("…and states its APPLICATION STATUS honestly (files are not the database, §3)",
    /APPLICATION STATUS: WRITTEN, NOT APPLIED/.test(mig))
  check("the WRITER names exactly those columns",
    /used_as_suppression_at:/.test(code("lib/ads/audience-exclusion.ts"))
    && /used_as_suppression_by_campaign_id:/.test(code("lib/ads/audience-exclusion.ts")))
  check("the READER exists — the ads dashboard states it on the audience card (§1: no writerless column)",
    /used_as_suppression_at/.test(code("app/dashboard/campaigns/ads/ads-dashboard-client.tsx"))
    && /Used as an EXCLUSION/.test(raw("app/dashboard/campaigns/ads/ads-dashboard-client.tsx")))
  check("POSITIVE CONTROL — the reader scanner reports ABSENCE on a surface that does not show it",
    !/used_as_suppression_at/.test(code("app/dashboard/campaigns/ads/ctv-lane.tsx")))

  // THE PENDING STATE, STATED (CLAUDE.md §3 — files are not the database). This
  // assertion holds BEFORE and AFTER the integrator applies m538, so it is not a
  // trap that has to be edited on application: either the live snapshot already
  // carries the columns, or the migration that adds them is on disk. What it
  // will NOT let happen is code naming those columns with no migration behind
  // them at all.
  const snapshotCols = new Set(SCHEMA_SNAPSHOT.facebook_custom_audiences ?? [])
  const liveYet = snapshotCols.has("used_as_suppression_at") && snapshotCols.has("used_as_suppression_by_campaign_id")
  check("the audit columns are either LIVE in the schema snapshot or backed by m538 on disk",
    liveYet || existsSync(join(root, migration)))
  console.log(liveYet
    ? "     · m538 is APPLIED — the columns are in the live snapshot."
    : "     · m538 is NOT applied yet: scripts/schema-drift-guard.ts reports exactly TWO findings\n" +
      "       (facebook_custom_audiences.used_as_suppression_at / _by_campaign_id, update) and they\n" +
      "       clear when the integrator applies m538 and regenerates scripts/schema-snapshot.ts.")

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[10 · MUTATION TESTS — each gate is REMOVED and the assertions go RED]")
  console.log("      (an assertion never shown to fail is not evidence, CLAUDE.md §7)")

  // MUTATION A — the escalation is dropped: the slot asks the audience's OWN rule
  // which operation it performs, which is what every gate did before this lane.
  function mutantA(ids: string[], rows: ExclusionAudienceRow[]): boolean {
    for (const id of ids) {
      const row = rows.find((r) => r.id === id)
      if (!row) continue
      const res = resolveAudiencePersonaBasis(row.source_rule)   // ← no "exclusion"
      if (!res.ok) return false
    }
    return true
  }
  const realRefusals = PROTECTED_AUDS.filter((k) => !resolveExclusionSlot([AUD[k].id], ALL_ROWS, "C").ok).length
  const mutantARefusals = PROTECTED_AUDS.filter((k) => !mutantA([AUD[k].id], ALL_ROWS)).length
  check(`WITH the escalation, all ${PROTECTED_AUDS.length} protected persona audiences are refused in the slot`,
    realRefusals === PROTECTED_AUDS.length, `${realRefusals}/${PROTECTED_AUDS.length}`)
  check(`WITHOUT it, ALL ${PROTECTED_AUDS.length} are ADMITTED — the exact HUD v. Meta shape, reproduced`,
    mutantARefusals === 0, `${mutantARefusals} still refused`)

  // MUTATION B — the unknown-audience arm is made permissive ("no row, nothing to
  // check"), which is the shape that reads as safe and is not.
  function mutantB(ids: string[], rows: ExclusionAudienceRow[]): boolean {
    const known = ids.filter((id) => rows.some((r) => r.id === id))
    return resolveExclusionSlot(known, rows, "C").ok
  }
  check("the REAL gate refuses an id it cannot resolve",
    !resolveExclusionSlot(["a-not-mine"], ALL_ROWS, "C").ok)
  check("…the mutant ADMITS it (an unverifiable suppression list waved through)",
    mutantB(["a-not-mine"], ALL_ROWS))
  check("…and the mutant admits a CROSS-TENANT id too — the same hole, wearing the IDOR shape",
    mutantB(["a-senior-from-another-brokerage"], ALL_ROWS))

  // MUTATION C — the payload's governance requirement is dropped.
  function mutantC(input: AdBuildInput): boolean {
    const v = validateAdReadiness(input)
    return v.violations.filter((x) => !x.includes("never gated")).length === 0
  }
  check("the REAL validator refuses an ungoverned exclusion list",
    !validateAdReadiness(baseInput(["fb-1"], false)).ready)
  check("…the mutant lets it through to the platform",
    mutantC(baseInput(["fb-1"], false)))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[11 · PUBLISHED BLIND SPOTS — beside the numbers, not omitted (CLAUDE.md §2)]")
  console.log("     · DENOMINATOR: this lane asserts on a 10-row AUDIENCE FIXTURE. The live")
  console.log("       tenant holds ZERO facebook_custom_audiences rows (2026-08-22), so every")
  console.log("       gate here would 'pass' a live check by having nothing to judge.")
  console.log("     · m538 is WRITTEN, NOT APPLIED. Until the integrator applies it the audit")
  console.log("       stamp refuses with PGRST204 and that refusal is surfaced as")
  console.log("       suppressionAuditWarning. The GATE does not depend on those columns.")
  console.log("     · NOT COVERED, and not claimable: an operator with direct Meta Ads Manager")
  console.log("       access can still build an audience there and exclude it by hand. No")
  console.log("       software in this repo is in that path. What changed is that the")
  console.log("       SUPPORTED way now runs through a gate instead of round the outside.")
  console.log("     · The gate reads an audience's STORED source_rule. An audience whose rule")
  console.log("       was legitimate when synced and whose CONTACTS later drifted is judged on")
  console.log("       the rule, not the delivered list — the same basis every other ads gate")
  console.log("       here uses, and the same blind spot.")

  finish()
}

function finish() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ AUDIENCE_EXCLUSION_PASS — an exclusion an operator intends is DECLARED in the")
  console.log("    product, gated at all four doors, refused when it would suppress a protected")
  console.log("    characteristic, and recorded on the audience it suppressed.")
}

main().catch((err) => {
  console.log(`  ✗ the simulator itself threw — ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
