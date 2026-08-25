#!/usr/bin/env tsx
/**
 * scripts/vendor-tenancy-lead-source-billing-simulator.ts
 *   (npm run test:vendor-tenancy-lead-source-billing)
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE WAYS THE CODE TRUSTED SOMETHING IT NEVER READ.
 *
 * The three defects this proves fixed look unrelated and are the same mistake:
 * a value the server did not establish stood in for one it should have.
 *
 *   1. A CALLER-SUPPLIED IDENTITY stood in for the session's.
 *      app/actions/ai-vendor-management.ts analyzeVendorPerformance called
 *      requireVendorCaller() — which proves the caller is authenticated
 *      SOMEWHERE — and then filtered `booked_by = params.agentId`, an identity
 *      read out of the REQUEST BODY, with NO brokerage predicate. Any
 *      authenticated user could name any agent's uuid and receive that agent's
 *      whole booking history, per-job COST and vendor ratings, in ANY tenant.
 *      The endpoint's own output is a cost analysis, so this handed out another
 *      brokerage's financials (§4, §5). getVendorRecommendations carried the
 *      identical read.
 *
 *      THE FIX HAD A TRAP IN IT. The obvious repair — swap params.agentId for
 *      ctx.agentId — is WRONG and would have failed silently: vendor_bookings
 *      .booked_by holds a users.id, not an agents.id. Every writer stamps one
 *      (app/actions/vendor-marketplace.ts:338 and :1386 `booked_by: user.id`;
 *      lib/kernel/vendors.ts:552 `booked_by: agentUserId`). agents.id and
 *      users.id are DISJOINT (CLAUDE.md §3), so an agents.id would have matched
 *      zero rows and rendered as "you have no booking history" rather than as a
 *      refusal. The actor is auth.userId; the brokerage predicate is added
 *      beside it.
 *
 *   2. A VOCABULARY THAT BOUND NOTHING stood in for validation.
 *      lib/constants LEAD_SOURCES had TWO importers and ZERO uses — both
 *      imports were dead — while contacts.source carries NO CHECK CONSTRAINT
 *      (measured live 2026-08-25; leads.source has none either — its CHECKs
 *      cover source_family/source_origin only). A `readonly [...]` is erased at
 *      build time, so on a `"use server"` export — a public HTTP endpoint — the
 *      column accepted any string in the body verbatim. THREE spellings of the
 *      pick list existed (§6). And the list could not simply be wired: it did
 *      not contain "manual", which is what lib/kernel/crm.ts:396 writes by
 *      default, so enforcing it as-written would have refused the product's own
 *      default value on every manually-added contact.
 *
 *   3. AN ABSENT ENTITLEMENT stood in for the largest entitlement sold.
 *      Unlimited seats are spelled NULL in subscription_tiers.max_agents and -1
 *      in an older convention; a previous wave folded both onto null so the
 *      unlimited plan stopped printing "Up to null agents". It left the second
 *      reading of that same absent value: with NO subscription row, `tier` is
 *      undefined, `tier?.max_agents` is undefined, and it reached the identical
 *      fold — so a tenant with no plan was shown "No Plan" and "Unlimited
 *      seats" in the same card. Every tenant on this database is in that state;
 *      `subscriptions` holds 0 rows.
 *
 * PURE:   the two folds, each with BOTH sides asserted — the value that must be
 *         admitted and the value that must be refused — plus negative controls
 *         proving the pre-fix behaviour really was broken, so a green result
 *         cannot come from a helper that says yes to everything.
 * SOURCE: shape scans over STRIPPED source (§2 — a tombstone is not a call
 *         site, and these files are now thick with tombstones NAMING the very
 *         strings being scanned for, so reading raw source would make every one
 *         of these checks accuse the fix of being the defect).
 * MUTATION: each source assertion is re-run against a copy of the file with the
 *         defect PUT BACK, and must go RED. An absence assertion that cannot
 *         recognise its own defect is not a measurement (§2).
 * LIVE:   gated on service-role creds. Seeds two brokerages with a booking each
 *         and proves the fixed predicate pair returns only the caller's own row
 *         where the old one returned both. Counts are re-read after cleanup.
 */
