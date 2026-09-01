"use server"

/**
 * Resumable voice-intake sessions — the reader behind the agent dashboard's
 * "pick up where you left off" card. Sits beside the two writers it serves
 * (draft-listing-from-voice.ts / draft-offer-from-voice.ts): a
 * workflow_intake_sessions row in 'in_progress' or 'ready_to_draft' is a
 * half-finished conversation the agent can resume at /mobile/voice.
 *
 * Identity is the draft actions' own shape (draft-listing-from-voice.ts:75-78):
 * supabase.auth.getUser(), then the caller's users row for brokerage_id — §4,
 * session-derived, never a parameter. Rows are scoped by brokerage_id AND
 * agent_user_id (users-class column — it stores user ids, not agents ids).
 *
 * STATUS VOCABULARY NOTE: the live CHECK admits 'abandoned', but NO writer in
 * the tree ever sets it — so this reader filters the terminal 'drafted' OUT
 * (and takes only the two live in-flight states) rather than filtering ON
 * 'abandoned', which would exclude nothing and read as if expiry existed.
 * The 14-day updated_at window is the actual staleness bound.
 */

import { createClient } from "@/lib/supabase/server"

export interface ResumableIntakeSession {
  id: string
  intakeType: "listing" | "offer"
  status: "in_progress" | "ready_to_draft"
  updatedAt: string
  /** Contact name (batched, tenant-anchored read) when the session has one. */
  contactName: string | null
  /** The address captured so far, from current_intake.propertyAddress.value. */
  propertyAddress: string | null
}

export async function listResumableIntakeSessions(): Promise<{
  ok: boolean
  sessions?: ResumableIntakeSession[]
  error?: string
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) return { ok: false, error: "No brokerage on user" }

  const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const { data: rows, error } = await supabase
    .from("workflow_intake_sessions")
    .select("id, intake_type, status, updated_at, contact_id, current_intake")
    .eq("brokerage_id", brokerageId)
    .eq("agent_user_id", user.id)
    .in("status", ["in_progress", "ready_to_draft"])
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(3)

  // §3 — a refused read is reported, never rendered as "no sessions to resume".
  if (error) return { ok: false, error: error.message }

  const list = (rows ?? []) as any[]

  // Batched, tenant-anchored contact resolution — one .in() read, never per-row.
  const contactIds = Array.from(new Set(list.map((r) => r.contact_id).filter(Boolean)))
  const { data: contacts } = contactIds.length > 0
    ? await supabase.from("contacts").select("id, first_name, last_name").eq("brokerage_id", brokerageId).in("id", contactIds)
    : { data: [] as any[] }
  const nameById = new Map(((contacts ?? []) as any[]).map((c) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Contact"]))

  return {
    ok: true,
    sessions: list.map((r) => ({
      id: r.id,
      intakeType: r.intake_type as "listing" | "offer",
      status: r.status as "in_progress" | "ready_to_draft",
      updatedAt: r.updated_at,
      contactName: r.contact_id ? nameById.get(r.contact_id) ?? null : null,
      propertyAddress:
        typeof (r.current_intake as any)?.propertyAddress?.value === "string"
          ? (r.current_intake as any).propertyAddress.value
          : null,
    })),
  }
}
