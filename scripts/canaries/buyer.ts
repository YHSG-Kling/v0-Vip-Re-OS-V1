/**
 * scripts/canaries/buyer.ts — BUYER canary:
 *   contact → qualification → search → journey
 * through lib/buyer-lifecycle (emitLifecycleTransition, checkFinancialVerification,
 * isSearchAllowed — the gate that keeps an unverified buyer out of search) and
 * lib/kernel/journey-snapshot.ts composeJourneySnapshot (the journey reading).
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"

export async function run() {
  const c = canary("Buyer: contact → qualification → search → journey")
  const B = uuid(), U = uuid(), AG = uuid(), CT = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-buyer` }],
    users: [{ id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, is_active: true }],
    contacts: [{ id: CT, brokerage_id: B, agent_id: AG, first_name: "Jordan", last_name: "Canary", email: `jordan@${CANARY_EMAIL_DOMAIN}`, contact_type: "buyer", tcpa_consent: true, notes: CANARY_TAG }],
  })
  setSvc(svc)
  const { emitLifecycleTransition, getCurrentBuyerState } = await import("../../lib/buyer-lifecycle/lifecycle-logger")
  const { isSearchAllowed } = await import("../../lib/buyer-lifecycle/gating-helpers")
  const { checkFinancialVerification } = await import("../../lib/buyer-lifecycle/financial-verification")
  const t1 = await emitLifecycleTransition({ contactId: CT, fromState: null, toState: "BUYER_CONTACT_CREATED", triggeredBy: "system", authorityRole: "system", userId: U, sourceSystem: "canary", brokerageId: B } as never)
  c.step("contact: the buyer enters the lifecycle (BUYER_CONTACT_CREATED transition logged)", t1.success && (await getCurrentBuyerState(CT)) === "BUYER_CONTACT_CREATED", t1.error ?? "")
  const blocked = await isSearchAllowed(CT)
  c.step("qualification GATE: an unverified buyer is NOT allowed to search (positive control)", !blocked.allowed && (blocked.blockers ?? []).length > 0, `${blocked.reason} [${(blocked.blockers ?? []).join(",")}]`)
  const { error: actErr } = await svc.from("activities").insert({ brokerage_id: B, entity_type: "contact", entity_id: CT, activity_type: "buyer.pre_approval.uploaded", agent_user_id: U, metadata: { lender: "stub", tag: CANARY_TAG }, created_at: nowIso() })
  const fv = await checkFinancialVerification({ contactId: CT })
  c.step("qualification: a pre-approval upload is READ back as financial verification", !actErr && fv.isVerified, `type=${String((fv as { verificationType?: string }).verificationType)}`)
  const t2 = await emitLifecycleTransition({ contactId: CT, fromState: "BUYER_CONTACT_CREATED", toState: "BUYER_FINANCIALLY_VERIFIED", triggeredBy: "system", authorityRole: "system", userId: U, sourceSystem: "canary", brokerageId: B } as never)
  const t3 = await emitLifecycleTransition({ contactId: CT, fromState: "BUYER_FINANCIALLY_VERIFIED", toState: "BUYER_SEARCHING", triggeredBy: "system", authorityRole: "system", userId: U, sourceSystem: "canary", brokerageId: B } as never)
  c.step("qualification: verified → searching transitions land", t2.success && t3.success && (await getCurrentBuyerState(CT)) === "BUYER_SEARCHING", t2.error ?? t3.error ?? "")
  const open = await isSearchAllowed(CT)
  c.step("search: the SAME gate now admits the verified, searching buyer", open.allowed === true, open.reason ?? "allowed")
  const { composeJourneySnapshot } = await import("../../lib/kernel/journey-snapshot")
  let journeyOk = false, journeyEv = ""
  try {
    const snap = composeJourneySnapshot({ contact: { id: CT, contact_type: "buyer", buyer_state: "BUYER_SEARCHING" }, activities: svc.tables.activities ?? [], transactions: [], listings: [], offers: [], appointments: [] } as never)
    journeyOk = !!snap && typeof snap === "object"
    journeyEv = JSON.stringify(snap).slice(0, 160)
  } catch (e) { journeyEv = (e as Error).message }
  c.step("journey: composeJourneySnapshot renders a snapshot for the buyer", journeyOk, journeyEv)
  // The lifecycle logger's one evidence table is lifecycle_events (lib/buyer-lifecycle/lifecycle-logger.ts:168).
  const evs = (svc.tables.lifecycle_events ?? []).filter((e) => e.entity_id === CT && e.brokerage_id === B)
  c.step("evidence: every transition is a lifecycle_events row on THIS tenant (3 transitions)", evs.length >= 3, `rows=${evs.length}: ${evs.map((e) => String(e.event_type)).join(",")}`.slice(0, 160))
  c.blind("Property SEARCH itself (lib/buyer-search/search-engine.ts searchPropertiesCore) is not executed — it reaches the listing feed provider when the tenant's source is rentcast/idx; the gate in front of it is what this canary proves.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
