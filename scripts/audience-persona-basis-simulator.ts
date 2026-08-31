#!/usr/bin/env tsx
/**
 * scripts/audience-persona-basis-simulator.ts  (npm run test:audience-persona-basis)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE. No DB, no mocks, no network.
 *
 * OWNER RULINGS UNDER TEST, VERBATIM:
 *   · "audience should be segmented on persona."
 *   · (2026-08-23, REVERSING this lane's first cut) "military, senior, divorced
 *     and probate need to be allowed as situation persona because that is how we
 *     show them info or ads that is worded to their situation as part of them-first
 *     methology."
 *   · (defining the term) "lifetime and active seller are contact type not
 *     persona. persona is more the situation that the contact or lead is in."
 *
 * ── WHAT CHANGED, AND WHY THE COUNTS MOVED (CLAUDE.md §2) ────────────────────
 * The first cut COMPUTED an eligibility split by running each canonical persona
 * through `protectedClassReasonFor`, which made senior/probate/divorce/military
 * ads-INELIGIBLE on fail-closed grounds. The owner ruled all four ELIGIBLE as an
 * INCLUSION basis. So the split is no longer by WORD, it is by OPERATION:
 *
 *   · a persona used to INCLUDE people and choose their wording  → ALLOWED;
 *   · a protected-characteristic persona used to EXCLUDE or SUPPRESS an
 *     audience (`exclusion_*` source-rule types)                 → REFUSED.
 *
 * WHAT IS PROVEN, AND IN BOTH DIRECTIONS:
 *   1. the canonical persona vocabulary is ONE vocabulary (CLAUDE.md §6) — the TS
 *      union, the runtime roster and the live CHECK agree;
 *   2. the inclusion set is every persona that names a SITUATION, and the four the
 *      ruling turned admit both gates now — INCLUDING the delta: each of the four
 *      is shown to be one the PRE-RULING derivation would have refused, so the
 *      reversal is measured rather than asserted;
 *   3. the EXCLUSION refusal is derived from the same classifier, never listed,
 *      and refuses at both gates — with a positive control that a NON-protected
 *      persona may still be excluded (a gate that refuses every exclusion is not
 *      this gate);
 *   4. THE RAW PROVIDER ATTRIBUTE PATH IS UNTOUCHED. `min_owner_age`,
 *      `demographics.recentlyDivorced`, `quicklists:["senior-owner","inherited"]`
 *      and `contact_tags:["seniors-55plus"]` are still refused/stripped on the ads
 *      lane — including when they are smuggled INTO the `personas` key, which is
 *      the one shape this lane's carve-out could plausibly have opened. This is
 *      the regression this lane was most likely to cause and it carries the most
 *      assertions;
 *   5. an unresolvable basis REFUSES rather than populating (CLAUDE.md §4);
 *   6. the DATA LANE still does not refuse any of them (CLAUDE.md §3, STEP 3 —
 *      the exemption the owner granted must survive this change);
 *   7. the pre-existing protected-class refusal still refuses everything else it
 *      was written for (nothing beyond the one carve-out was softened).
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  personaAdsEligibility,
  resolveAudiencePersonaBasis,
  assertAudiencePersonaBasis,
  declaresPersonaBasis,
  ADS_ELIGIBLE_PERSONAS,
  ADS_INELIGIBLE_PERSONAS,
  EXCLUSION_INELIGIBLE_PERSONAS,
  PERSONA_SEGMENT_TYPE,
  UNRESOLVED_PERSONA,
} from "../lib/ads/audience-persona-basis"
import {
  EXCLUSION_SOURCE_RULE_TYPES,
  SOURCE_RULE_TYPES,
  audienceUseOf,
} from "../lib/ads/audience-source-rules"
import {
  CAMPAIGN_PERSONAS,
  CAMPAIGN_CONTACT_TYPES,
  rawSpellingsForPersona,
  normalizeContactPersona,
  type CampaignPersona,
} from "../lib/campaigns/contact-sources"
import { LIFETIME_CONTACT_TYPES } from "../lib/contact-types"
import {
  PROTECTED_CLASS_TOKENS,
  protectedClassReasonFor,
  protectedClassSegmentationIn,
  assertAudienceSegmentationAllowed,
  screenProtectedClassCriteria,
} from "../lib/lead-governance/protected-class-signals"
import { FB_AUDIENCE_TEMPLATES } from "../lib/ads/fb-audience-templates"
import { blankComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")
/** Source with COMMENTS BLANKED — CLAUDE.md §2: never hand-roll a stripper, and
 *  never let this file's own prose satisfy a source assertion about another. */
const code = (p: string) => blankComments(src(p))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function throws(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return e instanceof Error ? e.message : String(e) }
}

/** The persona names the LIVE DB CHECK `contacts_contact_persona_check` admits —
 *  the column the ads lane actually selects an audience from — read from the
 *  database on 2026-08-31 (after m589 added `investor` on the owner ruling
 *  "investor is a persona and not a contact type") and pinned here so the TS
 *  roster cannot drift from the database silently. Regenerate with:
 *    SELECT pg_get_constraintdef(oid) FROM pg_constraint
 *     WHERE conname = 'contacts_contact_persona_check';
 *  NOTE for the integrator: `campaign_sequences_persona_check` (the previous
 *  anchor of this pin) still lists THIRTEEN — m591 (written, not applied)
 *  widens it; scripts/contact-vocabulary-guard.ts holds the two columns equal
 *  and is honestly red until it lands. */
