/**
 * POST /api/workflow/buyer-intake/create
 *
 * Agent creates a secure intake link for a buyer to self-serve their legal
 * name (with DL upload), funds source, and pre-approval/POF.
 *
 * Returns a tokenized URL the agent SMS/emails to the buyer.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import crypto from "node:crypto"

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { contactId?: string }
  if (!body.contactId) return NextResponse.json({ error: "contactId required" }, { status: 400 })

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) return NextResponse.json({ error: "No brokerage on user" }, { status: 422 })

  // Verify contact belongs to brokerage
  const { data: contact } = await supabase
    .from("contacts").select("id").eq("id", body.contactId).eq("brokerage_id", brokerageId).maybeSingle()
  if (!contact) return NextResponse.json({ error: "Contact not in your brokerage" }, { status: 403 })

  const token = crypto.randomBytes(24).toString("base64url")
  const expiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString()    // 14 days

  const { data: tokenRow, error } = await supabase.from("buyer_intake_tokens").insert({
    brokerage_id: brokerageId,
    contact_id:   body.contactId,
    agent_user_id: user.id,
    token,
    expires_at:   expiresAt,
    status:       "pending",
  }).select("id").single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.platform.com"
  const intakeUrl = `${baseUrl}/buyer-intake/${token}`

  return NextResponse.json({
    tokenId: tokenRow?.id,
    intakeUrl,
    expiresAt,
  })
}
