import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { FORM_PACKET_BUCKET, resolvePacketActor, usableTenantPacketPaths } from "@/lib/forms/tenant-form-packets"

/**
 * POST /api/forms/document-read  { packet_id } — THE AI FORM READER (wave 156, lane 156C; lib/forms/form-document-reader.ts).
 *
 * Reads a library form the seat may USE (usableTenantPacketPaths: brokerage / office / team / own, active, in license — a retired
 * master is refused) and returns its fields and signature boxes (facts of the PDF) plus model proposals — legal description,
 * governing clauses, requirements, field values the document itself states — each with its evidence quote, every one
 * `pending_review` for the FormWizard's review step. NOTHING is applied or written. A CDA is refused (the agent fills the CDA).
 *
 * GATE (CLAUDE.md §4): an active tenant staff seat (resolvePacketActor). ENTITLEMENT BEFORE THE PAID CALL: mayUseAndAfford
 * ("ai.generate") is asked first; a refusal still returns the PDF's structure, with no model called. Spend is booked by
 * generateObjectRouted to the SESSION tenant. The text layer is read without the vision reader (no second paid call).
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const svc = createServiceClient()
  const resolved = await resolvePacketActor(svc as never, user.id)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 403 })
  const actor = resolved.actor

  let body: { packet_id?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: "Send JSON: { packet_id }" }, { status: 400 }) }
  const packetId = typeof body.packet_id === "string" ? body.packet_id : ""
  const { data: row, error } = await svc.from("brokerage_form_library").select("id, name, form_code, storage_path").eq("id", packetId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error) return NextResponse.json({ error: `The form could not be read: ${error.message}` }, { status: 503 })
  if (!row?.storage_path) return NextResponse.json({ error: "That form has no master in your library to read." }, { status: 404 })
  const usable = await usableTenantPacketPaths(svc as never, actor, [row.storage_path as string])
  if (!usable.ok) return NextResponse.json({ error: usable.error }, { status: 503 })
  if (!usable.usable.has(row.storage_path as string)) return NextResponse.json({ error: "That form is not available to you (retired, out of license, or shared with another team or office)." }, { status: 403 })

  const { isCdaForm, readFormDocument } = await import("@/lib/forms/form-document-reader")
  if (isCdaForm({ name: row.name as string, formCode: row.form_code as string | null })) {
    return NextResponse.json({ ok: false, refused: "This is a Commission Disbursement Authorization — the agent fills the CDA; the AI reader does not prefill it." }, { status: 422 })
  }
  const { data: blob, error: dlErr } = await svc.storage.from(FORM_PACKET_BUCKET).download(row.storage_path as string)
  if (dlErr || !blob) return NextResponse.json({ error: `The form could not be opened: ${dlErr?.message ?? "no file"}` }, { status: 503 })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const { listPdfFields } = await import("@/lib/forms/pdf-form-fill")
  const fields = await listPdfFields(bytes).catch(() => [] as string[])
  const { ocrDocumentFromBuffer } = await import("@/lib/documents/ocr-pdf")
  const text = await ocrDocumentFromBuffer({ buffer: Buffer.from(bytes), mime: "application/pdf", fileName: "form.pdf", brokerageId: actor.brokerageId, userId: actor.userId, allowVision: false })

  const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
  const gate = await mayUseAndAfford({ brokerageId: actor.brokerageId, capability: "ai.generate", estTokens: Math.ceil(Math.min((text.text ?? "").length, 24000) / 4) + 2000, actor: { userType: actor.userType, platformRole: null } })
  const result = await readFormDocument({
    name: row.name as string, formCode: row.form_code as string | null, fields, text: text.success ? text.text : "",
    brokerageId: gate.allowed ? actor.brokerageId : null, userId: actor.userId,
  })
  if (!gate.allowed) result.notes.push(gate.message ?? `The AI reader is not available right now (${gate.reason}); the form's structure is shown.`)
  return NextResponse.json(result)
}
