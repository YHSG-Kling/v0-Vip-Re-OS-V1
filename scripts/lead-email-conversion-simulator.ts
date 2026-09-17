#!/usr/bin/env tsx
/**
 * scripts/lead-email-conversion-simulator.ts   (npm run test:lead-email-conversion)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 72A — "emails from LEADS" (owner verbatim): "we need to also be looking
 * out for emails from leads (people that have not yet converted to a contact
 * yet) and if they are positive intent and want assistance, they would be
 * qualified and need to be converted to a contact and assigned to an agent."
 *
 * The pipeline already existed (built across earlier waves) — this proof does
 * NOT rebuild it, it PROVES the wiring end to end and closes the one gap the
 * classification/conversion mechanics themselves don't cover (that logic is
 * already proven exhaustively by scripts/inbound-intent-simulator.ts,
 * test:inbound-intent — this file does not re-derive it):
 *
 *   ENTRY POINT     app/api/providers/inbound/route.ts — Step 3 matches a
 *                   CONTACT by email/phone FIRST; Step 4 falls back to an
 *                   ACTIVE LEAD only when no contact matched. Step 8b calls
 *                   processInboundEmail ONLY for entityType==="lead" with an
 *                   email — a contact's email never reaches the lead path.
 *   REPLY PATH      app/actions/ai-isa/handle-inbound-email.ts::
 *                   processInboundEmail — runs classifyAndRouteInbound; on a
 *                   CONVERTED outcome it returns immediately (responded:false)
 *                   — no duplicate lead-stage AI reply once the contact exists;
 *                   on anything else it falls through to the AI reply
 *                   generation + dispatch (the "ISA reply only" path).
 *   CONVERSION      lib/ai-isa/inbound-intent-classifier.ts::
 *                   classifyAndRouteInbound → convertSellerLeadOnIntent /
 *                   convertBuyerLeadOnIntent → acceptAIISAHandoff →
 *                   evaluateAndAssignLead → handleLeadAssigned →
 *                   createContactFromLead (lossless) + brokerage/team-lead
 *                   assignment_rules, then lib/contact-promotion/
 *                   lead-deactivator.ts marks the lead is_active=false,
 *                   ai_isa_owner=false and cancels its active/paused
 *                   sequence enrollments (no further lead-stage ISA sends).
 *
 * Sections:
 *   1. SOURCE — the entry-point + reply-path wiring above, read from STRIPPED
 *      source (blankComments, CLAUDE.md §2) so a tombstone comment can never
 *      read as a live call site.
 *   2. LIVE — tagged rows, deleted in the same run (CLAUDE.md wave-56 rule):
 *      (a) a CONTACT's email never enters the lead-match query (positive
 *          control: an unmatched sender's email DOES reach the leads query —
 *          proves the discriminator actually discriminates, not a blanket
 *          true);
 *      (b) a lead email with clear positive intent → classifyAndRouteInbound
 *          converts + the assignment call fires (assignment_log gets a row)
 *          + the lead is marked converted (is_active=false, ai_isa_owner=false);
 *      (c) a lead email with no clear intent → nurtured, NOT converted (the
 *          ISA-reply-only path — the lead stays a lead, an activities nurture
 *          row is recorded).
 *   3. HUBSPOT (wave 72A owner ruling, tied into this proof per the task):
 *      the inbound HubSpot pull is ABSENT from stripped source while the
 *      outbound sync is PRESENT — see lib/crm/import-pull.ts's tombstone and
 *      lib/crm/providers/hubspot.ts's survivor.
 *
 * No network calls: the AI reply generation / actual email dispatch inside
 * processInboundEmail is asserted by SOURCE, never invoked live here — the
 * classifier itself is exercised through the SAME injectable seam
 * scripts/inbound-intent-simulator.ts uses (a deterministic classifier, no
 * model call), and this file's live layer calls classifyAndRouteInbound
 * directly rather than processInboundEmail (which would also try to send a
 * real email via dispatchEmail).
 */

// ── test-only shim ──────────────────────────────────────────────────────────
// inbound-intent-classifier.ts imports `server-only`, which throws outside a
// Server Component. Neutralize it in the require cache BEFORE importing
// anything that transitively pulls it (same idiom as
// scripts/inbound-intent-simulator.ts).
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments } from "./strip-comments"
import type { ClassifiedIntent, InboundClassifier } from "../lib/ai-isa/inbound-intent-classifier"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const root = process.cwd()
const src = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => blankComments(src(p))

