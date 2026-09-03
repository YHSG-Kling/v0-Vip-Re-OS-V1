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

/**
 * A FINISHED intake and the document it produced — the reader for
 * `workflow_intake_sessions.document_id`.
 *
 * THE PREMISE OF "add document_id to the resumable list" IS FALSE, and the
 * reason is worth writing down: document_id is stamped in the SAME update that
 * sets status='drafted' (app/actions/voice-assistant/draft-offer-from-voice.ts:325
 * and draft-listing-from-voice.ts:225), and the resumable read above deliberately
 * excludes 'drafted'. Every row it can see therefore has document_id NULL, so
 * selecting the column there would add a field that is null by construction — a
 * reader in name only.
 *
 * The real gap is one state later. A voice intake that FINISHED produced a
 * document, the spoken response promised to open it ("Opening the FormWizard
 * now"), and if the agent navigated away that packet had no route back: nothing
 * in the tree read document_id, so the finished session knew where the document
 * was and could not say. This is that route back.
 */
export interface DraftedIntakeSession {
  id: string
  intakeType: "listing" | "offer"
  updatedAt: string
  contactName: string | null
  propertyAddress: string | null
  /** workflow_intake_sessions.document_id — the packet this intake produced. */
  documentId: string
  /**
   * Where that packet opens. Computed HERE rather than in the card, from the
   * same three facts the finalizers use, so this route and the finalizers'
   * `formwizardUrl` cannot drift apart (§6, one spelling of "where a drafted
   * packet opens"). See documentHref below for the one place they differ and why.
   */
  documentHref: string
}

/**
 * The destination for a drafted packet, mirroring the finalizers verbatim:
 *   listing → app/actions/voice-assistant/draft-listing-from-voice.ts:233
 *   offer, with a contact → draft-offer-from-voice.ts:330
 *
 * THE ONE DELIBERATE DIVERGENCE: the offer finalizer's no-contact fallback is
 * `/dashboard/documents/<id>` (draft-offer-from-voice.ts:332), and there is no
 * dynamic route at that path — app/dashboard/documents/ holds only static
 * children (contract-review, downloads, library), so that link 404s. This
 * returns the document CENTER instead, which exists. The finalizer's own dead
 * URL is left alone: it is a separate defect on a line no row of this lane owns,
 * and silently "fixing" a redirect the agent sees at a different moment is a
 * behaviour change nobody asked for.
 */
function documentHref(
  intakeType: "listing" | "offer",
  contactId: string | null,
  documentId: string,
): string {
  if (intakeType === "listing") return `/dashboard/listings/new?documentId=${documentId}`
  if (contactId) return `/crm?contact=${contactId}&action=new_offer&documentId=${documentId}`
  return "/dashboard/documents"
}

export async function listResumableIntakeSessions(): Promise<{
  ok: boolean
  sessions?: ResumableIntakeSession[]
  /** Recently FINISHED intakes with the document each one produced. Same gate,
   *  same tenant + agent scope, same 14-day window as the resumable list. */
  drafted?: DraftedIntakeSession[]
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

  // THE FINISHED HALF. A second bounded read beside the first — same brokerage,
  // same agent, same window — for sessions that reached 'drafted' AND carry the
  // document they produced. `.not("document_id","is",null)` is the point: a
  // drafted session with no document has nothing to open, and offering a dead
  // link would be worse than offering none.
  const { data: draftedRows, error: draftedErr } = await supabase
    .from("workflow_intake_sessions")
    .select("id, intake_type, updated_at, contact_id, current_intake, document_id")
    .eq("brokerage_id", brokerageId)
    .eq("agent_user_id", user.id)
    .eq("status", "drafted")
    .not("document_id", "is", null)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(3)
  // Non-fatal: the resumable list is the card's primary job and stands without
  // this. Reported out loud, never rendered as "you have finished nothing".
  if (draftedErr) {
    console.error("[list-resumable-intake-sessions] drafted read refused:", draftedErr.message)
  }
  const draftedList = (draftedRows ?? []) as any[]

  // Batched, tenant-anchored contact resolution — one .in() read, never per-row.
  const contactIds = Array.from(new Set([...list, ...draftedList].map((r) => r.contact_id).filter(Boolean)))
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
    drafted: draftedList.map((r) => ({
      id: r.id,
      intakeType: r.intake_type as "listing" | "offer",
      updatedAt: r.updated_at,
      contactName: r.contact_id ? nameById.get(r.contact_id) ?? null : null,
      propertyAddress:
        typeof (r.current_intake as any)?.propertyAddress?.value === "string"
          ? (r.current_intake as any).propertyAddress.value
          : null,
      documentId: r.document_id as string,
      documentHref: documentHref(
        r.intake_type as "listing" | "offer",
        (r.contact_id as string | null) ?? null,
        r.document_id as string,
      ),
    })),
  }
}
