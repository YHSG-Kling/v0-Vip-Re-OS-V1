#!/usr/bin/env tsx
/**
 * scripts/cda-closing-flow-guard.ts   (npm run test:cda-closing-flow)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 142, lane 142C — CDA · PRELIMINARY HUD/CD · COMMISSIONS/PAYMENTS · LIFETIME · LEGAL DESCRIPTION.
 * Owner rulings (2026-10-18), proved as RULES (never waypoints — no migration is pinned by number, no
 * chain position is asserted, every absence has a POSITIVE CONTROL and every code-token scan reads
 * STRIPPED source, CLAUDE.md §2):
 *   A. CDA ON/OFF — the brokerage setting is the ONE switch (resolveCdaMode); disabled → no mandatory
 *      CDA, NOTHING blocks closing, the no-CDA payout default applies; both readers that used to default
 *      the undeclared setting two different ways now read the one rule.
 *   B. MANUAL FILL — the agent fills the CDA; no model call lives in the CDA fill / form / portal code
 *      (a specimen AI fill IS caught by the same scan).
 *   C. PRELIMINARY STATEMENT — versions retained, deterministic comparison (never a fabricated $0),
 *      correction request → approval BLOCKED → revised statement re-opens the review → reviewed;
 *      title's upload bridged to the CDA chain; the broker's approval asks the figure gate.
 *   D. DEADLINE — tenant zone from the brokerage's state, date-only closing = the closing morning,
 *      earlier requirements win, 48h/24h reminders then escalation; swept by the reaper net.
 *   E. DELIVERY — portal inbox when title is on the deal team, else the verified email; never a
 *      duplicate on retry; 'portal' admitted by the sent_to_title_method CHECK.
 *   F. PAYMENT STATES — the owner's seven states DERIVED (one order), the status vocabulary unforked,
 *      the three stamps written by gated kernel writers (attestation = the agent; QuickBooks match only
 *      against a confirmed sync), LLMs never compute compensation.
 *   G. LIFETIME — verdict (CLOSED / PAYOUT PENDING), ONE idempotent writer shared by close + payout
 *      (promote twice → one schedule), tenant-pinned and counted; no inline conversion remains.
 *   H. LEGAL DESCRIPTION — shape rule (never a street address), sources = the LATEST migration's CHECK,
 *      research accepted only cited + shaped + not-low + verified by a human.
 *   I. REGISTRATION.
 *
 * MAINTENANCE: domain `cda_closing_flow` (lib/kernel/manager-registry.ts) — deal_coordinator; coOwners
 * finance_manager (the money states, the waterfall) and compliance_officer (the manual-fill rule, the
 * never-fabricated figures, the legal description).
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  CDA_FILL_RULE, resolveCdaMode,
  PRELIMINARY_STATEMENT_DOC_TYPES, nextPreliminaryStatementVersion, comparePreliminaryStatementFigures, describePreliminaryDiscrepancies,
  reviewOnNewStatementVersion, reviewOnCorrectionRequested, reviewOnConfirmed, cdaFigureGate, preliminaryReviewOf,
  resolveTenantTimeZone, resolveClosingDeadline, cdaDeadlineVerdict, CDA_DEADLINE_NOTIFICATION, CDA_DEADLINE_REMINDER_HOURS, CDA_DEADLINE_ESCALATE_HOURS,
  cdaDeliveryRoute, deliveryIdempotency,
} from "../lib/transactions/cda-closing-policy"
import { COMMISSION_LEDGER_STATUSES, COMMISSION_PAYMENT_STATES, COMMISSION_PAYMENT_STATE_LABELS, deriveCommissionPaymentState } from "../lib/commission/ledger-sync"
import { lifetimeConversionVerdict, readLifetimeConversionPolicy, promoteDealContactsToLifetime, LIFETIME_HOLD_LABEL } from "../lib/kernel/lifetime-conversion"
import { LEGAL_DESCRIPTION_SOURCES } from "../lib/forms/legal-description"
import { looksLikeLegalDescription } from "../lib/intelligence/offer-property-prefill"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(read(p))
const bare = (p: string) => blankStrings(stripComments(read(p)))
/** The migrations that define a CHECK on `column`, oldest → newest; the LAST is the vocabulary in force. */
function migrationsDefining(column: string): string[] {
  const dir = join(ROOT, "supabase/migrations")
  return readdirSync(dir)
    .filter((f) => /^m\d+-.*\.sql$/.test(f) && new RegExp(`${column} IN \\(`).test(readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => Number(a.match(/^m(\d+)/)![1]) - Number(b.match(/^m(\d+)/)![1]))
}
const checkValuesOf = (sql: string, column: string) =>
  [...sql.matchAll(new RegExp(`${column} IN \\(([^)]+)\\)`, "g"))].map((m) => m[1].split(",").map((s) => s.trim().replace(/'/g, "")).sort().join())
const STAMP = /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/
const MODEL_CALL = /generateText|generateObject|generateTextRouted|streamText|gatewayChat|anthropic|openai/i

async function main() {
  // ── A · CDA ON/OFF ─────────────────────────────────────────────────────────────────────────
  console.log("[A · the brokerage CDA setting is the one switch]")
  const on = resolveCdaMode({ offersCda: true })
  const off = resolveCdaMode({ offersCda: false, nonCdaPayoutDefault: "check" })
  const undeclared = resolveCdaMode({ offersCda: null })
  check("offers_cda TRUE → CDA mode, cdaRequired, no payout default", on.mode === "cda" && on.cdaRequired && on.payoutMethodDefault === null && on.reason === "offers_cda")
  check("offers_cda FALSE → no-CDA flow with the brokerage's payout default (check), reason no_cda_declared", off.mode === "no_cda" && !off.cdaRequired && off.payoutMethodDefault === "check" && off.reason === "no_cda_declared")
  check("undeclared (NULL) → no-CDA flow, direct_deposit default, reason cda_not_declared — an unanswered setting never manufactures a mandatory CDA", undeclared.mode === "no_cda" && undeclared.payoutMethodDefault === "direct_deposit" && undeclared.reason === "cda_not_declared")
  check("NOTHING BLOCKS CLOSING in either branch (blocksClosing is false everywhere)", [on, off, undeclared].every((v) => v.blocksClosing === false))
  const cdaPage = code("app/dashboard/transactions/[id]/cda/page.tsx")
  const reconcile = code("lib/commission/reconcile-tracking.ts")
  const reaper = code("lib/transactions/cda-delivery-reaper.ts")
  const DEFAULTED = /offers_cda \?\? (true|false)/
  check("BOTH READERS ask the one rule: the CDA page and finalizeCommissionAtClose call resolveCdaMode; neither defaults offers_cda by hand", /resolveCdaMode\(/.test(cdaPage) && /resolveCdaMode\(/.test(reconcile) && !DEFAULTED.test(cdaPage) && !DEFAULTED.test(reconcile))
  check("POSITIVE CONTROL: the hand-default scan recognises the HEAD defect it was written for", DEFAULTED.test("offersCda={(brokerage as { offers_cda?: boolean | null } | null)?.offers_cda ?? true}") && DEFAULTED.test("const offersCda = brk?.offers_cda ?? false"))
  check("the deadline reaper reads the mode and does nothing for a no-CDA brokerage (notApplicable)", /resolveCdaMode\(/.test(reaper) && /notApplicable = true/.test(reaper))

  // ── B · MANUAL FILL ────────────────────────────────────────────────────────────────────────
  console.log("\n[B · the agent fills the CDA; AI never does]")
  check("THE FILL RULE as data: agentFills, never aiFills, AI may explain figures", CDA_FILL_RULE.agentFills === true && CDA_FILL_RULE.aiFills === false && CDA_FILL_RULE.aiMayExplainFigures === true)
  const cdaFillFiles = ["app/actions/cda-portal.ts", "lib/transactions/cda-template-fields.ts", "app/dashboard/transactions/[id]/cda/cda-workflow-client.tsx", "lib/transactions/cda-closing-policy.ts"]
  const modelHits = cdaFillFiles.filter((f) => MODEL_CALL.test(bare(f)))
  check("no model call in the CDA fill / form / portal / policy code (stripped + strings blanked)", modelHits.length === 0, modelHits.join(", "))
  check("POSITIVE CONTROL: a specimen AI fill of the CDA form IS caught by the same scan", MODEL_CALL.test(blankStrings(stripComments(`const filled = await generateTextRouted({ brokerageId, prompt: "fill the CDA fields" })`))))

  // ── C · PRELIMINARY STATEMENT ──────────────────────────────────────────────────────────────
  console.log("\n[C · the title company's statement: versions, comparison, correction loop, the figure gate]")
  check("the two live doc_type spellings read as ONE family; the next version counts only statements", (PRELIMINARY_STATEMENT_DOC_TYPES as readonly string[]).length === 2 && nextPreliminaryStatementVersion([]) === 1 && nextPreliminaryStatementVersion([{ doc_type: "settlement_statement" }, { doc_type: "preliminary_closing_disclosure" }, { doc_type: "wire_instructions" }]) === 3)
  const cmp = comparePreliminaryStatementFigures({ sales_price: 400_000, gross_commission: 10_000, agent_net: 7_000 }, { sales_price: 400_000, gross_commission: 9_000, agent_net: null })
  check("IDENTIFY deterministically: a $1,000 / 11.1% gross difference is a BLOCKER, an equal sales price is not a discrepancy, a figure one side lacks is UNVERIFIABLE (never fabricated as $0)",
    cmp.discrepancies.length === 1 && cmp.discrepancies[0].field === "gross_commission" && cmp.discrepancies[0].severity === "blocker" && cmp.discrepancies[0].delta === 1000 && cmp.compared.includes("sales_price") && cmp.unverifiable.includes("agent_net") && !cmp.discrepancies.some((d) => d.field === "agent_net"), JSON.stringify(cmp))
  check("a $20 difference below the dollar floor is not a discrepancy", comparePreliminaryStatementFigures({ gross_commission: 9_020 }, { gross_commission: 9_000 }).discrepancies.length === 0)
  const lines = describePreliminaryDiscrepancies(cmp.discrepancies)
  check("EXPLAIN with the numbers only: the line names both figures and the delta, nothing else is invented", lines.length === 1 && /\$10,000/.test(lines[0]) && /\$9,000/.test(lines[0]) && /\+\$1,000/.test(lines[0]) && /must be corrected/.test(lines[0]))
  const v1 = reviewOnNewStatementVersion(null, { version: 1, documentId: "doc-1", at: "2026-06-01T00:00:00Z" })
  check("a statement arrives → pending_review v1, no history", v1.status === "pending_review" && v1.version === 1 && v1.history.length === 0 && cdaFigureGate(v1).ok)
  const requested = reviewOnCorrectionRequested(v1, { items: cmp.discrepancies, by: "u1", at: "2026-06-02T00:00:00Z", delivery: { route: "email", recipient: "t@title.test", message_id: "m1", at: "2026-06-02T00:00:00Z" } })
  check("correction requested → the FIGURE GATE blocks broker approval by name", requested.status === "correction_requested" && requested.items.length === 1 && !cdaFigureGate(requested).ok && cdaFigureGate(requested).error === "preliminary_statement_correction_pending")
  const v2 = reviewOnNewStatementVersion(requested, { version: 2, documentId: "doc-2", at: "2026-06-03T00:00:00Z" })
  check("the REVISED statement re-opens the review (v2 pending) and RETAINS v1's terminal state in history — a correction never stands against a replaced document", v2.status === "pending_review" && v2.version === 2 && v2.history.length === 1 && v2.history[0].version === 1 && v2.history[0].status === "correction_requested" && v2.history[0].document_id === "doc-1" && cdaFigureGate(v2).ok)
  const reviewed = reviewOnConfirmed(v2, "u2", "2026-06-04T00:00:00Z", "ok")
  check("reconciled → reviewed, gate open; the review object round-trips through field_values; garbage reads as no review", reviewed.status === "reviewed" && reviewed.reviewed_by === "u2" && cdaFigureGate(reviewed).ok && preliminaryReviewOf({ preliminary_statement: reviewed })?.history.length === 1 && preliminaryReviewOf({ preliminary_statement: { status: "nope" } }) === null && preliminaryReviewOf(null) === null)
  const portal = code("app/actions/cda-portal.ts")
  const titlePortal = code("app/actions/title-portal.ts")
  check("WIRED: approveCdaAction asks cdaFigureGate BEFORE the signature gate; the correction and confirm doors exist and are the client's", (() => { const a = portal.indexOf("export async function approveCdaAction"); const s = portal.slice(a, portal.indexOf("export async function", a + 10)); return /cdaFigureGate\(/.test(s) && s.indexOf("cdaFigureGate(") < s.lastIndexOf("signature_check_passed") })() && /export async function requestPreliminaryCdCorrectionAction/.test(portal) && /export async function confirmPreliminaryCdReviewAction/.test(portal) && /requestPreliminaryCdCorrectionAction\(/.test(code("app/dashboard/transactions/[id]/cda/cda-workflow-client.tsx")))
  check("the correction request never invents a value: it compares the reviewer's figures (comparePreliminaryStatementFigures) and refuses when nothing is documented", /comparePreliminaryStatementFigures\(/.test(portal) && /no_discrepancy_documented/.test(portal))
  check("TITLE'S UPLOAD IS BRIDGED: uploadTitleDocument hands a settlement_statement to notifyAgentOfPreliminaryCdAction and a final_closing_disclosure to the final attach, READING the result and escalating a refusal", /notifyAgentOfPreliminaryCdAction\(\{ transactionId: data\.transactionId, documentId: document\.id \}\)/.test(titlePortal) && /attachFinalStatementFromTitle\(/.test(titlePortal) && /title_statement_unattached/.test(titlePortal))
  check("the statement upload records the VERSION on the CDA (reviewOnNewStatementVersion) and the title portal lists the delivered 'cda' document", /reviewOnNewStatementVersion\(/.test(portal) && /nextPreliminaryStatementVersion\(/.test(portal) && /"cda",/.test(titlePortal))

  // ── D · DEADLINE ───────────────────────────────────────────────────────────────────────────
  console.log("\n[D · signed approved CDA at title before the scheduled closing, tenant zone]")
  const tzFL = resolveTenantTimeZone({ state: "FL" })
  check("the tenant zone derives from the brokerage's STATE (not hard-coded); unknown → UTC and SAID", tzFL.source === "brokerage_state" && tzFL.zone !== "UTC" && resolveTenantTimeZone({ state: null }).source === "fallback" && resolveTenantTimeZone({ explicitZone: "America/Denver" }).zone === "America/Denver")
  const dl = resolveClosingDeadline({ closeDate: "2026-06-15", timeZone: "America/Chicago" })
  check("a DATE-ONLY closing is the closing morning (09:00 local) in the tenant's zone — 2026-06-15 Chicago → 14:00Z", dl.dueAt === "2026-06-15T14:00:00.000Z" && dl.basis === "close_date" && dl.dateOnly)
  check("the title company's scheduled closing wins over the transaction's dates; an EARLIER requirement (24h) wins by subtraction", resolveClosingDeadline({ closingScheduledDate: "2026-06-10T18:00:00Z", closeDate: "2026-06-15", timeZone: "UTC" }).basis === "closing_scheduled_date" && resolveClosingDeadline({ closeDate: "2026-06-15", timeZone: "America/Chicago", earlierCutoffHours: 24 }).dueAt === "2026-06-14T14:00:00.000Z")
  check("no closing date → no deadline, said", resolveClosingDeadline({ timeZone: "UTC" }).basis === "none")
  const due = "2026-06-15T14:00:00.000Z"
  const at = (h: number) => new Date(Date.parse(due) - h * 3_600_000)
  check("the verdict ladder: ok → reminder_48h → reminder_24h → escalate (≤ 12h) → overdue; delivered / no-CDA / cancelled are not applicable",
    cdaDeadlineVerdict({ dueAt: due, now: at(72) }).state === "ok" && cdaDeadlineVerdict({ dueAt: due, now: at(40) }).state === "reminder_48h" && cdaDeadlineVerdict({ dueAt: due, now: at(20) }).state === "reminder_24h"
    && cdaDeadlineVerdict({ dueAt: due, now: at(6) }).state === "escalate" && cdaDeadlineVerdict({ dueAt: due, now: at(6) }).escalates && cdaDeadlineVerdict({ dueAt: due, now: at(-1) }).state === "overdue"
    && cdaDeadlineVerdict({ dueAt: due, now: at(6), sentToTitleAt: "2026-06-14T00:00:00Z" }).state === "delivered" && cdaDeadlineVerdict({ dueAt: due, now: at(6), usesCda: false }).state === "not_applicable"
    && cdaDeadlineVerdict({ dueAt: due, now: at(6), status: "cancelled" }).state === "not_applicable" && cdaDeadlineVerdict({ dueAt: null, now: at(6) }).state === "no_deadline")
  check("reminders at 48h/24h, escalation ≤ 12h; every actionable state has a notification type, the quiet ones none", CDA_DEADLINE_REMINDER_HOURS[0] === 48 && CDA_DEADLINE_REMINDER_HOURS[1] === 24 && CDA_DEADLINE_ESCALATE_HOURS === 12 && !!CDA_DEADLINE_NOTIFICATION.escalate && !!CDA_DEADLINE_NOTIFICATION.overdue && CDA_DEADLINE_NOTIFICATION.ok === null && CDA_DEADLINE_NOTIFICATION.delivered === null)
  check("SWEPT: reaper-net carries cda_deadline → reapCdaDeadlines; the reaper escalates to the brokerage admins AND the finance bus, idempotent per CDA + state", /domain: "cda_deadline"/.test(code("lib/intelligence/reaper-net.ts")) && /reapCdaDeadlines\(/.test(code("lib/intelligence/reaper-net.ts")) && /notifyBrokerageAdmins\(/.test(reaper) && /publishManagerSignal\(/.test(reaper) && /cda_deadline_at_risk/.test(reaper) && /\.eq\("is_read", false\)/.test(reaper))

  // ── E · DELIVERY ───────────────────────────────────────────────────────────────────────────
  console.log("\n[E · delivery: portal inbox on the deal team, else the verified email; never twice]")
  check("ROUTE: title on the deal team → portal; else a valid email → email; neither → none with the reason; a requested route the facts cannot honour is refused by name",
    cdaDeliveryRoute({ titlePortalUserId: "u-title" }).route === "portal" && cdaDeliveryRoute({ titleEmail: "closer@title.test" }).route === "email" && cdaDeliveryRoute({}).reason === "no_title_recipient"
    && cdaDeliveryRoute({ requested: "portal" }).reason === "title_not_on_deal_team" && cdaDeliveryRoute({ requested: "email", titleEmail: "not-an-email" }).reason === "title_email_missing_or_invalid" && cdaDeliveryRoute({ titlePortalUserId: "u", titleEmail: "a@b.co" }).route === "portal")
  check("IDEMPOTENT: a recorded delivery is refused on retry; an explicit re-send needs a reason (≥ 5 chars)",
    deliveryIdempotency({ sentToTitleAt: null, recipient: "x" }).ok && !deliveryIdempotency({ sentToTitleAt: "2026-06-01T00:00:00Z", sentRecipient: "x", recipient: "x" }).ok
    && deliveryIdempotency({ sentToTitleAt: "2026-06-01T00:00:00Z", recipient: "x", resend: true, resendReason: "bounced address" }).resend && !deliveryIdempotency({ sentToTitleAt: "2026-06-01T00:00:00Z", recipient: "x", resend: true, resendReason: "no" }).ok)
  check("WIRED: sendCdaToTitleAction asks deliveryIdempotency BEFORE any send, routes 'portal' through cdaDeliveryRoute into a transaction_documents 'cda' row + the title user's bell, and records the delivery evidence", (() => { const a = portal.indexOf("export async function sendCdaToTitleAction"); const s = portal.slice(a, portal.indexOf("export async function", a + 10)); return /deliveryIdempotency\(/.test(s) && s.indexOf("deliveryIdempotency(") < s.indexOf("dispatchEmail") && /cdaDeliveryRoute\(/.test(s) && /doc_type:\s*"cda"/.test(s) && /cda_delivered_portal/.test(s) && /title_delivery/.test(s) })())
  const methodMigs = migrationsDefining("sent_to_title_method")
  const methodMig = methodMigs.length ? read(`supabase/migrations/${methodMigs[methodMigs.length - 1]}`) : ""
  check(`the LATEST sent_to_title_method CHECK (${methodMigs[methodMigs.length - 1] ?? "none"}) admits 'portal' beside the four HEAD values and is honestly stamped`, methodMigs.length > 0 && STAMP.test(methodMig) && checkValuesOf(methodMig, "sent_to_title_method").some((v) => v.split(",").includes("portal") && v.split(",").includes("email")), methodMigs.join(", "))
  check("the external-broker RETURN door exists (the signed copy on file is the authorization, never an envelope merely sent) and refuses an on-platform brokerage", /export async function returnExternallySignedCdaAction/.test(portal) && /brokerage_on_platform_use_in_app_broker_signature/.test(portal) && /cda_signed_external/.test(portal))

  // ── F · PAYMENT STATES ─────────────────────────────────────────────────────────────────────
  console.log("\n[F · commissions / payments: seven derived states, gated writers, no LLM compensation]")
  check("the owner's seven states in the owner's order; the four-value ledger status is UNFORKED", COMMISSION_PAYMENT_STATES.join() === "expected,preliminary,approved_final,payment_initiated,payment_recorded,payment_received,reconciled" && COMMISSION_LEDGER_STATUSES.length === 4 && Object.keys(COMMISSION_PAYMENT_STATE_LABELS).length === 7)
  const D = deriveCommissionPaymentState
  check("DERIVATION ladder: expected → preliminary (deposit or statement) → approved_final → payment_initiated → payment_recorded → payment_received → reconciled; later evidence wins",
    D({ status: "pending" }).state === "expected" && D({ status: "pending", deposit_received_at: "x" }).state === "preliminary" && D({ status: "pending", preliminary_statement_at: "x" }).state === "preliminary"
    && D({ status: "approved" }).state === "approved_final" && D({ status: "approved", payment_initiated_at: "x" }).state === "payment_initiated" && D({ status: "paid", paid_at: "x", payment_initiated_at: "x" }).state === "payment_recorded"
    && D({ status: "paid", payment_received_at: "x" }).state === "payment_received" && D({ status: "paid", payment_received_at: "x", reconciled_at: "x" }).state === "reconciled")
  check("a DISPUTED row is HELD at the state its evidence reached, never advanced or reset", D({ status: "disputed", paid_at: "x" }).held && D({ status: "disputed", paid_at: "x" }).state === "payment_recorded" && D({ status: "disputed" }).state === "expected")
  const fin = code("lib/kernel/financial.ts")
  const slice = (fn: string) => { const a = fin.indexOf(`export async function ${fn}`); return fin.slice(a, fin.indexOf("export async function", a + 10)) }
  const init = slice("initiateCommissionPayout"), attest = slice("attestCommissionReceived"), recon = slice("reconcileCommissionPayment")
  check("WRITERS: initiate (finance admin, APPROVED only, check | direct_deposit) · attest (the agent who owns the row or finance on their behalf, PAID only, amount/date/payer/method/reference/evidence, amount compared with the ledger net) · reconcile (finance admin, PAID only)",
    /isBrokerageFinanceAdmin\(/.test(init) && /row\.status !== "approved"/.test(init) && /payment_initiated_at: initiatedAt/.test(init)
    && /ctx\.agentId === row\.agent_id/.test(attest) && /row\.status !== "paid"/.test(attest) && /payment_received_attestation: record/.test(attest) && /amount_matches_ledger/.test(attest) && /already_attested/.test(attest)
    && /isBrokerageFinanceAdmin\(/.test(recon) && /row\.status !== "paid"/.test(recon) && /reconciled_via: input\.via/.test(recon) && /already_reconciled/.test(recon))
  check("QUICKBOOKS MATCH ONLY AGAINST THE ACTUAL CONNECTED INTEGRATION: via 'quickbooks' requires the row's confirmed sync (quickbooks_synced_at) — else refused by name; 'manual' needs a statement reference", /quickbooks_not_synced/.test(recon) && /row\.quickbooks_synced_at/.test(recon) && /reference\.length < 3/.test(recon))
  check("a PGRST204 on an m787 column is reported BY NAME (the migration is not applied), never swallowed", /m787Refusal\(stampErr\.message\)/.test(init) && /m787Refusal\(stampErr\.message\)/.test(attest) && /m787Refusal\(stampErr\.message\)/.test(recon))
  check("markCommissionPaid stamps payment_initiated_at (initiated at latest when recorded) only when the row carries the column", /"payment_initiated_at" in \(commission as Record<string, unknown>\)/.test(fin))
  check("LLMs never calculate compensation: lib/kernel/financial.ts and the waterfall carry no model call (stripped + strings blanked); the specimen IS caught", !MODEL_CALL.test(bare("lib/kernel/financial.ts")) && !MODEL_CALL.test(bare("lib/commission/ledger-sync.ts")) && MODEL_CALL.test("const net = await generateObject({ prompt })"))
  const m787s = migrationsDefining("reconciled_via")
  const m787 = m787s.length ? read(`supabase/migrations/${m787s[m787s.length - 1]}`) : ""
  check(`the payment-state migration (${m787s[m787s.length - 1] ?? "none"}) adds the three stamps the writers name, with FKs on the *_by columns, honestly stamped`, m787s.length > 0 && STAMP.test(m787) && /payment_initiated_at timestamptz/.test(m787) && /payment_received_attestation jsonb/.test(m787) && /reconciled_at timestamptz/.test(m787) && /payment_received_by uuid REFERENCES public\.users\(id\)/.test(m787) && /reconciled_by uuid REFERENCES public\.users\(id\)/.test(m787))
  const fk = code("app/actions/financial-kernel.ts")
  check("WIRED end-to-end: the three session-tenant actions exist; the derived state rides on getAgentCommissions; the commissions page renders it with the attest / reconcile doors", /export async function initiateCommissionPayoutAction/.test(fk) && /export async function attestCommissionReceivedAction/.test(fk) && /export async function reconcileCommissionPaymentAction/.test(fk) && /brokerageId: ctx\.brokerageId/.test(fk)
    && /deriveCommissionPaymentState\(/.test(code("app/actions/agents.ts")) && /CommissionPaymentStateCell/.test(code("app/dashboard/financials/commissions/page.tsx")) && /initiateCommissionPayoutAction\(/.test(code("app/components/features/financial/CommissionPaymentStateCell.tsx")) && /attestCommissionReceivedAction\(/.test(code("app/components/features/financial/CommissionPaymentStateCell.tsx")) && /reconcileCommissionPaymentAction\(/.test(code("app/components/features/financial/CommissionPaymentStateCell.tsx")))

  // ── G · LIFETIME ───────────────────────────────────────────────────────────────────────────
  console.log("\n[G · contact → lifetime after the verified close; CLOSED / PAYOUT PENDING where rules require; never twice]")
  const V = lifetimeConversionVerdict
  check("VERDICT: not closed → never; closed without records → hold; closed + records + policy requires payout → CLOSED / PAYOUT PENDING; payout recorded → convert; policy off → convert at close",
    V({ closed: false, requiredRecordsComplete: true, payoutVerified: true, requirePayoutVerified: true }).action === "not_closed" && V({ closed: true, requiredRecordsComplete: false, payoutVerified: true, requirePayoutVerified: false }).action === "hold_records"
    && V({ closed: true, requiredRecordsComplete: true, payoutVerified: false, requirePayoutVerified: true }).action === "hold_payout_pending" && V({ closed: true, requiredRecordsComplete: true, payoutVerified: false, requirePayoutVerified: true }).label === LIFETIME_HOLD_LABEL && LIFETIME_HOLD_LABEL === "CLOSED / PAYOUT PENDING"
    && V({ closed: true, requiredRecordsComplete: true, payoutVerified: true, requirePayoutVerified: true }).action === "convert" && V({ closed: true, requiredRecordsComplete: true, payoutVerified: false, requirePayoutVerified: false }).action === "convert")
  const B = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222", T = "33333333-3333-4333-8333-333333333333"
  const B3 = "55555555-5555-4555-8555-555555555555"
  const svc = memSupabase({
    brokerage_settings: [
      { id: "bs-1", brokerage_id: B, settings: { lifetime_conversion: { require_payout_verified: true } } },
      { id: "bs-2", brokerage_id: B2, settings: { lifetime_conversion: "yes" } },
    ],
    contacts: [
      { id: "c-buyer", brokerage_id: B, contact_type: "buyer", lifecycle_state: "buyer" },
      { id: "c-seller", brokerage_id: B, contact_type: "seller", lifecycle_state: "seller" },
      { id: "c-other", brokerage_id: B2, contact_type: "buyer", lifecycle_state: "buyer" },
    ],
    lifetime_customer_touchpoints: [],
  })
  const [polOn, polBad, polNone] = await Promise.all([readLifetimeConversionPolicy(svc, B), readLifetimeConversionPolicy(svc, B2), readLifetimeConversionPolicy(svc, B3)])
  check("THE POLICY READ (the one product reader): brokerage_settings.settings.lifetime_conversion.require_payout_verified → hold; malformed / no row → convert at close, the source SAID", polOn.requirePayoutVerified && /brokerage_settings\.settings/.test(polOn.source) && !polBad.requirePayoutVerified && !polNone.requirePayoutVerified && /no brokerage_settings row/.test(polNone.source), JSON.stringify({ polOn, polBad, polNone }))
  const first = await promoteDealContactsToLifetime(svc, { brokerageId: B, transactionId: T, contactIds: ["c-buyer", "c-seller"], agentRecordId: "agent-1", closeDate: "2026-06-15" })
  const second = await promoteDealContactsToLifetime(svc, { brokerageId: B, transactionId: T, contactIds: ["c-buyer", "c-seller"], agentRecordId: "agent-1", closeDate: "2026-06-15" })
  const contacts = svc.tables.contacts
  const tps = svc.tables.lifetime_customer_touchpoints
  check("THE ONE WRITER converts both parties (COUNTED: 2 matched), both columns, and schedules the five touchpoints per contact ONCE", first.promoted === 2 && first.touchpointsScheduled === 10 && first.errors.length === 0 && contacts.filter((c) => c.brokerage_id === B).every((c) => c.contact_type === "lifetime_customer" && c.lifecycle_state === "lifetime_customer") && tps.length === 10 && tps.every((t) => t.related_transaction_id === T && t.status === "scheduled"), JSON.stringify({ first, tps: tps.length }))
  check("NO DUPLICATE CONVERSION: the second call (the payout release after a convert-at-close, or a retry) re-asserts the same value and inserts NO second schedule", second.promoted === 2 && second.touchpointsScheduled === 0 && second.skippedExistingTouchpoints && tps.length === 10, JSON.stringify(second))
  const cross = await promoteDealContactsToLifetime(svc, { brokerageId: B2, transactionId: "44444444-4444-4444-8444-444444444444", contactIds: ["c-buyer"], agentRecordId: "agent-2", closeDate: "2026-06-15" })
  check("TENANT-PINNED: naming another tenant's contact matches no row (promoted 0, SAID), the contact is untouched", cross.promoted === 0 && cross.errors.some((e) => /matched 0 of 1/.test(e)) && contacts.find((c) => c.id === "c-other")?.contact_type === "buyer")
  const txk = code("lib/kernel/transactions.ts")
  const INLINE = /contact_type:\s*LIFETIME_CUSTOMER_TYPE/
  check("WIRED at CLOSE: closeTransactionCommand reads the policy, converts or HOLDS through the one writer; the inline conversion and the inline schedule are gone (tombstoned)", /readLifetimeConversionPolicy\(/.test(txk) && /promoteDealContactsToLifetime\(/.test(txk) && /holdLifetimeConversionPendingPayout\(/.test(txk) && !INLINE.test(txk) && !/from\("lifetime_customer_touchpoints"\)\.insert/.test(txk))
  check("POSITIVE CONTROL: the inline-conversion scan recognises the HEAD shape", INLINE.test(`.update({ contact_type: LIFETIME_CUSTOMER_TYPE, lifecycle_state: LIFETIME_CUSTOMER_TYPE })`))
  check("WIRED at PAYOUT: markCommissionPaid releases a held conversion (releaseLifetimeConversionOnPayout) after the payout record lands; the policy key is a registered tenant policy", slice("markCommissionPaid").includes("releaseLifetimeConversionOnPayout(") && /lifetime_conversion:\s*\{/.test(code("lib/kernel/tenant-policy.ts")))
  const lc = code("lib/kernel/lifetime-conversion.ts")
  check("the release converts only a CLOSED transaction of the SAME tenant, and completes the CLOSED / PAYOUT PENDING activity (counted)", /!== "closed"/.test(lc) && /\.eq\("brokerage_id", args\.brokerageId\)/.test(lc) && /lifetime_conversion_pending_payout/.test(lc) && /\.eq\("status", "pending"\)\s*\n?\s*\.select\("id"\)/.test(lc))

  // ── H · LEGAL DESCRIPTION ──────────────────────────────────────────────────────────────────
  console.log("\n[H · legal description: sources with provenance, never invented, never the street address]")
  check("THE SHAPE RULE: lot/block/plat/PLSS/metes-and-bounds pass; a street address, a blank, a bare summary are refused by name",
    looksLikeLegalDescription("LOT 4 BLK 2 SPRINGFIELD ADD PB 12 PG 34").ok && looksLikeLegalDescription("The NE 1/4 of Section 12, Township 3 South, Range 29 West").ok && looksLikeLegalDescription("123 Main St").reason === "street_address"
    && looksLikeLegalDescription("").reason === "empty" && looksLikeLegalDescription("A lovely home near the park").reason === "no_legal_tokens" && looksLikeLegalDescription("Lot 1").reason === "too_short")
  const ldMigs = migrationsDefining("legal_description_source")
  const ldMig = ldMigs.length ? read(`supabase/migrations/${ldMigs[ldMigs.length - 1]}`) : ""
  check(`ONE vocabulary: LEGAL_DESCRIPTION_SOURCES equals the LATEST defining migration's CHECK (${ldMigs[ldMigs.length - 1] ?? "none"}, both tables); it names listing + public_record + rentcast + agent and never a model`,
    ldMigs.length > 0 && STAMP.test(ldMig) && checkValuesOf(ldMig, "legal_description_source").length === 2 && checkValuesOf(ldMig, "legal_description_source").every((v) => v === [...LEGAL_DESCRIPTION_SOURCES].sort().join())
    && ["agent", "listing", "rentcast", "public_record"].every((s) => (LEGAL_DESCRIPTION_SOURCES as readonly string[]).includes(s)) && !(LEGAL_DESCRIPTION_SOURCES as readonly string[]).some((s) => /ai|model|llm/.test(s)) && /legal_description_provenance jsonb/.test(ldMig))
  const ld = code("lib/forms/legal-description.ts")
  check("RESEARCH (the owner's osint) is accepted ONLY cited + shaped + not low-confidence, written as public_record with provenance, flagged verification_required and the agent asked to VERIFY", /looksLikeLegalDescription\(candidate\)/.test(ld) && /candidate && shape\.ok && cited && research\.dataConfidence !== "low"/.test(ld) && /verification_required: source === "public_record"/.test(ld) && /askHuman\(svc, args, "verification required", "verify"/.test(ld))
  check("THE ADDRESS FILL: the linked LISTING's value is copied onto the TRANSACTION as source 'listing'; every write carries provenance; the runner reads legal_description_source into the facts", /provenanceFor\("listing", null/.test(ld) && /legal_description_provenance: provenance/.test(ld) && /legalDescriptionSource/.test(code("lib/intelligence/offer-property-prefill-runner.ts")))
  const al = code("lib/property/address-lookup.ts")
  check("the research module returns the legal description WITH its citation (legalDescriptionSource) and nothing is accepted without one", /legalDescription: typeof parsed\.legalDescription === 'string'/.test(al) && /legalDescriptionSource: typeof parsed\.legalDescriptionSource === 'string'/.test(al) && /legalDescription: null, legalDescriptionSource: null/.test(al))

  // ── I · REGISTRATION ───────────────────────────────────────────────────────────────────────
  console.log("\n[I · registration]")
  const pkg = read("package.json")
  check("package.json wires test:cda-closing-flow", /"test:cda-closing-flow":\s*"tsx scripts\/cda-closing-flow-guard\.ts"/.test(pkg))
  check("the guard chain runs it (membership, never a position)", new RegExp("npm run test:cda-closing-flow(\\s|&|$)").test(JSON.parse(pkg).scripts.guard ?? ""))
  check("a MAINTENANCE_DOMAINS entry owns it", /proof:\s*"test:cda-closing-flow"/.test(code("lib/kernel/manager-registry.ts")))

  console.log("\nBLIND SPOTS: no provider, portal or e-sign call is made — the delivery routes and the title-portal bridge are proven on stripped source and pure rules;")
  console.log("  m786 / m787 / m788 are asserted as TEXT until the integrator applies them (the writers read the refusal by name until then); the tenant zone derives from")
  console.log("  the brokerage STATE because brokerages carries no timezone column at HEAD; the in-memory client models update().select() counts, not RLS.")
  console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`)
  if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)) }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