import { stripComments, blankStrings } from "./strip-comments"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCE_ALIASES,
  normalizeLeadSource,
} from "../lib/constants"
import {
  formatSeatLimit,
  formatTenantSeatLimit,
  normalizeCatalogSeatLimit,
} from "../lib/kernel/tier-role-matrix"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const root = process.cwd()
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")
/** §2: every code-token scan reads STRIPPED source. */
const src = (rel: string) => stripComments(raw(rel))

const VENDOR_ACTIONS = "app/actions/ai-vendor-management.ts"
const VENDOR_PANEL = "app/dashboard/partners/components/os/ai-vendor-insights-panel.tsx"
const CONTACTS_ACTION = "app/actions/contacts.ts"
const CONTACT_SERVICE = "lib/services/contact-management.service.ts"
const BILLING_PAGE = "app/settings/billing/page.tsx"
const PLAN_CARD = "app/settings/billing/current-plan-card.tsx"
const USAGE_SECTION = "app/settings/billing/usage-section.tsx"

// ─────────────────────────────────────────────────────────────────────────────
// The historical record. These are the THREE pick lists that were merged onto
// lib/constants LEAD_SOURCES, transcribed here verbatim from the deleted code.
// Their purpose is check LS4: the merge must have LOST NOTHING. Kept as data,
// not as a claim about the current tree — nothing asserts these arrays still
// exist anywhere, because they deliberately do not.
// ─────────────────────────────────────────────────────────────────────────────
const MERGED_FROM: Record<string, readonly string[]> = {
  "lib/constants (pre-merge, 10 values)": [
    "website", "referral", "open_house", "social_media", "paid_ad",
    "organic_search", "email_campaign", "phone_call", "walk_in", "other",
  ],
  "app/crm/contacts/new/page.tsx (deleted)": [
    "website", "referral", "open_house", "social_media", "zillow",
    "realtor_com", "cold_call", "door_knock", "other",
  ],
  "app/dashboard/acquisition/acquisition-quick-capture.tsx (deleted)": [
    "business_card", "open_house", "referral", "event", "other",
  ],
}

/** Inline unused-import scanner — same shape used to MEASURE the billing page. */
function unusedImports(rel: string): string[] {
  const stripped = src(rel)
  const importRe = /^import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/gm
  const names: string[] = []
  const spans: Array<[number, number]> = []
  let m: RegExpExecArray | null
  while ((m = importRe.exec(stripped))) {
    spans.push([m.index, m.index + m[0].length])
    const clause = m[1]
    const brace = clause.match(/\{([\s\S]*?)\}/)
    if (brace) {
      for (const p of brace[1].split(",")) {
        const n = p.trim().split(/\s+as\s+/).pop()!.trim()
        if (n) names.push(n)
      }
    }
    const def = clause.replace(/\{[\s\S]*?\}/, "").replace(/^type\s+/, "").split(",")[0].trim()
    if (def && !def.startsWith("*")) names.push(def)
  }
  let body = stripped
  for (const [a, b] of spans) body = body.slice(0, a) + " ".repeat(b - a) + body.slice(b)
  body = blankStrings(body)
  return names.filter((n) => {
    const re = new RegExp(`(?<![A-Za-z0-9_$])${n.replace(/\$/g, "\\$")}(?![A-Za-z0-9_$])`)
    return !re.test(body)
  })
}

/** The body of one exported function, from stripped source. */
function fnBody(stripped: string, name: string): string {
  const at = stripped.indexOf(`export async function ${name}`)
  if (at < 0) return ""
  // to the next top-level `export ` or EOF
  const next = stripped.indexOf("\nexport ", at + 10)
  return stripped.slice(at, next < 0 ? stripped.length : next)
}

