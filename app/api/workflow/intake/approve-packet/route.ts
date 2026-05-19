/**
 * POST /api/workflow/intake/approve-packet
 *
 * Agent-triggered: flips documents.status from 'needs_agent_input' →
 * 'draft_ready' so a downstream send_for_esign workflow step can find
 * and dispatch the document.
 *
 * Body:
 *   { documentId: string, agentNotes?: string, overrides?: Array<{
 *       fieldName: string, newValue: unknown, reason?: string
 *     }> }
 *
 * For each override:
 *   - calls recordAgentOverride to update document_field_audit
 *
 * Returns:
 *   { success: true, status: 'draft_ready' }
 *
 * Auth: requires authenticated user. Document must belong to user's brokerage.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { recordAgentOverride } from "@/lib/workflow/intelligence/field-audit"

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({})) as {
    documentId?: string
    agentNotes?: string
    overrides?: Array<{ fieldName: string; newValue: unknown; reason?: string }>
  }
  if (!body.documentId) return NextResponse.json({ error: "documentId required" }, { status: 400 })

  // Verify document belongs to user's brokerage
  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) return NextResponse.json({ error: "No brokerage on user" }, { status: 422 })

  const { data: doc } = await supabase
    .from("documents")
    .select("id, status, brokerage_id, metadata")
    .eq("id", body.documentId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (!doc) return NextResponse.json({ error: "Document not in your brokerage" }, { status: 403 })

  // Record any field overrides BEFORE flipping status (so the audit row exists
  // when the eSign step pulls the document later)
  for (const override of body.overrides ?? []) {
    await recordAgentOverride({
      documentId:     body.documentId,
      fieldName:      override.fieldName,
      newValue:       override.newValue,
      overrideReason: override.reason,
    }).catch(() => null)
  }

  // Flip status
  const newStatus =
    doc.status === "needs_agent_input" || doc.status === "draft" ? "draft_ready" : doc.status
  await supabase.from("documents")
    .update({
      status: newStatus,
      metadata: {
        ...(doc.metadata as Record<string, unknown>),
        approved_at: new Date().toISOString(),
        approved_by: user.id,
        agent_notes: body.agentNotes ?? null,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", body.documentId)

  return NextResponse.json({ success: true, status: newStatus })
}
