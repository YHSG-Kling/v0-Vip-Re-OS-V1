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
import { SOURCE_MAP, SOURCE_VENDOR, ALL_SOURCE_KEYS } from "../lib/lead-pipeline/source-intent-map"
// Lane 73A — pure, no-network exports only (preFilterAutomatedSender / extractInboundHeaderText
// do no I/O and no model call; classifyUnknownSenderIntent/identifyAndRouteUnknownSender are
// deliberately NEVER imported here — this file makes no network calls, per the lane's own rule).
// unknown-sender-identification.ts imports "server-only" itself, same as inbound-intent-
// classifier.ts above — loaded via a runtime `await import(...)` (below, after the shim has
// already run), never a static import, for the SAME reason the type-only import above exists.

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

// ─────────────────────────────────────────────────────────────────────────────
// 4. UNKNOWN SENDER IDENTIFICATION (lane 73A/74A, wave 73/74 owner rulings) —
//    SOURCE + PURE-function proofs only. No network calls: the AI classifier
//    itself (classifyUnknownSenderIntent) is never invoked here — that would be
//    a real model call — its fail-closed CONTRACT is proven by SOURCE below.
//    LIVE routing proofs (mailbox-owner branch, lead vs contact, dedup,
//    transactional listing match) are section 5, using the classifier
//    INJECTION seam (opts.classifier) so the routing decision is exercised
//    end-to-end with zero network calls.
// ─────────────────────────────────────────────────────────────────────────────
async function testUnknownSenderIdentification() {
  console.log("\n[4 · Unknown inbound sender identification — wave 73/74]")

  const { preFilterAutomatedSender, extractInboundHeaderText } =
    await import("../lib/lead-pipeline/unknown-sender-identification")

  const route = stripped("app/api/providers/inbound/route.ts")
  const mailRoute = stripped("app/api/webhooks/inbound-mail/route.ts")

  // ── (a) structural: the unknown-sender door can ONLY run after Steps 3+4
  // both failed to match — a contact OR an active lead sender never reaches it.
  const step5Idx = route.indexOf('if (!entityType || !entityId) {')
  const step5dIdx = route.indexOf("identifyAndRouteUnknownSender")
  check("route.ts: the unknown-sender identification call is INSIDE the '!entityType || !entityId' block (never reached once Step 3/4 matched)",
    step5Idx > -1 && step5dIdx > step5Idx)
  check("route.ts: the unknown-sender door is gated on providerType !== 'twilio' && fromEmail (SMS/WhatsApp routes through the separate, existing hand-raise capture, never this door)",
    /providerType !== "twilio" && inbound\.fromEmail/.test(route))
  check("route.ts: a lead is only minted on outcome 'lead_created' — 'dropped'/'held' leave entityType untouched (falls through to { linked: false }, same as before)",
    /identified\.outcome === "lead_created" && identified\.leadId/.test(route))
  check("route.ts: a CONTACT is also minted on outcome 'contact_created' (wave 74 — agent/team-lead mailbox case)",
    /identified\.outcome === "contact_created" && identified\.contactId/.test(route))
  check("route.ts: resolveInboundMailboxOwner is called with doorKind 'shared_brokerage_webhook' (this door has no per-agent recipient identity)",
    /doorKind: "shared_brokerage_webhook"/.test(route))
  // RAW source, not stripped — this checks that the ruling PROSE exists in the header comment,
  // the inverse of the tombstone-vs-call-site lesson (CLAUDE.md §2): here the comment IS what's
  // being asserted, so stripping it away would make the check pass or fail for the wrong reason.
  check("route.ts: the wave-74 ruling is recorded in the file header (CLAUDE.md-style — the rule travels with the code)",
    /process incorrect\. if this email is coming into a tenant or user account/.test(src("app/api/providers/inbound/route.ts")))
  check("app/api/webhooks/inbound-mail/route.ts: references unknown-sender-identification (wave 74 — the OTHER door now runs identification too)",
    /unknown-sender-identification/.test(mailRoute))
  check("app/api/webhooks/inbound-mail/route.ts: resolves mailbox owner via doorKind 'resolved_credential' (per-user aware — can resolve agent/team_lead, unlike the shared webhook)",
    /doorKind: "resolved_credential"/.test(mailRoute))
  check("app/api/webhooks/inbound-mail/route.ts: the wave-74 ruling is recorded in the file header",
    /a tenant or user account, that email needs to be processed to their crm/.test(src("app/api/webhooks/inbound-mail/route.ts")))

  const mod = stripped("lib/lead-pipeline/unknown-sender-identification.ts")

  check("unknown-sender-identification.ts: resolveInboundMailboxOwner is exported (the ONE mailbox-owner resolver both routes call)",
    /export async function resolveInboundMailboxOwner/.test(mod))

  // ── (b) the prefilter runs BEFORE the model call — bounce/noreply/vendor/own-domain mail
  // never reaches the classifier, so it never spends a token.
  const orchestratorStart = mod.indexOf("export async function identifyAndRouteUnknownSender")
  // Search FROM the orchestrator's own start — preFilterAutomatedSender/classifyUnknownSenderIntent
  // are also DEFINED earlier in the file (sections 1/2), so an unanchored indexOf would find the
  // function declarations, not the CALL SITES inside the orchestrator this check cares about.
  const prefilterCallIdx = orchestratorStart > -1 ? mod.indexOf("preFilterAutomatedSender(", orchestratorStart) : -1
  // Classifier is resolved through the injectable seam (opts.classifier ?? the real one) —
  // never a bare call to the real function's name (that would bypass the test seam).
  const classifyAssignIdx = orchestratorStart > -1 ? mod.indexOf("opts?.classifier ?? classifyUnknownSenderIntent", orchestratorStart) : -1
  check("unknown-sender-identification.ts: identifyAndRouteUnknownSender calls the PRE-FILTER before resolving the AI classifier (bounce/noreply/vendor mail never reaches the model)",
    orchestratorStart > -1 && prefilterCallIdx > orchestratorStart && classifyAssignIdx > prefilterCallIdx)
  check("unknown-sender-identification.ts: an automated prefilter verdict returns BEFORE the classifier is ever resolved/called (no model spend)",
    mod.indexOf("if (pre.isAutomated)", orchestratorStart) > -1 && mod.indexOf("if (pre.isAutomated)", orchestratorStart) < classifyAssignIdx)

  // ── (c) FAIL CLOSED — a classifier that cannot run creates NO row, NO lead, NO contact.
  const heldReturnIdx = mod.indexOf('return { outcome: "held", reason: "classifier_unavailable" }')
  const brokerageCreateIdx = mod.indexOf("createLeadDirectlyForBrokerage(brokerageId,", orchestratorStart)
  const contactCreateIdx = mod.indexOf("createContactForAgentMailbox(", orchestratorStart)
  check("unknown-sender-identification.ts: classifier-unavailable returns 'held' BEFORE either creation call ever runs (no lead, no contact, no row)",
    heldReturnIdx > -1 && brokerageCreateIdx > -1 && contactCreateIdx > -1 &&
    heldReturnIdx < brokerageCreateIdx && heldReturnIdx < contactCreateIdx)
  check("unknown-sender-identification.ts: the held path is a COUNTED drop (lifecycle_events), never a silent no-op",
    /recordDrop\(svc, brokerageId, "classifier_unavailable"/.test(mod))

  // ── (d) spam is dropped; no-intent-and-non-transactional is dropped — neither ever
  // reaches a creation call.
  const spamCheckIdx = mod.indexOf("if (c.isSpamOrVendor) {", orchestratorStart)
  const noQualifyCheckIdx = mod.indexOf("if (!c.hasRealEstateIntent && !isTransactional)", orchestratorStart)
  check("unknown-sender-identification.ts: spam is checked BEFORE either creation call (never promoted)",
    spamCheckIdx > -1 && spamCheckIdx < brokerageCreateIdx && spamCheckIdx < contactCreateIdx)
  check("unknown-sender-identification.ts: no-real-estate-intent AND non-transactional is checked BEFORE either creation call (transactional alone still qualifies)",
    noQualifyCheckIdx > -1 && noQualifyCheckIdx < brokerageCreateIdx && noQualifyCheckIdx < contactCreateIdx)

  // ── (e) WAVE 74 TOMBSTONE — the raw-lead pipeline is REMOVED for this source; a
  // BROKERAGE mailbox creates a lead DIRECTLY, an AGENT/TEAM-LEAD mailbox creates a
  // CONTACT directly, and the route's EXISTING Step 8b still hands a fresh lead's
  // ORIGINAL email to the ISA (never a second invocation).
  check("unknown-sender-identification.ts: NO LONGER imports/calls ingestRawSourceBatch — the raw-lead path is REMOVED for this source (wave 74 tombstone)",
    !/ingestRawSourceBatch/.test(mod))
  check("unknown-sender-identification.ts: NO LONGER imports/calls processRawRecord — never the raw scraped-lead pipeline any more",
    !/processRawRecord/.test(mod))
  check("unknown-sender-identification.ts: a BROKERAGE mailbox creates a lead via the GOVERNED direct insert (createLeadOnlyRecordForAcquisitionSource), never raw_scraped_leads",
    /createLeadOnlyRecordForAcquisitionSource/.test(mod))
  check("unknown-sender-identification.ts: an AGENT/TEAM-LEAD mailbox creates a contact via captureContact — the ONE contact-intake door, never a second one",
    /captureContact/.test(mod))
  check("unknown-sender-identification.ts: dedup (findExistingLeadOrContact) runs BEFORE either creation call — an email already on file never mints a second row",
    mod.indexOf("findExistingLeadOrContact(svc, brokerageId, params.fromEmail)") > -1 &&
    mod.indexOf("findExistingLeadOrContact(svc, brokerageId, params.fromEmail)") < brokerageCreateIdx)
  check("unknown-sender-identification.ts: never calls processInboundEmail itself — Step 8b in route.ts is the ONE ISA-handoff call site (no second invocation)",
    !/processInboundEmail/.test(mod))
  check("route.ts Step 8b still calls processInboundEmail for ANY entityType==='lead' with an email — including a lead THIS module just created (same code path, no special-casing)",
    /if \(entityType === "lead" && entityId && inbound\.fromEmail\)/.test(route))

  // POSITIVE CONTROL (CLAUDE.md §2): a "no ingestRawSourceBatch reference" scanner that
  // simply cannot see code would also report zero — prove the same detector still flags
  // a live import of the retired name.
  const liveRawFixture = 'import { ingestRawSourceBatch } from "@/lib/kernel/scraping"\n'
  check("positive control: a live ingestRawSourceBatch import IS detected by this same regex after stripping",
    /ingestRawSourceBatch/.test(blankComments(liveRawFixture)))

  // ── (f) AI ledger — booked under manager 'ai_isa', the cheapest routed model lane.
  check("unknown-sender-identification.ts: books the classifier call to ai_tool_usage under manager 'ai_isa' (never unassigned)",
    /manager: "ai_isa"/.test(mod))
  check("unknown-sender-identification.ts: uses gpt-4o-mini — AI_TASK_ROUTING's own documented \"Cheapest option\" lane, not an arbitrary model",
    /gpt-4o-mini/.test(mod))
  check("unknown-sender-identification.ts: calls guardedGenerateText (the Data Guard chokepoint), never the raw SDK generateText",
    /guardedGenerateText\(/.test(mod) && !/\bimport\s*\{\s*generateText\s*\}\s*from\s*"ai"/.test(mod))

  // ── (g) SourceKey registered — one vocabulary, no second definition.
  check("source-intent-map.ts: SourceKey 'inbound_email_unknown' has a SOURCE_MAP entry",
    "inbound_email_unknown" in SOURCE_MAP)
  check("source-intent-map.ts: SOURCE_VENDOR marks it 'internal' ($0 vendor cost — the tenant's own mailbox, not a vendor scrape)",
    SOURCE_VENDOR.inbound_email_unknown === "internal")
  check("source-intent-map.ts: ALL_SOURCE_KEYS derives it (no hand-copied second list, CLAUDE.md §6)",
    ALL_SOURCE_KEYS.includes("inbound_email_unknown"))

  // ── (h) PURE prefilter — bounce/noreply/vendor/own-domain/list-unsubscribe, zero I/O.
  console.log("\n  ── pure prefilter (no network, no model) ──")
  check("bounce/mailer-daemon local part is automated",
    preFilterAutomatedSender({ fromEmail: "mailer-daemon@some-mta.example.com" }).isAutomated === true)
  check("noreply@ local part is automated",
    preFilterAutomatedSender({ fromEmail: "noreply@somesender.com" }).isAutomated === true)
  check("a known ESP/newsletter domain is automated",
    preFilterAutomatedSender({ fromEmail: "campaign@mailchimpapp.net" }).isAutomated === true &&
    preFilterAutomatedSender({ fromEmail: "campaign@mailchimpapp.net" }).reason === "known_vendor_or_newsletter_domain")
  check("our OWN sending domain replying to itself is a mail loop, not a customer",
    preFilterAutomatedSender({ fromEmail: "anything@vip-re.com" }).isAutomated === true &&
    preFilterAutomatedSender({ fromEmail: "anything@vip-re.com" }).reason === "own_domain_loop")
  check("a List-Unsubscribe header marks the sender automated even with an ordinary-looking address",
    preFilterAutomatedSender({
      fromEmail: "campaigns@some-random-esp-domain.io",
      raw: { headers: "From: campaigns@some-random-esp-domain.io\nList-Unsubscribe: <mailto:unsub@x.io>\n" },
    }).isAutomated === true)
  check("invalid email syntax is automated (never reaches the classifier)",
    preFilterAutomatedSender({ fromEmail: "not-an-email" }).isAutomated === true)
  // POSITIVE CONTROL (CLAUDE.md §2): the prefilter must still recognise the ORDINARY, real
  // human sender it exists to let through — a broken always-true prefilter would report the
  // same "automated" verdict for everything and this suite would never catch it.
  check("POSITIVE CONTROL: an ordinary human sender at a real, non-listed domain is NOT automated",
    preFilterAutomatedSender({ fromEmail: "jane.doe@gmail.com" }).isAutomated === false)

  console.log("\n  ── header-text extraction (provider-shape-agnostic) ──")
  check("extractInboundHeaderText reads SendGrid's flat 'headers' string field",
    extractInboundHeaderText({ headers: "List-Unsubscribe: <mailto:x@y.com>" }).includes("List-Unsubscribe"))
  check("extractInboundHeaderText reads Postmark's 'Headers' array of {Name,Value}",
    extractInboundHeaderText({ Headers: [{ Name: "List-Unsubscribe", Value: "<mailto:x@y.com>" }] }).includes("List-Unsubscribe"))
  check("extractInboundHeaderText never throws on a shape with no header field, and never fabricates a List-Unsubscribe marker",
    !extractInboundHeaderText({ from: "a@b.com" }).includes("List-Unsubscribe"))
  check("extractInboundHeaderText never throws on null/undefined raw",
    extractInboundHeaderText(null) === "" && extractInboundHeaderText(undefined) === "")
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. UNKNOWN SENDER ROUTING — LIVE (lane 74A, wave 74 mailbox-owner correction).
//    Exercises the FULL routing decision (mailbox-owner resolution, dedup,
//    lead-vs-contact branch, transactional listing match) via the classifier
//    INJECTION seam (opts.classifier) — ZERO network calls, never a real model
//    call, the same "no network" contract section 2 already keeps. Tagged rows,
//    deleted in the same run (CLAUDE.md wave-56 rule).
// ─────────────────────────────────────────────────────────────────────────────
async function testUnknownSenderRouting() {
  console.log("\n[5 · Unknown sender ROUTING — wave 74 mailbox-owner correction]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { identifyAndRouteUnknownSender, resolveInboundMailboxOwner } =
    await import("../lib/lead-pipeline/unknown-sender-identification")
  const svc = createServiceClient()

  const TAG = `__unkrouting_${Date.now()}__`
  const cleanup: Array<{ table: string; column: string; value: string }> = []
  function reg(table: string, column: string, value: string) { cleanup.push({ table, column, value }) }

  type FixedFields = {
    isSpamOrVendor?: boolean
    hasRealEstateIntent?: boolean
    intentType?: string
    isTransactional?: boolean
    transactionalType?: string
    extractedName?: string | null
    extractedPhone?: string | null
    extractedAddress?: string | null
    confidence?: number
  }
  const fixedClassifier = (f: FixedFields) => async () => ({
    available: true,
    classification: {
      isSpamOrVendor: false, hasRealEstateIntent: false, intentType: "unknown",
      isTransactional: false, transactionalType: "none",
      extractedName: null, extractedPhone: null, extractedAddress: null, confidence: 0.5,
      ...f,
    } as any,
  })
  const heldClassifier = async () => ({ available: false, classification: null, unavailableReason: "model_error" as const })

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
    const agentUserId = (agent as any).user_id as string

    // ── (a) mailbox-owner resolution — the SHARED webhook always resolves
    // 'brokerage'; a per-user credential scoped to this agent resolves 'agent'
    // with the LIVE agents.id, from the route's own verified binding, never body.
    console.log("\n  ── (a) mailbox-owner resolution ──")
    const brokerageOwner = await resolveInboundMailboxOwner(svc, { doorKind: "shared_brokerage_webhook", brokerageId })
    check("(a) shared brokerage webhook resolves ownerKind='brokerage'",
      brokerageOwner.ownerKind === "brokerage" && brokerageOwner.brokerageId === brokerageId && brokerageOwner.agentId === null)

    const agentCredential = {
      platform: "gmail" as const, scope: "agent" as const, credential_id: "sim",
      brokerage_id: brokerageId, agent_user_id: agentUserId,
      access_token: null, refresh_token: null, account_id: null, config: {},
    }
    const agentOwner = await resolveInboundMailboxOwner(svc, { doorKind: "resolved_credential", credential: agentCredential })
    check("(a) an agent-scoped credential resolves ownerKind='agent' with the LIVE agents.id",
      agentOwner.ownerKind === "agent" && agentOwner.agentId === agentId && agentOwner.userId === agentUserId)

    // ── (b) BROKERAGE mailbox + intent → LEAD DIRECTLY (never raw_scraped_leads) ──
    console.log("\n  ── (b) brokerage mailbox + intent → lead, ISA-ready, unassigned ──")
    const leadEmail = `${TAG}_broker@example.com`
    const resultB = await identifyAndRouteUnknownSender(
      { mailboxOwner: brokerageOwner, fromEmail: leadEmail, subject: "Interested in buying",
        body: "Hi, I'm looking to buy a home in the next few months, can someone help?", messageId: null },
      { classifier: fixedClassifier({ hasRealEstateIntent: true, intentType: "buyer", extractedName: "Pat Buyer", confidence: 0.9 }) },
    )
    check("(b) outcome lead_created", resultB.outcome === "lead_created" && !!resultB.leadId, JSON.stringify(resultB))
    if (resultB.leadId) { reg("leads", "id", resultB.leadId); reg("lifecycle_events", "entity_id", resultB.leadId) }
    const { data: leadRow } = await svc.from("leads").select("id, brokerage_id, agent_id, source").eq("id", resultB.leadId ?? "").maybeSingle()
    check("(b) the lead is brokerage-owned, source inbound_email_unknown, NEVER a scraped source",
      (leadRow as any)?.brokerage_id === brokerageId && (leadRow as any)?.source === "inbound_email_unknown")
    check("(b) the lead has NO agent_id (brokerage-owned, unassigned until assignment — CLAUDE.md §5)",
      !(leadRow as any)?.agent_id)

    // ── (c) AGENT mailbox + intent → CONTACT for that agent (never a raw lead) ──
    console.log("\n  ── (c) agent mailbox + intent → contact assigned to the agent ──")
    const agentSenderEmail = `${TAG}_agentmbx@example.com`
    const resultC = await identifyAndRouteUnknownSender(
      { mailboxOwner: agentOwner, fromEmail: agentSenderEmail, subject: "Relocating",
        body: "Hi, I'm relocating for work and need an agent to help me find a place.", messageId: null },
      { classifier: fixedClassifier({ hasRealEstateIntent: true, intentType: "relocation", extractedName: "Sam Relocator", confidence: 0.9 }) },
    )
    check("(c) outcome contact_created", resultC.outcome === "contact_created" && !!resultC.contactId, JSON.stringify(resultC))
    if (resultC.contactId) { reg("contacts", "id", resultC.contactId); reg("lifecycle_events", "entity_id", resultC.contactId) }
    const { data: contactRow } = await svc.from("contacts").select("id, brokerage_id, agent_id, source, contact_persona").eq("id", resultC.contactId ?? "").maybeSingle()
    check("(c) the contact is assigned to THAT agent's own agents.id (never brokerage-wide, never unassigned)",
      (contactRow as any)?.agent_id === agentId)
    check("(c) the contact source is inbound_email_unknown — NEVER a raw lead for an agent mailbox",
      (contactRow as any)?.source === "inbound_email_unknown")
    check("(c) contact_persona filled from a confident 'relocation' classification → 'relocated' (CampaignPersona vocabulary)",
      (contactRow as any)?.contact_persona === "relocated")

    // ── (d) TRANSACTIONAL — an offer email that matches an in-house listing address,
    // with NO buyer/seller intent language at all — qualifies through the DETERMINISTIC
    // address-match arm alone (matchEmailToOwnListing), never the classifier's own intent read.
    console.log("\n  ── (d) transactional offer on an in-house listing address → routed WITHOUT intent words ──")
    const { data: listing } = await svc
      .from("listings").select("id, address, brokerage_id")
      .eq("brokerage_id", brokerageId).not("address", "is", null).is("deleted_at", null).limit(1).maybeSingle()
    if (!listing) {
      console.log("  ⏭  (d) skipped — this brokerage has no live listing with an address to match against.")
    } else {
      const listingAddr = (listing as any).address as string
      const offerEmail = `${TAG}_offer@example.com`
      const resultD = await identifyAndRouteUnknownSender(
        { mailboxOwner: brokerageOwner, fromEmail: offerEmail, subject: "Offer attached",
          body: `Please see the attached offer for ${listingAddr}.`, messageId: null },
        // hasRealEstateIntent=false AND isTransactional=false from the classifier itself —
        // ONLY the deterministic listing-address match can qualify this sender.
        { classifier: fixedClassifier({ hasRealEstateIntent: false, isTransactional: false, extractedAddress: listingAddr, confidence: 0.5 }) },
      )
      check("(d) outcome lead_created with NO intent language — the address match alone qualified it",
        resultD.outcome === "lead_created", JSON.stringify(resultD))
      check("(d) the routing reason names it transactional (not a fabricated 'intent:')",
        resultD.reason.startsWith("transactional:"), resultD.reason)
      if (resultD.leadId) { reg("leads", "id", resultD.leadId); reg("lifecycle_events", "entity_id", resultD.leadId) }
    }

    // ── (e) spam → dropped, counted, no row ANYWHERE ──
    console.log("\n  ── (e) spam → dropped, counted, no row ──")
    const spamEmail = `${TAG}_spam@example.com`
    const resultE = await identifyAndRouteUnknownSender(
      { mailboxOwner: brokerageOwner, fromEmail: spamEmail, subject: "Grow your business",
        body: "Buy our SEO package today!", messageId: null },
      { classifier: fixedClassifier({ isSpamOrVendor: true, confidence: 0.9 }) },
    )
    check("(e) outcome dropped, reason classified_spam_or_vendor",
      resultE.outcome === "dropped" && resultE.reason === "classified_spam_or_vendor", JSON.stringify(resultE))
    const { data: leadForSpam } = await svc.from("leads").select("id").eq("brokerage_id", brokerageId).eq("email", spamEmail).maybeSingle()
    check("(e) NO lead row was created for the spam sender", !leadForSpam)
    const { count: dropCount } = await svc
      .from("lifecycle_events").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("event_type", "unknown_sender_dropped")
      .eq("metadata->>from_email", spamEmail)
    check("(e) the drop was COUNTED (lifecycle_events row exists for this sender) — never a silent no-op",
      (dropCount ?? 0) >= 1, `dropCount=${dropCount}`)

    // ── (f) classifier unavailable → HELD — fail closed, never a guess ──
    console.log("\n  ── (f) classifier unavailable → held, no row ──")
    const heldEmail = `${TAG}_held@example.com`
    const resultF = await identifyAndRouteUnknownSender(
      { mailboxOwner: brokerageOwner, fromEmail: heldEmail, subject: "hi", body: "hi", messageId: null },
      { classifier: heldClassifier },
    )
    check("(f) outcome held, reason classifier_unavailable",
      resultF.outcome === "held" && resultF.reason === "classifier_unavailable", JSON.stringify(resultF))
    const { data: leadForHeld } = await svc.from("leads").select("id").eq("brokerage_id", brokerageId).eq("email", heldEmail).maybeSingle()
    check("(f) NO lead row was created while held (fail closed, never guessed)", !leadForHeld)

    // ── (g) a sender who is ALREADY A CONTACT never re-enters (dedup FIRST) ──
    console.log("\n  ── (g) an email already belonging to a CONTACT never mints a second row ──")
    const alreadyEmail = `${TAG}_already@example.com`
    const { data: existingContact, error: ecErr } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, agent_id: agentId, first_name: TAG, last_name: "AlreadyContact",
      email: alreadyEmail, contact_type: "buyer",
    }).select("id").single()
    if (ecErr || !existingContact) {
      check("seed already-a-contact row", false, ecErr?.message)
    } else {
      reg("contacts", "id", (existingContact as any).id)
      const resultG = await identifyAndRouteUnknownSender(
        { mailboxOwner: brokerageOwner, fromEmail: alreadyEmail, subject: "hi again",
          body: "Following up on my home search.", messageId: null },
        { classifier: fixedClassifier({ hasRealEstateIntent: true, intentType: "buyer", confidence: 0.9 }) },
      )
      check("(g) outcome dropped — already_a_contact — never a second row for a sender who is already on file",
        resultG.outcome === "dropped" && resultG.reason === "already_a_contact", JSON.stringify(resultG))
    }
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
    check("(routing) cleanup verified — 0 seeded rows remain", remaining === 0, `remaining=${remaining}`)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lead-email conversion simulator")
  console.log("══════════════════════════════════════════════════")
  testSourceWiring()
  await testLive()
  testHubSpotSyncOutOnly()
  await testUnknownSenderIdentification()
  await testUnknownSenderRouting()

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
    "intent gets the ISA reply only, no conversion; the HubSpot inbound pull stays retired; an " +
    "UNKNOWN sender is identified before anything is created — bounce/noreply/vendor mail never " +
    "reaches the model. WAVE 74: a BROKERAGE mailbox creates a LEAD directly (never " +
    "raw_scraped_leads) and the SAME Step 8b hands it to the ISA; an AGENT/TEAM-LEAD mailbox " +
    "creates a CONTACT assigned to that person (never a raw lead); a transactional email " +
    "(offer/showing/inspection/escrow/contract) qualifies even with no intent words, via a " +
    "deterministic match against the brokerage's own listings; dedup runs first so an email " +
    "already on file never mints a second row; spam/non-qualifying is dropped and counted; a " +
    "classifier outage HOLDS (no lead, no contact, no row) rather than guessing; both inbound " +
    "doors call the SAME module.",
  )
}
main().catch((e) => { console.error(e); process.exit(1) })
