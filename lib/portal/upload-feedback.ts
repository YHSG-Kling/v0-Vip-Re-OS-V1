/**
 * lib/portal/upload-feedback.ts — WHAT A CONTACT IS TOLD WHEN A PORTAL UPLOAD FAILS, AND WHO IS TOLD TO FIX IT
 * (wave 152, lane 152J — directive 152J "Tenant-safe feedback": "a Contact's document/form/portal error must never expose
 * a stack trace, while the correct responsible user or manager sees a real recoverable task. The user should know whether
 * their file/upload/form/QR was saved.")
 *
 * The gap this closes, on the survivor door (app/actions/documents.ts uploadDocument — the universal lane every portal
 * upload rides): a storage refusal THREW `Failed to store document: <provider text>` and a refused record threw
 * `Failed to create document record`; the portal dialog rendered either as `Upload failed: <raw>` (or, in production,
 * as Next's generic server-action failure), told clients "Maximum size is 10MB" (the real ceiling is the server-action
 * transport's, lib/storage/file-limits.ts) and "Storage not configured. Please contact support." — and NOBODY on the
 * account learned that a client's document never arrived.
 *
 * Now every failure a Contact can hit is composed by THE presenter (lib/errors presentTenantMessage / presentTenantError,
 * audience "contact"): what happened · nothing was saved (always TRUE here — every path below runs before a row exists,
 * or after the stored bytes were undone) · who acts · one action · a reference. The raw text stays internal (logged by
 * presentTenantError with the reference; carried on the ledger detail). A SYSTEM-side failure (storage refused, the record
 * refused) also opens ONE recoverable task for the Contact's assigned agent — ledgered (portal_upload.failure_task.open),
 * idempotent per Contact per UTC day, so a client retrying five times makes one task, not five. A failure the Contact can
 * fix themselves (too large, a type the bucket refuses, an unmeasurable size, a folder that is not theirs) opens no task.
 *
 * Not server-only: pure composition + one injected client, so scripts/saved-home-alerts-guard.ts §K drives it on
 * scripts/in-memory-supabase.ts.
 */
import { presentTenantError, presentTenantMessage } from "@/lib/errors"
import { withActionLedger } from "@/lib/kernel/action-ledger"

type Db = { from: (t: string) => any }

/** Where the upload stopped. The first four are the Contact's to fix; storage / record are ours (a task opens). */
type ContactUploadFailureStage = "size" | "content_type" | "unmeasurable" | "not_permitted" | "storage" | "record"

const SYSTEM_STAGES = new Set<ContactUploadFailureStage>(["storage", "record"])
const FAILURE_TASK_ACTION = "portal_upload.failure_task.open"
const FAILURE_TASK_SOURCE = "portal_upload_failure"

/** The Contact's sentence for a stage the Contact can fix (no task). */
function selfServiceMessage(stage: Exclude<ContactUploadFailureStage, "storage" | "record">, limitText: string | null): string {
  switch (stage) {
    case "size":
      return presentTenantMessage({ what: `This file is too large to upload here${limitText ? ` (the limit is ${limitText})` : ""}`, work: { state: "not_saved" }, next: "you", action: { label: "Upload a smaller copy, such as a PDF or a photo of each page" }, audience: "contact" }).sentence
    case "content_type":
      return presentTenantMessage({ what: "This kind of file can't be uploaded here", work: { state: "not_saved" }, next: "you", action: { label: "Save it as a PDF or a photo and upload that" }, audience: "contact" }).sentence
    case "unmeasurable":
      return presentTenantMessage({ what: "We couldn't check this file before uploading it", work: { state: "not_saved" }, next: "you", action: { label: "Choose the file again and upload it" }, audience: "contact" }).sentence
    case "not_permitted":
      return presentTenantMessage({ what: "This document couldn't be added to this folder", work: { state: "not_saved" }, next: "account_admin", audience: "contact" }).sentence
  }
}

interface ContactUploadFailureReport {
  /** The ONE sentence the Contact reads (presenter-composed; never a provider string or a stack trace). */
  message: string
  /** Always false — every path that reports here runs before the record exists, or after the stored bytes were undone. */
  saved: false
  /** The safe reference the Contact can quote (null when nothing technical was logged). */
  reference: string | null
  /** The agent task that will recover this (null = a self-service failure, no assigned agent, or not written). */
  taskId: string | null
  /** Why no task was opened when one was due (internal). */
  taskNote: string | null
}

/**
 * Report ONE failed portal upload by a Contact. `raw` is the internal error text (never shown to the Contact). The
 * tenant and Contact come from the caller's SESSION-verified gate (uploadDocument has already checked the Contact is the
 * session's own, in the session's tenant). Never throws.
 */