// ═════════════════════════════════════════════════════════════════════════════
function pureLeadSource() {
  console.log("\n[pure · the lead-source vocabulary, both sides]")

  // THE TRAP THE OWNER NAMED. The pre-merge list did not contain "manual", and
  // lib/kernel/crm.ts:396 writes exactly that by default. Wiring the old list
  // unchanged would have started refusing the product's own default value.
  check("LS1 the product's OWN default 'manual' is IN the vocabulary — wiring the old 10-value list would have refused it",
    normalizeLeadSource("manual") === "manual")

  // MEASURED live: contacts.source holds website_widget(1). It is the pickers'
  // "website" under a second spelling (§6), so it folds rather than multiplying.
  check("LS2 the live column value 'website_widget' folds onto canonical 'website'",
    normalizeLeadSource("website_widget") === "website")

  // NEGATIVE SIDE — without this, LS1/LS2 would also pass for a function that
  // returns its input unchanged and validates nothing.
  check("LS3 NEGATIVE an out-of-vocabulary value is REFUSED (null), not waved through",
    normalizeLeadSource("totally_made_up_source") === null
    && normalizeLeadSource("") === null
    && normalizeLeadSource(null) === null
    && normalizeLeadSource(undefined) === null)

  // §1.1 — merge onto the survivor BEFORE deleting the duplicate. If any value
  // from any of the three lists no longer resolves, the merge dropped it.
  const lost: string[] = []
  for (const [listName, values] of Object.entries(MERGED_FROM)) {
    for (const v of values) if (normalizeLeadSource(v) === null) lost.push(`${listName}:${v}`)
  }
  check("LS4 the merge LOST NOTHING — every value of all three pre-merge pick lists still resolves",
    lost.length === 0, lost.join(", "))

  check("LS5 every canonical value has a label, and the vocabulary has no duplicates",
    LEAD_SOURCES.every((v) => typeof LEAD_SOURCE_LABELS[v] === "string" && LEAD_SOURCE_LABELS[v].length > 0)
    && new Set(LEAD_SOURCES).size === LEAD_SOURCES.length)

  check("LS6 every alias points AT a canonical member (an alias to nowhere would refuse silently)",
    Object.values(LEAD_SOURCE_ALIASES).every((t) => (LEAD_SOURCES as readonly string[]).includes(t)))

  check("LS7 normalization is case- and whitespace-insensitive at the HTTP boundary",
    normalizeLeadSource("  Open_House ") === "open_house")
}

function pureSeatLimit() {
  console.log("\n[pure · absent plan vs unlimited plan]")

  check("SL1 a tier that SAYS unlimited (NULL, the live multi_location spelling) still reads Unlimited",
    formatTenantSeatLimit(true, null) === "Unlimited")

  check("SL2 …and the older -1 convention folds to the same answer",
    formatTenantSeatLimit(true, -1) === "Unlimited")

  check("SL3 a real cap is printed as itself",
    formatTenantSeatLimit(true, 2) === "2" && formatTenantSeatLimit(true, 50) === "50")

  // THE FIX. Absence of a tier must not borrow the unlimited label.
  check("SL4 NO PLAN is NOT unlimited — an absent entitlement never renders as the largest one sold",
    formatTenantSeatLimit(false, null) !== "Unlimited"
    && formatTenantSeatLimit(false, undefined) !== "Unlimited")

  // POSITIVE CONTROL for SL4 (§2): prove the hole was real, so SL4 is not
  // vacuously true against a helper that never had the defect. This is the
  // EXACT expression the two billing displays used to evaluate.
  check("SL4-CONTROL the pre-fix expression really did print Unlimited for a tenant with no tier — SL4 is not vacuous",
    formatSeatLimit(undefined) === "Unlimited" && normalizeCatalogSeatLimit(undefined) === null)

  check("SL5 the seat-cap fold is unchanged for catalogue rows — this lane widened the reading, it did not move the number",
    normalizeCatalogSeatLimit(null) === null
    && normalizeCatalogSeatLimit(-1) === null
    && normalizeCatalogSeatLimit(5) === 5)
}

// ═════════════════════════════════════════════════════════════════════════════
/**
 * The vendor tenancy assertions, as a function of the file's text, so the SAME
 * predicates can be re-run against a mutated copy. A check that only runs
 * against the fixed tree cannot tell a clean tree from a broken scanner.
 */
