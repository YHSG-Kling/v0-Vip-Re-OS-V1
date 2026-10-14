"use server"

// app/actions/brokerage-transfer.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE DOORS OF THE TRANSFER RAIL (wave 141, lane 141A). Every export is a public
// HTTP endpoint (CLAUDE.md §4): the tenant comes from the SESSION on every call,
// no brokerage id is accepted from the body, and every refusal is a readable
// message. The rail itself is lib/kernel/brokerage-transfer.ts; this file only
// gates and delegates.
//
//   · the ADOPTING side (Settings → Users, the "Adopt an independent agent or
//     team" card): a tenant admin of the session brokerage files a request by
//     the agent's ACCOUNT EMAIL (never a brokerage name), lists its requests,
//     cancels one before it migrates, or retries a stalled migration.
//   · the ADOPTED side (Settings → General, the "Brokerage affiliation" card):
//     the independent workspace's owner sees the request addressed to them and
//     consents (with a statement recorded as evidence) or declines. Consent runs
//     the migration immediately in the same call.
//
// Gates: requireCaller (session → users row → tenant) + resolveTenantAdmin
// (user_type OR a tenant role grant — the full predicate, never a retyped role
// list) for the adopting side; requireTenantAdminOrSoloOwner for the adopted
// side (a solo owner's seat may carry user_type 'agent' — tier parity).
// Platform staff never bypass these (no superadmin fallback): staff act as the
// tenant through the god console's act-as seam like any other tenant surface.

import { createServiceClient } from "@/lib/supabase/service"
import { requireCaller, requireTenantAdminOrSoloOwner } from "@/lib/auth/require-caller"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import {
  requestBrokerageTransfer, recordBrokerageTransferConsent, cancelBrokerageTransferRequest,
  runBrokerageTransferMigration, listBrokerageTransferRequests, transferStepsPending,
  TRANSFER_TARGET_ROLES,
  type TransferRequestRow, type TransferTargetRole, type TransferStep,
} from "@/lib/kernel/brokerage-transfer"

export interface TransferRequestView {
  id: string
  status: TransferRequestRow["status"]
  targetRole: TransferTargetRole
  reason: string | null
  sourceBrokerageId: string
  targetBrokerageId: string
  sourceName: string | null
  targetName: string | null
  subjectEmail: string | null
  createdAt: string
  effectiveAt: string | null
  completedAt: string | null
  consentAt: string | null
  pendingSteps: TransferStep[]
  lastError: string | null
  billingPending: boolean
  ready: boolean | null
  counts: Record<string, number>
}

async function viewOf(svc: any, rows: TransferRequestRow[]): Promise<TransferRequestView[]> {
  const ids = Array.from(new Set(rows.flatMap((r) => [r.source_brokerage_id, r.target_brokerage_id])))
  const userIds = Array.from(new Set(rows.map((r) => r.subject_user_id)))
  const names = new Map<string, string | null>()
  const emails = new Map<string, string | null>()
  if (ids.length) {
    const { data } = await svc.from("brokerages").select("id, name").in("id", ids)
    for (const b of (data ?? []) as Array<{ id: string; name: string | null }>) names.set(b.id, b.name)
  }
  if (userIds.length) {
    const { data } = await svc.from("users").select("id, email").in("id", userIds)
    for (const u of (data ?? []) as Array<{ id: string; email: string | null }>) emails.set(u.id, u.email)
  }
  return rows.map((r) => ({
    id: r.id, status: r.status, targetRole: r.target_role, reason: r.reason,
    sourceBrokerageId: r.source_brokerage_id, targetBrokerageId: r.target_brokerage_id,
    sourceName: names.get(r.source_brokerage_id) ?? null, targetName: names.get(r.target_brokerage_id) ?? null,
    subjectEmail: emails.get(r.subject_user_id) ?? null,
    createdAt: r.created_at, effectiveAt: r.effective_at, completedAt: r.completed_at,
    consentAt: r.consent?.decision === "consent" ? r.consent.at : null,
    pendingSteps: r.status === "migrating" || r.status === "consented" ? transferStepsPending(r.migration) : [],
    lastError: r.migration?.last_error ?? null,
    billingPending: r.billing_handoff ? !r.billing_handoff.ok : false,
    ready: r.readiness?.ready ?? null,
    counts: r.migration?.counts ?? {},
  }))
}

/** The adopting side's gate: session tenant + tenant admin (user_type or grant). */
async function requireAdoptingAdmin(): Promise<{ ok: true; userId: string; brokerageId: string; svc: any } | { ok: false; error: string }> {
  const caller = await requireCaller()
  if (!caller.ok) return { ok: false, error: caller.error }
  const admin = await resolveTenantAdmin(caller.supabase, caller.userId, { user_type: caller.userType, brokerage_id: caller.brokerageId })
  if (!admin.ok) return { ok: false, error: `Could not resolve your permissions: ${admin.error}` }
  if (!admin.isTenantAdmin) return { ok: false, error: "Only a brokerage admin can adopt a workspace." }
  return { ok: true, userId: caller.userId, brokerageId: caller.brokerageId, svc: createServiceClient() }
}

