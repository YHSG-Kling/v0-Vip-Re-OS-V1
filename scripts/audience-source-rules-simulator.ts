#!/usr/bin/env tsx
/**
 * scripts/audience-source-rules-simulator.ts  (npm run test:audience-source-rules)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE. No DB, no mocks, no network.
 *
 * THE DEFECT UNDER TEST. `lib/kernel/ads.ts syncAudience` declared FIFTEEN
 * `SourceRule` types and narrowed its contacts query for exactly TWO. The other
 * THIRTEEN fell through to
 *
 *     select … from contacts where brokerage_id = $t and email is not null
 *                              and tcpa_consent = true
 *
 * and the result was SHA-256 hashed and uploaded to Meta / Google Customer Match
 * on the six-hourly cron, under an audience name that promised a narrow slice.
 *
 * WHY THE TESTS BELOW LOOK THE WAY THEY DO:
 *
 *   · A FILTER THAT RETURNS EVERYONE IS INDISTINGUISHABLE FROM NO FILTER. That
 *     is precisely how this survived — the live tenant holds FOUR contacts and
 *     they are all consented, so every rule "worked" at that size. So every
 *     ADMITTED rule gets a POSITIVE CONTROL on a fixture where its population is
 *     a STRICT SUBSET: it must admit at least one row AND exclude at least one.
 *     Both halves. A gate that refuses everything is not a gate either.
 *
 *   · THE OLD BEHAVIOUR MUST BE PROVABLY GONE. Section 4 asserts that a rule with
 *     no honest definition REFUSES, and section 4b is the MUTATION TEST: it
 *     restores the fall-through in a copy of the resolver and shows the same
 *     assertions going RED. An assertion that has never been shown to fail is not
 *     evidence.
 *
 *   · THE COUNT AND ITS DENOMINATOR (CLAUDE.md §2). Section 6 proves the query
 *     builder in `syncAudience` and the fixture evaluator here implement the SAME
 *     rules, because a preview that resolved differently from the sync would be a
 *     reassurance about a set that was never delivered.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  SOURCE_RULE_TYPES,
  isSourceRuleType,
  resolveSourceRuleNarrowing,
  contactMatchesNarrowing,
  rowMatchesPredicates,
  type SourceRuleNarrowing,
  type SourceRuleNarrowingOk,
  type SourceRuleType,
} from "../lib/ads/audience-source-rules"
import { rawSpellingsForPersona } from "../lib/campaigns/contact-sources"
import { LIFETIME_CONTACT_TYPES } from "../lib/contact-types"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { FB_AUDIENCE_TEMPLATES } from "../lib/ads/fb-audience-templates"
import { blankComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
/** Source with COMMENTS BLANKED — CLAUDE.md §2: never hand-roll a stripper, and
 *  never let a file's own prose satisfy a source assertion about it. */
const code = (p: string) => blankComments(readFileSync(join(root, p), "utf8"))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

