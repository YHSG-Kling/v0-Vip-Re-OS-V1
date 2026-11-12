#!/usr/bin/env tsx
/**
 * scripts/inbound-suppression-lead-identity-simulator.ts
 *   (npm run test:inbound-suppression-lead-identity — pure, no DB)
 * ─────────────────────────────────────────────────────────────────────────────
 * AN UNCONVERTED LEAD CAN SAY "STOP", AND IT HAS TO BIND.
 *
 * OWNER RULING (2026-08-24), verbatim:
 *   "inbound should be checked on contact id and leads are pulled from leads
 *    (contactid) which should this should be checking on contacts and leads
 *    since the inbound can be for leads that haven't converted yet."
 *
 * ── THE DEFECT THIS EXISTS TO KEEP DEAD ─────────────────────────────────────
 * app/api/webhooks/inbound-suppression/route.ts resolved a bare phone number or
 * email address — the only identity an external email/DM feed actually carries —
 * against `contacts` ONLY, and resolved a named `leadId` through
 * `leads.contact_id`, which is NULL until the lead is promoted. So for a LEAD
 * THAT HAS NOT CONVERTED both doors were shut and the handler answered 404
 * `contact_not_found`. The feed was told we do not know the person; the
 * do-not-contact instruction was dropped in silence.
 *
 * That is the SAME FAILURE DIRECTION as the `recordSuppressionEvent` defect the
 * previous wave killed (lib/kernel/suppression-sync.ts:168): the system accepts a
 * consent withdrawal and leaves the person contactable. It is a CONSENT defect,
 * not a lookup bug, which is why it is guarded rather than merely fixed.
 *
 * ── WHY PART EXECUTION, PART SOURCE ─────────────────────────────────────────
 * The RULES are pure functions, so they are EXECUTED: a regex cannot tell a
 * returned `kind:"lead"` from a returned `kind:"contact"`, nor an `ok:false` from
 * an `ok:true`. The WIRING — that the route reads both tables, unions them before
 * resolving, and hands a lead to the lead-side writer instead of promoting it —
 * is structural, so it is read from source, and EVERY source assertion carries a
 * MUTATION that must turn it red. A source check never shown to fail is
 * indistinguishable from one whose regex quietly stopped matching (CLAUDE.md §2).
 *
 * Source is read through `stripComments`: this route carries long tombstones that
 * quote the very code that was removed, and the header above quotes the ruling
 * itself. Reading raw source would let prose satisfy the assertions it describes
 * — the exact failure that took five guards red in one wave.
 *
 * ── COLUMN NAMES ARE NOT ASSUMED ────────────────────────────────────────────
 * The identity columns the route queries are PARSED OUT OF THE ROUTE and checked
 * against scripts/schema-snapshot.ts — the machine-written cache of the live
 * database (generated 2026-08-24 from public.live_schema_json(); CI holds no
 * credentials, which is the only reason the cache is committed). `leads.phone` is
 * `character varying` and `contacts.phone` is `text`; they happen to share a
 * name, and this check is what notices the day one of them stops.
 *
 * BLIND SPOTS, stated beside the numbers (CLAUDE.md §2):
 *   · Identity matching is EXACT-STRING on `phone` / `email`, on both tables.
 *     A feed sending `+15551234567` against a row holding `(555) 123-4567` still
 *     matches nothing. `phone_digits` exists on BOTH tables and is deliberately
 *     NOT queried here — adding a third identity column widens the ambiguity
 *     surface and belongs to whoever owns normalization, not to this lane. It is
 *     a real remaining gap, reported rather than silently half-closed.
 *   · This guard reads source and executes pure rules. It does NOT execute the
 *     route against a database; the write behaviour of applyLeadOptOut is proved
 *     by scripts/lead-pipeline-simulator.ts and scripts/mail-unsubscribe-simulator.ts.
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import {
  resolveUnambiguousTenant,
  pickIdentitySubject,
  type IdentitySubjectCandidate,
} from "../lib/kernel/unambiguous-tenant"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const raw = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "")
const code = (p: string) => stripComments(raw(p))

const ROUTE = "app/api/webhooks/inbound-suppression/route.ts"
const WRITER = "lib/lead-intent/lead-opt-out.ts"
const RULE = "lib/kernel/unambiguous-tenant.ts"

let pass = 0
let fail = 0
const failures: string[] = []

function check(label: string, cond: boolean, why?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${why ? `\n      ${why}` : ""}`) }
}

/**
 * A source assertion PLUS its own negative control. `predicate` runs on the real
 * stripped source (must be TRUE) and again on a mutated copy (must be FALSE).
 * A missing mutation anchor is a FAILURE, not a skip: without the control the
 * green means nothing.
 */
