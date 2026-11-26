/**
 * scripts/canaries/communication.ts — COMMUNICATION canary:
 *   approved communication → dispatcher → ledger → outcome/reconciliation
 * through lib/agents/agent-client-messages.ts proposeClientMessage → approveClientMessage
 * (the human-approval egress; PORTAL channel = no provider), the action ledger it writes,
 * and lib/outcomes/reconciliation-ledger.ts recordOutcomeClaim → ingestProviderTruth.
 * NEVER a live message: the only regulated-channel case is a NO-CONSENT contact on SMS,
 * blocked by the compliance gate BEFORE any provider (portal-e2e-simulator's method).
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"

export async function run() {
  const c = canary("Communication: approved communication → dispatcher → ledger → outcome/reconciliation")
  const B = uuid(), U = uuid(), AG = uuid(), CT = uuid(), NOCONSENT = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-comms` }],
    users: [{ id: U, email: `broker@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, is_active: true }],
    contacts: [
      { id: CT, brokerage_id: B, agent_id: AG, first_name: "Jordan", last_name: "Canary", email: `jordan@${CANARY_EMAIL_DOMAIN}`, contact_type: "buyer", portal_access: true, notes: CANARY_TAG },
      { id: NOCONSENT, brokerage_id: B, agent_id: AG, first_name: "Nia", last_name: "Canary", phone: "5125550177", email: `nia@${CANARY_EMAIL_DOMAIN}`, contact_type: "buyer", tcpa_consent: false, sms_opt_in: false, notes: CANARY_TAG },
    ],
  })
  setSvc(svc)
  const { proposeClientMessage, approveClientMessage } = await import("../../lib/agents/agent-client-messages")
  const p = await proposeClientMessage({ brokerageId: B, agentKind: "deal_coordinator", entityType: "contact", entityId: CT, recipientContactId: CT, audience: "buyer", subject: "Your showing recap", body: "Here is the recap of today's showings and the next steps we discussed.", rationale: "post-showing recap", channel: "portal" }, svc as never)
  c.step("approved communication: proposeClientMessage lands a PROPOSED row (nothing sent yet)", p.ok && svc.tables.agent_client_messages?.find((m) => m.id === p.id)?.status === "proposed", p.error ?? `message ${p.id}`)
  const a = await approveClientMessage(p.id ?? "", U, undefined, svc as never)
  const msg = svc.tables.agent_client_messages?.find((m) => m.id === p.id)
  c.step("dispatcher: a human approval releases it — status sent, approved_by the human", a.status === "sent" && msg?.status === "sent" && msg?.approved_by === U, JSON.stringify(a.result).slice(0, 160))
  c.step("dispatcher: the PORTAL hop rendered a transparency card for the client (stamped human_approved)", !!svc.tables.transparency_updates?.some((t) => t.contact_id === CT && t.brokerage_id === B), `cards=${(svc.tables.transparency_updates ?? []).length}`)
  // The ledger: approveClientMessage builds the withActionLedger cycle (`agent_client_message:<id>`)
  // and hands it to the provider dispatchers (email/sms/voice/mail) — the PORTAL hop writes the card
  // directly and opens no agent_action_ledger row at HEAD. Asserted as it is; published beside it.
  const ledger = (svc.tables.agent_action_ledger ?? []).filter((l) => l.brokerage_id === B)
  c.step("ledger: the release is evidenced — approved_by + approved_at on the row, the card, the client notification (portal hop: no agent_action_ledger row at HEAD — see blind spot)", !!msg?.approved_at && msg?.approved_by === U && (svc.tables.notifications ?? []).length + (svc.tables.transparency_updates ?? []).length > 0, `ledger_rows=${ledger.length} notifications=${(svc.tables.notifications ?? []).length}`)
  const again = await approveClientMessage(p.id ?? "", U, undefined, svc as never)
  c.step("idempotency: approving the same proposal again does NOT send twice", again.status !== "sent" || (svc.tables.transparency_updates ?? []).filter((t) => t.contact_id === CT).length === 1, `second=${again.status}`)
  const sms = await proposeClientMessage({ brokerageId: B, agentKind: "deal_coordinator", entityType: "contact", entityId: NOCONSENT, recipientContactId: NOCONSENT, audience: "buyer", body: "Quick update", channel: "sms" }, svc as never)
  const smsRes = await approveClientMessage(sms.id ?? "", U, undefined, svc as never)
  c.step("POSITIVE CONTROL: SMS to a NO-TCPA-consent contact is HARD-BLOCKED at the gate before any provider", smsRes.status === "failed" && svc.tables.agent_client_messages?.find((m) => m.id === sms.id)?.status === "failed", JSON.stringify(smsRes.result).slice(0, 160))
  const { recordOutcomeClaim, ingestProviderTruth } = await import("../../lib/outcomes/reconciliation-ledger")
  const ref = `${CANARY_TAG}-${uuid().slice(0, 8)}`
  const claim = await recordOutcomeClaim({ brokerageId: B, channel: "email", providerRef: ref, claimedStatus: "sent", entityType: "agent_client_message", entityId: p.id ?? null, contactId: CT, claimedByManager: "deal_coordinator" as never })
  c.step("outcome: a dispatch CLAIM opens a pending reconciliation row (provider ref recorded)", claim.ok && svc.tables.outcome_reconciliations?.some((r) => r.provider_ref === ref && r.verdict === "pending"), claim.reason ?? `row ${claim.id}`)
  const truth = await ingestProviderTruth({ channel: "email", providerRef: ref, truth: { status: "delivered", at: nowIso() } })
  c.step("reconciliation: the provider's truth CONFIRMS the claim and returns the owning tenant", truth.ok && truth.verdict === "confirmed" && truth.brokerageId === B, JSON.stringify(truth).slice(0, 160))
  const ref2 = `${CANARY_TAG}-${uuid().slice(0, 8)}`
  await recordOutcomeClaim({ brokerageId: B, channel: "email", providerRef: ref2, claimedStatus: "sent", contactId: CT, claimedByManager: "deal_coordinator" as never })
  // SendGrid's verbatim status vocabulary (TRUTH_SOURCES.email.contradicts): "bounce", never normalised.
  const bad = await ingestProviderTruth({ channel: "email", providerRef: ref2, truth: { status: "bounce", at: nowIso() } })
  c.step("POSITIVE CONTROL: a contradicting truth flips the claim to CONTRADICTED and tells a manager once", bad.ok && bad.verdict === "contradicted" && bad.escalated && (svc.tables.manager_signals ?? []).length > 0, JSON.stringify(bad).slice(0, 160))
  const foreign = await ingestProviderTruth({ channel: "email", providerRef: "not-ours", truth: { status: "delivered", at: nowIso() } })
  c.step("reconciliation: an unknown provider ref is NOT ours — no row is invented", foreign.ok && foreign.verdict === null && !svc.tables.outcome_reconciliations?.some((r) => r.provider_ref === "not-ours"), foreign.reason ?? "")
  c.blind("The PORTAL release opens no agent_action_ledger row at HEAD (the ledger cycle is handed to provider dispatchers only) — reported under Outside-lane corrections, not patched here.")
  c.blind("No email/SMS/mail/voice provider is called: the portal hop is the only delivery; the email claim/truth pair models the webhook's report (the dispatcher's own egress proofs: egress-send-guard, portal-e2e).")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