export async function reportContactUploadFailure(
  db: Db,
  a: { brokerageId: string; contactId: string | null; fileName: string; stage: ContactUploadFailureStage; raw?: unknown; limitText?: string | null; now?: Date },
): Promise<ContactUploadFailureReport> {
  if (!SYSTEM_STAGES.has(a.stage)) {
    return { message: selfServiceMessage(a.stage as Exclude<ContactUploadFailureStage, "storage" | "record">, a.limitText ?? null), saved: false, reference: null, taskId: null, taskNote: null }
  }

  // Ours to fix: log the raw text under a reference (presentTenantError), open the agent's recoverable task, then tell
  // the Contact — "your agent has been told" ONLY when the task really landed.
  const logged = presentTenantError({ what: "Your document didn't upload because of a problem on our side", raw: a.raw ?? `${a.stage} failure`, work: { state: "not_saved" }, context: `portal_upload_${a.stage}`, audience: "contact" })
  const reference = logged.referenceId
  const now = a.now ?? new Date()
  let taskId: string | null = null
  let taskNote: string | null = null
  try {
    const opened = await openUploadFailureTask(db, { ...a, reference, now })
    taskId = opened.taskId
    taskNote = opened.note
  } catch (e) {
    taskNote = `task not opened: ${e instanceof Error ? e.message : String(e)}`
  }
  const message = presentTenantMessage({
    what: "Your document didn't upload because of a problem on our side",
    affects: taskId ? "Your agent has been told so they can help you get it to them" : null,
    work: { state: "not_saved" },
    next: taskId ? "you" : "account_admin",
    action: { label: "Try again in a few minutes" },
    referenceId: reference,
    audience: "contact",
  }).sentence
  return { message, saved: false, reference, taskId, taskNote }
}

/** ONE task per Contact per UTC day for the Contact's assigned agent (contacts.agent_id is an agents.id), ledgered. */
async function openUploadFailureTask(
  db: Db,
  a: { brokerageId: string; contactId: string | null; fileName: string; stage: ContactUploadFailureStage; raw?: unknown; reference: string | null; now: Date },
): Promise<{ taskId: string | null; note: string | null }> {
  if (!a.contactId) return { taskId: null, note: "no contact on the upload — nobody to assign" }
  const { data: who, error: whoErr } = await db.from("contacts").select("agent_id, first_name, last_name").eq("id", a.contactId).eq("brokerage_id", a.brokerageId).maybeSingle()
  if (whoErr) return { taskId: null, note: `contact read refused: ${whoErr.message}` }
  const person = (who ?? null) as { agent_id?: string | null; first_name?: string | null; last_name?: string | null } | null
  if (!person?.agent_id) return { taskId: null, note: "the contact has no assigned agent" }
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ").trim() || "A client"
  const day = a.now.toISOString().slice(0, 10)
  const file = a.fileName.replace(/[\r\n]+/g, " ").slice(0, 120)
  const rawText = a.raw instanceof Error ? a.raw.message : typeof a.raw === "string" ? a.raw : ""
  return withActionLedger<{ taskId: string | null; note: string | null }>(
    {
      brokerageId: a.brokerageId, action: FAILURE_TASK_ACTION,
      actor: { type: "system" },
      subject: { type: "contact", id: a.contactId, ref: `portal_upload:${day}` },
      reasonCode: "SERVICE_NOTICE",
      reasonDetail: `a client's portal upload failed at ${a.stage}; the assigned agent recovers it`,
      idempotencyKey: `${FAILURE_TASK_ACTION}:${a.contactId}:${day}`, riskClass: "LOW_RISK_WRITE", channel: "portal",
      systemSource: "portal_upload",
      // The technical detail stays INTERNAL: here (the ledger) and in the log line keyed by the same reference.
      detail: { stage: a.stage, reference: a.reference, file_name: file, raw_error: rawText.slice(0, 500) },
    },
    async () => {
      const { data, error } = await db.from("tasks").insert({
        brokerage_id: a.brokerageId, contact_id: a.contactId, assigned_to_agent_id: person.agent_id, listing_id: null, transaction_id: null,
        title: `${name}'s document didn't upload`,
        description: `${name} tried to upload "${file}" from the client portal and it was not saved${a.reference ? ` (reference ${a.reference})` : ""}. Ask them to try again, or collect the document another way. If it keeps failing, contact support with the reference.`,
        due_date: new Date(a.now.getTime() + 86_400_000).toISOString().slice(0, 10),
        priority: "high", status: "pending", assignee_type: "agent", source: FAILURE_TASK_SOURCE, auto_generated: true,
      }).select("id").single()
      if (error || !data) return { taskId: null, note: `task not written: ${error?.message ?? "no row"}` }
      return { taskId: String((data as { id: string }).id), note: null }
    },
    {
      settle: (r) => (r.taskId ? { status: "executed", outcome: "task_opened", providerRef: r.taskId } : { status: "failed", outcome: "task_not_written", error: r.note }),
      // A retry the same day finds today's task: the Contact is still truthfully told the agent knows.
      replay: (claim) => ({ taskId: claim.kind === "replay" ? (claim.entry?.provider_ref ?? null) : null, note: claim.kind === "replay" ? "today's task already exists for this contact" : `not opened: ${claim.kind}` }),
    },
    { client: db as never },
  )
}