function checkWithMutation(
  label: string,
  src: string,
  predicate: (s: string) => boolean,
  mutation: [find: string, replace: string],
  why: string,
) {
  const live = predicate(src)
  const mutated = src.includes(mutation[0]) ? src.replace(mutation[0], mutation[1]) : null
  if (mutated === null) {
    fail++
    failures.push(`${label} (mutation anchor missing)`)
    console.log(`  ✗ ${label}\n      MUTATION ANCHOR NOT FOUND: ${JSON.stringify(mutation[0].slice(0, 80))}`)
    console.log("      The control cannot run, so this check's green means nothing.")
    return
  }
  const broken = predicate(mutated)
  if (live && !broken) { pass++; console.log(`  ✓ ${label}  [mutation → red ✓]`) }
  else {
    fail++
    failures.push(label)
    console.log(`  ✗ ${label}`)
    if (!live) console.log(`      the real source does NOT satisfy it — ${why}`)
    if (broken) console.log("      …and the MUTATED source satisfies it too, so the check cannot detect the defect at all")
  }
}

/**
 * An ABSENCE assertion with its POSITIVE CONTROL (CLAUDE.md §2). `finder` must
 * find NOTHING in the real source and must find the planted specimen — otherwise
 * "0 found" is just a broken regex reporting a clean bill of health.
 */
function checkAbsence(
  label: string,
  src: string,
  finder: (s: string) => boolean,
  specimen: string,
  why: string,
) {
  const found = finder(src)
  const controlFires = finder(specimen)
  if (!found && controlFires) { pass++; console.log(`  ✓ ${label}  [positive control fires ✓]`) }
  else {
    fail++
    failures.push(label)
    console.log(`  ✗ ${label}`)
    if (found) console.log(`      FOUND IT IN THE REAL SOURCE — ${why}`)
    if (!controlFires) console.log("      …and the finder does NOT recognise its own specimen, so the '0 found' above is meaningless")
  }
}

console.log("══════════════════════════════════════════════════════════════════")
console.log("INBOUND SUPPRESSION — AN UNCONVERTED LEAD CAN SAY STOP")
console.log("══════════════════════════════════════════════════════════════════")

const src = code(ROUTE)
const writerSrc = code(WRITER)
const ruleSrc = code(RULE)

check("the three files were read at all", src.length > 2000 && writerSrc.length > 2000 && ruleSrc.length > 1000,
  "an empty read makes every assertion below vacuously true")

// ══ 1. THE SUBJECT RULE, EXECUTED ═════════════════════════════════════════
console.log("\n═══ 1. pickIdentitySubject — which row is the subject (pure, executed) ═══")
{
  const A = "11111111-1111-1111-1111-111111111111"
  const B = "22222222-2222-2222-2222-222222222222"
  const c = (id: string, b: string | null): IdentitySubjectCandidate => ({ id, brokerage_id: b, table: "contacts" })
  const l = (id: string, b: string | null): IdentitySubjectCandidate => ({ id, brokerage_id: b, table: "leads" })

  check("A LEAD-ONLY match resolves to the LEAD — this is the whole ruling",
    (() => { const s = pickIdentitySubject([l("lead-1", A)]); return s?.kind === "lead" && s.id === "lead-1" })(),
    "an unconverted lead has no contacts row; returning null here is the 404 the feed used to get, and the opt-out is dropped")

  check("a CONTACT-only match still resolves to the contact (the old behaviour is intact)",
    (() => { const s = pickIdentitySubject([c("contact-1", A)]); return s?.kind === "contact" && s.id === "contact-1" })(),
    "widening the search must not break the case that already worked")

  check("both rows in ONE tenant → the CONTACT wins",
    (() => { const s = pickIdentitySubject([l("lead-1", A), c("contact-1", A)]); return s?.kind === "contact" && s.id === "contact-1" })(),
    "a converted person owns both rows and every contact-side gate reads the CONTACT's flags; suppressing only the lead leaves the CRM able to reach them")

  check("NEGATIVE CONTROL — the rule is NOT 'take rows[0]'",
    (() => {
      const rows = [l("lead-1", A), c("contact-1", A)]
      const naive = rows[0]
      const s = pickIdentitySubject(rows)
      return naive.table === "leads" && s?.kind === "contact"
    })(),
    "the naive answer and the rule's answer would agree, which would mean the rule adds nothing and a reordered read changes who gets silenced")

  check("no candidates → null, not a crash and not a guess",
    pickIdentitySubject([]) === null && pickIdentitySubject(null) === null && pickIdentitySubject(undefined) === null,
    "supabase-js returns data:null on a refusal (§3), so this is the shape a REFUSED read arrives in")

  check("the subject carries the tenant of the row it picked, never of the other one",
    (() => {
      const s = pickIdentitySubject([l("lead-1", A)])
      return s?.brokerageId === A
    })(),
    "the tenant must be DERIVED from the row the identity resolved to (§4)")
}