const LIVE_CHECK_PERSONAS = [
  "first_time", "relocated", "luxury", "fsbo", "probate", "upsize", "downsize",
  "military", "divorce", "senior", "expired", "foreclosure", "investor", "other",
]

function main() {
  console.log("\n══════════════════════════════════════════════════")
  console.log(" AUDIENCE PERSONA BASIS — the positive half of the ads rule")
  console.log("══════════════════════════════════════════════════")

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[1 · ONE persona vocabulary — the TS union, the roster and the live CHECK agree]")

  check("the runtime roster IS the live contacts_contact_persona_check vocabulary (same members)",
    JSON.stringify([...CAMPAIGN_PERSONAS].sort()) === JSON.stringify([...LIVE_CHECK_PERSONAS].sort()),
    `roster=${CAMPAIGN_PERSONAS.join(",")}`)

  // The TS union at lib/kernel/types.ts is a TYPE — it has no runtime value — so
  // it is pinned by SOURCE, over comment-masked text so this file's own prose and
  // that file's own comments cannot satisfy the match.
  const kernelTypes = code("lib/kernel/types.ts")
  const unionBlock = kernelTypes.slice(kernelTypes.indexOf("export type Persona ="))
  const unionMembers = (unionBlock.slice(0, unionBlock.indexOf("export type EducationFormat"))
    .match(/"([a-z_]+)"/g) ?? []).map((s) => s.replace(/"/g, ""))
  check("the `Persona` TS union at lib/kernel/types.ts has exactly the same members",
    JSON.stringify(unionMembers.slice().sort()) === JSON.stringify([...LIVE_CHECK_PERSONAS].sort()),
    `union=${unionMembers.join(",")}`)
  // THE RULE, NOT THE NUMBER (§2 — this read `=== 13`, a waypoint that broke the
  // day the owner added the fourteenth member): the scanner must find exactly as
  // many members as the runtime roster declares, and more than zero.
  check("POSITIVE CONTROL — the union scanner actually found members (a broken scan would report agreement by finding nothing)",
    unionMembers.length > 0 && unionMembers.length === CAMPAIGN_PERSONAS.length)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[2 · the split is by OPERATION now, and both halves are DERIVED, never hand-listed]")

  // Re-derive the protected set here from the raw token vocabulary, INDEPENDENTLY
  // of the module under test. If the module ever hard-codes its four names, a token
  // added to PROTECTED_CLASS_TOKENS makes these two disagree and this goes red.
  const tokenSet = new Set(PROTECTED_CLASS_TOKENS)
  const independentlyProtected = CAMPAIGN_PERSONAS.filter((p) => tokenSet.has(p))
  check("the four protected-characteristic personas are exactly senior/probate/divorce/military",
    JSON.stringify([...independentlyProtected].sort())
      === JSON.stringify(["divorce", "military", "probate", "senior"]),
    independentlyProtected.join(","))

  // THE RULING, AS A COUNT. Inclusion refuses ONE persona and it is the catch-all.
  check("ADS_INELIGIBLE_PERSONAS (inclusion) is exactly the null basis — the four are IN, per the ruling",
    JSON.stringify([...ADS_INELIGIBLE_PERSONAS]) === JSON.stringify([UNRESOLVED_PERSONA]),
    `ineligible=${ADS_INELIGIBLE_PERSONAS.join(",")}`)
  check("ADS_ELIGIBLE_PERSONAS is every canonical persona EXCEPT the catch-all (all but one)",
    ADS_ELIGIBLE_PERSONAS.length === CAMPAIGN_PERSONAS.length - 1
    && independentlyProtected.every((p) => (ADS_ELIGIBLE_PERSONAS as readonly string[]).includes(p)),
    `eligible=${ADS_ELIGIBLE_PERSONAS.join(",")}`)

  // THE MEASURED DELTA (CLAUDE.md §2 — a count that moves is the finding). Each of
  // the four is proved to be one the PRE-RULING derivation refused: the classifier
  // still classifies it protected, and the inclusion gate now admits it anyway.
  // That is the reversal, stated as a difference rather than as a claim.
  check("DELTA — all four are STILL classified protected by the classifier (the vocabulary was not gutted)",
    independentlyProtected.every((p) => protectedClassReasonFor(p) !== null))
  check("DELTA — and the pre-ruling derivation (protected ⇒ ineligible) would have refused exactly those four,",
    independentlyProtected.every((p) => !(ADS_INELIGIBLE_PERSONAS as readonly string[]).includes(p))
    && independentlyProtected.length === 4)

  check("EXCLUSION_INELIGIBLE_PERSONAS = the protected-token personas + the null basis (independently re-derived)",
    JSON.stringify([...EXCLUSION_INELIGIBLE_PERSONAS].sort())
      === JSON.stringify([...independentlyProtected, UNRESOLVED_PERSONA].sort()),
    `exclusion-ineligible=${EXCLUSION_INELIGIBLE_PERSONAS.join(",")}`)
  check("the module hard-codes NO persona list of its own (both splits are computed)",
    !/ADS_INELIGIBLE_PERSONAS[^=]*=\s*\[/.test(code("lib/ads/audience-persona-basis.ts"))
    && !/EXCLUSION_INELIGIBLE_PERSONAS[^=]*=\s*\[/.test(code("lib/ads/audience-persona-basis.ts")))
  check("POSITIVE CONTROL — that scanner still recognises a hard-coded list when one exists",
    /ADS_INELIGIBLE_PERSONAS[^=]*=\s*\[/.test('const ADS_INELIGIBLE_PERSONAS = ["senior"]'))
  check("every canonical persona is classified — nothing falls between the two sets",
    ADS_ELIGIBLE_PERSONAS.length + ADS_INELIGIBLE_PERSONAS.length === CAMPAIGN_PERSONAS.length)

  // THE EXCLUSION CONCEPT IS THE PRODUCT'S OWN, NOT ONE THIS GATE INVENTED.
  check("'an audience that removes people' is a FIRST-CLASS source-rule type, derived by prefix from the ONE roster",
    EXCLUSION_SOURCE_RULE_TYPES.length > 0
    && EXCLUSION_SOURCE_RULE_TYPES.every((t) => SOURCE_RULE_TYPES.includes(t))
    && JSON.stringify([...EXCLUSION_SOURCE_RULE_TYPES])
      === JSON.stringify(SOURCE_RULE_TYPES.filter((t) => t.startsWith("exclusion_"))),
    EXCLUSION_SOURCE_RULE_TYPES.join(","))
  check("POSITIVE CONTROL — the exclusion set is NOT silently empty (an empty set makes the refusal unreachable)",
    EXCLUSION_SOURCE_RULE_TYPES.includes("exclusion_active_pipeline"))
  check("audienceUseOf reads the operation off the rule: exclusion_* → exclusion, everything else → inclusion",
    audienceUseOf({ type: "exclusion_active_pipeline" }) === "exclusion"
    && audienceUseOf({ type: PERSONA_SEGMENT_TYPE }) === "inclusion"
    && audienceUseOf({ type: "contact_list" }) === "inclusion"
    && audienceUseOf(null) === "inclusion"
    && audienceUseOf({ type: PERSONA_SEGMENT_TYPE }) !== "exclusion")

  // ── §6: BOTH DOORS READ THE OPERATION WITH THE SAME FUNCTION ────────────────
  // `protectedClassSegmentationIn` used to inline `isExclusionSourceRuleType`
  // instead — a second spelling of "this audience subtracts", in the module whose
  // job is to turn the persona carve-out OFF for exactly that case. Two spellings
  // there is not a style question: if they ever disagree, the compliance door
  // grants a carve-out the ads door refuses, and the disagreement is silent.
  // `audienceUseOf` now lives beside the roster BECAUSE of the cycle that made
  // the second spelling look necessary — audience-persona-basis imports
  // protectedClassReasonFor from protected-class-signals, so the wire could not
  // go the other way.
  {
    const pcs = code("lib/lead-governance/protected-class-signals.ts")
    const suppressesLine = /const\s+suppresses\s*=\s*([^\n]+)/.exec(pcs)?.[1] ?? ""
    check("§6 — protectedClassSegmentationIn reads the operation with audienceUseOf, not a second spelling",
      /audienceUseOf\s*\(/.test(suppressesLine)
      && !/isExclusionSourceRuleType/.test(pcs))
    // POSITIVE CONTROL — the finder still recognises the defect it was written for.
    check("  control: the same finder REJECTS the inlined second spelling it replaced",
      !/audienceUseOf\s*\(/.test("const suppresses = isExclusionSourceRuleType((rule as { type?: unknown } | null)?.type)"))
    // POSITIVE CONTROL — and it is reading a real line, not an empty match.
    check("  control: the suppresses assignment was actually found in the file",
      suppressesLine.trim().length > 0)
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[3 · INCLUSION — ADMITS every situation persona, the four the owner ruled IN included]")

  for (const p of ADS_ELIGIBLE_PERSONAS) {
    const rule = { type: PERSONA_SEGMENT_TYPE, filters: { personas: [p] } }
    const verdict = personaAdsEligibility(p as CampaignPersona)
    check(`"${p}" → ads-ELIGIBLE as an inclusion basis, no refusal kind`,
      verdict.eligible && verdict.refusalKind === null && verdict.use === "inclusion")
    const res = resolveAudiencePersonaBasis(rule)
    check(`"${p}" → resolves to exactly [${p}]`,
      res.ok && JSON.stringify(res.personas) === JSON.stringify([p]))
    // THE WHOLE POINT OF THE RECONCILIATION: the persona gate is not the only gate
    // at these doors. Before the ruling `assertAudienceSegmentationAllowed` refused
    // `senior` independently — "defence in depth" that now has to STAND DOWN on the
    // inclusion path or the owner's ruling cannot ship.
    check(`"${p}" → NEITHER gate refuses it (the audience can actually be built)`,
      throws(() => assertAudiencePersonaBasis(rule, "x")) === null
      && throws(() => assertAudienceSegmentationAllowed(rule, "x")) === null,
      throws(() => assertAudienceSegmentationAllowed(rule, "x")) ?? "")
  }
  check("a MULTI-persona basis resolves, de-duplicated, order preserved",
    (() => {
      const r = resolveAudiencePersonaBasis({ type: PERSONA_SEGMENT_TYPE, filters: { personas: ["upsize", "downsize", "upsize"] } })
      return r.ok && JSON.stringify(r.personas) === JSON.stringify(["upsize", "downsize"])
    })())
  check("a MIXED list of a situation persona and a ruled-in protected persona resolves WHOLE",
    (() => {
      const r = resolveAudiencePersonaBasis({ type: PERSONA_SEGMENT_TYPE, filters: { personas: ["first_time", "senior"] } })
      return r.ok && JSON.stringify(r.personas) === JSON.stringify(["first_time", "senior"])
    })())
  check("ONE bad persona still poisons the whole basis — a mixed list with the catch-all refuses",
    !resolveAudiencePersonaBasis({ type: PERSONA_SEGMENT_TYPE, filters: { personas: ["first_time", "other"] } }).ok)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[4 · EXCLUSION — a protected-characteristic persona may NOT suppress an audience]")

  for (const p of independentlyProtected) {
    for (const exclusionType of EXCLUSION_SOURCE_RULE_TYPES) {
      const rule = { type: exclusionType, filters: { personas: [p] } }
      const verdict = personaAdsEligibility(p as CampaignPersona, "exclusion")
      check(`"${p}" as an EXCLUSION basis → REFUSED, classified protected_characteristic`,
        !verdict.eligible && verdict.refusalKind === "protected_characteristic" && verdict.use === "exclusion")
      const msg = throws(() => assertAudiencePersonaBasis(rule, `${p} suppression`)) ?? ""
      check(`"${p}" as an EXCLUSION basis → the persona gate REFUSES, naming the persona and the audience`,
        msg.includes("REFUSED") && msg.includes(`"${p}"`) && msg.includes(`${p} suppression`))
      check(`"${p}" as an EXCLUSION basis → the refusal draws the INCLUDE/WITHHOLD line in words`,
        /SUPPRESSES/.test(msg) && /WITHHOLDING/.test(msg) && /3604\(c\)/.test(msg))
      // DEFENCE IN DEPTH, KEPT WHERE IT STILL APPLIES. The token gate stands down
      // for a canonical persona on an INCLUSION rule only; on an exclusion rule it
      // refuses the same value it always did.
      const tokenMsg = throws(() => assertAudienceSegmentationAllowed(rule, `${p} suppression`)) ?? ""
      check(`"${p}" as an EXCLUSION basis → the protected-class gate ALSO refuses it (two independent gates)`,
        tokenMsg.includes("REFUSED") && protectedClassSegmentationIn(rule).length > 0,
        `hits=${protectedClassSegmentationIn(rule).join(",")}`)
    }
  }
  check("POSITIVE CONTROL — a NON-protected persona may still be excluded (this is not refuse-every-exclusion)",
    (() => {
      const rule = { type: EXCLUSION_SOURCE_RULE_TYPES[0], filters: { personas: ["fsbo"] } }
      const r = resolveAudiencePersonaBasis(rule)
      return r.ok && JSON.stringify(r.personas) === JSON.stringify(["fsbo"])
        && throws(() => assertAudiencePersonaBasis(rule, "x")) === null
        && throws(() => assertAudienceSegmentationAllowed(rule, "x")) === null
    })())
  check("POSITIVE CONTROL — the ordinary exclusion audience (no persona basis at all) is untouched",
    throws(() => assertAudiencePersonaBasis({ type: "exclusion_active_pipeline", filters: {} }, "x")) === null
    && throws(() => assertAudienceSegmentationAllowed({ type: "exclusion_active_pipeline", filters: {} }, "x")) === null)
  check("the SAME persona flips verdict with the OPERATION and nothing else (one rule, one field changed)",
    resolveAudiencePersonaBasis({ type: PERSONA_SEGMENT_TYPE, filters: { personas: ["senior"] } }).ok
    && !resolveAudiencePersonaBasis({ type: "exclusion_active_pipeline", filters: { personas: ["senior"] } }).ok)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[4b · THE RAW PROVIDER ATTRIBUTE PATH IS UNTOUCHED — the regression this lane risked]")

  // The owner permitted a PERSONA — a situation label on a contact we already
  // hold. He did not permit demographic targeting criteria sent to an ad platform.
  // These are the shapes that must still refuse on the ads lane, and the ones at
  // the `personas` KEY are the shapes the carve-out could plausibly have opened.
  const rawAttributeRules: Array<[string, unknown]> = [
    ["min_owner_age: 65", { type: PERSONA_SEGMENT_TYPE, filters: { min_owner_age: 65 } }],
    ["max_owner_age: 40", { type: PERSONA_SEGMENT_TYPE, filters: { max_owner_age: 40 } }],
    ["demographics.recentlyDivorced", { type: PERSONA_SEGMENT_TYPE, filters: { demographics: { recentlyDivorced: true } } }],
    ["quicklists: ['senior-owner','inherited']", { type: PERSONA_SEGMENT_TYPE, filters: { quicklists: ["senior-owner", "inherited"] } }],
    ["contact_tags: ['seniors-55plus']", { type: PERSONA_SEGMENT_TYPE, filters: { contact_tags: ["seniors-55plus"] } }],
    ["has_children: true", { type: PERSONA_SEGMENT_TYPE, filters: { has_children: true } }],
    ["SMUGGLED — personas: ['senior-owner'] (a provider slug at the persona key)", { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["senior-owner"] } }],
    ["SMUGGLED — personas: ['seniors-55plus'] (a tag at the persona key)", { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["seniors-55plus"] } }],
    ["SMUGGLED — personas: ['min_owner_age'] (a filter name at the persona key)", { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["min_owner_age"] } }],
    ["SMUGGLED — personas: ['inherited'] (the provider quickList, not the persona)", { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["inherited"] } }],
  ]
  for (const [label, rule] of rawAttributeRules) {
    const tokenMsg = throws(() => assertAudienceSegmentationAllowed(rule, "Raw attribute audience")) ?? ""
    // Pinned to the PROTECTED-CLASS GATE specifically, not to "something refused".
    // An `or` across the two gates would stay green if the carve-out were widened
    // to the whole `personas` key, because the persona gate would still refuse the
    // smuggled value for not being canonical — and the thing this lane must prove
    // is that the fair-housing gate itself never stopped seeing these shapes.
    check(`${label} → STILL REFUSED by the protected-class gate on the ads lane`,
      tokenMsg.includes("REFUSED"),
      `token="${tokenMsg}"`)
  }
  check("POSITIVE CONTROL — the carve-out is keyed on the ROSTER, not on the key name alone",
    // `senior` at the persona key is admitted; `senior-owner` at the SAME key is
    // not. If the carve-out were "anything under personas", both would pass and
    // this check would go red — which is the whole separation this lane must keep.
    protectedClassSegmentationIn({ type: PERSONA_SEGMENT_TYPE, filters: { personas: ["senior"] } }).length === 0
    && protectedClassSegmentationIn({ type: PERSONA_SEGMENT_TYPE, filters: { personas: ["senior-owner"] } }).length > 0)
  check("POSITIVE CONTROL — the carve-out is keyed on the KEY, not on the value alone",
    // `senior` under `contact_tags` is still a protected-class segmentation hit.
    protectedClassSegmentationIn({ type: PERSONA_SEGMENT_TYPE, filters: { contact_tags: ["senior"] } }).length > 0)
  check("the ads-lane CRITERIA screen has NO persona carve-out at all (a different function, untouched)",
    (() => {
      const screened = screenProtectedClassCriteria(
        { personas: ["senior"], min_owner_age: 65, quicklists: ["senior-owner"] }, "ad_audience")
      // `personas` is not a protected KEY and not slug-valued, so it is kept here
      // exactly as it always was — while the two raw attributes are STRIPPED.
      return screened.removed.includes("min_owner_age")
        && screened.removed.includes("quicklists[senior-owner]")
        && !("min_owner_age" in screened.criteria)
    })())

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[5 · FAIL CLOSED — an unresolvable basis REFUSES, it does not populate everyone]")

  const unresolvable: Array<[string, unknown]> = [
    ["no personas key at all", { type: PERSONA_SEGMENT_TYPE, filters: {} }],
    ["personas: null", { type: PERSONA_SEGMENT_TYPE, filters: { personas: null } }],
    ["personas: []", { type: PERSONA_SEGMENT_TYPE, filters: { personas: [] } }],
    ["personas: 'first_time' (a string, not a list)", { type: PERSONA_SEGMENT_TYPE, filters: { personas: "first_time" } }],
    ["personas: [42]", { type: PERSONA_SEGMENT_TYPE, filters: { personas: [42] } }],
    ["an unknown spelling", { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["first_time_buyer"] } }],
    ["the catch-all `other`", { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["other"] } }],
    ["no filters object at all", { type: PERSONA_SEGMENT_TYPE }],
  ]
  for (const [label, rule] of unresolvable) {
    check(`${label} → REFUSED`,
      !resolveAudiencePersonaBasis(rule).ok
      && (throws(() => assertAudiencePersonaBasis(rule, "Unresolvable")) ?? "").includes("REFUSED"))
  }
  check("`other` refuses as no_basis, NOT as a protected characteristic (two different reasons, two different fixes)",
    personaAdsEligibility(UNRESOLVED_PERSONA).refusalKind === "no_basis")
  check("a drifted DB spelling is NOT guessed forward into a different audience",
    !resolveAudiencePersonaBasis({ type: PERSONA_SEGMENT_TYPE, filters: { personas: ["luxury_buyer"] } }).ok
    // …even though the READER maps it, which is correct for reading a stored row.
    && normalizeContactPersona("luxury_buyer") === "luxury")

  check("an audience that declares NO persona basis is untouched by this rule (it is not a second gate on everything)",
    throws(() => assertAudiencePersonaBasis({ type: "qualified_leads", filters: { days_lookback: 60 } }, "x")) === null
    && !declaresPersonaBasis({ type: "qualified_leads", filters: { days_lookback: 60 } }))
  check("a persona filter smuggled onto ANOTHER rule type is still a persona basis (the type string is not the opt-out)",
    declaresPersonaBasis({ type: "contact_list", filters: { personas: ["other"] } })
    && (throws(() => assertAudiencePersonaBasis({ type: "contact_list", filters: { personas: ["other"] } }, "Smuggled")) ?? "").includes("REFUSED"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[6 · THE DATA LANE KEEPS ITS EXEMPTION — every persona still usable there]")

  for (const p of CAMPAIGN_PERSONAS) {
    const kept = screenProtectedClassCriteria({ persona: p }, "data_sourcing")
    check(`data_sourcing keeps persona "${p}" INTACT (nothing removed)`,
      kept.removed.length === 0 && (kept.criteria as Record<string, unknown>).persona === p)
  }
  // MEASUREMENT NOTE (CLAUDE.md §2 — publish the blind spot beside the number).
  // The check above is a WEAK claim on its own, and saying so is the point:
  // `screenProtectedClassCriteria` token-scans KEYS always and VALUES only for
  // SLUG_VALUED_KEYS (quicklist/quicklists/orQuickLists/…). The key `persona` is
  // not protected and is not slug-valued, so `{ persona: "senior" }` is kept on
  // BOTH lanes and an "unchanged on data_sourcing" result there proves only that
  // the shape is unclassifiable, not that the lane is exempt. The real claim is
  // made below, on the shapes the sourcing lane actually sends — the PROTECTED
  // ATTRIBUTES those personas are derived from.
  const sourcingPayload = {
    quicklists: ["inherited", "senior-owner", "vacant"],
    min_owner_age: 65,
    "demographics.recentlyDivorced": true,
    min_sale_propensity: 80,
  }
  const dataLane = screenProtectedClassCriteria(sourcingPayload, "data_sourcing")
  check("the protected ATTRIBUTES behind senior/probate/divorce survive INTACT on data_sourcing (the owner's exemption holds)",
    dataLane.removed.length === 0
    && (dataLane.criteria.quicklists as string[]).includes("inherited")
    && (dataLane.criteria.quicklists as string[]).includes("senior-owner")
    && dataLane.criteria.min_owner_age === 65
    && dataLane.criteria["demographics.recentlyDivorced"] === true,
    `removed=${dataLane.removed.join(",")}`)
  check("…and they are LABELLED rather than silently kept (a held protected fact is a RECORDED one)",
    dataLane.labelled.length >= 4
    && dataLane.labelled.every((l) => l.reason.trim().length > 0))
  check("POSITIVE CONTROL — the SAME payload on the ads lane is STRIPPED (the two lanes really do differ)",
    (() => {
      const adLane = screenProtectedClassCriteria(sourcingPayload, "ad_audience")
      return adLane.removed.length >= 4
        && !("min_owner_age" in adLane.criteria)
        && !(adLane.criteria.quicklists as string[] | undefined ?? []).includes("senior-owner")
        // …and the parcel fact is NOT stripped: the ads lane is not refuse-everything.
        && adLane.criteria.min_sale_propensity === 80
    })())
  check("the classifier still reads protected personas as protected (the vocabulary was not gutted to make ads pass)",
    independentlyProtected.every((p) => protectedClassReasonFor(p) !== null))
  check("an ads-INELIGIBLE persona is STILL a valid persona everywhere else (campaigns, copy, education read it fine)",
    independentlyProtected.every((p) => normalizeContactPersona(p) === p && CAMPAIGN_PERSONAS.includes(p)))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[7 · the pre-existing ads refusals are UNCHANGED — nothing was softened]")

  check("min_owner_age still refused", (throws(() => assertAudienceSegmentationAllowed({ filters: { min_owner_age: 65 } }, "A")) ?? "").includes("REFUSED"))
  check("has_children still refused", (throws(() => assertAudienceSegmentationAllowed({ filters: { has_children: true } }, "A")) ?? "").includes("REFUSED"))
  check("a protected-class TAG VALUE still refused", (throws(() => assertAudienceSegmentationAllowed({ filters: { contact_tags: ["seniors-55plus"] } }, "A")) ?? "").includes("REFUSED"))
  check("POSITIVE CONTROL — a behaviour-only rule is still ADMITTED (the old gate did not become refuse-everything)",
    throws(() => assertAudienceSegmentationAllowed({ type: "qualified_leads", filters: { days_lookback: 60 } }, "A")) === null)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[8 · the basis actually NARROWS — the gate is not theatre]")

  check("rawSpellingsForPersona('first_time') includes the drifted live spelling first_time_buyer",
    rawSpellingsForPersona("first_time").includes("first_time_buyer")
    && rawSpellingsForPersona("first_time").includes("first_time"))
  check("rawSpellingsForPersona('luxury') includes luxury_buyer and luxury_seller",
    rawSpellingsForPersona("luxury").includes("luxury_buyer") && rawSpellingsForPersona("luxury").includes("luxury_seller"))
  check("it never emits a spelling that normalizeContactPersona reads as a DIFFERENT persona (reader/query agree)",
    CAMPAIGN_PERSONAS.every((p) => rawSpellingsForPersona(p).every((s) => normalizeContactPersona(s) === p)))
  check("contact-type spellings that name no situation (listing_seller, past_client) are in NO persona's spelling set",
    CAMPAIGN_PERSONAS.every((p) => {
      const s = rawSpellingsForPersona(p)
      return !s.includes("listing_seller") && !s.includes("past_client")
    }))

  const adsSrc = code("lib/kernel/ads.ts")
  check("syncAudience actually applies the persona filter to the contact query (.in on contact_persona)",
    /\.in\("contact_persona",\s*spellings\)/.test(adsSrc))
  check("POSITIVE CONTROL — that scanner finds the call it is written for",
    /\.in\("contact_persona",\s*spellings\)/.test('contactsQuery = contactsQuery.in("contact_persona", spellings)'))
  check("'persona_segment' is now a real SourceRule type (the orphaned CHECK value has a writer)",
    /\|\s*"persona_segment"/.test(adsSrc))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[9 · ALL FOUR DOORS onto facebook_custom_audiences carry the rule]")

  const doors: Array<[string, string]> = [
    ["lib/kernel/ads.ts (createAudienceSegment + syncAudience)", "lib/kernel/ads.ts"],
    ["app/actions/campaign-presets.ts (the second define door)", "app/actions/campaign-presets.ts"],
    ["lib/audiences/audience-sync.ts (the audience_members staging drip)", "lib/audiences/audience-sync.ts"],
  ]
  for (const [label, path] of doors) {
    check(`${label} calls assertAudiencePersonaBasis`,
      /assertAudiencePersonaBasis\s*\(/.test(code(path)))
  }
  check("lib/kernel/ads.ts carries it on BOTH the define and the populate side (two call sites)",
    (adsSrc.match(/assertAudiencePersonaBasis\s*\(/g) ?? []).length === 2,
    `found ${(adsSrc.match(/assertAudiencePersonaBasis\s*\(/g) ?? []).length}`)
  check("POSITIVE CONTROL — the door scanner still reports ABSENCE on a file that has no such call",
    !/assertAudiencePersonaBasis\s*\(/.test(code("lib/lead-governance/protected-class-signals.ts")))
  check("…and the pre-existing protected-class assertion is STILL at all three doors (not replaced by the new one)",
    [ "lib/kernel/ads.ts", "app/actions/campaign-presets.ts" ]
      .every((p) => /assertAudienceSegmentationAllowed\s*\(/.test(code(p)))
    && /protectedClassSegmentationIn\s*\(/.test(code("lib/audiences/audience-sync.ts")))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[10 · the shipped template catalog cannot offer an audience the gate refuses]")

  const personaTemplates = FB_AUDIENCE_TEMPLATES.filter((t) => t.category === "persona")
  check("the catalog ships one persona template per ADS-ELIGIBLE persona (minus the null basis)",
    personaTemplates.length === ADS_ELIGIBLE_PERSONAS.filter((p) => p !== UNRESOLVED_PERSONA).length,
    `templates=${personaTemplates.length} eligible=${ADS_ELIGIBLE_PERSONAS.length}`)
  check("NO template exists for any ads-ineligible persona",
    ADS_INELIGIBLE_PERSONAS.every((p) => !FB_AUDIENCE_TEMPLATES.some((t) => t.id === `persona_${p}`)))
  check("the four the owner ruled IN now SHIP a template (the ruling reached the operator's shelf, not just the gate)",
    independentlyProtected.every((p) => FB_AUDIENCE_TEMPLATES.some((t) => t.id === `persona_${p}`)),
    independentlyProtected.filter((p) => !FB_AUDIENCE_TEMPLATES.some((t) => t.id === `persona_${p}`)).join(",") || "all four present")
  check("…and each of those four templates is an INCLUSION basis, never an exclusion rule type",
    independentlyProtected.every((p) => {
      const t = FB_AUDIENCE_TEMPLATES.find((x) => x.id === `persona_${p}`)
      // ASKS THE RULE, not the shelf label. `category: "exclusion"` is deleted
      // (§6) — SURVIVOR: audienceUseOf(t.sourceRule), the same function every
      // gate reads, which is why this assertion is now checking the thing that
      // actually decides the operation.
      return !!t && t.sourceRule.type === PERSONA_SEGMENT_TYPE && audienceUseOf(t.sourceRule) !== "exclusion"
    }))
  check("NO shipped template anywhere in the catalog combines an exclusion rule type with a persona basis",
    FB_AUDIENCE_TEMPLATES.every((t) => !(audienceUseOf(t.sourceRule) === "exclusion" && declaresPersonaBasis(t.sourceRule))))
  check("EVERY shipped template — persona or not — passes BOTH ads gates (nothing in the catalog errors on click)",
    FB_AUDIENCE_TEMPLATES.every((t) =>
      throws(() => assertAudienceSegmentationAllowed(t.sourceRule, t.name)) === null
      && throws(() => assertAudiencePersonaBasis(t.sourceRule, t.name)) === null))
  check("POSITIVE CONTROL — a hypothetical `senior` SUPPRESSION template WOULD be refused by that same check",
    (throws(() => assertAudiencePersonaBasis(
      { type: "exclusion_active_pipeline", filters: { personas: ["senior"] } }, "Exclude — Seniors")) ?? "").includes("REFUSED"))

  // The audience shelf looks the badge up UNGUARDED — `TEMPLATE_CATEGORY_META[
  // template.category].badge` — so a category in the union with no entry there is
  // a RUNTIME CRASH on the shelf, not a missing badge. Adding "persona" to the
  // union without this entry would have shipped exactly that.
  const dashboard = code("app/dashboard/campaigns/ads/ads-dashboard-client.tsx")
  check("the ads dashboard has a category badge for every template category actually shipped",
    [...new Set(FB_AUDIENCE_TEMPLATES.map((t) => t.category))]
      .every((c) => new RegExp(`\\n\\s*${c}:\\s*\\{\\s*label:`).test(dashboard)),
    [...new Set(FB_AUDIENCE_TEMPLATES.map((t) => t.category))].join(","))
  check("POSITIVE CONTROL — that scanner reports ABSENCE for a category the dashboard does not define",
    !new RegExp(`\\n\\s*no_such_category:\\s*\\{\\s*label:`).test(dashboard))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[11 · PERSONA vs CONTACT TYPE — the 14 audited against the owner's definition]")
  //
  // OWNER, VERBATIM: "lifetime and active seller are contact type not persona.
  // persona is more the situation that the contact or lead is in."
  // And 2026-08-31: "investor is a persona and not a contact type" — the ruling
  // that added the fourteenth member (m589) and moved investor OFF contact_type.

  const contactTypeVocabulary = new Set<string>([
    ...CAMPAIGN_CONTACT_TYPES, ...LIFETIME_CONTACT_TYPES,
  ])
  check("no canonical persona is ALSO a contact_type value (the two axes do not overlap)",
    CAMPAIGN_PERSONAS.every((p) => !contactTypeVocabulary.has(p)),
    CAMPAIGN_PERSONAS.filter((p) => contactTypeVocabulary.has(p)).join(",") || "no overlap")
  check("POSITIVE CONTROL — that overlap scanner recognises a contact type when it sees one",
    contactTypeVocabulary.has("lifetime_customer") && contactTypeVocabulary.has("sphere"))

  // The verdict per member, printed rather than asserted where the answer is a
  // judgement call. A judgement asserted as a pass is how a review becomes a
  // rubber stamp (CLAUDE.md §2 — publish the blind spot beside the number).
  const AUDIT: Record<CampaignPersona, string> = {
    first_time:  "SITUATION — buying their first home.",
    relocated:   "SITUATION — moving into or across the market.",
    fsbo:        "SITUATION — selling without representation.",
    upsize:      "SITUATION — outgrown the home, trading up.",
    downsize:    "SITUATION — deliberately moving smaller. A stated INTENT, not an inference about age.",
    expired:     "SITUATION — listing expired unsold.",
    foreclosure: "SITUATION — facing foreclosure; sourced from public filings on the parcel.",
    investor:    "SITUATION — buying for investment (portfolio, rental, flip). Owner-ruled a persona 2026-08-31 ('investor is a persona and not a contact type'); NOT a protected class, so eligible on BOTH operations.",
    probate:     "SITUATION — settling an estate that includes a property. (Owner-ruled ads-eligible 2026-08-23.)",
    divorce:     "SITUATION — dividing a marital home. (Owner-ruled ads-eligible 2026-08-23.)",
    senior:      "FLAG — the LABEL is an age band, a characteristic; the SITUATION it stands for is a later-life move. Owner ruled it a situation persona and the template copy names the transition, not the age. Recorded, not changed: renaming it is a live-CHECK migration another lane owns.",
    military:    "FLAG — the LABEL is a status, not a situation; the SITUATION it stands for is a PCS move / VA financing. Owner ruled it a situation persona. Same recording, same reason.",
    luxury:      "FLAG — NOT a situation and NOT a contact type either: it is a PRICE TIER, a fact about the inventory rather than about what brought the person to market. It is the one member that fits the owner's definition least well. Unresolved: it is live in the CHECK and has two drifted DB spellings (luxury_buyer, luxury_seller) mapping onto it.",
    other:       "FLAG — names no situation at all. The catch-all for a contact whose situation we have not learned. Valid for sequences and copy; refused as an ad-audience basis (no_basis).",
  }
  for (const p of CAMPAIGN_PERSONAS) console.log(`     · ${p.padEnd(12)} ${AUDIT[p]}`)
  check("every canonical persona has an audit verdict (nothing was skipped over quietly)",
    CAMPAIGN_PERSONAS.every((p) => (AUDIT[p] ?? "").length > 0))
  console.log("     [not asserted] 'luxury' is reported as the one member that is neither a situation")
  console.log("     nor a contact type. contacts_contact_persona_check pins these same 14 values live")
  console.log("     (m589); campaign_sequences_persona_check still lists 13 until m591 is applied.")

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ AUDIENCE_PERSONA_BASIS_PASS — an audience is segmented on persona; all 14 minus")
  console.log("    the catch-all may INCLUDE and choose wording; a protected-characteristic persona")
  console.log("    may not SUPPRESS an audience; raw demographic attributes stay refused on the ads lane.")
}

main()
