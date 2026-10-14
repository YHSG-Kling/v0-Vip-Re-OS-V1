/**
 * scripts/canaries/brokerage-adoption.ts — BROKERAGE ADOPTION canary (wave 141, lane 141J; wired by lane 141K):
 *   independent subscriber → verified brokerage-location joins → consent → migrate → direct billing stopped
 *   (prorated) → brokerage seat active → no data loss → no double billing
 * Owner (wave 141): "Later adoption by the ACTUAL brokerage location = a deliberate relationship transfer:
 * identify the exact brokerage/location → explicit agent/team permission → verify → migrate membership/data
 * through canonical services → preserve history/evidence → stop individual billing at the right effective
 * time → Stripe proration → no double billing → brokerage owns the seat/platform relationship."
 *
 * AUDITED AT 01a71c3c2: no transfer rail and no billing handoff existed. LANDED AT 81fcd1f14 and driven here:
 *   · lane 141A — lib/kernel/brokerage-transfer.ts requestBrokerageTransfer → recordBrokerageTransferConsent (runs
 *     the migration IMMEDIATELY) → runBrokerageTransferMigration (verification → membership → data →
 *     billing_handoff → archive_source → target_readiness; resumable step record) → cancel / list;
 *   · lane 141A — lib/billing/subscriber-billing-handoff.ts handoffSubscriberBillingToBrokerage, the ONE billing
 *     seam the rail calls (decides never-billed / trial / Stripe-linked);
 *   · lane 141H — lib/billing/subscriber-handoff.ts handoffSubscriberBillingToBrokerage, the Stripe side behind it
 *     (actor = an admin OF THE TARGET, FINANCIAL ledger keyed on the handoff cycle, proration by Stripe, local
 *     cancel_at mirror, SUBSCRIPTION_CANCELLED reason brokerage_handoff). Its SDK call
 *     (stripeEndSubscriptionForHandoff) is the ONE thing stubbed — a recorder that answers like Stripe would,
 *     so the kernel + ledger + event half runs for real and no money moves.
 * The 141A rail is given exactly one injected dep — `billingHandoff` = the real orchestrator with its Stripe side
 * = the real lane-H handoff with the SDK recorder (the orchestrator's own defaultStripeSide shape,
 * lib/billing/subscriber-billing-handoff.ts:105, minus the network). Every other survivor (users.ts movers,
 * seat gate, tier matrix, mayUseAndAfford, readiness, emit, notifications, action ledger) is the REAL default.
 */
import type { BrokerageTransferDeps } from "../../lib/kernel/brokerage-transfer"
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, strippedRepo } from "./_registry"
import { nameKeyedBrokerageReads } from "./same-name-brokerage"

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- the in-memory client's row shape