// ══ 2. CROSS-TABLE AMBIGUITY, EXECUTED ════════════════════════════════════
console.log("\n═══ 2. cross-table ambiguity refuses exactly as cross-tenant does ═══")
{
  const A = "11111111-1111-1111-1111-111111111111"
  const B = "22222222-2222-2222-2222-222222222222"
  const c = (id: string, b: string | null): IdentitySubjectCandidate => ({ id, brokerage_id: b, table: "contacts" })
  const l = (id: string, b: string | null): IdentitySubjectCandidate => ({ id, brokerage_id: b, table: "leads" })

  check("a LEAD at brokerage A and a CONTACT at brokerage B is REFUSED as ambiguous",
    (() => {
      const r = resolveUnambiguousTenant([l("lead-1", A), c("contact-1", B)])
      return !r.ok && r.reason === "ambiguous_tenant" && r.tenantCount === 2
    })(),
    "the same human really is a lead at one brokerage and a contact at another; suppressing the wrong one leaves the right one contactable AND is a cross-tenant write")

  check("TWO-SIDED CONTROL — the union is what catches it; each table ALONE looks fine",
    (() => {
      const perContacts = resolveUnambiguousTenant([c("contact-1", B)])
      const perLeads = resolveUnambiguousTenant([l("lead-1", A)])
      const unioned = resolveUnambiguousTenant([l("lead-1", A), c("contact-1", B)])
      return perContacts.ok && perLeads.ok && !unioned.ok
    })(),
    "resolving each table separately and reconciling afterwards would call BOTH unambiguous and never notice they disagree — this is why the candidates are unioned BEFORE the rule runs")

  check("a lead and a contact in the SAME tenant are NOT ambiguity",
    (() => {
      const r = resolveUnambiguousTenant([l("lead-1", A), c("contact-1", A)])
      return r.ok && r.brokerageId === A && r.rows.length === 2
    })(),
    "refusing the converted-person shape would 409 the commonest case and drop those opt-outs instead")

  check("an untenanted candidate is unambiguous ABOUT BEING UNTENANTED, not a tenant",
    (() => { const r = resolveUnambiguousTenant([c("contact-1", null)]); return r.ok && r.brokerageId === null })(),
    "contacts.brokerage_id is nullable; the route must be able to tell 'no tenant' from 'two tenants' and refuse each with its own reason")
}

