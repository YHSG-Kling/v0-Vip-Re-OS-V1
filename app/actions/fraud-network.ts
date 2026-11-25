"use server"

/**
 * app/actions/fraud-network.ts — the session doors of the Real Estate Trust & Fraud Intelligence Network (wave 156,
 * lane 156J). Every export is a public endpoint (CLAUDE.md §4): each one resolves the caller from the SESSION first
 * (lib/auth/require-caller.ts resolveCallerIdentity — the REAL seat, never an impersonated context and never a body
 * field), gates, and only then uses the service client. Tenant doors admit FRAUD_NETWORK_PARTICIPANT_USER_TYPES; staff
 * doors admit platform staff holding the `support` capability (lib/platform/require-capability.ts), write doors with
 * write access. The domain rules live in lib/fraud-network/network.ts; this file never decides them.
 * Owner: the Compliance Manager (`compliance_officer`) with platform safety staff as the human moderators.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveCallerIdentity } from "@/lib/auth/require-caller"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import type { IncidentInput, TenantActor, StaffActor } from "@/lib/fraud-network/network"

type Refusal = { ok: false; error: string }
const net = () => import("@/lib/fraud-network/network")

/** The SESSION seat as a tenant actor, or a refusal. Not exported (a "use server" export is a public endpoint). */
async function tenantSeat(): Promise<{ ok: true; actor: TenantActor } | Refusal> {
  const id = await resolveCallerIdentity()
  if (!id.ok) return { ok: false, error: "Sign in to use the fraud network." }
  if (!id.brokerageId) return { ok: false, error: "Your account is not linked to a business." }
  const { isParticipant, tenantMayParticipate } = await net()
  if (!isParticipant({ userType: id.userType })) return { ok: false, error: "Your seat cannot use the fraud network." }
  const svc = createServiceClient()
  // A paused (suspended) or departed tenant's seats do not take part — the tenant-lifecycle vocabulary decides.
  const standing = await tenantMayParticipate(svc, id.brokerageId)
  if (!standing.ok) return standing
  const { data: a, error } = await svc.from("agents").select("id").eq("user_id", id.userId).maybeSingle()
  if (error) return { ok: false, error: "Your seat could not be checked right now." }
  return { ok: true, actor: { kind: "tenant", userId: id.userId, brokerageId: id.brokerageId, userType: String(id.userType ?? "").toLowerCase(), agentId: (a as { id?: string } | null)?.id ?? null } }
}

/** Platform safety staff (capability `support`); write doors require write access. Fail closed. */
async function staffSeat(write: boolean): Promise<{ ok: true; actor: StaffActor } | Refusal> {
  const gate = await requirePlatformCapability("support", write ? { requireWrite: true } : {})
  if (!gate.ok || !gate.userId) return { ok: false, error: "Platform safety staff only." }
  return { ok: true, actor: { kind: "staff", userId: gate.userId, role: String(gate.role ?? ""), canWrite: gate.access === "write" } }
}

/** Who is looking — drives which panels the page shows. */
export async function getFraudNetworkViewer(): Promise<{ tenant: boolean; reviewer: boolean; staff: boolean }> {
  const t = await tenantSeat()
  const s = await requirePlatformCapability("support")
  const { isCaseReviewer } = await net()
  return { tenant: t.ok, reviewer: t.ok && isCaseReviewer(t.actor), staff: !!s.ok }
}

// ── tenant doors ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function submitFraudIncident(input: IncidentInput) {
  const s = await tenantSeat()
  if (!s.ok) return s
  const { submitIncidentCase } = await net()
  const { requireDealDesk } = await import("@/lib/transactions/role-guard")
  const seat = { userId: s.actor.userId, userType: s.actor.userType, brokerageId: s.actor.brokerageId, agentId: s.actor.agentId }
  return submitIncidentCase(createServiceClient(), s.actor, input, { askDealDesk: async (tx) => requireDealDesk(tx, seat) })
}

export async function listMyFraudCases() {
  const s = await tenantSeat()
  if (!s.ok) return s
  return (await net()).listCases(createServiceClient(), s.actor)
}

/** Staff first (a moderator reads any tenant's case), else the tenant seat (its own rules: reporter or case reviewer). */
async function caseReader(): Promise<TenantActor | StaffActor | null> {
  const st = await staffSeat(false)
  if (st.ok) return st.actor
  const t = await tenantSeat()
  return t.ok ? t.actor : null
}

export async function getFraudCase(caseId: string) {
  const actor = await caseReader()
  if (!actor) return { ok: false as const, error: "Case not found." }
  return (await net()).readCase(createServiceClient(), actor, caseId)
}

export async function requestFraudEvidenceView(caseId: string) {
  const actor = await caseReader()
  if (!actor) return { ok: false as const, error: "Case not found." }
  return (await net()).evidenceFileView(createServiceClient(), actor, caseId)
}

/** Add an evidence FILE to a case: metadata is stripped first; until the private bucket exists the door refuses with the
 *  honest state and says what it removed. The bytes arrive base64-encoded (a server action body). */
export async function uploadFraudEvidenceFile(caseId: string, kind: string, label: string, base64: string) {
  const s = await tenantSeat()
  if (!s.ok) return s
  const bytes = new Uint8Array(Buffer.from(String(base64 ?? ""), "base64"))
  return (await net()).uploadEvidenceFile(createServiceClient(), s.actor, { caseId, kind, label, bytes })
}

