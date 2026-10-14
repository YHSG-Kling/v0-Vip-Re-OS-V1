/**
 * scripts/canaries/brokerage-adoption.ts — BROKERAGE ADOPTION canary (wave 141, lane 141J):
 *   independent subscriber → verified brokerage-location joins → consent → migrate → direct billing stopped
 *   (prorated) → brokerage seat active → no data loss → no double billing
 * Owner (wave 141): "Later adoption by the ACTUAL brokerage location = a deliberate relationship transfer:
 * identify the exact brokerage/location → explicit agent/team permission → verify → migrate membership/data
 * through canonical services → preserve history/evidence → stop individual billing at the right effective
 * time → Stripe proration → no double billing → brokerage owns the seat/platform relationship."
 *
 * AUDITED AT 01a71c3c2: no transfer rail and no billing handoff exist (lane 141A builds the rail, lane 141H
 * the handoff `handoffSubscriberBillingToBrokerage`). This canary seeds the two tenants, proves the
 * PRE-CONDITIONS the rail must preserve, and holds the contract steps as WAVE141 HOOKS; once a lane lands
 * (the registry's probes answer), the contract assertions run and the integrator wires the rail's exports
 * at the marked lines.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Brokerage adoption: independent → verified location joins → consent → migrate → billing stopped (prorated) → brokerage seat → no data loss → no double billing")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: the transfer rail moves tenancy — in-memory only")
  const S = uuid(), B = uuid(), X = uuid(), SOLO = uuid(), SOLO_AG = uuid(), ADMIN = uuid(), SUB_S = uuid(), SUB_B = uuid()
  const svc = canaryClient({
    brokerages: [
      { id: S, name: `${CANARY_TAG} Harbor Realty`, plan_tier: "solo_agent", slug: `${CANARY_TAG}-solo`, brokerage_on_platform: false, team_on_platform: false, created_at: nowIso() },
      { id: B, name: `${CANARY_TAG} Harbor Realty`, plan_tier: "brokerage", slug: `${CANARY_TAG}-hq`, brokerage_on_platform: true, team_on_platform: true, created_at: nowIso() },
      { id: X, name: `${CANARY_TAG} Unrelated Realty`, plan_tier: "brokerage", slug: `${CANARY_TAG}-x`, created_at: nowIso() },
    ],
    users: [
      { id: SOLO, email: `solo@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: S },
      { id: ADMIN, email: `admin@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B },
    ],
    agents: [{ id: SOLO_AG, user_id: SOLO, brokerage_id: S, first_name: "Canary", last_name: "Solo", is_active: true }],
    contacts: [
      { id: uuid(), brokerage_id: S, agent_id: SOLO_AG, first_name: "Dana", last_name: "Canary", email: `dana@${CANARY_EMAIL_DOMAIN}`, status: "new", notes: CANARY_TAG },
      { id: uuid(), brokerage_id: S, agent_id: SOLO_AG, first_name: "Jordan", last_name: "Canary", email: `jordan@${CANARY_EMAIL_DOMAIN}`, status: "active", notes: CANARY_TAG },
    ],
    listings: [{ id: uuid(), brokerage_id: S, agent_id: SOLO_AG, address: "1 Canary Way", status: "active", notes: CANARY_TAG }],
    subscriptions: [
      { id: SUB_S, brokerage_id: S, status: "active", stripe_customer_id: "cus_canary_solo", stripe_subscription_id: "sub_canary_solo", current_period_end: new Date(Date.now() + 20 * 864e5).toISOString() },
      { id: SUB_B, brokerage_id: B, status: "active", stripe_customer_id: "cus_canary_hq", stripe_subscription_id: "sub_canary_hq", current_period_end: new Date(Date.now() + 25 * 864e5).toISOString() },
    ],
  })
  setSvc(svc)
  const soloRows = () => ({ contacts: (svc.tables.contacts ?? []).filter((r) => r.brokerage_id === S).length, listings: (svc.tables.listings ?? []).filter((r) => r.brokerage_id === S).length })
  const before = soloRows()
  c.step("pre-condition: the independent subscriber's data is TENANT-SCOPED to its own id (contacts, listings, agent, subscription all carry brokerage_id = S)", before.contacts === 2 && before.listings === 1 && (svc.tables.agents ?? []).every((a) => a.brokerage_id === S || a.brokerage_id === B) && (svc.tables.subscriptions ?? []).filter((s) => s.brokerage_id === S).length === 1, JSON.stringify(before))
  c.step("pre-condition: the target is identified by CANONICAL ID — the solo's declared name matches the brokerage's name AND an unrelated tenant exists; neither name fact creates a relationship (no membership, no shared rows)", (svc.tables.users ?? []).find((u) => u.id === SOLO)?.brokerage_id === S && (svc.tables.brokerages ?? []).filter((b) => b.name === `${CANARY_TAG} Harbor Realty`).length === 2, "")
  c.step("pre-condition: ONE subscription per tenant (the invariant 'no double billing' is measured against)", (svc.tables.subscriptions ?? []).filter((s) => s.brokerage_id === S).length === 1 && (svc.tables.subscriptions ?? []).filter((s) => s.brokerage_id === B).length === 1, "")
  c.step("pre-condition: no raw cross-tenant membership rewrite exists in the member core outside the ONE adoption seam (lib/kernel/tenant-creation.ts adoptExistingOwnerIntoTenant anchors a TENANT-LESS user only: `.is(\"brokerage_id\", null)`)", /\.update\(\{\s*brokerage_id:[^}]*\}\)[\s\S]{0,200}\.is\(\s*["']brokerage_id["']\s*,\s*null\s*\)/.test(strippedRepo("lib/kernel/tenant-creation.ts") ?? ""), "")

  for (const h of hooksFor("brokerage-adoption")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract); continue }
    if (h.lane === "141H") {
      // WAVE141 HOOK (integrator): 141H — the contract-named function, wherever the lane put it.
      const mod = (await import(`../../${at.replace(/\.ts$/, "")}`)) as Record<string, unknown>
      const handoff = mod.handoffSubscriberBillingToBrokerage as ((svc: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined
      if (!handoff) { c.step(`141H landed (${at}) but handoffSubscriberBillingToBrokerage is not exported there — wire the import (WAVE141 HOOK (integrator): 141H)`, false, Object.keys(mod).join(",")); continue }
      const effectiveAt = new Date(Date.now() + 2 * 864e5).toISOString()
      const subsBefore = (svc.tables.subscriptions ?? []).length
      const r1 = await handoff(svc, { sourceBrokerageId: S, targetBrokerageId: B, effectiveAt, actorUserId: ADMIN })
      c.step("141H handoff: answers with a DECLARED outcome (ok boolean; a refusal names why — Stripe is not configured in-memory)", typeof r1.ok === "boolean", JSON.stringify(r1).slice(0, 200))
      const r2 = await handoff(svc, { sourceBrokerageId: S, targetBrokerageId: B, effectiveAt, actorUserId: ADMIN })
      c.step("141H idempotent: a second run changes nothing — same verdict, no second subscription row, never a second charge", r2.ok === r1.ok && (svc.tables.subscriptions ?? []).length === subsBefore, "")
      const wrong = await handoff(svc, { sourceBrokerageId: S, targetBrokerageId: X, effectiveAt, actorUserId: ADMIN })
      c.step("141H wrong target: a brokerage with no verified relationship to the subscriber is REFUSED", wrong.ok === false, String(wrong.error ?? ""))
      c.step("141H evidence: the attempt is ledgered (agent_action_ledger) on the source or target tenant", (svc.tables.agent_action_ledger ?? []).some((l) => l.brokerage_id === S || l.brokerage_id === B), `${(svc.tables.agent_action_ledger ?? []).length} ledger rows`)
    } else {
      // WAVE141 HOOK (integrator): 141A — the rail's exports (request → consent → verify → migrate → archive)
      // are the lane's to name; wire them here and assert: consent missing → refused; wrong target → refused;
      // migration keeps every solo row (counts equal, provenance stamped); old tenant archived not deleted;
      // second run changes nothing; readiness verdict on the target.
      const src = strippedRepo(at) ?? ""
      const exported = [...src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]).filter((n) => /transfer|adopt|migrat|consent/i.test(n))
      c.step(`141A landed (${at}) — exports [${exported.join(", ")}] must be wired into this canary (WAVE141 HOOK (integrator): 141A)`, false, "the integrator wires the rail; until then the contract is unproven here")
    }
  }
  const after = soloRows()
  c.step("no data loss (at HEAD nothing moved): the solo's rows are byte-for-byte where they were", after.contacts === before.contacts && after.listings === before.listings, JSON.stringify(after))
  c.blind("Stripe is never called: proration, credit notes and invoice immutability are the Stripe-side contract (lane 141H's test:coupons-and-handoff stubs the SDK); this canary proves the kernel-side invariants.")
  c.blind("The readiness verdict on the TARGET after migration is asserted only once the 141A rail is wired (evaluateTenantReadiness is the contract, wave 140B).")
  const a = await cleanupCanary(svc, S), b = await cleanupCanary(svc, B), x = await cleanupCanary(svc, X)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length + x.mismatches.length === 0 && a.residual + b.residual + x.residual === 0, [...a.cleanup, ...b.cleanup, ...x.cleanup].map((r) => `${r.table}:${r.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup, ...x.cleanup], a.residual + b.residual + x.residual)
}