// ══ 3. THE WIRING — BOTH TABLES ARE ACTUALLY QUERIED ══════════════════════
console.log("\n═══ 3. the route queries BOTH tables, through ONE rule ═══")
{
  // DERIVED, not hardcoded: the table list is parsed out of the route and the
  // RULE asserted ("contacts and leads are both in it"), so this cannot pin to a
  // waypoint the way a literal-string match would.
  const tablesOf = (s: string): string[] => {
    const m = /const IDENTITY_TABLES = \[([^\]]*)\]/.exec(s)
    if (!m) return []
    return m[1].split(",").map((x) => x.trim().replace(/["']/g, "")).filter(Boolean)
  }

  checkWithMutation(
    "the identity search covers BOTH contacts and leads",
    src,
    (s) => { const t = tablesOf(s); return t.includes("contacts") && t.includes("leads") },
    ['["contacts", "leads"] as const', '["contacts"] as const'],
    "this IS the defect: a contacts-only search answers contact_not_found for every unconverted lead",
  )

  checkWithMutation(
    "the lookup is driven BY that list — one query body, run per table",
    src,
    (s) => /\.from\(table\)/.test(s) && /for \(const table of IDENTITY_TABLES\)/.test(s),
    [".from(table)", '.from("contacts")'],
    "a hardcoded table would make the list above decorative: it would still say 'leads' while the query never read it",
  )

  checkWithMutation(
    "each identity read still takes limit(2), so ambiguity stays VISIBLE",
    src,
    (s) => /\.eq\(identity\.column, identity\.value\)\s*\.limit\(2\)/.test(s),
    [".limit(2)", ".limit(1)"],
    "with one row per table the tenant rule cannot tell an unambiguous match from a truncated ambiguous one — and widening to two tables makes ambiguity MORE likely, not less",
  )

  checkWithMutation(
    "the tenant rule is applied to the UNION — every call takes the combined candidate list",
    src,
    (s) => {
      const args = [...s.matchAll(/resolveUnambiguousTenant\(([^)]*)\)/g)].map((m) => m[1].trim())
      return args.length > 0 && args.every((a) => a === "candidates")
    },
    ["resolveUnambiguousTenant(candidates)", "resolveUnambiguousTenant(contactsOnly)"],
    "a per-table resolution would call each table individually unambiguous and never see that the two disagree",
  )

  checkWithMutation(
    "the subject choice goes through the shared PURE rule, not a private re-spelling",
    src,
    (s) => /pickIdentitySubject\(match\.rows\)/.test(s) &&
           /pickIdentitySubject/.test(raw(RULE)) &&
           /from "@\/lib\/kernel\/unambiguous-tenant"/.test(raw(ROUTE)),
    ["pickIdentitySubject(match.rows)", "match.rows.find((r) => r.table === \"contacts\")"],
    "§6 — a second spelling of 'which row is the subject', which a simulator could then only pattern-match instead of execute",
  )

  checkWithMutation(
    "a REFUSED read in EITHER table fails closed — never 'the other table found nobody'",
    src,
    (s) => /lookupRefusedIn = table/.test(s) && /if \(lookupRefusedIn\)/.test(s) && /"contact_lookup_failed"/.test(s),
    ["lookupRefusedIn = table", "lookupRefusedIn = null"],
    "CLAUDE.md §3/§4 — a refused leads read with a clean contacts read would resolve to 'not a lead' and suppress nobody: 'we could not look' rendering as 'there is nobody there'",
  )

  checkWithMutation(
    "cross-table ambiguity refuses with the SAME 409 a cross-tenant one does",
    src,
    (s) => /reason === "ambiguous_tenant"/.test(s) && /"tenant_ambiguous"/.test(s) && /status: 409/.test(s),
    ['reason === "ambiguous_tenant"', 'reason === "never"'],
    "the ambiguous branch would fall through and the handler would silence whichever row it found first",
  )

  checkWithMutation(
    "a NAMED leadId with no contact_id becomes a LEAD subject instead of a 404",
    src,
    (s) => /if \(!contactId && lead\) leadSubjectId = lead\.id/.test(s),
    ["if (!contactId && lead) leadSubjectId = lead.id", "if (false) leadSubjectId = lead.id"],
    "leads.contact_id is NULL until promotion; the old code threw away an authoritative named row because it had not converted yet",
  )
}

// ══ 4. A MATCH ON A LEAD SUPPRESSES THE LEAD ══════════════════════════════
console.log("\n═══ 4. a lead is suppressed AS A LEAD — no conversion is invented ═══")
{
  checkWithMutation(
    "the lead arm calls the designated lead-side writer",
    src,
    (s) => /applyLeadOptOut\(\{/.test(s) && /leadId: leadSubjectId/.test(s),
    ["applyLeadOptOut({", "addSuppression({"],
    "addSuppression writes contact_suppression_list.contact_id, an FK onto contacts(id) — for an unconverted lead there is no such row, and the insert would be refused and swallowed",
  )

  check("…and that writer still exists and is still exported",
    /export async function applyLeadOptOut/.test(writerSrc),
    "the wiring above would be pointing at nothing; §1 — the writer is the survivor, not collateral damage")

  check("…and its reopen counterpart was not collateral damage either",
    /export async function reopenLeadOnInboundConsent/.test(writerSrc),
    "an opt-out that can never be lifted is the opposite asymmetry")

  checkAbsence(
    "the route NEVER promotes/converts a lead as a side effect of an opt-out",
    src,
    (s) => /(promote|convert)[A-Za-z]*Lead|leadToContact|lead_to_contact/i.test(s),
    "await convertLeadToContact({ leadId })",
    "CLAUDE.md §5 — conversion happens on the promotion path. A webhook that created a CRM record because someone asked to be LEFT ALONE would be manufacturing the very record the request says not to use",
  )

  checkAbsence(
    "the route NEVER inserts into contacts",
    src,
    (s) => /\.from\("contacts"\)\s*\.insert\(|\.from\("contacts"\)\s*\.upsert\(/.test(s),
    '.from("contacts").insert({ email })',
    "same ruling: a suppression must not mint a contact row",
  )

  checkWithMutation(
    "the lead arm's tenant is DERIVED from the LEAD row, never from the payload",
    src,
    (s) => /const resolvedLeadBrokerageId =\s*\(leadData as/.test(s) && /brokerageId: resolvedLeadBrokerageId/.test(s),
    ["const resolvedLeadBrokerageId =", "const resolvedLeadBrokerageId = payload.brokerage ??"],
    "CLAUDE.md §4 — a webhook has no session, so the tenant must come from the row the identity resolved to",
  )

  checkWithMutation(
    "an untenanted lead REFUSES (409) rather than writing a row it cannot tenant",
    src,
    (s) => /if \(!resolvedLeadBrokerageId\)/.test(s) && /"tenant_unresolved"/.test(s),
    ["if (!resolvedLeadBrokerageId)", "if (false)"],
    "contact_suppression_list.brokerage_id and leads.brokerage_id are both NOT NULL; a null would be refused by the database and the refusal swallowed",
  )

  checkWithMutation(
    "a REFUSED lead opt-out is reported, not answered success:true",
    src,
    (s) => /if \(!leadResult\.applied\)/.test(s) && /"lead_suppression_failed"/.test(s),
    ["if (!leadResult.applied)", "if (false)"],
    "a consent withdrawal that is not recorded is not a consent withdrawal — the exact lie recordSuppressionEvent told for its whole life",
  )

  checkWithMutation(
    "a CONTACT-side suppression mirrors onto the linked LEAD row unconditionally",
    src,
    (s) => /syncSuppressionState\(\{/.test(s) &&
           !/if \(payload\.leadId\) \{\s*await syncSuppressionState/.test(s),
    ["await syncSuppressionState({", "if (payload.leadId) {\n      await syncSuppressionState({"],
    "lib/providers/dispatch.ts picks the row to evaluate as `params.contactId ? \"contacts\" : \"leads\"`, so a send addressed by leadId reads the LEAD's flags — gating the mirror on the caller having named a lead left every feed-identified stop unmirrored",
  )

  check("the CONTACT arm is untouched: still counts rows, still ledgers through addSuppression",
    /updated\.length === 0/.test(src) && /addSuppression\(\{/.test(src) &&
    /brokerageId: resolvedBrokerageId/.test(src) && /if \(!ledger\.suppressed\)/.test(src),
    "NEGATIVE CONTROL — widening the search must not have quietly removed the contact-side discipline the previous wave installed")
}

// ══ 5. VOCABULARY — ONE SPELLING, AND THE REOPEN CAN STILL LIFT IT ════════
console.log("\n═══ 5. channel and source vocabularies (§6) ═══")
{
  checkWithMutation(
    "the lead channel is DERIVED from the contact-side channel decision, not re-branched",
    src,
    (s) => /LEAD_OPT_OUT_CHANNEL\[SUPPRESSION_CHANNEL\[suppressionType\]\]/.test(s),
    ["LEAD_OPT_OUT_CHANNEL[SUPPRESSION_CHANNEL[suppressionType]]", 'LEAD_OPT_OUT_CHANNEL["email"]'],
    "§6 — two intent→channel decisions would let a lead and a contact carrying the identical message be ledgered under different channels",
  )

  // DERIVED CROSS-FILE RULE: every source this route can stamp must be one the
  // reopen path is allowed to remove. Both lists are PARSED, so neither a rename
  // nor a fifth member can slip through as a hardcoded pass.
  const routeSourceBlock = /const LEAD_OPT_OUT_SOURCE[^=]*=\s*\{([\s\S]*?)\}/.exec(src)?.[1] ?? ""
  const routeSources = [...routeSourceBlock.matchAll(/"([a-z_]+)"/g)].map((x) => x[1])
  const reopenable = [...(/const LEAD_INBOUND_SOURCES[^=]*=\s*\[([\s\S]*?)\]/.exec(writerSrc)?.[1] ?? "")
    .matchAll(/"([a-z_]+)"/g)].map((x) => x[1])

  check("both source lists were actually parsed (denominator, not a vacuous pass)",
    routeSources.length >= 4 && reopenable.length >= 4,
    `parsed ${routeSources.length} route sources and ${reopenable.length} reopenable sources — a zero on either side would make the subset check below meaningless`)

  check("every source this route can stamp is one reopenLeadOnInboundConsent can LIFT",
    routeSources.length > 0 && routeSources.every((s) => reopenable.includes(s)),
    `route stamps [${routeSources.join(", ")}], reopen may remove [${reopenable.join(", ")}] — a source outside that set produces a suppression row that can never be lifted when the person comes back`)

  check("POSITIVE CONTROL — the subset check notices a fifth, unliftable spelling",
    !["inbound_sms", "inbound_webhook"].every((s) => reopenable.includes(s)),
    "the finder accepts a source the reopen path cannot remove, so the green above proves nothing")
}

// ══ 6. THE COLUMN NAMES ARE THE LIVE ONES ═════════════════════════════════
console.log("\n═══ 6. identity columns checked against the live schema cache ═══")
{
  // Parsed out of the route, so a lane that adds a third identity column gets it
  // checked automatically instead of silently.
  const identityColumns = [...src.matchAll(/\{ column: "([a-z_]+)", value: payload\.[A-Za-z]+ \}/g)].map((m) => m[1])
  const tables = (() => {
    const m = /const IDENTITY_TABLES = \[([^\]]*)\]/.exec(src)
    return m ? m[1].split(",").map((x) => x.trim().replace(/["']/g, "")).filter(Boolean) : []
  })()

  check("the identity columns and tables were parsed out of the route",
    identityColumns.length >= 2 && tables.length >= 2,
    `parsed columns [${identityColumns.join(", ")}] over tables [${tables.join(", ")}] — an empty parse makes the checks below vacuous`)

  for (const table of tables) {
    const cols = SCHEMA_SNAPSHOT[table] ?? []
    check(`\`${table}\` exists in the live schema cache and carries id + brokerage_id`,
      cols.includes("id") && cols.includes("brokerage_id"),
      `the route selects "id, brokerage_id" from ${table}; PostgREST refuses a select naming an absent column and supabase-js resolves that refusal (§3)`)
    for (const col of identityColumns) {
      check(`\`${table}.${col}\` exists in the live schema cache`,
        cols.includes(col),
        `the fuzzy identity match filters ${table} on ${col}; the spelling is NOT assumed to be shared between the two tables`)
    }
  }

  check("POSITIVE CONTROL — the schema check would notice a renamed column",
    !(SCHEMA_SNAPSHOT["leads"] ?? []).includes("phone_number_that_does_not_exist"),
    "the cache answers 'yes' to anything, so every column assertion above is meaningless")

  check("the lead-side ledger table still carries what applyLeadOptOut writes",
    ["brokerage_id", "channel", "suppression_reason", "source", "email", "phone", "contact_id"]
      .every((c) => (SCHEMA_SNAPSHOT["contact_suppression_list"] ?? []).includes(c)),
    "the bridge rows are the ONLY arm of checkSuppression that can fire for a person with no contact row")
}

console.log("\n══════════════════════════════════════════════════════════════════")
console.log(`INBOUND SUPPRESSION LEAD IDENTITY — ${pass} passed, ${fail} failed`)
console.log("BLIND SPOTS: exact-string identity match only (phone_digits not queried); no DB execution — applyLeadOptOut's writes are proved by test:lead-pipeline / test:mail-unsubscribe.")
if (fail > 0) {
  console.log("\nFAILED:")
  for (const f of failures) console.log(`  - ${f}`)
  console.log(" ❌ INBOUND_SUPPRESSION_LEAD_IDENTITY_FAIL — an unconverted lead's 'stop' can go unheard")
  process.exit(1)
}
console.log(" ✅ INBOUND_SUPPRESSION_LEAD_IDENTITY_PASS — contacts AND leads searched, ambiguity refused, the lead suppressed as a lead")
