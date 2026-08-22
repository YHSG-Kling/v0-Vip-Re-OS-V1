#!/usr/bin/env tsx
/**
 * scripts/audience-persona-basis-simulator.ts  (npm run test:audience-persona-basis)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE. No DB, no mocks, no network.
 *
 * OWNER RULING UNDER TEST, VERBATIM: "audience should be segmented on persona."
 *
 * The ads lane already carried the NEGATIVE half — a housing ad audience may not
 * be segmented by a protected class — while the data lanes (scraping, enrichment,
 * signals, scoring, sourcing) hold and use the same attributes by the owner's
 * standing exemption. This proves the POSITIVE half was added WITHOUT reopening
 * the negative one, which is the only way "segment on persona" can be dangerous:
 * several canonical persona names ARE protected characteristics (senior = age,
 * probate = inheritance, divorce = marital status, military = veteran status), so
 * a careless positive rule is a laundering route for exactly what the ads gate
 * refuses, under a friendlier name.
 *
 * WHAT IS PROVEN, AND IN BOTH DIRECTIONS:
 *   1. the canonical persona vocabulary is ONE vocabulary (CLAUDE.md §6) — the TS
 *      union, the runtime roster and the live CHECK agree;
 *   2. the eligibility split is DERIVED from the existing classifier, not listed —
 *      and a hand-listed split would have to be caught, so the derivation is
 *      re-computed here from `PROTECTED_CLASS_TOKENS` independently;
 *   3. the ads lane REFUSES every protected-characteristic persona, at all four
 *      doors, with a legible reason that names the persona;
 *   4. the ads lane ADMITS every transaction-situation persona (the positive
 *      control — a gate that refuses everything is not a gate);
 *   5. an unresolvable basis REFUSES rather than populating (CLAUDE.md §4);
 *   6. the DATA LANE still does not refuse any of them (CLAUDE.md §3, STEP 3 —
 *      the exemption the owner granted must survive this change);
 *   7. the pre-existing protected-class refusal still refuses the things it was
 *      written for (nothing here softened it).
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
  PERSONA_SEGMENT_TYPE,
  UNRESOLVED_PERSONA,
} from "../lib/ads/audience-persona-basis"
import {
  CAMPAIGN_PERSONAS,
  rawSpellingsForPersona,
  normalizeContactPersona,
  type CampaignPersona,
} from "../lib/campaigns/contact-sources"
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

/** The persona names the LIVE DB CHECK `campaign_sequences_persona_check` admits,
 *  read from the database on 2026-08-22 and pinned here so the TS roster cannot
 *  drift from the database silently. Regenerate with:
 *    SELECT pg_get_constraintdef(oid) FROM pg_constraint
 *     WHERE conname = 'campaign_sequences_persona_check'; */
const LIVE_CHECK_PERSONAS = [
  "first_time", "relocated", "luxury", "fsbo", "probate", "upsize", "downsize",
  "military", "divorce", "senior", "expired", "foreclosure", "other",
]