// ── Adopting side ─────────────────────────────────────────────────────────────

export interface AdoptionPanel {
  canManage: boolean
  planTier: string | null
  roles: readonly TransferTargetRole[]
  requests: TransferRequestView[]
}

export async function getBrokerageAdoptionPanelAction(): Promise<{ ok: true; panel: AdoptionPanel } | { ok: false; error: string }> {
  const gate = await requireAdoptingAdmin()
  if (!gate.ok) return gate
  const { data: tenant, error: tErr } = await gate.svc.from("brokerages").select("plan_tier").eq("id", gate.brokerageId).maybeSingle()
  if (tErr) return { ok: false, error: `Could not read your plan: ${tErr.message}` }
  const list = await listBrokerageTransferRequests(gate.svc, { brokerageId: gate.brokerageId, side: "target" })
  if (!list.ok) return { ok: false, error: `Could not list adoption requests: ${list.error}` }
  const planTier = (tenant as { plan_tier?: string | null } | null)?.plan_tier ?? null
  return { ok: true, panel: { canManage: planTier !== "solo_agent", planTier, roles: TRANSFER_TARGET_ROLES, requests: await viewOf(gate.svc, list.requests) } }
}

export async function requestBrokerageAdoptionAction(input: { subjectEmail: string; targetRole: TransferTargetRole; reason?: string | null }): Promise<{ ok: true; request: TransferRequestView } | { ok: false; error: string }> {
  const gate = await requireAdoptingAdmin()
  if (!gate.ok) return gate
  const r = await requestBrokerageTransfer(gate.svc, { targetBrokerageId: gate.brokerageId, initiatedByUserId: gate.userId, subjectEmail: input?.subjectEmail ?? "", targetRole: input?.targetRole, reason: input?.reason ?? null })
  if (!r.ok) return r
  return { ok: true, request: (await viewOf(gate.svc, [r.request]))[0] }
}

export async function cancelBrokerageAdoptionAction(input: { requestId: string; reason?: string | null }): Promise<{ ok: boolean; error?: string }> {
  const gate = await requireAdoptingAdmin()
  if (!gate.ok) return gate
  return cancelBrokerageTransferRequest(gate.svc, { requestId: String(input?.requestId ?? ""), actor: { userId: gate.userId, brokerageId: gate.brokerageId, kind: "target_admin" }, reason: input?.reason ?? null })
}

/** Retry a stalled migration (consented / migrating) — resumes only the steps that did not finish. */
export async function retryBrokerageAdoptionAction(input: { requestId: string }): Promise<{ ok: boolean; error?: string; completed?: boolean; stalledAt?: TransferStep | null }> {
  const gate = await requireAdoptingAdmin()
  if (!gate.ok) return gate
  const r = await runBrokerageTransferMigration(gate.svc, { requestId: String(input?.requestId ?? ""), actor: { userId: gate.userId, brokerageId: gate.brokerageId, kind: "target_admin" } })
  return r.ok ? { ok: true, completed: true } : { ok: false, error: r.error, completed: false, stalledAt: r.stalledAt }
}

// ── Adopted side ──────────────────────────────────────────────────────────────

export async function listIncomingTransferRequestsAction(): Promise<{ ok: true; requests: TransferRequestView[] } | { ok: false; error: string }> {
  const owner = await requireTenantAdminOrSoloOwner()
  if (!owner.ok) return owner
  const svc = createServiceClient()
  const list = await listBrokerageTransferRequests(svc, { brokerageId: owner.brokerageId, side: "source" })
  if (!list.ok) return { ok: false, error: `Could not list requests: ${list.error}` }
  return { ok: true, requests: await viewOf(svc, list.requests) }
}

export async function respondToBrokerageTransferAction(input: { requestId: string; decision: "consent" | "decline"; statement: string }): Promise<{ ok: boolean; error?: string; status?: TransferRequestRow["status"]; completed?: boolean; stalledAt?: TransferStep | null; migrationError?: string }> {
  const owner = await requireTenantAdminOrSoloOwner()
  if (!owner.ok) return owner
  if (input?.decision !== "consent" && input?.decision !== "decline") return { ok: false, error: "Answer with consent or decline." }
  const svc = createServiceClient()
  const r = await recordBrokerageTransferConsent(svc, {
    requestId: String(input.requestId ?? ""), decision: input.decision, statement: String(input.statement ?? ""), channel: "settings_ui",
    actor: { userId: owner.userId, brokerageId: owner.brokerageId, kind: "subject" },
  })
  if (!r.ok) return { ok: false, error: r.error }
  const m = r.migration
  return { ok: true, status: r.request.status, completed: m?.ok === true, stalledAt: m && !m.ok ? m.stalledAt : null, migrationError: m && !m.ok ? m.error : undefined }
}
