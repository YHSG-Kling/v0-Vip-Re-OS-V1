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
// re-runs). Deal-side client_documents awaiting a signature chase the same way.
// NO client egress from this sweep — humans get nudged, humans contact
// clients (zero new TCPA surface). Deterministic: no LLM in the cron path.

export const NUDGE_HOURS = 48
export const ESCALATE_HOURS = 96

/**
 * THE DEAL-DOC CHASE LEG MATCHED NOTHING.
 *
 * This sweep filtered `client_documents.signature_status = "pending"`. Every
 * writer on that rail writes `"pending_signature"`:
 *
 *   app/actions/dotloop-integration.ts:276    signature_status: "pending_signature"
 *   app/actions/dotloop-integration.ts:1423   signature_status: … ? "pending_signature" : null
 *   app/actions/ai-document-intelligence.ts:521  .update({ signature_status: "pending_signature" })
 *
 * and dotloop-integration's own reader comments the ladder as
 * 'pending_signature' → 'signed'. Nothing anywhere writes the bare "pending"
 * to this column.
 *
 * VERIFIED LIVE (pg_constraint, project hrvaqgvukzxfskkcrwbt): there is NO
 * CHECK constraint on client_documents.signature_status — it is plain nullable
 * text (scripts/510 declared DEFAULT 'not_required'; the live column default is
 * NULL, so even that never took). So the DATABASE admits BOTH spellings: it
 * would never have refused the reader's filter, and it will never refuse a
 * writer either. The vocabulary is settled by the writers alone, which is
 * exactly why a reader can drift from it in silence — and did. The reader now
 * derives its filter from this one constant, and `classifySignatureStall`
 * derives its open-status set from the same constant, so the two legs of the
 * rail cannot disagree again.
 *
 * "pending" is KEPT in OPEN_STATUSES below and NOT removed: it is a real value
 * on the OTHER ledger this sweep reads (contract_signatures_esign_status_check
 * admits 'pending'), and callers already classify rows with it.
 */
export const CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES = ["pending_signature"] as const

