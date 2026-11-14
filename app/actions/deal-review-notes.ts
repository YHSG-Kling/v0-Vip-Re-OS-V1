"use server"

/**
 * COMPLIANCE REVIEW NOTES AND COORDINATOR FLAGS ON LISTINGS AND TRANSACTIONS (wave 153, lane 153C; directive §153C C1).
 *
 * Owner (verbatim, 2026-11-14): "the agetn takes charge and a transaction coordinator can see and assist active listings and
 * transactions, and compliance can review/make notes etc on listings and transactions".
 *
 * THE SURVIVOR IS `ai_assistant_notes` — the existing entity-scoped note store (entity_type / entity_id, transaction_id,
 * listing_id, note_text, note_type, role, source, created_by, brokerage_id; live CHECKs note_type ⊂ {…, observation, action_item, …}
 * and source ⊂ {ai_assistant, human, ai_draft_human_approved}). A person's review note is `source='human'`; no new table, no new
 * vocabulary. A REVIEW NOTE (note_type 'observation') needs the `annotate` capability — compliance and tenant admins, throughout the
 * deal's life, closed deals included. A FLAG (note_type 'action_item') needs `flag` — the agent, the deal's TC, compliance, admins,
 * the team lead — and also rings the owning agent's bell. Who may do what is lib/auth/deal-work-ownership.ts resolveDealWork, read
 * from the SESSION's own assignments; a vendor, a Contact or another tenant's seat is refused before anything is read.
 * Every export is a public endpoint (CLAUDE.md §4).
 */

import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { presentTenantMessage } from "@/lib/errors"

type Result<T = Record<string, never>> = ({ success: true } & T) | { success: false; error: string }
type Svc = ReturnType<typeof createServiceClient>
type NoteKind = "review_note" | "flag"

function refuse(what: string, saved = false): { success: false; error: string } {
  return { success: false, error: presentTenantMessage({ what, work: saved ? null : { state: "not_saved" }, next: "you" }).sentence }
}

/** The stage-aware access of the session user on a listing or a transaction (the same rule for both). */
async function entityAccess(svc: Svc, auth: { userId: string; brokerageId: string; userType: string | null }, entityType: "transaction" | "listing", entityId: string) {
  const { loadDealWorkAccess, resolveDealWork } = await import("@/lib/auth/deal-work-ownership")
  if (entityType === "transaction") {
    const r = await loadDealWorkAccess(svc, { userId: auth.userId, brokerageId: auth.brokerageId, userType: auth.userType, transactionId: entityId })
    return r.ok ? { ok: true as const, access: r.access, agentId: r.deal.agentId } : { ok: false as const }
  }
  const { data: listing, error } = await svc.from("listings").select("id, agent_id, status, lifecycle_stage").eq("id", entityId).eq("brokerage_id", auth.brokerageId).maybeSingle()
  if (error) return { ok: false as const }
  const [meAgent, grants] = await Promise.all([
    svc.from("agents").select("id").eq("user_id", auth.userId).eq("brokerage_id", auth.brokerageId).maybeSingle(),
    svc.from("user_role_assignments").select("role, brokerage_id").eq("user_id", auth.userId),
  ])
  if (meAgent.error || grants.error) return { ok: false as const }
  const l = (listing ?? null) as { agent_id: string | null; status: string | null; lifecycle_stage: string | null } | null
  const { isListingLive } = await import("@/lib/enrichment/deal-vocabulary")
  const myAgentId = ((meAgent.data ?? null) as { id?: string } | null)?.id ?? null
  const access = resolveDealWork({
    sameTenant: !!l, userType: auth.userType,
    grantedRoles: ((grants.data ?? []) as Array<{ role: string | null; brokerage_id: string | null }>).filter((g) => g.brokerage_id === auth.brokerageId && g.role).map((g) => String(g.role)),
    isOwningAgent: !!l && !!myAgentId && l.agent_id === myAgentId, isAssignedTc: false, isTeamLeadOfDealAgent: false,
    // a live listing reads as an active engagement; a closed / withdrawn one as finished (lib/enrichment/deal-vocabulary.ts)
    dealStatus: l && isListingLive(l) ? "active" : "closed", dealStage: null,
  })
  return { ok: true as const, access, agentId: l?.agent_id ?? null }
}