/** A fixed clock so every lookback window is deterministic. */
const NOW = new Date("2026-08-22T12:00:00.000Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

// ─── THE FIXTURE BOOK ─────────────────────────────────────────────────────────
// TEN contacts, deliberately more varied than the live tenant's four. Every one
// of them is consented and emailable — i.e. every one of them WAS in the audience
// under the old behaviour, whatever the audience was called. That is the point:
// the fixture makes "everybody" and "the right slice" different sets.

const CONTACTS: Array<Record<string, unknown>> = [
  { id: "c1", contact_type: "buyer",             status: "active", buyer_stage: "BUYER_SEARCHING",      engagement_score: 87, contact_persona: "first_time_buyer", last_contacted_at: daysAgo(3),   zip_code: "78701", tags: ["hot-lead"] },
  { id: "c2", contact_type: "seller",            status: "active", buyer_stage: null,                    engagement_score: 92, contact_persona: "listing_seller",   last_contacted_at: daysAgo(2),   zip_code: "78704", tags: ["farm"] },
  { id: "c3", contact_type: "buyer",             status: "active", buyer_stage: "BUYER_UNDER_CONTRACT",  engagement_score: 78, contact_persona: "luxury_buyer",     last_contacted_at: daysAgo(1),   zip_code: "78730", tags: ["hot-lead", "luxury"] },
  { id: "c4", contact_type: "both",              status: "active", buyer_stage: null,                    engagement_score: 65, contact_persona: "past_client",      last_contacted_at: daysAgo(200), zip_code: "78702", tags: [] },
  // c5 REKEYED (owner ruling 2026-08-31: "investor is a persona and not a contact
  // type") — the investing moved from contact_type onto contact_persona (m589),
  // and the investor_contacts rule now narrows on the persona.
  { id: "c5", contact_type: "buyer",             status: "active", buyer_stage: "BUYER_ON_HOLD",         engagement_score: 40, contact_persona: "investor",         last_contacted_at: daysAgo(10),  zip_code: "78745", tags: [] },
  { id: "c6", contact_type: "lifetime_customer", status: "active", buyer_stage: "BUYER_CLOSED",          engagement_score: 55, contact_persona: null,               last_contacted_at: daysAgo(400), zip_code: "78701", tags: [] },
  { id: "c7", contact_type: "lifetime_customer", status: "inactive", buyer_stage: null,                  engagement_score: 20, contact_persona: null,               last_contacted_at: daysAgo(900), zip_code: "78704", tags: [] },
  { id: "c8", contact_type: "lead",              status: "new",    buyer_stage: null,                    engagement_score: 5,  contact_persona: "downsizer",        last_contacted_at: daysAgo(5),   zip_code: "78660", tags: [] },
  { id: "c9", contact_type: "buyer",             status: "active", buyer_stage: null,                    engagement_score: 71, contact_persona: "relocation",       last_contacted_at: daysAgo(60),  zip_code: "78701", tags: ["hot-lead"] },
  { id: "c10", contact_type: "prospect",         status: "active", buyer_stage: null,                    engagement_score: 0,  contact_persona: null,               last_contacted_at: null,          zip_code: null,    tags: null },
]

/** Join-table fixtures, keyed by the table each narrowing names. */
const JOIN_ROWS: Record<string, Array<Record<string, unknown>>> = {
  leads: [
    { contact_id: "c1", lead_stage: "qualified", stage_entered_at: daysAgo(10) },
    { contact_id: "c9", lead_stage: "qualified", stage_entered_at: daysAgo(300) }, // outside a 60d window
    { contact_id: "c8", lead_stage: "assigned",  stage_entered_at: daysAgo(2) },   // never qualified
  ],
  listings: [
    { seller_contact_id: "c2", contact_id: null, status: "active" },
    { seller_contact_id: null, contact_id: "c4", status: "coming_soon" },
    { seller_contact_id: "c7", contact_id: null, status: "sold" },                 // not an active seller
  ],
  transactions: [
    { contact_id: "c3", buyer_contact_id: "c3", seller_contact_id: null, status: "under_contract", close_date: null },
    { contact_id: "c2", buyer_contact_id: null, seller_contact_id: "c2", status: "clear_to_close", close_date: null },
    { contact_id: "c6", buyer_contact_id: "c6", seller_contact_id: null, status: "closed",         close_date: "2020-01-15" },
    { contact_id: "c4", buyer_contact_id: "c4", seller_contact_id: null, status: "closed",         close_date: "2026-08-01" },
  ],
  open_house_attendees: [
    { contact_id: "c1", check_in_time: daysAgo(10) },
    { contact_id: "c5", check_in_time: daysAgo(300) },  // outside a 90d window
    { contact_id: null, check_in_time: daysAgo(1) },    // walk-in, no contact_id — the published blind spot
  ],
}

/** Every contact the OLD behaviour delivered: all of them. */
const EVERYBODY = CONTACTS.map((c) => c.id as string)

function resolveMembers(
  narrowing: SourceRuleNarrowingOk,
  personaSpellings: readonly string[] | null = null,
): string[] {
  const joinRows = narrowing.join ? JOIN_ROWS[narrowing.join.table] ?? [] : []
  return CONTACTS
    .filter((c) => contactMatchesNarrowing(c, narrowing, joinRows, personaSpellings))
    .map((c) => c.id as string)
}

function ok(n: SourceRuleNarrowing): SourceRuleNarrowingOk {
  if (!n.ok) throw new Error(`expected an admitted narrowing, got refusal: ${n.refusal}`)
  return n
}

// ─── THE EXPECTED SLICES ──────────────────────────────────────────────────────
// Hand-computed from the fixture above, NOT read back from the module. If the
// module and this table ever disagree, the assertion goes red — which is the only
// way a test of a filter is worth anything.

interface AdmittedCase {
  type: SourceRuleType
  filters: Record<string, unknown>
  /** Exactly who should be in the audience. */
  expect: string[]
  /** Persona spellings, only for a persona basis. */
  personas?: string[]
}

const ADMITTED: AdmittedCase[] = [
  { type: "contact_list", filters: { contact_tags: ["hot-lead"] }, expect: ["c1", "c3", "c9"] },
  { type: "contact_list", filters: { contact_tags: ["hot-lead", "luxury"] }, expect: ["c3"] },
  { type: "investor_contacts", filters: {}, expect: ["c5"] },
  // LIFETIME_CONTACT_TYPES = lifetime_customer, sphere (m539 collapsed the three
  // lifetime spellings; m563 removed 'client' — the survivor set is lib/contact-types.ts).
  // No fixture row carries a retired spelling, so these expectations are unchanged
  // by either migration; c6/c7 are both 'lifetime_customer'.
  { type: "lifetime_customers", filters: {}, expect: ["c6", "c7"] },
  { type: "lifetime_customers", filters: { min_tenure_months: 0 }, expect: ["c6", "c7"] },
  // Tenure ≥ 12 months → transactions closed on/before 2025-08-22. c6 closed 2020;
  // c4 closed 2026-08-01 (too recent) AND is contact_type 'both', not a lifetime type.
  { type: "lifetime_customers", filters: { min_tenure_months: 12 }, expect: ["c6"] },
  { type: "high_engagement_contacts", filters: { min_engagement_score: 70 }, expect: ["c1", "c2", "c3", "c9"] },
  { type: "high_engagement_contacts", filters: { min_engagement_score: 90 }, expect: ["c2"] },
  // buyer/both, contacted ≤30d, not under contract/closed/on hold/disengaged.
  // c1 ✓ (3d, searching). c3 ✗ (under contract). c4 ✗ (200d). c9 ✗ (60d).
  { type: "active_buyers", filters: { days_lookback: 30 }, expect: ["c1"] },
  // c4 is contact_type 'both' with a null buyer_stage and a 200-day-old touch, so
  // it enters at 365 and not at 30. 'both' counting as a buyer is deliberate: a
  // buy-and-sell client IS shopping, and excluding them would make the audience
  // quietly narrower than its name.
  { type: "active_buyers", filters: { days_lookback: 365 }, expect: ["c1", "c4", "c9"] },
  // seller/both holding a pre-listing or live listing. c2 (active) ✓, c4 (coming_soon) ✓,
  // c7 ✗ (sold, and 'past_client' is not a seller type anyway).
  { type: "active_sellers", filters: {}, expect: ["c2", "c4"] },
  { type: "qualified_leads", filters: {}, expect: ["c1", "c9"] },
  { type: "qualified_leads", filters: { days_lookback: 60 }, expect: ["c1"] },
  { type: "open_house_attendees", filters: {}, expect: ["c1", "c5"] },
  { type: "open_house_attendees", filters: { days_lookback: 90 }, expect: ["c1"] },
  { type: "in_pipeline", filters: {}, expect: ["c2", "c3"] },
  // The one deliberately-wide rule. WIDE IS NOT UNNARROWED: c7 (inactive) and
  // c8 (new) are excluded, so it is still a defined set.
  { type: "exclusion_active_pipeline", filters: {}, expect: ["c1", "c2", "c3", "c4", "c5", "c6", "c9", "c10"] },
  // The persona basis, narrowed by the gate the persona lane built.
  { type: "persona_segment", filters: { personas: ["first_time"] }, expect: ["c1"], personas: ["first_time"] },
  { type: "persona_segment", filters: { personas: ["luxury", "downsize"] }, expect: ["c3", "c8"], personas: ["luxury", "downsize"] },
  // Service-area narrowing — `filters.zip_codes` was declared and read by NOTHING.
  { type: "investor_contacts", filters: { zip_codes: ["78701"] }, expect: [] },
  { type: "high_engagement_contacts", filters: { min_engagement_score: 70, zip_codes: ["78701"] }, expect: ["c1", "c9"] },
]

/** Rule types that must REFUSE, with the reason each must give. */
const MUST_REFUSE: Array<{ label: string; rule: unknown; kind: string }> = [
  { label: "website_visitors (platform-native — no CRM record reproduces it)", rule: { type: "website_visitors", filters: { days_lookback: 30 } }, kind: "platform_native" },
  { label: "engagement (platform-native)", rule: { type: "engagement", filters: { days_lookback: 30 } }, kind: "platform_native" },
  { label: "consultations_completed (appointments table is EMPTY and writerless)", rule: { type: "consultations_completed", filters: {} }, kind: "no_expressing_data" },
  { label: "contact_list with NO tags", rule: { type: "contact_list", filters: {} }, kind: "underspecified" },
  { label: "contact_list with an EMPTY tag list", rule: { type: "contact_list", filters: { contact_tags: [] } }, kind: "underspecified" },
  { label: "contact_list with a non-string tag", rule: { type: "contact_list", filters: { contact_tags: [7] } }, kind: "underspecified" },
  { label: "high_engagement_contacts with NO threshold", rule: { type: "high_engagement_contacts", filters: {} }, kind: "underspecified" },
  { label: "high_engagement_contacts with threshold 0 (engagement_score DEFAULTS to 0)", rule: { type: "high_engagement_contacts", filters: { min_engagement_score: 0 } }, kind: "underspecified" },
  { label: "active_buyers with NO lookback ('active' is a recency claim)", rule: { type: "active_buyers", filters: {} }, kind: "underspecified" },
  { label: "active_buyers with a negative lookback", rule: { type: "active_buyers", filters: { days_lookback: -5 } }, kind: "underspecified" },
  { label: "qualified_leads with a non-numeric lookback", rule: { type: "qualified_leads", filters: { days_lookback: "60" } }, kind: "underspecified" },
  { label: "in_pipeline with a zero lookback", rule: { type: "in_pipeline", filters: { days_lookback: 0 } }, kind: "underspecified" },
  { label: "lifetime_customers with a non-numeric tenure", rule: { type: "lifetime_customers", filters: { min_tenure_months: "12" } }, kind: "underspecified" },
  { label: "an UNKNOWN rule type", rule: { type: "everyone_please", filters: {} }, kind: "unknown_type" },
  { label: "a rule with NO type at all", rule: { filters: { days_lookback: 30 } }, kind: "unknown_type" },
  { label: "the EMPTY object campaign-presets defaults source_rule to", rule: {}, kind: "unknown_type" },
  { label: "source_rule = null", rule: null, kind: "no_rule" },
  { label: "source_rule = undefined", rule: undefined, kind: "no_rule" },
  { label: "source_rule = a string", rule: "qualified_leads", kind: "no_rule" },
  { label: "source_rule = an array", rule: [{ type: "qualified_leads" }], kind: "no_rule" },
]

function main() {
  console.log("\n══════════════════════════════════════════════════")
  console.log(" AUDIENCE SOURCE RULES — fifteen declared, fifteen resolved or refused")
  console.log("══════════════════════════════════════════════════")

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[1 · ONE roster — the TS union, the runtime list and the kernel agree]")

  check("the roster holds exactly 15 types (the number syncAudience declared)",
    SOURCE_RULE_TYPES.length === 15, `got ${SOURCE_RULE_TYPES.length}`)
  check("every member is unique",
    new Set(SOURCE_RULE_TYPES).size === SOURCE_RULE_TYPES.length)

  // lib/kernel/ads.ts must DERIVE its union from the roster rather than restate
  // it — a restated union is how fifteen declared types and two narrowings
  // co-existed for so long without anything noticing.
  const adsSrc = code("lib/kernel/ads.ts")
  check("lib/kernel/ads.ts DERIVES SourceRule['type'] from the roster (does not restate the members)",
    /type:\s*SourceRuleType/.test(adsSrc)
    && !/\|\s*"consultations_completed"/.test(adsSrc),
    "the union is restated in ads.ts")
  check("POSITIVE CONTROL — that scanner still recognises a restated union when one exists",
    /\|\s*"consultations_completed"/.test('type: "a" | "consultations_completed"'))
  check("every roster member is recognised by the type guard",
    SOURCE_RULE_TYPES.every((t) => isSourceRuleType(t)))
  check("POSITIVE CONTROL — the type guard REJECTS a plausible non-member",
    !isSourceRuleType("website_visits") && !isSourceRuleType("") && !isSourceRuleType(null))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[2 · EVERY roster member is either DEFINED or REFUSED — no third answer]")

  // The MINIMUM VALID filters for each type — the smallest input under which a
  // type could possibly resolve. A type that refuses even here has no honest
  // definition in the schema, which is the distinction this sweep measures.
  // Deliberately NOT taken from the shipped templates: no template exists for
  // `contact_list`, so a template-driven sweep would score a rule that resolves
  // perfectly well as "refused" and report the wrong number.
  const MINIMUM_VALID_FILTERS: Record<SourceRuleType, Record<string, unknown>> = {
    website_visitors: { days_lookback: 30 },
    contact_list: { contact_tags: ["hot-lead"] },
    engagement: { days_lookback: 30 },
    lifetime_customers: {},
    qualified_leads: {},
    active_buyers: { days_lookback: 30 },
    active_sellers: {},
    consultations_completed: {},
    open_house_attendees: {},
    high_engagement_contacts: { min_engagement_score: 70 },
    investor_contacts: {},
    in_pipeline: {},
    lookalike_seed: {},
    exclusion_active_pipeline: {},
    persona_segment: { personas: ["first_time"] },
  }
  const defined = new Set<string>()
  const refused = new Set<string>()
  for (const t of SOURCE_RULE_TYPES) {
    const n = resolveSourceRuleNarrowing({ type: t, filters: MINIMUM_VALID_FILTERS[t] }, NOW)
    if (n.ok) defined.add(t)
    else refused.add(t)
  }
  check("every one of the 15 is resolved to a definition or an explicit refusal",
    defined.size + refused.size === SOURCE_RULE_TYPES.length)
  check("the three REFUSED types are exactly website_visitors / engagement / consultations_completed",
    JSON.stringify([...refused].sort()) === JSON.stringify(["consultations_completed", "engagement", "website_visitors"]),
    [...refused].join(","))
  check("…so TWELVE types now have a real narrowing where TWO did (the count that moved, CLAUDE.md §2)",
    defined.size === 12, `defined=${defined.size}`)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[3 · POSITIVE CONTROL PER RULE TYPE — each one EXCLUDES somebody]")
  console.log("     (a filter that returns everyone is indistinguishable from no filter)")

  for (const c of ADMITTED) {
    const n = resolveSourceRuleNarrowing({ type: c.type, filters: c.filters }, NOW)
    if (!n.ok) {
      check(`${c.type} ${JSON.stringify(c.filters)} → admitted`, false, n.refusal)
      continue
    }
    const spellings = c.personas
      ? c.personas.flatMap((p) => rawSpellingsForPersona(p as never))
      : null
    const members = resolveMembers(n, spellings)
    const label = `${c.type} ${JSON.stringify(c.filters)}`
    check(`${label} → exactly [${c.expect.join(",")}]`,
      JSON.stringify(members) === JSON.stringify(c.expect),
      `got [${members.join(",")}]`)
    // THE HALF THAT ACTUALLY CATCHES THE DEFECT.
    check(`${label} → EXCLUDES somebody (delivered ${members.length} of ${EVERYBODY.length})`,
      members.length < EVERYBODY.length,
      "this rule delivered the whole book — indistinguishable from no filter")
  }
  // …and the other half: a gate that refuses everything is not a gate.
  check("POSITIVE CONTROL — at least one rule ADMITS somebody (the narrowing is not refuse-everything)",
    ADMITTED.some((c) => {
      const n = resolveSourceRuleNarrowing({ type: c.type, filters: c.filters }, NOW)
      if (!n.ok) return false
      const spellings = c.personas ? c.personas.flatMap((p) => rawSpellingsForPersona(p as never)) : null
      return resolveMembers(n, spellings).length > 0
    }))
  check("POSITIVE CONTROL — the fixture book itself is not degenerate (all 10 differ in at least one filtered column)",
    new Set(CONTACTS.map((c) => `${c.contact_type}|${c.status}|${c.engagement_score}|${c.buyer_stage}`)).size === CONTACTS.length)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[4 · THE OLD BEHAVIOUR IS GONE — no honest definition means REFUSE, never widen]")

  for (const c of MUST_REFUSE) {
    const n = resolveSourceRuleNarrowing(c.rule, NOW)
    check(`${c.label} → REFUSED (${c.kind})`,
      !n.ok && n.refusalKind === c.kind,
      n.ok ? "ADMITTED — this is the fall-through the fix removes" : `kind=${(n as { refusalKind: string }).refusalKind}`)
    check(`${c.label} → the refusal names the audience's promise, not a bare code`,
      !n.ok && n.refusal.length > 60 && /[a-z]\s[a-z]/.test(n.refusal))
  }
  check("the resolver source contains NO permissive default arm",
    !/default:\s*\n?\s*return\s*\{\s*ok:\s*true/.test(code("lib/ads/audience-source-rules.ts")))
  check("POSITIVE CONTROL — that scanner recognises a permissive default when one exists",
    /default:\s*\n?\s*return\s*\{\s*ok:\s*true/.test("switch(x){ default: return { ok: true, predicates: [] } }"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[4b · MUTATION TEST — restore the fall-through and section 4 goes RED]")
  console.log("      (an assertion never shown to fail is not evidence)")

  /** The resolver as it behaved BEFORE this lane: anything it does not narrow for
   *  falls through to no predicates at all — i.e. every consented contact. */
  function mutatedResolve(rule: unknown): SourceRuleNarrowing {
    const real = resolveSourceRuleNarrowing(rule, NOW)
    if (real.ok) return real
    return {
      ok: true,
      ruleType: (rule && typeof rule === "object" ? (rule as { type?: string }).type : undefined) as SourceRuleType ?? "custom" as SourceRuleType,
      label: "(fall-through — no narrowing)",
      predicates: [],
      join: null,
      uploadsContacts: true,
      narrowedByPersonaGate: false,
    }
  }

  const mutantAdmitted = MUST_REFUSE.filter((c) => mutatedResolve(c.rule).ok)
  check(`under the restored fall-through, ALL ${MUST_REFUSE.length} refusal cases are ADMITTED instead`,
    mutantAdmitted.length === MUST_REFUSE.length,
    `${mutantAdmitted.length}/${MUST_REFUSE.length}`)
  const mutantDelivers = mutatedResolve({ type: "website_visitors", filters: { days_lookback: 30 } })
  check("…and the mutant's 'Website Visitors' audience delivers the ENTIRE fixture book (the original defect, reproduced)",
    mutantDelivers.ok && resolveMembers(mutantDelivers).length === EVERYBODY.length,
    mutantDelivers.ok ? `delivered ${resolveMembers(mutantDelivers).length}` : "refused")
  check("…while the REAL resolver refuses that same rule (the mutation is the only difference)",
    !resolveSourceRuleNarrowing({ type: "website_visitors", filters: { days_lookback: 30 } }, NOW).ok)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[5 · EVERY SHIPPED TEMPLATE RESOLVES — the catalog cannot offer a lie]")

  for (const t of FB_AUDIENCE_TEMPLATES) {
    const n = resolveSourceRuleNarrowing(t.sourceRule, NOW)
    check(`template “${t.name}” (${t.sourceRule.type}) resolves`, n.ok,
      n.ok ? "" : n.refusal.slice(0, 110))
    if (n.ok && n.uploadsContacts && !n.narrowedByPersonaGate) {
      check(`template “${t.name}” EXCLUDES somebody`,
        resolveMembers(n).length < EVERYBODY.length,
        "delivered the whole fixture book")
    }
  }
  check("the lookalike templates upload NO CRM contacts (they seed from an external audience id)",
    FB_AUDIENCE_TEMPLATES.filter((t) => t.sourceRule.type === "lookalike_seed")
      .every((t) => { const n = resolveSourceRuleNarrowing(t.sourceRule, NOW); return n.ok && !n.uploadsContacts }))
  check("…and a seed rule therefore resolves NOBODY into a contact upload",
    (() => { const n = resolveSourceRuleNarrowing({ type: "lookalike_seed", filters: {} }, NOW); return n.ok && resolveMembers(n).length === 0 })())

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[6 · THE QUERY AND THE EVALUATOR IMPLEMENT THE SAME RULES]")
  console.log("     (a preview that resolves differently from the sync is worse than none)")

  check("syncAudience resolves through the shared resolveAudiencePopulation (ONE code path)",
    (adsSrc.match(/resolveAudiencePopulation\s*\(/g) ?? []).length >= 3,
    `found ${(adsSrc.match(/resolveAudiencePopulation\s*\(/g) ?? []).length}`)
  check("…and the OLD inline contact_list narrowing is gone from syncAudience",
    !/sourceRule\?\.type\s*===\s*"contact_list"/.test(adsSrc))
  check("POSITIVE CONTROL — that scanner still recognises the old inline narrowing",
    /sourceRule\?\.type\s*===\s*"contact_list"/.test('if (sourceRule?.type === "contact_list" && x) {}'))
  check("the query builder implements every operator the pure evaluator emits",
    (() => {
      const ops = ["eq", "in", "not_in", "gte", "lte", "contains", "not_null"]
      const applyBlock = adsSrc.slice(adsSrc.indexOf("function applyPredicate"))
        .slice(0, 1800)
      return ops.every((o) => new RegExp(`case "${o}":`).test(applyBlock))
    })())
  check("`not_in` is written as an OR with is-null on BOTH sides (a null stage has not gone under contract)",
    /\.is\.null,\$\{p\.column\}\.not\.in\./.test(adsSrc)
    && rowMatchesPredicates({ buyer_stage: null }, [{ column: "buyer_stage", op: "not_in", value: ["BUYER_CLOSED"], says: "" }]))
  check("an empty JOIN prefetch yields an EMPTY audience, never an unfiltered one",
    (() => {
      const n = ok(resolveSourceRuleNarrowing({ type: "in_pipeline", filters: {} }, NOW))
      return CONTACTS.filter((c) => contactMatchesNarrowing(c, n, [])).length === 0
    })())
  check("…and the kernel returns early on an empty id set rather than skipping the .in()",
    /AN EMPTY PREFETCH IS AN EMPTY AUDIENCE|ids\.size === 0/.test(adsSrc))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[7 · ALL FOUR DOORS onto facebook_custom_audiences carry the source-rule rule]")

  const doors: Array<[string, string]> = [
    ["lib/kernel/ads.ts — createAudienceSegment (define) + syncAudience (populate)", "lib/kernel/ads.ts"],
    ["app/actions/campaign-presets.ts — the second define door", "app/actions/campaign-presets.ts"],
    ["lib/audiences/audience-sync.ts — the audience_members staging drip", "lib/audiences/audience-sync.ts"],
  ]
  for (const [label, path] of doors) {
    check(`${label} calls resolveSourceRuleNarrowing`,
      /resolveSourceRuleNarrowing\s*\(/.test(code(path)))
  }
  check("POSITIVE CONTROL — the door scanner reports ABSENCE on a file that has no such call",
    !/resolveSourceRuleNarrowing\s*\(/.test(code("lib/ads/audience-persona-basis.ts")))
  check("the PERSONA gate is still at its doors — this lane did not fork or replace it (CLAUDE.md §6)",
    /assertAudiencePersonaBasis\s*\(/.test(adsSrc)
    && /assertAudiencePersonaBasis\s*\(/.test(code("app/actions/campaign-presets.ts"))
    && /assertAudiencePersonaBasis\s*\(/.test(code("lib/audiences/audience-sync.ts")))
  check("…and the source-rule module does NOT re-implement persona resolution (it defers)",
    !/ADS_ELIGIBLE_PERSONAS|personaAdsEligibility|PERSONA_ALIASES/.test(code("lib/ads/audience-source-rules.ts")))
  check("the protected-class refusal is still at its doors too (nothing was softened)",
    /assertAudienceSegmentationAllowed\s*\(/.test(adsSrc)
    && /assertAudienceSegmentationAllowed\s*\(/.test(code("app/actions/campaign-presets.ts")))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[8 · THE OPERATOR CAN SEE IT — count, denominator and rule, before the sync]")

  check("a preview command exists and reports the resolved count",
    /export async function previewAudienceResolution/.test(adsSrc)
    && /resolvedCount/.test(adsSrc))
  check("…with the DENOMINATOR beside it (a count without one is not a measurement, CLAUDE.md §2)",
    /totalConsented/.test(adsSrc) && /count:\s*"exact",\s*head:\s*true/.test(adsSrc))
  check("…and the RULE LABEL that produced the count",
    /ruleLabel/.test(adsSrc) && /resolved_rule_label/.test(adsSrc))
  check("the sync ledger records the resolved rule beside records_attempted",
    /resolved_rule_type:/.test(adsSrc) && /resolved_records:/.test(adsSrc))
  const dash = code("app/dashboard/campaigns/ads/ads-dashboard-client.tsx")
  check("the ads dashboard surfaces it on the audience card (Check reach)",
    /previewAudienceReach\s*\(/.test(dash) && /Check reach/.test(readFileSync(join(root, "app/dashboard/campaigns/ads/ads-dashboard-client.tsx"), "utf8")))
  check("…and says so IN WORDS when the resolved set is the whole consented book",
    /resolvedCount === r\.totalConsented|everybody/.test(dash))
  check("the manual audience picker no longer offers the two platform-native lies",
    !/SelectItem value="website_visitors"/.test(dash) && !/SelectItem value="engagement"/.test(dash))
  check("POSITIVE CONTROL — that scanner still recognises such an option when present",
    /SelectItem value="website_visitors"/.test('<SelectItem value="website_visitors">x</SelectItem>'))
  check("every rule the manual picker DOES offer resolves with the inputs the dialog collects",
    (["contact_list", "investor_contacts", "lifetime_customers", "high_engagement_contacts", "active_buyers", "exclusion_active_pipeline"] as const)
      .every((t) => {
        const filters: Record<string, unknown> =
          t === "contact_list" ? { contact_tags: ["x"] }
          : t === "high_engagement_contacts" ? { min_engagement_score: 70 }
          : t === "active_buyers" ? { days_lookback: 30 }
          : {}
        return resolveSourceRuleNarrowing({ type: t, filters }, NOW).ok
      }))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[9 · ONE VOCABULARY — the lifetime set is shared, not re-typed (CLAUDE.md §6)]")

  // THE RULE, NOT THE NUMBER (CLAUDE.md §2 — do not pin an assertion to a waypoint).
  // This read `LIFETIME_CONTACT_TYPES.length === 3`, which was true only between
  // m539 (which made the roster client / lifetime_customer / sphere) and m563
  // (which removed 'client' on the owner ruling, leaving two). The cardinality was
  // never the property worth asserting; the property is that the roster is
  // non-empty and every member is a value the LIVE CHECK still admits — a member
  // the column cannot hold makes the ads audience narrow silently, which is the
  // defect this section exists for.
  check("LIFETIME_CONTACT_TYPES is the ONE canonical roster, every member is admitted\n     by the live contacts_contact_type_check, and the ads rule uses it",
    LIFETIME_CONTACT_TYPES.length > 0
    && LIFETIME_CONTACT_TYPES.every((t) => (CHECK_VOCABULARIES.contacts?.contact_type ?? []).includes(t))
    && /LIFETIME_CONTACT_TYPES/.test(code("lib/ads/audience-source-rules.ts")),
    `roster: ${LIFETIME_CONTACT_TYPES.join("/")}`)
  check("POSITIVE CONTROL — that membership test really rejects a retired spelling\n     ('client', removed by m563, and 'past_client', removed by m539)",
    !(CHECK_VOCABULARIES.contacts?.contact_type ?? []).includes("client")
    && !(CHECK_VOCABULARIES.contacts?.contact_type ?? []).includes("past_client")
    && (CHECK_VOCABULARIES.contacts?.contact_type ?? []).includes("lifetime_customer"))
  check("…and the source-rule module hard-codes NO lifetime list of its own",
    !/\[\s*"lifetime",\s*"lifetime_customer"/.test(code("lib/ads/audience-source-rules.ts")))
  check("POSITIVE CONTROL — that scanner recognises a hard-coded list when one exists",
    /\[\s*"lifetime",\s*"lifetime_customer"/.test('const x = ["lifetime", "lifetime_customer", "past_client"]'))
  check("the lifetime rule really uses that shared set (all five types resolve into it)",
    (() => {
      const n = ok(resolveSourceRuleNarrowing({ type: "lifetime_customers", filters: {} }, NOW))
      const pred = n.predicates.find((p) => p.column === "contact_type")
      return !!pred && JSON.stringify(pred.value) === JSON.stringify([...LIFETIME_CONTACT_TYPES])
    })())

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[10 · PUBLISHED BLIND SPOTS — stated beside the numbers, not omitted]")

  console.log("     · THE LIVE TENANT HOLDS 4 CONTACTS, all consented, all status='active'.")
  console.log("       At that size EVERY rule above would 'pass' a live check, including the")
  console.log("       broken one. Every discriminating assertion here is on the 10-row fixture.")
  console.log("     · open_house_attendees.contact_id is written by ONE of its three insert")
  console.log("       sites; walk-in sign-ins leave it NULL and are NOT in that audience.")
  console.log("       Undercounts — the fail-closed direction. Fixture row 3 pins it.")
  console.log("     · leads.lead_stage has NO CHECK; 'qualified' is pinned to its two writers.")
  console.log("       A writer that changes spelling makes that audience empty, not wide.")
  console.log("     · contacts.contact_persona IS CHECK-constrained now (14 values incl. 'investor'")
  console.log("       since m589 — measured in scripts/check-vocabularies.ts); pre-CHECK drifted")
  console.log("       spellings still read forward through the ONE alias map, so the persona rule")
  console.log("       queries raw spellings too. This line used to claim NO CHECK — stale.")
  console.log("     · contacts.zip_code is NULL on all 4 live rows, so zip narrowing resolves")
  console.log("       to zero live contacts today. Proven on fixtures instead.")
  check("the walk-in blind spot is real and pinned (a null contact_id attendee is excluded)",
    (() => {
      const n = ok(resolveSourceRuleNarrowing({ type: "open_house_attendees", filters: {} }, NOW))
      return JOIN_ROWS.open_house_attendees.some((r) => r.contact_id === null)
        && resolveMembers(n).length === 2
    })())

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ AUDIENCE_SOURCE_RULES_PASS — every declared rule type resolves or refuses;")
  console.log("    no rule falls through to 'every consented contact in the brokerage'.")
}

main()