const OPEN_STATUSES = [
  "sent", "viewed", "agent_signed", "pending",
  ...CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES,
] as const

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

    // TENANT SCOPE. `svc` is a service-role client and bypasses RLS, so every
    // read here carries its brokerage filter explicitly. A row with no
    // brokerage cannot be tenant-scoped and is not chased — notifications
    // is brokerage-keyed and an unscoped nudge is a cross-tenant leak.
    if (!brokerageId) { r.skipped += 1; return }

    const tag = chaseTag(table, rowId, tier)
    // A FAILED DEDUPE READ IS NOT "no duplicate". supabase-js RESOLVES a refused
    // query, so `{ data: dup }` alone turns a refusal into "nothing found" and
    // this sweep would re-notify every recipient on every daily run.
    const { data: dup, error: dupError } = await svc.from("notifications").select("id")
      .eq("brokerage_id", brokerageId).ilike("body", `%${tag}%`).limit(1).maybeSingle()
    if (dupError) {
      console.error(`[signature-chase] dedupe read failed for ${table}:${rowId}:`, dupError.message)
      r.errors += 1
      return
    }
    if (dup) { r.skipped += 1; return }
    const ageHours = (now.getTime() - new Date(anchor).getTime()) / 3_600_000
    const line = composeChaseLine(docLabel, status, tier, ageHours)

    let recipients: string[] = []
    if (tier === "nudge" && agentUserId) recipients = [agentUserId]
    else {
      const { data: brokers, error: brokersError } = await svc.from("users").select("id")
        .eq("brokerage_id", brokerageId).in("user_type", ["broker", "admin"]).limit(3)
      if (brokersError) {
        // An escalation with no readable recipient list is not an escalation.
        console.error(`[signature-chase] broker lookup failed for brokerage ${brokerageId}:`, brokersError.message)
        r.errors += 1
        return
      }
      recipients = ((brokers ?? []) as any[]).map((u) => u.id)
      if (tier === "escalate" && agentUserId && !recipients.includes(agentUserId)) recipients.push(agentUserId)
    }
    if (recipients.length === 0) { r.skipped += 1; return }

    let delivered = 0
    for (const uid of recipients) {
      // The insert used to be `.then(undefined, () => {})` — a REJECTED write
      // and a written row were indistinguishable, and the counters below
      // reported nudges that never landed.
      const { error: insertError } = await svc.from("notifications").insert({
        user_id: uid, brokerage_id: brokerageId, type: "signature_chase",
        title: tier === "escalate" ? "Unsigned document needs a call" : "A signature is waiting on a nudge",
        body: `${line} ${tag}`.slice(0, 480),
        priority: tier === "escalate" ? "high" : "medium", channel: "in_app", is_read: false,
      })
      if (insertError) {
        console.error(`[signature-chase] notification insert failed for user ${uid}:`, insertError.message)
        r.errors += 1
      } else {
        delivered += 1
      }
    }
    // Only count a chase that actually reached somebody.
    if (delivered === 0) return
    if (tier === "escalate") r.escalated += 1
    else r.nudged += 1
  }

  try {
    // Onboarding/agent contracts (contract_signatures — its own esign vocab).
    const cutoff = new Date(now.getTime() - NUDGE_HOURS * 3_600_000).toISOString()
    const { data: contracts, error: contractsError } = await svc.from("contract_signatures")
      .select("id, brokerage_id, agent_id, contract_type, esign_status, sent_at")
      .in("esign_status", [...CONTRACT_ESIGN_SENT_AWAITING_STATUSES])
      .not("sent_at", "is", null).lt("sent_at", cutoff).limit(500)
    if (contractsError) {
      // A refused sweep read is NOT an empty ledger — say so instead of
      // reporting a clean run over zero rows.
      console.error("[signature-chase] contract_signatures scan failed:", contractsError.message)
      r.errors += 1
    }
    for (const c of (contracts ?? []) as any[]) {
      r.scanned += 1
      try {
        // IDENTITY CLASS. contract_signatures.agent_id FKs agents(id)
        // (pg_constraint: contract_signatures_agent_id_fkey → agents.id), and
        // notifications.user_id is a USERS id — resolved, never aliased.
        let agentUserId: string | null = null
        if (c.agent_id) {
          const { data: a, error: agentError } = await svc.from("agents").select("user_id").eq("id", c.agent_id).maybeSingle()
          if (agentError) {
            console.error(`[signature-chase] agents lookup failed for ${c.agent_id}:`, agentError.message)
            r.errors += 1
            continue
          }
          agentUserId = (a as any)?.user_id ?? null
        }
        await chase("contract_signatures", c.id, c.brokerage_id, agentUserId,
          String(c.contract_type ?? "contract").replace(/_/g, " "), c.esign_status, c.sent_at)
      } catch (err) {
        console.error(`[signature-chase] contract row ${c.id} threw:`, err instanceof Error ? err.message : err)
        r.errors += 1
      }
    }

    // Deal documents — the spelling the WRITERS use, derived from the one
    // constant so the reader and the writers cannot drift apart again.
    const { data: docs, error: docsError } = await svc.from("client_documents")
      .select("id, brokerage_id, document_name, signature_status, created_at, contact_id")
      .in("signature_status", [...CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES])
      .not("created_at", "is", null).lt("created_at", cutoff).limit(500)
    if (docsError) {
      console.error("[signature-chase] client_documents scan failed:", docsError.message)
      r.errors += 1
    }
    for (const d of (docs ?? []) as any[]) {
      r.scanned += 1
      try {
        // The contact's assigned agent owns the nudge.
        // IDENTITY CLASS: contacts.agent_id FKs agents(id); agents.user_id is
        // the users id notifications wants.
        let agentUserId: string | null = null
        if (d.contact_id) {
          const { data: contact, error: contactError } = await svc.from("contacts").select("agent_id").eq("id", d.contact_id).maybeSingle()
          if (contactError) {
            console.error(`[signature-chase] contacts lookup failed for ${d.contact_id}:`, contactError.message)
            r.errors += 1
            continue
          }
          if ((contact as any)?.agent_id) {
            const { data: a, error: agentError } = await svc.from("agents").select("user_id").eq("id", (contact as any).agent_id).maybeSingle()
            if (agentError) {
              console.error(`[signature-chase] agents lookup failed for ${(contact as any).agent_id}:`, agentError.message)
              r.errors += 1
              continue
            }
            agentUserId = (a as any)?.user_id ?? null
          }
        }
        // Pass the row's OWN status through — hard-coding "pending" here was the
        // second half of the same defect: it made the notification text describe
        // a status the row does not carry.
        await chase("client_documents", d.id, d.brokerage_id, agentUserId,
          d.document_name ?? "document", String(d.signature_status ?? ""), d.created_at)
      } catch (err) {
        console.error(`[signature-chase] document row ${d.id} threw:`, err instanceof Error ? err.message : err)
        r.errors += 1
      }
    }
  } catch (err) {
    console.error("[signature-chase] sweep threw:", err instanceof Error ? err.message : err)
    r.errors += 1
  }
  return r
}