export async function run() {
  const c = canary("Brokerage adoption: independent → verified location joins → consent → migrate → billing stopped (prorated) → brokerage seat → no data loss → no double billing")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: the transfer rail moves tenancy — in-memory only")
  const S = uuid(), B = uuid(), X = uuid(), SOLO = uuid(), SOLO_AG = uuid(), ADMIN = uuid(), SUB_S = uuid(), SUB_B = uuid()
  const svc = canaryClient({
    brokerages: [
      { id: S, name: `${CANARY_TAG} Harbor Realty`, plan_tier: "solo_agent", status: "active", slug: `${CANARY_TAG}-solo`, brokerage_on_platform: false, team_on_platform: false, created_at: nowIso() },
      { id: B, name: `${CANARY_TAG} Harbor Realty`, plan_tier: "brokerage", status: "active", slug: `${CANARY_TAG}-hq`, brokerage_on_platform: true, team_on_platform: true, created_at: nowIso() },
      { id: X, name: `${CANARY_TAG} Unrelated Realty`, plan_tier: "brokerage", status: "active", slug: `${CANARY_TAG}-x`, created_at: nowIso() },
    ],
    subscription_tiers: [
      { id: uuid(), tier_name: "solo_agent", is_active: true, display_name: `${CANARY_TAG} Solo Agent` },
      { id: uuid(), tier_name: "brokerage", is_active: true, display_name: `${CANARY_TAG} Brokerage` },
    ],
    users: [
      { id: SOLO, email: `solo@${CANARY_EMAIL_DOMAIN}`, first_name: "Canary", last_name: "Solo", user_type: "broker_owner", brokerage_id: S, platform_role: null, team_id: null },
      { id: ADMIN, email: `admin@${CANARY_EMAIL_DOMAIN}`, first_name: "Canary", last_name: "Admin", user_type: "broker_owner", brokerage_id: B, platform_role: null },
    ],
    agents: [{ id: SOLO_AG, user_id: SOLO, brokerage_id: S, first_name: "Canary", last_name: "Solo", is_active: true }],
    user_role_assignments: [{ id: uuid(), user_id: SOLO, role: "broker_owner", brokerage_id: S }],
    contacts: [
      { id: uuid(), brokerage_id: S, agent_id: SOLO_AG, first_name: "Dana", last_name: "Canary", email: `dana@${CANARY_EMAIL_DOMAIN}`, status: "new", notes: CANARY_TAG },
      { id: uuid(), brokerage_id: S, agent_id: SOLO_AG, first_name: "Jordan", last_name: "Canary", email: `jordan@${CANARY_EMAIL_DOMAIN}`, status: "active", notes: CANARY_TAG },
    ],
    listings: [{ id: uuid(), brokerage_id: S, agent_id: SOLO_AG, address: "1 Canary Way", status: "active", notes: CANARY_TAG }],
    subscriptions: [
      { id: SUB_S, brokerage_id: S, status: "active", stripe_customer_id: "cus_canary_solo", stripe_subscription_id: "sub_canary_solo", current_period_end: new Date(Date.now() + 20 * 864e5).toISOString(), created_at: nowIso(), updated_at: nowIso() },
      { id: SUB_B, brokerage_id: B, status: "active", stripe_customer_id: "cus_canary_hq", stripe_subscription_id: "sub_canary_hq", current_period_end: new Date(Date.now() + 25 * 864e5).toISOString(), created_at: nowIso(), updated_at: nowIso() },
    ],
  })
  setSvc(svc)
  const tagged = (rows: Row[] | undefined, tenant: string) => (rows ?? []).filter((r) => r.brokerage_id === tenant && String(r.notes ?? "").includes(CANARY_TAG))
  const soloRows = (tenant: string) => ({ contacts: tagged(svc.tables.contacts, tenant).length, listings: tagged(svc.tables.listings, tenant).length })
  const user = (id: string) => (svc.tables.users ?? []).find((u) => u.id === id)
  const sub = (id: string) => (svc.tables.subscriptions ?? []).find((s) => s.id === id)
  const brokerage = (id: string) => (svc.tables.brokerages ?? []).find((b) => b.id === id)
  const events = (tenant: string, type: RegExp) => (svc.tables.lifecycle_events ?? []).filter((e) => e.brokerage_id === tenant && type.test(String(e.event_type)))
  const before = soloRows(S)
  c.step("pre-condition: the independent subscriber's data is TENANT-SCOPED to its own id (contacts, listings, agent, subscription all carry brokerage_id = S)", before.contacts === 2 && before.listings === 1 && (svc.tables.agents ?? []).every((a) => a.brokerage_id === S || a.brokerage_id === B) && (svc.tables.subscriptions ?? []).filter((s) => s.brokerage_id === S).length === 1, JSON.stringify(before))
  c.step("pre-condition: the target is identified by CANONICAL ID — the solo's declared name matches the brokerage's name AND an unrelated tenant exists; neither name fact creates a relationship (no membership, no shared rows)", user(SOLO)?.brokerage_id === S && (svc.tables.brokerages ?? []).filter((b) => b.name === `${CANARY_TAG} Harbor Realty`).length === 2, "")
  c.step("pre-condition: ONE subscription per tenant (the invariant 'no double billing' is measured against)", (svc.tables.subscriptions ?? []).filter((s) => s.brokerage_id === S).length === 1 && (svc.tables.subscriptions ?? []).filter((s) => s.brokerage_id === B).length === 1, "")
  c.step("pre-condition: no raw cross-tenant membership rewrite exists in the member core outside the ONE adoption seam (lib/kernel/tenant-creation.ts adoptExistingOwnerIntoTenant anchors a TENANT-LESS user only: `.is(\"brokerage_id\", null)`)", /\.update\(\{\s*brokerage_id:[^}]*\}\)[\s\S]{0,200}\.is\(\s*["']brokerage_id["']\s*,\s*null\s*\)/.test(strippedRepo("lib/kernel/tenant-creation.ts") ?? ""), "")

  // ── the landing census: both lanes' modules answer, or the step stays a pending HOOK ──
  const landed = new Map<string, string>()
  for (const h of hooksFor("brokerage-adoption")) { const at = h.probe(); if (at) landed.set(h.lane, at); else c.hook(h.lane, h.contract) }

  // THE STRIPE RECORDER — the only stub: lane H's `endSubscription` seam (stripeEndSubscriptionForHandoff's shape).
  const stripeCalls: Array<{ subscriptionId: string; effectiveAtUnix: number; nowUnix: number; idempotencyKey: string; immediate: boolean }> = []
  const endSubscription = async (subscriptionId: string | null | undefined, effectiveAtUnix: number, nowUnix: number, idempotencyKey: string) => {
    const immediate = effectiveAtUnix <= nowUnix
    stripeCalls.push({ subscriptionId: String(subscriptionId), effectiveAtUnix, nowUnix, idempotencyKey, immediate })
    return { applied: true, skipped: false, mode: (immediate ? "cancelled_now" : "scheduled_cancel") as "cancelled_now" | "scheduled_cancel", finalInvoiceId: immediate ? "in_canary_final" : null, cancelAtUnix: effectiveAtUnix }
  }

  if (landed.has("141H")) {
    // WAVE141 HOOK (integrator): 141H — wired 141K. The orchestrator (lib/billing/subscriber-billing-handoff.ts) is
    // the door the rail calls; the Stripe side (lib/billing/subscriber-handoff.ts) is reached through it.
    const { handoffSubscriberBillingToBrokerage: orchestrate } = await import("../../lib/billing/subscriber-billing-handoff")
    const { handoffSubscriberBillingToBrokerage: stripeSide } = await import("../../lib/billing/subscriber-handoff")
    const later = new Date(Date.now() + 2 * 864e5).toISOString()
    const subsBefore = (svc.tables.subscriptions ?? []).length
    const pending = await orchestrate(svc, { sourceBrokerageId: S, targetBrokerageId: B, effectiveAt: later, transferRequestId: uuid(), actorUserId: ADMIN })
    c.step(`141H landed (${landed.get("141H")}) — honest without Stripe: a Stripe-linked source with NO SDK in this runtime answers ok:false stripe_handoff_pending through the real Stripe side — nothing changed (status active, no cancel_at, no second row), nothing fabricated (no refund, no price)`, !pending.ok && pending.code === "stripe_handoff_pending" && (svc.tables.subscriptions ?? []).length === subsBefore && sub(SUB_S)?.status === "active" && !sub(SUB_S)?.cancel_at, JSON.stringify(pending).slice(0, 200))
    const wrong = await orchestrate(svc, { sourceBrokerageId: S, targetBrokerageId: X, effectiveAt: later, transferRequestId: uuid(), actorUserId: ADMIN })
    c.step("141H wrong target: a brokerage with no subscription row (no seat relationship to carry) is REFUSED by name", !wrong.ok && wrong.code === "target_subscription_missing", wrong.ok ? "allowed" : wrong.error.slice(0, 160))
    const notAdmin = await stripeSide(svc, { sourceBrokerageId: S, targetBrokerageId: B, effectiveAt: later, actorUserId: SOLO }, { endSubscription })
    c.step("141H authority (fail closed): the Stripe side refuses an approver who is not an admin OF THE TARGET (the subject cannot move billing anywhere; a source-side actor neither) — the SDK is never reached", !notAdmin.ok && notAdmin.refused === "actor_not_authorized" && stripeCalls.length === 0, notAdmin.ok ? "allowed" : notAdmin.error)
    c.step("141H evidence: the refused attempt is ledgered on the SOURCE tenant (agent_action_ledger, FINANCIAL) with a failed settlement", (svc.tables.agent_action_ledger ?? []).some((l) => l.brokerage_id === S && /handoff_to_brokerage/.test(String(l.action))), `${(svc.tables.agent_action_ledger ?? []).length} ledger rows`)
  }

  if (landed.has("141A")) {
    // WAVE141 HOOK (integrator): 141A — wired 141K: request → consent → verify → migrate → archive, through the rail's
    // real exports; the billing seam carries the 141H Stripe side with the SDK recorder (see header).
    const { requestBrokerageTransfer, recordBrokerageTransferConsent, runBrokerageTransferMigration, cancelBrokerageTransferRequest, transferMigrationComplete } = await import("../../lib/kernel/brokerage-transfer")
    const { handoffSubscriberBillingToBrokerage: orchestrate } = await import("../../lib/billing/subscriber-billing-handoff")
    const { handoffSubscriberBillingToBrokerage: stripeSide, handoffCycle } = await import("../../lib/billing/subscriber-handoff")
    const deps: BrokerageTransferDeps = {
      billingHandoff: (client, input) => orchestrate(client, input, {
        stripeSide: async (client2, i) => {
          if (!i.actorUserId) return { ok: false, error: "The Stripe handoff needs the approving human's user id — the transfer carries none." }
          const r = await stripeSide(client2, { sourceBrokerageId: i.sourceBrokerageId, targetBrokerageId: i.targetBrokerageId, effectiveAt: i.effectiveAt, actorUserId: i.actorUserId, reason: `brokerage transfer ${i.transferRequestId}` }, { endSubscription })
          return r.ok ? { ok: true, evidence: { stripe_mode: r.source.mode, proration: r.source.proration, final_invoice_id: r.source.finalInvoiceId, replay: r.replay, handoff_cycle: r.evidence.cycle } } : { ok: false, error: r.error, evidence: { stripe_refusal: r.refused } }
        },
      }),
    }
    const rail = strippedRepo("lib/kernel/brokerage-transfer.ts") ?? ""
    const req = await requestBrokerageTransfer(svc, { targetBrokerageId: B, initiatedByUserId: ADMIN, subjectEmail: `solo@${CANARY_EMAIL_DOMAIN}`, targetRole: "agent", reason: `${CANARY_TAG} adoption` })
    const R = req.ok ? req.request.id : ""
    const row = () => (svc.tables.brokerage_transfer_requests ?? []).find((r) => r.id === R) as Row | undefined
    c.step(`141A landed (${landed.get("141A")}) — request: the TARGET admin asks by the owner's ACCOUNT EMAIL (never a brokerage name) → ONE brokerage_transfer_requests row pinned to the target (brokerage_id = target), status requested, consent null, the subject told on their own tenant; ledgered (tenant.transfer.request) and evented (brokerage_transfer_requested)`, req.ok && req.request.brokerage_id === B && req.request.source_brokerage_id === S && req.request.target_brokerage_id === B && req.request.subject_user_id === SOLO && req.request.status === "requested" && req.request.consent === null && req.notified.subject && (svc.tables.notifications ?? []).some((n) => n.user_id === SOLO && n.brokerage_id === S && /consent_requested/.test(String(n.type))) && (svc.tables.agent_action_ledger ?? []).some((l) => l.brokerage_id === B && l.action === "tenant.transfer.request") && events(B, /^brokerage_transfer_requested$/).length === 1, req.ok ? R : req.error)
    c.step("141A identity is CANONICAL: the rail reads brokerages by id only (0 name-keyed brokerages reads, stripped), the request input is an email + the session tenant, and every data update is pinned to the source id", nameKeyedBrokerageReads(rail) === 0 && /subjectEmail/.test(rail) && !/brokerageName|subjectBrokerageName/.test(rail) && /\.update\(\{\s*brokerage_id:\s*targetId\s*\}\)\.eq\("brokerage_id",\s*sourceId\)/.test(rail), "")
    const second = await requestBrokerageTransfer(svc, { targetBrokerageId: X, initiatedByUserId: ADMIN, subjectEmail: `solo@${CANARY_EMAIL_DOMAIN}`, targetRole: "agent" })
    c.step("141A one open request per workspace: a second brokerage asking for the same owner while a request is open is REFUSED (the m765 partial unique index says the same)", !second.ok && /open adoption request/.test(second.error), second.ok ? "accepted" : second.error)
    const early = await runBrokerageTransferMigration(svc, { requestId: R, actor: { userId: ADMIN, brokerageId: B, kind: "target_admin" } }, deps)
    c.step("141A consent missing → NOTHING moves: the target admin cannot run the migration before the owner consents (rows and membership untouched)", !early.ok && /not consented/.test(early.error) && soloRows(S).contacts === before.contacts && user(SOLO)?.brokerage_id === S, early.ok ? "ran" : early.error)
    const notOwner = await recordBrokerageTransferConsent(svc, { requestId: R, actor: { userId: ADMIN, brokerageId: B, kind: "target_admin" }, decision: "consent", statement: "I consent on their behalf, which is not allowed.", channel: "canary" }, deps)
    c.step("141A consent is the SUBJECT's own session: a target admin 'consenting' on their behalf is refused", !notOwner.ok && /owner of the workspace/.test(notOwner.error), notOwner.ok ? "accepted" : notOwner.error)
    const consent = await recordBrokerageTransferConsent(svc, { requestId: R, actor: { userId: SOLO, brokerageId: S, kind: "subject" }, decision: "consent", statement: "I consent to Harbor Realty adopting my workspace.", channel: "canary_settings_ui" }, deps)
    const mig = consent.ok ? consent.migration : null
    const r1 = row()
    c.step("141A consent recorded as EVIDENCE (the owner's own statement, channel, request snapshot; ledgered tenant.transfer.consent; brokerage_transfer_consented) and the migration ran IMMEDIATELY in the same call — verification passed (checks recorded), membership moved, data moved", consent.ok && r1?.consent?.decision === "consent" && /I consent/.test(String(r1?.consent?.statement)) && r1?.consent?.request_snapshot?.target_brokerage_id === B && r1?.verification?.ok === true && Array.isArray(r1?.verification?.checks) && mig?.record?.steps?.verification?.status === "done" && mig?.record?.steps?.membership?.status === "done" && mig?.record?.steps?.data?.status === "done" && events(B, /^brokerage_transfer_consented$/).length === 1, consent.ok ? JSON.stringify(mig?.record?.steps).slice(0, 200) : consent.error)
    c.step("141A INTEGRATOR FINDING, asserted as it stands: the consent-driven run carries the SUBJECT as actor (brokerage-transfer.ts:452) and the Stripe side requires an admin OF THE TARGET (subscriber-handoff.ts:220) — so a Stripe-linked source STALLS honestly at billing_handoff: source NOT archived, Stripe NOT called, status 'migrating', the Finance Manager route fired (target admins told), resumable", !!mig && !mig.ok && mig.stalledAt === "billing_handoff" && brokerage(S)?.status === "active" && !brokerage(S)?.archived_at && stripeCalls.length === 0 && r1?.status === "migrating" && r1?.billing_handoff?.ok === false && /admin of the adopting brokerage/.test(String(r1?.billing_handoff?.error)) && (svc.tables.notifications ?? []).some((n) => n.brokerage_id === B && /billing_pending/.test(String(n.type))) && events(B, /^brokerage_transfer_stalled$/).length === 1, mig ? (mig.ok ? "completed in one run (no stall)" : String(mig.error).slice(0, 200)) : "no migration ran")
    const retry = await runBrokerageTransferMigration(svc, { requestId: R, actor: { userId: ADMIN, brokerageId: B, kind: "target_admin" } }, deps)
    const final = row()
    const effectiveAt = String(final?.effective_at ?? "")
    c.step("141A retry by the adopting admin RESUMES at billing_handoff (done steps not re-run; attempt 2): the Stripe side ends the source subscription with proration — ONE SDK call, immediate = prorate + invoice_now, idempotency key = the handoff cycle — the local row mirrors cancel_at, the source is ARCHIVED (status + archived_at; row kept, never deleted), the target's readiness verdict is recorded, status completed", retry.ok && retry.completed && !retry.alreadyCompleted && final?.status === "completed" && transferMigrationComplete(final?.migration) && final?.migration?.attempts === 2 && stripeCalls.length === 1 && stripeCalls[0].subscriptionId === "sub_canary_solo" && stripeCalls[0].immediate && stripeCalls[0].idempotencyKey === handoffCycle(S, B, new Date(effectiveAt).toISOString()) && final?.billing_handoff?.ok === true && final?.billing_handoff?.mode === "stripe_prorated" && final?.billing_handoff?.evidence?.proration === "prorate_invoice_now" && brokerage(S)?.status === "archived" && !!brokerage(S)?.archived_at && !!brokerage(S) && typeof final?.readiness?.ready === "boolean" && sub(SUB_S)?.cancel_at === effectiveAt, retry.ok ? `effective ${effectiveAt} readiness ${final?.readiness?.ready}` : retry.error)
    const after = soloRows(B)
    c.step("141A no data loss + provenance: every tagged solo row now carries brokerage_id = target with its agent_id and ids intact, none remains in the source, and the counts are recorded on the request", after.contacts === before.contacts && after.listings === before.listings && soloRows(S).contacts === 0 && soloRows(S).listings === 0 && tagged(svc.tables.contacts, B).every((r) => r.agent_id === SOLO_AG) && final?.migration?.counts?.contacts === before.contacts && final?.migration?.counts?.listings === before.listings && final?.migration?.counts?.members === 1, JSON.stringify(final?.migration?.counts).slice(0, 200))
    const grants = svc.tables.user_role_assignments ?? []
    c.step("141A membership through the canonical movers: the owner is in the target as a PRODUCING agent (never an admin by adoption), their agents row moved, the source grant retired, a target grant exists", user(SOLO)?.brokerage_id === B && user(SOLO)?.user_type === "agent" && (svc.tables.agents ?? []).find((a) => a.id === SOLO_AG)?.brokerage_id === B && !grants.some((g) => g.user_id === SOLO && g.brokerage_id === S) && grants.some((g) => g.user_id === SOLO && g.brokerage_id === B && g.role === "agent"), `user_type=${user(SOLO)?.user_type}`)
    c.step("141A no double billing: the target's subscription is untouched; the source keeps ONE row (cancel_at written, status mirrored by Stripe's webhook — never a second row, never an invented refund); two subscription rows in all", sub(SUB_B)?.stripe_subscription_id === "sub_canary_hq" && !sub(SUB_B)?.cancel_at && (svc.tables.subscriptions ?? []).filter((s) => s.brokerage_id === S).length === 1 && (svc.tables.subscriptions ?? []).length === 2, "")
    const ledgerActions = new Set((svc.tables.agent_action_ledger ?? []).map((l) => String(l.action)))
    c.step("141A evidence, tenant-pinned: kernel events requested → consented → stalled → completed on the target, brokerage_archived + SUBSCRIPTION_CANCELLED(reason brokerage_handoff) on the source; ledger rows tenant.transfer.{request,consent,migrate} + billing.subscription.handoff_to_brokerage; the immediate-operation report (brokerage_transfer) landed", events(B, /^brokerage_transfer_completed$/).length === 1 && events(S, /^brokerage_archived$/).length === 1 && events(S, /^subscription_cancelled$/).some((e) => (e.metadata as { reason?: string })?.reason === "brokerage_handoff") && ["tenant.transfer.request", "tenant.transfer.consent", "tenant.transfer.migrate", "billing.subscription.handoff_to_brokerage"].every((a) => ledgerActions.has(a)) && (svc.tables.lifecycle_events ?? []).some((e) => e.brokerage_id === B && (e.metadata as { operation?: string })?.operation === "brokerage_transfer"), [...ledgerActions].join(","))
    const again = await runBrokerageTransferMigration(svc, { requestId: R, actor: { userId: ADMIN, brokerageId: B, kind: "target_admin" } }, deps)
    c.step("141A idempotent: running the completed transfer again changes nothing — alreadyCompleted, same counts, still ONE Stripe call, same two subscription rows", again.ok && again.alreadyCompleted && stripeCalls.length === 1 && (svc.tables.subscriptions ?? []).length === 2 && soloRows(B).contacts === before.contacts, "")
    const replay = await stripeSide(svc, { sourceBrokerageId: S, targetBrokerageId: B, effectiveAt, actorUserId: ADMIN }, { endSubscription })
    c.step("141H replay: the Stripe side called again for the same (source, target, effectiveAt) is a REPLAY — acts on nothing, no second SDK call, no second cancellation event", replay.ok && replay.replay === true && stripeCalls.length === 1 && events(S, /^subscription_cancelled$/).length === 1, JSON.stringify({ ok: replay.ok, replay: replay.ok ? replay.replay : replay.error, mode: replay.ok ? replay.source.mode : null, stripeCalls: stripeCalls.length, cancelledEvents: events(S, /^subscription_cancelled$/).length }))
    const cross = await requestBrokerageTransfer(svc, { targetBrokerageId: X, initiatedByUserId: ADMIN, subjectEmail: `solo@${CANARY_EMAIL_DOMAIN}`, targetRole: "agent" })
    const cancelLate = await cancelBrokerageTransferRequest(svc, { requestId: R, actor: { userId: ADMIN, brokerageId: B, kind: "target_admin" } }, deps)
    c.step("141A cannot cross, immutable: once adopted the owner is a brokerage member (no longer an independent subscriber) — another brokerage cannot request them; a completed request cannot be cancelled", !cross.ok && !cancelLate.ok, cross.ok ? "accepted" : cross.error)
  }

  c.blind("Stripe is a recorder (lib/billing/subscriber-handoff.ts endSubscription seam): proration arithmetic, credit notes and invoice immutability are Stripe's own and lane 141H's test:coupons-and-handoff; the kernel, ledger (its at-most-once rides the UNIQUE idempotency_key the canary client models — _harness.ts CANARY_UNIQUE), local mirror and events ran for real. The webhook that mirrors Stripe's status onto the local row is app/api/billing/webhook (not driven). RLS is not modelled.")
  c.blind("Consent-driven migration of a Stripe-linked source stalls at billing by construction (subject ≠ target admin) and completes on the adopting admin's retry — published as an integrator finding, not relaxed.")
  const a = await cleanupCanary(svc, S), b = await cleanupCanary(svc, B), x = await cleanupCanary(svc, X)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length + x.mismatches.length === 0 && a.residual + b.residual + x.residual === 0, [...a.cleanup, ...b.cleanup, ...x.cleanup].map((r) => `${r.table}:${r.deleted}`).join(" ") + (a.mismatches.length + b.mismatches.length + x.mismatches.length ? ` MISMATCH ${[...a.mismatches, ...b.mismatches, ...x.mismatches].join("; ")}` : ""))
  return c.report([...a.cleanup, ...b.cleanup, ...x.cleanup], a.residual + b.residual + x.residual)
}