export async function withdrawFraudCase(caseId: string) {
  const s = await tenantSeat()
  if (!s.ok) return s
  return (await net()).withdrawCase(createServiceClient(), s.actor, caseId)
}

export async function appealFraudCaseDecision(caseId: string, statement: string) {
  const s = await tenantSeat()
  if (!s.ok) return s
  return (await net()).appealCase(createServiceClient(), s.actor, caseId, statement)
}

export async function listFraudBulletins(filter: { typology?: string | null; jurisdiction?: string | null } = {}) {
  const t = await tenantSeat()
  if (t.ok) return (await net()).listBulletins(createServiceClient(), t.actor, filter)
  const st = await staffSeat(false)
  if (!st.ok) return st
  return (await net()).listBulletins(createServiceClient(), st.actor, filter)
}

export async function openFraudBulletin(bulletinId: string) {
  const s = await tenantSeat()
  if (!s.ok) return s
  return (await net()).openBulletin(createServiceClient(), s.actor, bulletinId)
}

export async function setFraudWarningSubscription(input: { typology?: string | null; jurisdiction?: string | null; on: boolean }) {
  const s = await tenantSeat()
  if (!s.ok) return s
  return (await net()).setSubscription(createServiceClient(), s.actor, input)
}

export async function listMyFraudWarningSubscriptions() {
  const s = await tenantSeat()
  if (!s.ok) return [] as Array<{ id: string; typology: string | null; jurisdiction: string | null }>
  return (await net()).listSubscriptions(createServiceClient(), s.actor)
}

export async function requestFraudBulletinCorrection(bulletinId: string, statement: string) {
  const s = await tenantSeat()
  if (!s.ok) return s
  return (await net()).tenantCorrectionRequest(createServiceClient(), s.actor, bulletinId, statement)
}

export async function addFraudBulletinToTopicPool(bulletinId: string) {
  const s = await tenantSeat()
  if (!s.ok) return s
  return (await net()).addBulletinToTopicPool(createServiceClient(), s.actor, bulletinId)
}

export async function getFraudNetworkMetrics() {
  const st = await staffSeat(false)
  if (st.ok) return (await net()).fraudNetworkMetrics(createServiceClient(), { kind: "platform" })
  const s = await tenantSeat()
  if (!s.ok) return s
  return (await net()).fraudNetworkMetrics(createServiceClient(), { kind: "tenant", brokerageId: s.actor.brokerageId })
}

// ── platform safety staff doors ───────────────────────────────────────────────────────────────────────────────────

export async function listFraudModerationQueue() {
  const s = await staffSeat(false)
  if (!s.ok) return s
  return (await net()).moderationQueue(createServiceClient(), s.actor)
}

export async function addFraudCaseModerationNote(caseId: string, note: string, status?: string | null) {
  const s = await staffSeat(true)
  if (!s.ok) return s
  return (await net()).addModerationNote(createServiceClient(), s.actor, caseId, note, status)
}

export async function draftFraudBulletinFromCase(caseId: string) {
  const s = await staffSeat(true)
  if (!s.ok) return s
  return (await net()).draftBulletinFromCase(createServiceClient(), s.actor, caseId)
}

export async function linkFraudCaseToBulletin(bulletinId: string, caseId: string) {
  const s = await staffSeat(true)
  if (!s.ok) return s
  return (await net()).linkCaseToBulletin(createServiceClient(), s.actor, bulletinId, caseId)
}

export async function updateFraudBulletinDraft(bulletinId: string, fields: Record<string, unknown>) {
  const s = await staffSeat(true)
  if (!s.ok) return s
  return (await net()).updateBulletinDraft(createServiceClient(), s.actor, bulletinId, fields)
}

export async function publishFraudBulletin(bulletinId: string, ctx: { attestNoPersonIdentified: boolean; legalReviewConfirmed: boolean; verificationNote: string }) {
  const s = await staffSeat(true)
  if (!s.ok) return s
  return (await net()).publishBulletin(createServiceClient(), s.actor, bulletinId, ctx)
}

/** The SECOND moderator's review of a name-review hold (the moderator who triggered it cannot clear it). */
export async function clearFraudNameReview(bulletinId: string, note: string) {
  const s = await staffSeat(true)
  if (!s.ok) return s
  return (await net()).clearNameReview(createServiceClient(), s.actor, bulletinId, note)
}

export async function correctFraudBulletin(bulletinId: string, fields: Record<string, unknown>, reason: string) {
  const s = await staffSeat(true)
  if (!s.ok) return s
  return (await net()).correctBulletin(createServiceClient(), s.actor, bulletinId, fields, reason)
}

export async function takeDownFraudBulletin(bulletinId: string, reason: string) {
  const s = await staffSeat(true)
  if (!s.ok) return s
  return (await net()).takeDownBulletin(createServiceClient(), s.actor, bulletinId, reason)
}

export async function recordFraudSubjectCorrection(input: { bulletinId: string; channel: string; statement: string; supportTicketId?: string | null }) {
  const s = await staffSeat(true)
  if (!s.ok) return s
  return (await net()).recordSubjectCorrection(createServiceClient(), s.actor, input)
}

export async function resolveFraudCorrectionRequest(input: { requestId: string; outcome: "corrected" | "taken_down" | "rejected"; resolution: string; changes?: Record<string, unknown> }) {
  const s = await staffSeat(true)
  if (!s.ok) return s
  return (await net()).resolveCorrection(createServiceClient(), s.actor, input)
}