function vendorTenancyVerdicts(vendorSrc: string) {
  const analyze = fnBody(vendorSrc, "analyzeVendorPerformance")
  const recommend = fnBody(vendorSrc, "getVendorRecommendations")

  /**
   * The vendor_bookings query inside one function — NOT the whole function.
   *
   * The first draft of this asserted `brokerage_id` anywhere in the function
   * body and passed the mutation test for the wrong reason:
   * getVendorRecommendations ALSO reads `vendors` with its own
   * `.eq("brokerage_id", auth.brokerageId)`, so deleting the predicate from the
   * BOOKINGS read left the check green. A tenancy assertion that any tenanted
   * query in the vicinity can satisfy is not a tenancy assertion.
   */
  const bookingsRead = (body: string) => {
    const at = body.indexOf('.from("vendor_bookings")')
    return at < 0 ? "" : body.slice(at, at + 700)
  }
  const analyzeRead = bookingsRead(analyze)
  const recommendRead = bookingsRead(recommend)

  return {
    foundBoth: analyzeRead.length > 0 && recommendRead.length > 0,
    // No read in this file may filter an identity taken from the request body.
    noBodyIdentity: !/\.eq\(\s*["']booked_by["']\s*,\s*params\.agentId\s*\)/.test(vendorSrc),
    // Both reads take the actor from the session — and from userId, because
    // booked_by holds a users.id (agents.id would match nothing).
    analyzeSessionActor: /\.eq\(\s*["']booked_by["']\s*,\s*auth\.userId\s*\)/.test(analyzeRead),
    recommendSessionActor: /\.eq\(\s*["']booked_by["']\s*,\s*auth\.userId\s*\)/.test(recommendRead),
    // …and each BOOKINGS read carries the tenant predicate beside it.
    analyzeTenant: /\.eq\(\s*["']brokerage_id["']\s*,\s*auth\.brokerageId\s*\)/.test(analyzeRead),
    recommendTenant: /\.eq\(\s*["']brokerage_id["']\s*,\s*auth\.brokerageId\s*\)/.test(recommendRead),
    // NOT ctx.agentId / auth.agentId — the disjoint-id trap.
    noAgentIdOnBookedBy: !/\.eq\(\s*["']booked_by["']\s*,\s*(?:auth|ctx)\.agentId\s*\)/.test(vendorSrc),
  }
}

function sourceVendorTenancy() {
  console.log("\n[source · tenant and actor from the session]")
  const vendorSrc = src(VENDOR_ACTIONS)
  const v = vendorTenancyVerdicts(vendorSrc)

  check("VT0 both endpoints are still present and parsed (a missing body would make every check below vacuously green)",
    v.foundBoth)
  check("VT1 NO read filters booked_by on a REQUEST-BODY identity anywhere in the file",
    v.noBodyIdentity)
  check("VT2 analyzeVendorPerformance takes the actor from the SESSION",
    v.analyzeSessionActor)
  check("VT3 analyzeVendorPerformance carries the brokerage predicate",
    v.analyzeTenant)
  check("VT4 getVendorRecommendations — the sibling with the identical hole — takes the actor from the SESSION",
    v.recommendSessionActor)
  check("VT5 getVendorRecommendations carries the brokerage predicate",
    v.recommendTenant)
  check("VT6 booked_by is NOT compared to an agents.id — agents.id and users.id are DISJOINT, so that would match nothing and read as 'no history'",
    v.noAgentIdOnBookedBy)

  // Every vendor_bookings query in this file — READ **OR WRITE** — must be
  // tenant-scoped. Keyed to the RULE rather than to a list of function names, so
  // a new query cannot be added without a predicate (§2 — assert the rule and
  // derive the number, never hardcode the count).
  //
  // THIS CHECK EARNED ITS KEEP THE MOMENT IT WAS WRITTEN. It was added for the
  // two READS this lane was sent to fix and immediately went red on a THIRD
  // query nobody had reported: transitionBookingStatus updated on `id` alone,
  // so any authenticated user could mark any other brokerage's booking
  // completed / cancelled / no_show. The more damaging verb had the same hole.
  const blocks = vendorSrc.split('.from("vendor_bookings")').slice(1)
  const untenanted = blocks.filter((b) => !/\.eq\(\s*["']brokerage_id["']/.test(b.slice(0, 700)))
  check(`VT7 every vendor_bookings query in this file — read AND write — is tenant-scoped (${blocks.length} queries, ${untenanted.length} untenanted)`,
    blocks.length > 0 && untenanted.length === 0)

  // §3 — an UPDATE that matches nothing resolves indistinguishably from one that
  // worked, so a refused cross-tenant write would report success.
  const transition = fnBody(vendorSrc, "transitionBookingStatus")
  check("VT8 the booking-status write COUNTS the rows it changed — a wrong-tenant update must not report success",
    /\.select\(\s*["']id["']\s*\)/.test(transition) && /updated\.length === 0/.test(transition))

  // ── MUTATION TEST ────────────────────────────────────────────────────────
  // Put the defect back and prove the checks above go RED. Without this, a
  // regex that silently stopped matching would report a clean tree.
  console.log("\n[mutation · restore the body-supplied agentId, the checks MUST go red]")
  const mutated = vendorSrc
    .replace(/\.eq\("booked_by", auth\.userId\)\n\s*\.eq\("brokerage_id", auth\.brokerageId\)/g,
             '.eq("booked_by", params.agentId)')
  check("MUT0 the mutation actually changed the text (a no-op mutation would prove nothing)",
    mutated !== vendorSrc)
  const mv = vendorTenancyVerdicts(mutated)
  check("MUT1 VT1 goes RED against the restored body-supplied identity",
    mv.noBodyIdentity === false)
  check("MUT2 VT2/VT4 go RED — neither endpoint reads the session actor any more",
    mv.analyzeSessionActor === false && mv.recommendSessionActor === false)
  check("MUT3 VT3/VT5 go RED — the brokerage predicate is gone from the BOOKINGS read specifically (the vendors read in the same function keeps its own, and must not satisfy this)",
    mv.analyzeTenant === false && mv.recommendTenant === false)
  const mutBlocks = mutated.split('.from("vendor_bookings")').slice(1)
  check("MUT4 VT7 goes RED — the sweep counts the untenanted queries the mutation restored",
    mutBlocks.filter((b) => !/\.eq\(\s*["']brokerage_id["']/.test(b.slice(0, 700))).length > 0)

  // Independent mutation for the WRITE, which the read mutation above does not touch.
  const mutWrite = vendorSrc.replace(
    /\.eq\("id", params\.bookingId\)\n\s*\.eq\("brokerage_id", auth\.brokerageId\)/,
    '.eq("id", params.bookingId)')
  check("MUT5 restoring the untenanted booking-status UPDATE also goes RED",
    mutWrite !== vendorSrc
    && mutWrite.split('.from("vendor_bookings")').slice(1)
        .filter((b) => !/\.eq\(\s*["']brokerage_id["']/.test(b.slice(0, 700))).length > 0)
}

function sourceVendorCaller() {
  console.log("\n[source · the caller, whose contract the fix changed]")
  const panel = src(VENDOR_PANEL)

  check("VC1 the panel no longer passes a brokerage id as the whole params object behind an `as any`",
    !/getVendorRecommendations\(\s*brokerageId\s+as\s+any\s*\)/.test(panel))

  // §1.2 — the missing half was BUILT: the import was dead, so the panel had
  // never once rendered a real insight.
  check("VC2 analyzeVendorPerformance is no longer a DEAD IMPORT here — it is actually called",
    /analyzeVendorPerformance\s*\(/.test(panel))

  check("VC3 the panel sends NO identity to the server — tenant and actor come from the session",
    !/analyzeVendorPerformance\(\s*\{[^}]*(?:agentId|brokerageId)/.test(panel))

  const dead = unusedImports(VENDOR_PANEL)
  check(`VC4 the panel carries no dead imports at all (${dead.length} found)`,
    dead.length === 0, dead.join(", "))
}

function sourceLeadSourceWiring() {
  console.log("\n[source · the vocabulary is CALLED, not merely declared]")

  const contactsAction = src(CONTACTS_ACTION)
  const service = src(CONTACT_SERVICE)

  check("LW1 the public createContact endpoint folds the body's source through normalizeLeadSource",
    /normalizeLeadSource\s*\(/.test(contactsAction))
  check("LW2 …and REFUSES an unrecognised value rather than persisting it verbatim",
    /if\s*\(\s*!\s*source\s*\)/.test(contactsAction) && /Unknown lead source/.test(contactsAction))
  check("LW3 the second writer of contacts.source folds through the SAME function, so the two cannot disagree (§6)",
    /normalizeLeadSource\s*\(/.test(service) && /Unknown lead source/.test(service))

  // The write must use the CANONICAL value, not the raw body string.
  check("LW4 the kernel is handed the canonical value, not the raw request field",
    !/source_label:\s*contactData\.source/.test(contactsAction))
  check("LW5 the service insert writes the canonical value, not `params.source || \"manual\"`",
    !/source:\s*params\.source\s*\|\|/.test(service))

  // §1.1 — the duplicates are gone. Keyed to the values that were UNIQUE to
  // each deleted copy appearing inside an array/object literal in that file.
  const newContact = src("app/crm/contacts/new/page.tsx")
  const quickCapture = src("app/dashboard/acquisition/acquisition-quick-capture.tsx")
  check("LW6 the crm/contacts/new private pick list is DELETED — it imports the survivor instead",
    !/value:\s*"zillow"/.test(newContact) && /from\s+["']@\/lib\/constants["']/.test(newContact))
  check("LW7 the acquisition quick-capture private pick list is DELETED — it imports the survivor instead",
    !/value:\s*"business_card"/.test(quickCapture) && /from\s+["']@\/lib\/constants["']/.test(quickCapture))

  // The agent's pick was silently dropped: createContact takes `source`, the
  // form sent `lead_source`, and an `as any` stopped the compiler objecting.
  check("LW8 quick-capture sends `source` — it sent `lead_source` behind an `as any`, so the agent's pick was DROPPED on every capture",
    !/lead_source:\s*source/.test(quickCapture) && /\bsource,/.test(quickCapture))

  // A survivor with only dead importers is the state this lane found. Assert
  // the RULE: at least one file imports it AND references it in its body.
  const importers = [CONTACTS_ACTION, CONTACT_SERVICE, "app/crm/contacts/new/page.tsx",
                     "app/dashboard/acquisition/acquisition-quick-capture.tsx"]
  const liveUsers = importers.filter((f) => {
    const s = src(f)
    if (!/LEAD_SOURCES|normalizeLeadSource/.test(s)) return false
    return unusedImports(f).every((n) => n !== "LEAD_SOURCES" && n !== "normalizeLeadSource")
  })
  check(`LW9 LEAD_SOURCES has LIVE importers, not dead ones (${liveUsers.length} of ${importers.length} use what they import)`,
    liveUsers.length === importers.length, `dead in: ${importers.filter((f) => !liveUsers.includes(f)).join(", ")}`)

  // ── THE BOUNDARY OF THIS VOCABULARY, RECORDED SO IT IS NOT "HELPFULLY" WIDENED
  // contacts.source holds TWO populations: values an AGENT PICKED, and machine
  // PROVENANCE written by the kernel's other entry points. Measured writers of
  // the second kind, neither of which is in the pick list and neither of which
  // is wrong:
  //     app/actions/transactions.ts:117           source_label: "manual_transaction"
  //     app/api/widget/live-agent-request/route.ts:97
  //                                               source_label: "website_widget_callback"
  //
  // This is why NO CHECK CONSTRAINT was added to the column and why m558 was
  // left unused. A CHECK is a claim about the WHOLE column; those two writers
  // are live and correct, so a CHECK built from the agent pick list would refuse
  // them (PGRST204/23514 refuses the ENTIRE row, §3). The gate belongs at the
  // agent-facing endpoint, which is where it now is.
  //
  // The assertion is therefore the RULE, not a waypoint: the gate must sit on
  // the PUBLIC endpoint and must NOT have been pushed down into the kernel
  // command that these two machine writers also call.
  const crmKernel = src("lib/kernel/crm.ts")
  check("LW10 the pick-list gate is NOT inside the kernel command — machine provenance writers (manual_transaction, website_widget_callback) must keep reaching contacts.source",
    !/normalizeLeadSource/.test(crmKernel))
  check("LW11 …and those two machine writers do not route through the gated public endpoint, so they are unaffected by it",
    !/normalizeLeadSource/.test(src("app/actions/transactions.ts"))
    && !/normalizeLeadSource/.test(src("app/api/widget/live-agent-request/route.ts")))

  // MUTATION — remove the gate and prove LW1/LW2 notice.
  console.log("\n[mutation · remove the vocabulary gate, the checks MUST go red]")
  const mutated = contactsAction.replace(/normalizeLeadSource\s*\(/g, "String(")
  check("MUT6 the mutation changed the text", mutated !== contactsAction)
  check("MUT7 LW1 goes RED with the fold removed",
    !/normalizeLeadSource\s*\(/.test(mutated))
}

function sourceBilling() {
  console.log("\n[source · the billing page]")

  const dead = unusedImports(BILLING_PAGE)
  check(`BP1 app/settings/billing/page.tsx carries NO dead imports (was 16 of 27 bindings; now ${dead.length})`,
    dead.length === 0, dead.join(", "))

  const page = src(BILLING_PAGE)
  // The page is NOT a stub and never was — assert what it actually renders, so
  // a future gutting is caught.
  check("BP2 the page still mounts all three billing surfaces (it is wiring, not a stub)",
    /<CurrentPlanCard/.test(page) && /<UsageSection/.test(page) && /<InvoiceHistoryTable/.test(page))

  check("BP3 the page tells its children whether a catalogue tier was READ, not only what it held",
    /const hasTier\s*=\s*Boolean\(currentTier\)/.test(page) && /hasTier=\{hasTier\}/.test(page))

  const usage = src(USAGE_SECTION)
  const card = src(PLAN_CARD)
  check("BP4 both seat displays go through formatTenantSeatLimit, which cannot print Unlimited for an absent plan",
    /formatTenantSeatLimit/.test(usage) && /formatTenantSeatLimit/.test(card))
  check("BP5 the usage meter no longer labels the seat cap from the bare fold",
    !/max:\s*formatSeatLimit\(maxAgents\)/.test(usage))

  // UpgradeModal was one of the 16 — and it is the one that is NOT dead product.
  check("BP6 UpgradeModal is still mounted — by CurrentPlanCard, which owns the Upgrade button (the page's own import was the redundant one)",
    /<UpgradeModal/.test(card))
}

// ═════════════════════════════════════════════════════════════════════════════
async function liveLayer() {
  console.log("\n[live · a booking in another tenant is unreachable]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY
    && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE service creds not set (pure + source + mutation layers ran).")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `VTLB${Date.now()}`
  const brokerages: string[] = []
  const bookings: string[] = []

  // Starting totals — re-read after cleanup and required to match.
  const before = {
    brokerages: (await svc.from("brokerages").select("id", { count: "exact", head: true })).count ?? -1,
    bookings: (await svc.from("vendor_bookings").select("id", { count: "exact", head: true })).count ?? -1,
  }

  try {
    for (const n of ["A", "B"]) {
      const { data, error } = await svc.from("brokerages").insert({ name: `${TAG} ${n}` }).select("id").single()
      if (error) { check(`live: seed brokerage ${n}`, false, error.message); return }
      brokerages.push((data as any).id)
    }
    const { data: vendor, error: vErr } = await svc.from("vendors")
      // "inspector", not "inspection": vendors_category_check admits the former.
      // (The AI matcher greps `%inspection%` against this column and therefore
      // matches nothing — recorded in the lane report, not fixed here.)
      .insert({ name: `${TAG} Vendor`, category: "inspector", brokerage_id: brokerages[0] })
      .select("id").single()
    if (vErr) { check("live: seed vendor", false, vErr.message); return }

    // One booking per tenant, SAME booked_by, so only the brokerage predicate
    // can separate them — which is precisely what was missing.
    const actor = crypto.randomUUID()
    for (let i = 0; i < 2; i++) {
      const { data, error } = await svc.from("vendor_bookings").insert({
        vendor_id: (vendor as any).id,
        brokerage_id: brokerages[i],
        booked_by: actor,
        service_type: "inspection",
        status: "completed",
      }).select("id").single()
      if (error) { check(`live: seed booking ${i}`, false, error.message); return }
      bookings.push((data as any).id)
    }

    // THE OLD PREDICATE — actor only. Must see BOTH tenants' rows; that is the
    // defect, and proving it here is what makes the next check meaningful.
    const oldWay = await svc.from("vendor_bookings").select("id, brokerage_id").eq("booked_by", actor)
    check("live CONTROL: the pre-fix predicate (booked_by alone) reaches BOTH tenants' bookings — the defect is real",
      oldWay.error === null && (oldWay.data ?? []).length === 2)

    // THE FIXED PREDICATE — actor AND tenant. Must see exactly its own.
    const newWay = await svc.from("vendor_bookings").select("id, brokerage_id")
      .eq("booked_by", actor).eq("brokerage_id", brokerages[0])
    check("live: the fixed predicate returns ONLY the caller's own tenant's booking",
      newWay.error === null
      && (newWay.data ?? []).length === 1
      && (newWay.data as any[])[0].brokerage_id === brokerages[0])

    const otherWay = await svc.from("vendor_bookings").select("id")
      .eq("booked_by", actor).eq("brokerage_id", brokerages[1])
    check("live: the same actor scoped to the OTHER tenant returns that tenant's row and no more — the predicate separates, it does not merely shrink",
      otherWay.error === null && (otherWay.data ?? []).length === 1)
  } finally {
    // §3 — a DELETE that matches nothing also resolves. .select() and COUNT.
    for (const id of bookings) {
      const { data } = await svc.from("vendor_bookings").delete().eq("id", id).select("id")
      if ((data ?? []).length !== 1) check(`live cleanup: booking ${id} removed`, false, "delete matched 0 rows")
    }
    await svc.from("vendors").delete().like("name", `${TAG}%`).select("id")
    for (const id of brokerages) {
      const { data } = await svc.from("brokerages").delete().eq("id", id).select("id")
      if ((data ?? []).length !== 1) check(`live cleanup: brokerage ${id} removed`, false, "delete matched 0 rows")
    }
    const after = {
      brokerages: (await svc.from("brokerages").select("id", { count: "exact", head: true })).count ?? -2,
      bookings: (await svc.from("vendor_bookings").select("id", { count: "exact", head: true })).count ?? -2,
    }
    check(`live cleanup: totals returned to their starting values (brokerages ${before.brokerages}→${after.brokerages}, vendor_bookings ${before.bookings}→${after.bookings})`,
      before.brokerages === after.brokerages && before.bookings === after.bookings)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Vendor tenancy · lead-source vocabulary · billing seat display")
  console.log(" (three ways the code trusted a value it never read)")
  console.log("══════════════════════════════════════════════════")
  pureLeadSource()
  pureSeatLimit()
  sourceVendorTenancy()
  sourceVendorCaller()
  sourceLeadSourceWiring()
  sourceBilling()
  await liveLayer()

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    console.log(" ❌ VENDOR_TENANCY_LEAD_SOURCE_BILLING_FAIL")
    process.exit(1)
  }
  console.log(" ✅ VENDOR_TENANCY_LEAD_SOURCE_BILLING_PASS — the vendor endpoints take tenant and actor from the session (and from users.id, which is what booked_by holds); the lead-source vocabulary is one list that is actually CALLED at both writers and admits the product's own 'manual' default; and a tenant with no plan is no longer shown the unlimited seat cap")
}

main()
