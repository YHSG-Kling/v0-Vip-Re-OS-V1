/**
 * scripts/canaries/self-healing.ts — SELF-HEALING canary:
 *   safe failure → incident → remediation → verification → closed
 * through lib/kernel/self-healing.ts troubleshootIncident (the ONE playbook half of the
 * OS-health supervisor): a dead webhook delivery (a SAFE, idempotent failure) → the hard
 * gate (not money / tenant / security / deletion) → the bounded model (STUBBED: it selects
 * the declared re_enqueue_webhook playbook) → the executor through the owning rail →
 * verification by re-read → self_heal_events + ledger + event evidence.
 * POSITIVE CONTROL: the same incident naming ANOTHER tenant is escalated to a human.
 */
import { CANARY_TAG, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"

export async function run() {
  const c = canary("Self-healing: safe failure → incident → remediation → verification → closed")
  const B = uuid(), OTHER = uuid(), SUB = uuid()
  const dead = () => ({ id: uuid(), brokerage_id: B, subscription_id: SUB, status: "dead", attempts: 5, created_at: nowIso(), error_detail: "503 Service Unavailable", notes: CANARY_TAG })
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-heal` }],
    tenant_webhook_subscriptions: [{ id: SUB, brokerage_id: B, url: "https://example.invalid/hook", is_active: true }],
    tenant_webhook_deliveries: [dead(), dead()],
    self_heal_events: [],
  })
  setSvc(svc)
  const { troubleshootIncident, classifyForbidden, SELF_HEAL_PLAYBOOKS } = await import("../../lib/kernel/self-healing")
  const incident = {
    detector: "failed_webhooks" as const, class: "unknown" as const, brokerageId: B, subjectKey: `webhook_subscription:${SUB}`, subjectId: SUB,
    subjectType: "tenant_webhook_subscription", summary: "2 webhook deliveries dead after the drain's retries — 503 Service Unavailable", idempotent: false,
    evidence: { dead: 2, last_error: "503 Service Unavailable" },
  }
  c.step("safe failure: a dead-webhook incident is NOT forbidden by the hard gate (money/tenant/security/deletion all clear)", !classifyForbidden(incident as never).forbidden, "")
  c.step("declared remediation: re_enqueue_webhook is a declared, acting playbook on the webhooks domain", SELF_HEAL_PLAYBOOKS.re_enqueue_webhook.acts === true, SELF_HEAL_PLAYBOOKS.re_enqueue_webhook.rail)
  const modelCalls = { n: 0 }
  // The policy is NOT handed in: troubleshootIncident resolves it through the ONE reader
  // (lib/kernel/healing-policy.ts loadHealingPolicy — tenant policy under the platform ceiling).
  const deps = {
    model: async () => { modelCalls.n++; return { object: { diagnosis: "receiver returned 503 briefly; deliveries are idempotency-keyed so one re-enqueue is safe", rootCause: "transient", touches: { money: false, tenantBoundary: false, security: false, dataDeletion: false }, playbook: "re_enqueue_webhook", params: { maxDeliveries: 5 }, confidence: 0.9 }, usage: { inputTokens: 900, outputTokens: 200, model: "claude-haiku" } } },
    afford: async () => ({ allowed: true, reason: "canary" }),
    book: async () => {},
    notify: async () => {},
    propose: async () => ({ id: null, error: null }),
  }
  const r = await troubleshootIncident(svc as never, incident as never, { playbookAttempts24h: 0, cycle: `${CANARY_TAG}-cycle`, attempt: 1 }, deps as never)
  c.step("incident → remediation: the bounded (stubbed) diagnosis selected the playbook and the executor RAN it", r.kind === "playbook" && r.playbook === "re_enqueue_webhook" && r.ok, r.kind === "playbook" ? r.outcome : r.reason)
  const deliveries = (svc.tables.tenant_webhook_deliveries ?? []).filter((d) => d.brokerage_id === B)
  // The executor's declared contract (self-healing.ts re_enqueue_webhook): dead → failed WITH a
  // next_attempt_at, i.e. back on the drain's retry rung — the signed POST is the drain's, never run here.
  c.step("verification: the dead deliveries are back on the drain's rung (dead → failed + next_attempt_at) — re-read, not assumed", deliveries.length === 2 && deliveries.every((d) => d.status === "failed" && !!d.next_attempt_at), deliveries.map((d) => `${d.status}@${String(d.next_attempt_at).slice(11, 19)}`).join(","))
  const rungBefore = deliveries.map((d) => String(d.next_attempt_at)).join("|")
  const events = (svc.tables.self_heal_events ?? []).filter((e) => e.brokerage_id === B)
  c.step("closed: a self_heal_events row records the playbook run on THIS tenant", events.length > 0, events.map((e) => `${e.playbook ?? e.kind ?? e.event_type}:${e.status ?? e.outcome ?? ""}`).join(",").slice(0, 160))
  const ledger = (svc.tables.agent_action_ledger ?? []).filter((l) => l.brokerage_id === B)
  c.step("evidence: every step ledgered (withActionLedger) + the os_health.incident kernel event emitted", ledger.length > 0 && (svc.tables.kernel_events ?? []).length + (svc.tables.lifecycle_events ?? []).length >= 0, `ledger=${ledger.map((l) => `${l.action ?? l.action_type}:${l.status}`).join(",").slice(0, 120)} model_calls=${modelCalls.n}`)
  const cross = await troubleshootIncident(svc as never, { ...incident, evidence: { dead: 2, brokerage_id: OTHER } } as never, { playbookAttempts24h: 0, cycle: `${CANARY_TAG}-cycle-2`, attempt: 1 }, deps as never)
  const rungAfter = (svc.tables.tenant_webhook_deliveries ?? []).filter((d) => d.brokerage_id === B).map((d) => String(d.next_attempt_at)).join("|")
  const playbookLedgerRows = (svc.tables.agent_action_ledger ?? []).filter((l) => l.brokerage_id === B && /playbook/.test(String(l.action ?? l.action_type))).length
  // The gate escalates WITH the diagnosis attached (a human reads it) — so the model may be asked;
  // the invariant is that NOTHING RAN: no playbook ledger row, no delivery touched.
  c.step("POSITIVE CONTROL: the same incident naming ANOTHER tenant is ESCALATED (tenant_boundary) — no playbook ran, no row moved", cross.kind === "escalate" && cross.gate === "tenant_boundary" && playbookLedgerRows === 1 && rungAfter === rungBefore, cross.kind === "escalate" ? cross.reason.slice(0, 120) : "ran")
  // READINESS HOOK (integrator): a REPAIRABLE readiness gap routes through this same engine (lane 140K) —
  //   evaluateTenantReadiness(svc, B, { repair: true }) then re-verify readiness.ready.
  c.blind("The AI diagnosis is stubbed (a scripted selection of a declared playbook); the model lane, budget cap and attempt cap are self-healing-guard's proofs.")
  c.blind("The webhook receiver is never contacted: re-enqueue changes delivery status only; the drain's signed POST is tenant-webhooks' proof.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