function main() {
  console.log("\n══════════════════════════════════════════════════")
  console.log(" AUDIENCE PERSONA BASIS — the positive half of the ads rule")
  console.log("══════════════════════════════════════════════════")

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[1 · ONE persona vocabulary — the TS union, the roster and the live CHECK agree]")

  check("the runtime roster IS the live campaign_sequences_persona_check vocabulary (same members)",
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
  check("POSITIVE CONTROL — the union scanner actually found members (a broken scan would report agreement by finding nothing)",
    unionMembers.length === 13)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[2 · the eligibility split is DERIVED from the ONE classifier, never hand-listed]")

  // Re-derive the split here from the raw token vocabulary, INDEPENDENTLY of the
  // module under test. If the module ever hard-codes its four names, a token added
  // to PROTECTED_CLASS_TOKENS makes these two disagree and this check goes red.
  const tokenSet = new Set(PROTECTED_CLASS_TOKENS)
  const independentlyProtected = CAMPAIGN_PERSONAS.filter((p) => tokenSet.has(p))
  check("ADS_INELIGIBLE_PERSONAS = the protected-token personas + the null basis (independently re-derived)",
    JSON.stringify([...ADS_INELIGIBLE_PERSONAS].sort())
      === JSON.stringify([...independentlyProtected, UNRESOLVED_PERSONA].sort()),
    `ineligible=${ADS_INELIGIBLE_PERSONAS.join(",")}`)
  check("the four protected-characteristic personas are exactly senior/probate/divorce/military",
    JSON.stringify([...independentlyProtected].sort())
      === JSON.stringify(["divorce", "military", "probate", "senior"]),
    independentlyProtected.join(","))
  check("the module hard-codes NO persona list of its own (the split is computed)",
    !/ADS_INELIGIBLE_PERSONAS[^=]*=\s*\[/.test(code("lib/ads/audience-persona-basis.ts")))
  check("POSITIVE CONTROL — that scanner still recognises a hard-coded list when one exists",
    /ADS_INELIGIBLE_PERSONAS[^=]*=\s*\[/.test('const ADS_INELIGIBLE_PERSONAS = ["senior"]'))
  check("every canonical persona is classified — nothing falls between the two sets",
    ADS_ELIGIBLE_PERSONAS.length + ADS_INELIGIBLE_PERSONAS.length === CAMPAIGN_PERSONAS.length)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[3 · REFUSES every protected-characteristic persona, and says WHY legibly]")

  for (const p of independentlyProtected) {
    const rule = { type: PERSONA_SEGMENT_TYPE, filters: { personas: [p] } }
    const verdict = personaAdsEligibility(p as CampaignPersona)
    check(`"${p}" → ads-INELIGIBLE, classified protected_characteristic`,
      !verdict.eligible && verdict.refusalKind === "protected_characteristic")
    const msg = throws(() => assertAudiencePersonaBasis(rule, `${p} audience`)) ?? ""
    check(`"${p}" → the persona-basis gate REFUSES, naming the persona and the audience`,
      msg.includes("REFUSED") && msg.includes(`"${p}"`) && msg.includes(`${p} audience`))
    check(`"${p}" → the refusal says it stays valid on the data/education lane (a scope boundary, not a bug)`,
      /education, sourcing, enrichment, scoring/.test(msg))
    // THE LAUNDERING ROUTE, CLOSED TWICE. The pre-existing protected-class gate
    // scans string VALUES as well as keys, so it independently refuses the same
    // rule — this is the check that proves "segment on persona" did not become a
    // way around it.
    const tokenMsg = throws(() => assertAudienceSegmentationAllowed(rule, `${p} audience`)) ?? ""
    check(`"${p}" → the PRE-EXISTING protected-class gate ALSO still refuses the same rule (no laundering route)`,
      tokenMsg.includes("REFUSED") && protectedClassSegmentationIn(rule).length > 0)
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[4 · POSITIVE CONTROL — ADMITS every transaction-situation persona]")

  for (const p of ADS_ELIGIBLE_PERSONAS) {
    const rule = { type: PERSONA_SEGMENT_TYPE, filters: { personas: [p] } }
    const res = resolveAudiencePersonaBasis(rule)
    check(`"${p}" → ads-ELIGIBLE, resolves to exactly [${p}]`,
      res.ok && JSON.stringify(res.personas) === JSON.stringify([p]))
    check(`"${p}" → neither gate refuses it (the audience can actually be built)`,
      throws(() => assertAudiencePersonaBasis(rule, "x")) === null
      && throws(() => assertAudienceSegmentationAllowed(rule, "x")) === null)
  }
  check("a MULTI-persona basis resolves, de-duplicated, order preserved",
    (() => {
      const r = resolveAudiencePersonaBasis({ type: PERSONA_SEGMENT_TYPE, filters: { personas: ["upsize", "downsize", "upsize"] } })
      return r.ok && JSON.stringify(r.personas) === JSON.stringify(["upsize", "downsize"])
    })())
  check("ONE bad persona poisons the whole basis — a mixed list refuses rather than silently narrowing",
    !resolveAudiencePersonaBasis({ type: PERSONA_SEGMENT_TYPE, filters: { personas: ["first_time", "senior"] } }).ok)

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
    declaresPersonaBasis({ type: "contact_list", filters: { personas: ["senior"] } })
    && (throws(() => assertAudiencePersonaBasis({ type: "contact_list", filters: { personas: ["senior"] } }, "Smuggled")) ?? "").includes("REFUSED"))

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
  check("EVERY shipped template — persona or not — passes BOTH ads gates (nothing in the catalog errors on click)",
    FB_AUDIENCE_TEMPLATES.every((t) =>
      throws(() => assertAudienceSegmentationAllowed(t.sourceRule, t.name)) === null
      && throws(() => assertAudiencePersonaBasis(t.sourceRule, t.name)) === null))
  check("POSITIVE CONTROL — a hypothetical `senior` template WOULD be refused by that same check",
    (throws(() => assertAudiencePersonaBasis(
      { type: PERSONA_SEGMENT_TYPE, filters: { personas: ["senior"] } }, "Persona — Seniors")) ?? "").includes("REFUSED"))

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

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ AUDIENCE_PERSONA_BASIS_PASS — an audience is segmented on persona;")
  console.log("    protected-characteristic personas stay ads-ineligible and data-lane valid.")
}

main()
