import { CONTRACT_ESIGN_SENT_AWAITING_STATUSES } from "@/lib/transactions/coordination-status"
// lib/kernel/signature-chase.ts
// ─────────────────────────────────────────────────────────────────────────────
// SIGNATURE-CHASE AUTONOMY — PROVIDER-AGNOSTIC by the owner's rule: the tenant
// chooses their e-sign/transaction provider in settings (the send path already
// resolves it via the provider_overrides cascade); the CHASE therefore runs on
// OUR ledgers, never a vendor's API. What was missing: a sent envelope that
// stalls sat silent forever — no reminder, no escalation. Now: any
// contract_signatures row stuck in sent/viewed/agent_signed past the nudge
// window gets ONE agent nudge; past the escalation window, ONE broker
// escalation (both deduped per row+tier via the notification tag — idempotent
// re-runs). Deal-side client_documents stuck 'pending' chase the same way.
// NO client egress from this sweep — humans get nudged, humans contact
// clients (zero new TCPA surface). Deterministic: no LLM in the cron path.

export const NUDGE_HOURS = 48
export const ESCALATE_HOURS = 96

const OPEN_STATUSES = ["sent", "viewed", "agent_signed", "pending"] as const

export type ChaseTier = "none" | "nudge" | "escalate"

/** PURE: how stale is this envelope? Terminal/unsent rows never chase. */
export function classifySignatureStall(row: { esign_status?: string | null; signature_status?: string | null; sent_at?: string | null; created_at?: string | null }, now: Date): ChaseTier {
  const status = (row.esign_status ?? row.signature_status ?? "").toLowerCase()
  if (!(OPEN_STATUSES as readonly string[]).includes(status)) return "none"
  const anchor = row.sent_at ?? row.created_at
  if (!anchor) return "none" // undated is never a fabricated stall
  const ageHours = (now.getTime() - new Date(anchor).getTime()) / 3_600_000
  if (Number.isNaN(ageHours) || ageHours < NUDGE_HOURS) return "none"
  return ageHours >= ESCALATE_HOURS ? "escalate" : "nudge"
}

/** PURE: the dedupe tag — one nudge and one escalation per row, ever. */
export function chaseTag(table: string, rowId: string, tier: ChaseTier): string {
  return `[SIG_CHASE:${tier}] [${table}:${rowId}]`
}

/** PURE: the notification line — names the doc, the stall, and the next move. */
export function composeChaseLine(docLabel: string, status: string, tier: ChaseTier, ageHours: number): string {
  const days = Math.floor(ageHours / 24)
  return tier === "escalate"
    ? `"${docLabel}" has sat ${status.replace(/_/g, " ")} for ${days} days with no signature — your agent was nudged at day 2; it may need a phone call.`
    : `"${docLabel}" went out ${days} days ago and is still ${status.replace(/_/g, " ")} — a personal nudge closes most of these same-day.`
}

export interface SignatureChaseResult { scanned: number; nudged: number; escalated: number; skipped: number; errors: number }

/** Daily runner over BOTH signature ledgers (onboarding contracts + deal docs). */
export async function runSignatureChase(svc: any, now: Date = new Date()): Promise<SignatureChaseResult> {
  const r: SignatureChaseResult = { scanned: 0, nudged: 0, escalated: 0, skipped: 0, errors: 0 }

  const chase = async (table: string, rowId: string, brokerageId: string, agentUserId: string | null, docLabel: string, status: string, anchor: string) => {
    const tier = classifySignatureStall({ esign_status: status, sent_at: anchor }, now)
    if (tier === "none") { r.skipped += 1; return }
    const tag = chaseTag(table, rowId, tier)
    const { data: dup } = await svc.from("notifications").select("id").ilike("body", `%${tag}%`).limit(1).maybeSingle()
    if (dup) { r.skipped += 1; return }
    const ageHours = (now.getTime() - new Date(anchor).getTime()) / 3_600_000
    const line = composeChaseLine(docLabel, status, tier, ageHours)

    let recipients: string[] = []
    if (tier === "nudge" && agentUserId) recipients = [agentUserId]
    else {
      const { data: brokers } = await svc.from("users").select("id")
        .eq("brokerage_id", brokerageId).in("user_type", ["broker", "admin"]).limit(3)
      recipients = ((brokers ?? []) as any[]).map((u) => u.id)
      if (tier === "escalate" && agentUserId && !recipients.includes(agentUserId)) recipients.push(agentUserId)
    }
    if (recipients.length === 0) { r.skipped += 1; return }
    for (const uid of recipients) {
      await svc.from("notifications").insert({
        user_id: uid, brokerage_id: brokerageId, type: "signature_chase",
        title: tier === "escalate" ? "Unsigned document needs a call" : "A signature is waiting on a nudge",
        body: `${line} ${tag}`.slice(0, 480),
        priority: tier === "escalate" ? "high" : "medium", channel: "in_app", is_read: false,
      }).then(undefined, () => {})
    }
    if (tier === "escalate") r.escalated += 1
    else r.nudged += 1
  }

  try {
    // Onboarding/agent contracts (contract_signatures — its own esign vocab).
    const cutoff = new Date(now.getTime() - NUDGE_HOURS * 3_600_000).toISOString()
    const { data: contracts } = await svc.from("contract_signatures")
      .select("id, brokerage_id, agent_id, contract_type, esign_status, sent_at")
      .in("esign_status", [...CONTRACT_ESIGN_SENT_AWAITING_STATUSES])
      .not("sent_at", "is", null).lt("sent_at", cutoff).limit(500)
    for (const c of (contracts ?? []) as any[]) {
      r.scanned += 1
      try {
        let agentUserId: string | null = null
        if (c.agent_id) {
          const { data: a } = await svc.from("agents").select("user_id").eq("id", c.agent_id).maybeSingle()
          agentUserId = (a as any)?.user_id ?? null
        }
        await chase("contract_signatures", c.id, c.brokerage_id, agentUserId,
          String(c.contract_type ?? "contract").replace(/_/g, " "), c.esign_status, c.sent_at)
      } catch { r.errors += 1 }
    }

    // Deal documents (client_documents.signature_status 'pending').
    const { data: docs } = await svc.from("client_documents")
      .select("id, brokerage_id, document_name, signature_status, created_at, contact_id")
      .eq("signature_status", "pending").not("created_at", "is", null).lt("created_at", cutoff).limit(500)
    for (const d of (docs ?? []) as any[]) {
      r.scanned += 1
      try {
        // The contact's assigned agent owns the nudge.
        let agentUserId: string | null = null
        if (d.contact_id) {
          const { data: contact } = await svc.from("contacts").select("agent_id").eq("id", d.contact_id).maybeSingle()
          if ((contact as any)?.agent_id) {
            const { data: a } = await svc.from("agents").select("user_id").eq("id", (contact as any).agent_id).maybeSingle()
            agentUserId = (a as any)?.user_id ?? null
          }
        }
        await chase("client_documents", d.id, d.brokerage_id, agentUserId,
          d.document_name ?? "document", "pending", d.created_at)
      } catch { r.errors += 1 }
    }
  } catch { r.errors += 1 }
  return r
}