/** Record a compliance REVIEW NOTE or a FLAG on a listing or a transaction. */
export async function addDealReviewNoteAction(input: { entityType: "transaction" | "listing"; entityId: string; kind: NoteKind; body: string }): Promise<Result<{ noteId: string }>> {
  const auth = await requireCallerTenant()
  if (!auth.ok) return refuse(auth.error)
  const entityType = input?.entityType === "listing" ? "listing" : input?.entityType === "transaction" ? "transaction" : null
  const kind: NoteKind | null = input?.kind === "flag" ? "flag" : input?.kind === "review_note" ? "review_note" : null
  const body = String(input?.body ?? "").trim()
  if (!entityType || !kind || !input?.entityId) return refuse("Choose the listing or transaction and whether this is a review note or a flag")
  if (body.length < 3 || body.length > 4000) return refuse("Write the note (3 to 4,000 characters)")
  const svc = createServiceClient()
  const a = await entityAccess(svc, { userId: auth.userId, brokerageId: auth.brokerageId, userType: auth.userType ?? null }, entityType, input.entityId)
  if (!a.ok) return refuse("Access to this record could not be checked right now")
  if (!a.access.capabilities.read) return refuse(`You do not have access to this ${entityType}`)
  if (kind === "review_note" && !a.access.capabilities.annotate) return refuse("Review notes are added by compliance or an account admin — you can flag the item instead")
  if (kind === "flag" && !a.access.capabilities.flag) return refuse(`You cannot flag this ${entityType}`)
  const role = a.access.role === "compliance_reviewer" ? "compliance_officer" : a.access.role === "assisting_tc" ? "tc" : a.access.role === "owning_agent" ? "agent" : a.access.role === "team_lead" ? "team_lead" : "admin"

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const written = await withActionLedger<{ id: string | null; error: string | null }>(
    {
      brokerageId: auth.brokerageId, action: kind === "flag" ? "compliance.deal_flag.record" : "compliance.review_note.record",
      actor: { type: "user", userId: auth.userId }, subject: { type: entityType, id: input.entityId },
      reasonCode: kind === "flag" ? "STAFF_ALERT" : "COMPLIANCE_NOTICE", reasonDetail: `${kind} by ${role}`, riskClass: "LOW_RISK_WRITE", systemSource: "deal_review_notes",
      idempotencyKey: `deal-note:${auth.brokerageId}:${entityType}:${input.entityId}:${auth.userId}:${body.length}:${body.slice(0, 64)}:${new Date().toISOString().slice(0, 16)}`,
      detail: { kind, role, entity_type: entityType },
    },
    async () => {
      const { data, error } = await svc.from("ai_assistant_notes").insert({
        brokerage_id: auth.brokerageId, created_by: auth.userId, note_text: body, note_type: kind === "flag" ? "action_item" : "observation",
        source: "human", role, entity_type: entityType, entity_id: input.entityId,
        ...(entityType === "transaction" ? { transaction_id: input.entityId } : { listing_id: input.entityId }),
      }).select("id")
      if (error) return { id: null, error: error.message }
      return { id: ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null, error: null }
    },
    {
      settle: (x) => x.error ? { status: "failed", outcome: "refused", error: x.error } : x.id ? { status: "executed", outcome: kind } : { status: "failed", outcome: "no_row" },
      replay: (claim) => ({ id: null, error: claim.kind === "replay" || claim.kind === "in_flight" ? "duplicate" : "ledger_refused" }),
    },
    { client: svc as never },
  )
  if (written.error === "duplicate") return refuse("This note was already saved a moment ago", true)
  if (written.error || !written.id) return refuse("The note could not be saved right now")

  // A FLAG rings the owning agent's bell (users.id crossed from agents.user_id — CLAUDE.md §3). A lost bell never unsaves the flag.
  if (kind === "flag" && a.agentId) {
    const { data: agentRow, error: agErr } = await svc.from("agents").select("user_id").eq("id", a.agentId).eq("brokerage_id", auth.brokerageId).maybeSingle()
    const agentUserId = ((agentRow ?? null) as { user_id?: string | null } | null)?.user_id ?? null
    if (!agErr && agentUserId && agentUserId !== auth.userId) {
      const { error: nErr } = await svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: auth.brokerageId, type: "deal_flag", title: `A ${entityType} you lead was flagged`,
        body: body.slice(0, 500), entity_type: entityType, entity_id: input.entityId, priority: "high",
      })
      if (nErr) console.error(`[deal-review-notes] the flag was saved but the agent's notification was refused: ${nErr.message}`)
    }
  }
  revalidatePath(entityType === "transaction" ? `/dashboard/transactions/${input.entityId}` : `/dashboard/listings/${input.entityId}`)
  return { success: true, noteId: written.id }
}

/** The review notes and flags on a listing or transaction, newest first, for anyone with read access to it. */
export async function listDealReviewNotesAction(input: { entityType: "transaction" | "listing"; entityId: string }): Promise<Result<{
  notes: Array<{ id: string; kind: NoteKind; role: string | null; body: string; createdAt: string; mine: boolean }>
  access: { summary: string; canAnnotate: boolean; canFlag: boolean; canAssist: boolean; canActAsAgent: boolean; closingApproval: boolean; active: boolean }
}>> {
  const auth = await requireCallerTenant()
  if (!auth.ok) return refuse(auth.error)
  const entityType = input?.entityType === "listing" ? "listing" : input?.entityType === "transaction" ? "transaction" : null
  if (!entityType || !input?.entityId) return refuse("Choose the listing or transaction")
  const svc = createServiceClient()
  const a = await entityAccess(svc, { userId: auth.userId, brokerageId: auth.brokerageId, userType: auth.userType ?? null }, entityType, input.entityId)
  if (!a.ok) return refuse("Access to this record could not be checked right now")
  if (!a.access.capabilities.read) return refuse(`You do not have access to this ${entityType}`)
  const { data, error } = await svc.from("ai_assistant_notes").select("id, note_type, role, note_text, created_by, created_at")
    .eq("brokerage_id", auth.brokerageId).eq("entity_type", entityType).eq("entity_id", input.entityId).eq("source", "human")
    .in("note_type", ["observation", "action_item"]).order("created_at", { ascending: false }).limit(100)
  if (error) return refuse("The notes could not be read right now")
  const c = a.access.capabilities
  return {
    success: true,
    notes: ((data ?? []) as Array<Record<string, any>>).map((n) => ({
      id: String(n.id), kind: n.note_type === "action_item" ? "flag" : "review_note", role: n.role ?? null, body: String(n.note_text ?? ""),
      createdAt: String(n.created_at ?? ""), mine: n.created_by === auth.userId,
    })),
    access: { summary: a.access.summary, canAnnotate: c.annotate, canFlag: c.flag, canAssist: c.assist, canActAsAgent: c.actAsAgent, closingApproval: c.closingApproval, active: a.access.dealActive },
  }
}