// ─────────────────────────────────────────────────────────────────────────────
// 1. SOURCE — entry-point + reply-path wiring
// ─────────────────────────────────────────────────────────────────────────────
function testSourceWiring() {
  console.log("\n[1 · SOURCE — entry point + reply path wiring]")

  const route = stripped("app/api/providers/inbound/route.ts")

  const contactMatchIdx = route.indexOf('from("contacts")')
  const leadMatchIdx = route.indexOf('from("leads")\n      .select("id")')
  check("route.ts: the CONTACT match query appears BEFORE the LEAD match query",
    contactMatchIdx > -1 && leadMatchIdx > -1 && contactMatchIdx < leadMatchIdx,
    `contactIdx=${contactMatchIdx} leadIdx=${leadMatchIdx}`)

  check("route.ts: the lead match is gated on 'no contact matched yet' (!entityType)",
    /if \(!entityType && \(emailNorm \|\| phoneDigits\)\)/.test(route))

  check("route.ts: both matches scope on inbound.brokerageId (server-resolved, never a request body)",
    (route.match(/\.eq\("brokerage_id", inbound\.brokerageId\)/g) ?? []).length >= 2)

  check("route.ts: processInboundEmail is called ONLY for entityType===\"lead\" with an email (never a contact)",
    /if \(entityType === "lead" && entityId && inbound\.fromEmail\)/.test(route) &&
    route.indexOf('if (entityType === "lead" && entityId && inbound.fromEmail)') <
      route.indexOf('processInboundEmail'))

  check("route.ts: the lead-email door imports processInboundEmail from the ai-isa reply handler",
    /await import\("@\/app\/actions\/ai-isa\/handle-inbound-email"\)/.test(route))

  check("route.ts: forwards CRON_SECRET as internalSecret (the trusted-internal contract handle-inbound-email.ts documents)",
    /internalSecret: process\.env\.CRON_SECRET/.test(route))

  check("route.ts: Step 8c (SMS+email lead door) also scopes tenant server-side and never re-reads a body brokerageId for the match itself",
    /leadId: entityId,/.test(route) && /brokerageId: inbound\.brokerageId,/.test(route))

  const handler = stripped("app/actions/ai-isa/handle-inbound-email.ts")
  check("handle-inbound-email.ts: calls classifyAndRouteInbound (the intent classifier + converter router)",
    /await import\('@\/lib\/ai-isa\/inbound-intent-classifier'\)/.test(handler) && /classifyAndRouteInbound\(/.test(handler))

  const convertedIdx = handler.indexOf("routed.outcome === 'converted'")
  const replyGenIdx = handler.indexOf("generateText({")
  check("handle-inbound-email.ts: on a CONVERTED outcome it returns BEFORE ever generating an AI reply (no duplicate lead-stage send once a contact exists)",
    convertedIdx > -1 && replyGenIdx > -1 && convertedIdx < replyGenIdx)

  check("handle-inbound-email.ts: a NON-converted outcome (ambiguous/nurtured/halted-elsewhere) falls through to the AI reply + dispatch — the ISA-reply-only path",
    /await checkMaxTouches\(/.test(handler) && /await dispatchEmail\(/.test(handler))

  check("handle-inbound-email.ts: trusted-internal auth gate (CRON_SECRET) OR an authenticated session — never an open door",
    /params\.internalSecret === cronSecret/.test(handler) && /getAgentContext\(\)/.test(handler))

  const classifier = stripped("lib/ai-isa/inbound-intent-classifier.ts")
  check("inbound-intent-classifier.ts: positive route calls the CANONICAL converters (never a second conversion path)",
    /convertSellerLeadOnIntent\(/.test(classifier) && /convertBuyerLeadOnIntent\(/.test(classifier))
  check("inbound-intent-classifier.ts: the ambiguous/nurture write goes through sentinelWrite (consequential write, never a swallowed refusal)",
    /sentinelWrite\(svc, svc\.from\("activities"\)\.insert/.test(classifier))
  check("inbound-intent-classifier.ts: negative intent halts BEFORE any DB read of the lead (never converts on a misread)",
    classifier.indexOf("detectNegativeIntent(params.message)") < classifier.indexOf('.from("leads")'))

  const sellerConverter = stripped("lib/ai-isa/convert-seller-lead-on-intent.ts")
  const buyerConverter = stripped("lib/ai-isa/convert-buyer-lead-on-intent.ts")
  check("convert-seller-lead-on-intent.ts routes through the canonical handoff (acceptAIISAHandoff)",
    /acceptAIISAHandoff\(/.test(sellerConverter))
  check("convert-buyer-lead-on-intent.ts routes through the canonical handoff (acceptAIISAHandoff)",
    /acceptAIISAHandoff\(/.test(buyerConverter))

  const handoff = stripped("app/actions/ai-isa/accept-handoff.ts")
  check("accept-handoff.ts: the canonical handoff assigns via evaluateAndAssignLead (brokerage/team-lead assignment_rules — never a second assigner)",
    /evaluateAndAssignLead\(/.test(handoff))

  const deactivator = stripped("lib/contact-promotion/lead-deactivator.ts")
  check("lead-deactivator.ts: marks the lead is_active=false AND ai_isa_owner=false on conversion (no further lead-stage ISA sends)",
    /is_active: false,/.test(deactivator) && /ai_isa_owner: false,/.test(deactivator))
  check("lead-deactivator.ts: cancels active/paused sequence_enrollments on conversion (a paused one cannot resume firing later)",
    /from\("sequence_enrollments"\)/.test(deactivator) && /\.in\("status", \["active", "paused"\]\)/.test(deactivator))
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. LIVE — tagged rows, deleted in the same run
// ─────────────────────────────────────────────────────────────────────────────
async function testLive() {
  console.log("\n[2 · LIVE — contact-exclusion + positive-intent conversion + no-intent nurture]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { classifyAndRouteInbound, keywordIntentFallback } = await import("../lib/ai-isa/inbound-intent-classifier")
  const svc = createServiceClient()

  const TAG = `__leademail_${Date.now()}__`
  const cleanup: Array<{ table: string; column: string; value: string }> = []
  function reg(table: string, column: string, value: string) { cleanup.push({ table, column, value }) }

  try {
    const { data: agent } = await svc
      .from("agents")
      .select("id, user_id, brokerage_id")
      .not("user_id", "is", null)
      .not("brokerage_id", "is", null)
      .eq("is_active", true)
      .limit(1)
      .single()
    if (!agent) { console.log("  ⏭  Skipped — need an active agent with user_id + brokerage_id."); return }
    const brokerageId = (agent as any).brokerage_id as string
    const agentId = (agent as any).id as string

    // ── (a) contact-exclusion: mirror route.ts Steps 2–4 EXACTLY ──────────────
    // A real contact's email must resolve at the CONTACT query and never even
    // reach the lead query (the route's own `if (!entityType && ...)` gate,
    // asserted by source above). An unmatched sender's email is the POSITIVE
    // CONTROL — it must fall through and BE found by the lead query, proving
    // the gate actually discriminates rather than always skipping.
    console.log("\n  ── (a) contact email excluded from the lead path; unknown sender enters it ──")
    const contactEmail = `${TAG}_contact@example.com`
    const leadEmail = `${TAG}_lead@example.com`

    const { data: contactRow, error: contactErr } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, agent_id: agentId,
      first_name: TAG, last_name: "ExistingContact",
      email: contactEmail, contact_type: "buyer",
    }).select("id").single()
    if (contactErr || !contactRow) { check("seed tagged contact", false, contactErr?.message); return }
    const contactId = (contactRow as any).id as string
    reg("contacts", "id", contactId)

    const { data: leadRow, error: leadErr } = await svc.from("leads").insert({
      brokerage_id: brokerageId, agent_id: agentId,
      first_name: TAG, last_name: "UnmatchedLead",
      email: leadEmail, lead_type: "buyer", motivation_type: "buyer",
      lifecycle_state: "isa_qualifying", is_active: true, ai_isa_owner: true,
    }).select("id").single()
    if (leadErr || !leadRow) { check("seed tagged lead", false, leadErr?.message); return }
    const leadId = (leadRow as any).id as string
    reg("leads", "id", leadId)
    reg("assignment_log", "lead_id", leadId)
    reg("activities", "entity_id", leadId)
    reg("lifecycle_events", "entity_id", leadId)

    // Step 3 shape, reproduced exactly (see the SOURCE assertion above pinning
    // this literal query in route.ts): match a CONTACT by email first.
    const { data: contactMatchForContactEmail } = await svc
      .from("contacts").select("id").eq("brokerage_id", brokerageId).eq("email", contactEmail).maybeSingle()
    check("(a) the existing contact's email resolves at the CONTACT query", (contactMatchForContactEmail as any)?.id === contactId)
    // Because a contact matched, route.ts's `if (!entityType && ...)` gate means
    // the lead query never even runs for this sender — proven by source above.

    const { data: contactMatchForLeadEmail } = await svc
      .from("contacts").select("id").eq("brokerage_id", brokerageId).eq("email", leadEmail).maybeSingle()
    check("(a) POSITIVE CONTROL: the unmatched (lead-only) email does NOT resolve at the CONTACT query", !contactMatchForLeadEmail)
    const { data: leadMatchForLeadEmail } = await svc
      .from("leads").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).eq("email", leadEmail).maybeSingle()
    check("(a) POSITIVE CONTROL: the unmatched sender's email DOES resolve at the LEAD query (the fallback the gate exists for)", (leadMatchForLeadEmail as any)?.id === leadId)

    // ── (b) positive intent → conversion + assignment call ────────────────────
    console.log("\n  ── (b) lead email, clear positive intent → conversion + assignment ──")
    const positiveMessage = "Looking for a 3bd under $500k — can you help?"
    const positiveClassified = keywordIntentFallback(positiveMessage, null)
    check("(b) keyword classifier reads clear positive intent (buyer/criteria_request) — the SAME vocabulary classifyAndRouteInbound uses, not a second one",
      positiveClassified?.side === "buyer" && positiveClassified?.reason === "criteria_request", JSON.stringify(positiveClassified))

    const fixed = (intent: ClassifiedIntent | null): InboundClassifier => () => intent
    const routedPositive = await classifyAndRouteInbound(
      { leadId, brokerageId, message: positiveMessage },
      { classifier: fixed(positiveClassified) },
    )
    check("(b) outcome CONVERTED", routedPositive.outcome === "converted", JSON.stringify(routedPositive))
    if (routedPositive.contactId) reg("contacts", "id", routedPositive.contactId)
    reg("activities", "contact_id", routedPositive.contactId ?? leadId)
    reg("lifecycle_events", "entity_id", routedPositive.contactId ?? leadId)

    const { data: leadAfterConvert } = await svc
      .from("leads").select("is_active, ai_isa_owner, contact_id").eq("id", leadId).maybeSingle()
    check("(b) the lead is marked CONVERTED — is_active=false, ai_isa_owner=false (no further lead-stage ISA sends)",
      (leadAfterConvert as any)?.is_active === false && (leadAfterConvert as any)?.ai_isa_owner === false,
      JSON.stringify(leadAfterConvert))
    check("(b) the lead carries the contact link (all lead info carried to the contact via the canonical survivor)",
      !!(leadAfterConvert as any)?.contact_id && (leadAfterConvert as any)?.contact_id === routedPositive.contactId)

    const { count: assignCount } = await svc.from("assignment_log").select("id", { count: "exact", head: true }).eq("lead_id", leadId)
    check("(b) the ASSIGNMENT call fired — assignment_log carries a row for this lead (brokerage/team-lead assignment_rules ran)",
      (assignCount ?? 0) >= 1, `assignment_log rows=${assignCount}`)

    // ── (c) no clear intent → ISA reply only, no conversion ───────────────────
    console.log("\n  ── (c) lead email, no clear intent → nurtured (ISA reply only, no conversion) ──")
    const { data: leadRow2, error: lead2Err } = await svc.from("leads").insert({
      brokerage_id: brokerageId, agent_id: agentId,
      first_name: TAG, last_name: "AmbiguousLead",
      email: `${TAG}_lead2@example.com`, lead_type: "buyer", motivation_type: "buyer",
      lifecycle_state: "isa_qualifying", is_active: true, ai_isa_owner: true,
    }).select("id").single()
    if (lead2Err || !leadRow2) { check("seed second tagged lead", false, lead2Err?.message); return }
    const leadId2 = (leadRow2 as any).id as string
    reg("leads", "id", leadId2)
    reg("activities", "entity_id", leadId2)
    reg("activities", "contact_id", leadId2)
    reg("lifecycle_events", "entity_id", leadId2)

    const ambiguousMessage = "thanks for reaching out, have a good day"
    const ambiguousClassified = keywordIntentFallback(ambiguousMessage, null)
    check("(c) keyword classifier reads NO clear intent (ambiguous) for the courtesy reply", ambiguousClassified === null)

    const routedAmbiguous = await classifyAndRouteInbound(
      { leadId: leadId2, brokerageId, message: ambiguousMessage },
      { classifier: fixed(ambiguousClassified) },
    )
    check("(c) outcome NURTURED, not converted (the ISA-reply-only path — processInboundEmail falls through to generateText, proven by source above)",
      routedAmbiguous.outcome === "nurtured" && routedAmbiguous.reason === "none", JSON.stringify(routedAmbiguous))

    const { data: leadAfterNurture } = await svc.from("leads").select("is_active, contact_id").eq("id", leadId2).maybeSingle()
    check("(c) the lead is STILL a lead — no conversion, no contact minted for a no-intent reply",
      (leadAfterNurture as any)?.is_active === true && !(leadAfterNurture as any)?.contact_id, JSON.stringify(leadAfterNurture))

    const { count: nurtureCount } = await svc.from("activities").select("id", { count: "exact", head: true })
      .eq("entity_id", leadId2).eq("activity_type", "ai_isa_inbound_nurture")
    check("(c) a nurture breadcrumb was recorded (sentinelWrite, not a swallowed refusal)", (nurtureCount ?? 0) === 1, `nurture rows=${nurtureCount}`)
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      const { table, column, value } = cleanup[i]
      if (!value) continue
      try { await svc.from(table).delete().eq(column, value) } catch { /* noop */ }
    }
    let remaining = 0
    for (const { table, column, value } of cleanup) {
      if (!value) continue
      const { count } = await svc.from(table).select("id", { count: "exact", head: true }).eq(column, value)
      remaining += count ?? 0
    }
    check("cleanup verified — 0 seeded rows remain", remaining === 0, `remaining=${remaining}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. HUBSPOT — inbound pull ABSENT, outbound sync PRESENT (wave 72A, tied into
//    this proof per the task: "hubspot is only sync out to hubspot.")
// ─────────────────────────────────────────────────────────────────────────────
function testHubSpotSyncOutOnly() {
  console.log("\n[3 · HubSpot — inbound pull absent, outbound sync present]")

  const importPull = stripped("lib/crm/import-pull.ts")
  check('lib/crm/import-pull.ts: NO "hubspot" reference in stripped source (pull retired — tombstone only, in a comment)',
    !/hubspot/i.test(importPull))
  check("lib/crm/import-pull.ts: three providers remain (followupboss, lofty, gohighlevel)",
    /export const CRM_IMPORT_PROVIDERS: CrmImportProvider\[\] = \["followupboss", "lofty", "gohighlevel"\]/.test(importPull))

  const adapter = stripped("lib/providers/hubspot/client.ts")
  check("lib/providers/hubspot/client.ts: listContactsPage (the inbound page fetch) is GONE from stripped source",
    !/export async function listContactsPage/.test(adapter))
  check("lib/providers/hubspot/client.ts: the OUTBOUND functions still stand (upsertContactByEmail, createContact)",
    /export async function upsertContactByEmail/.test(adapter) && /export async function createContact/.test(adapter))

  const outbound = stripped("lib/crm/providers/hubspot.ts")
  check("lib/crm/providers/hubspot.ts (the survivor): still calls the outbound adapter functions",
    /upsertContactByEmail\(/.test(outbound) && /createContact\(/.test(outbound))

  const panel = stripped("app/dashboard/superadmin/brokerages/[id]/tenant-crm-pull-panel.tsx")
  check("the white-glove migration-import panel no longer lists HubSpot as a pull source",
    !/key: "hubspot"/.test(panel))

  // POSITIVE CONTROL (CLAUDE.md §2): the detector must still recognise the
  // defect it was written for — a live "hubspot" code reference in a fixture
  // reads as present; the same text inside a `//` comment strips to absent.
  const liveFixture = 'export async function pullHubSpot() { return listContactsPage("t", {}) }\n'
  const commentFixture = '// TOMBSTONE: hubspot inbound pull retired, see lib/crm/providers/hubspot.ts:25\nexport const DONE = true\n'
  check('positive control: a live "hubspot"/"listContactsPage" code line is still detected after stripping',
    /hubspot/i.test(blankComments(liveFixture)) || /listContactsPage/.test(blankComments(liveFixture)))
  check('tombstone lesson: the SAME words inside a // COMMENT strip to absent (not a call site)',
    !/listContactsPage/.test(blankComments(commentFixture)))
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lead-email conversion simulator")
  console.log("══════════════════════════════════════════════════")
  testSourceWiring()
  await testLive()
  testHubSpotSyncOutOnly()

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" FAILURES:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(
    " LEAD_EMAIL_CONVERSION_PASS — an inbound email from an already-a-contact sender never " +
    "reaches the lead path; an inbound email from a LEAD with positive intent converts + assigns " +
    "through the canonical lane and stops further lead-stage ISA sends; a lead email with no clear " +
    "intent gets the ISA reply only, no conversion; the HubSpot inbound pull stays retired.",
  )
}
main().catch((e) => { console.error(e); process.exit(1) })
