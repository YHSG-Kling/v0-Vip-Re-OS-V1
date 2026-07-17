/**
 * POST /api/workflow/buyer-intake/submit
 *
 * Buyer submits their self-serve intake. Public endpoint authenticated by
 * the unique token. Updates the contact record with verified legal name,
 * funds info, and DL image URL.
 *
 * Body:
 *   {
 *     token:               required
 *     legalFirstName:      required
 *     legalMiddleName:     optional
 *     legalLastName:       required
 *     dlImageBlobUrl:      Vercel Blob URL of uploaded DL photo
 *     fundsSourceType:     'pre_approval' | 'pof' | 'mixed'
 *     fundsMaxPurchase:    number
 *     preApprovalDocUrl?:  Vercel Blob URL of pre-approval letter
 *     pofDocUrl?:          Vercel Blob URL of POF letter
 *     emailVerified?:      string (their email — for cross-check)
 *   }
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => ({})) as {
    token?:             string
    legalFirstName?:    string
    legalMiddleName?:   string
    legalLastName?:     string
    dlImageBlobUrl?:    string
    fundsSourceType?:   "pre_approval" | "pof" | "mixed"
    fundsMaxPurchase?:  number
    preApprovalDocUrl?: string
    pofDocUrl?:         string
    emailVerified?:     string
  }

  if (!body.token || !body.legalFirstName || !body.legalLastName || !body.dlImageBlobUrl) {
    return NextResponse.json({ error: "token, legalFirstName, legalLastName, dlImageBlobUrl required" }, { status: 400 })
  }

  const svc = createServiceClient()

  // Validate the token
  const { data: tokenRow } = await svc
    .from("buyer_intake_tokens")
    .select("id, brokerage_id, contact_id, agent_user_id, status, expires_at")
    .eq("token", body.token)
    .maybeSingle()

  if (!tokenRow) return NextResponse.json({ error: "Invalid token" }, { status: 404 })
  if (tokenRow.status !== "pending") return NextResponse.json({ error: "Token already used or cancelled" }, { status: 410 })
  if (new Date(tokenRow.expires_at) < new Date()) {
    await svc.from("buyer_intake_tokens").update({ status: "expired" }).eq("id", tokenRow.id)
    return NextResponse.json({ error: "Token expired" }, { status: 410 })
  }

  // Update the contact record.
  // tenant anchor (scope burn-down): pinned to the token-validated contact AND
  // the token's brokerage so a stale/foreign contact_id can never cross tenants.
  const contactUpdate = {
    legal_first_name:        body.legalFirstName,
    legal_middle_name:       body.legalMiddleName ?? null,
    legal_last_name:         body.legalLastName,
    legal_name_verified_at:  new Date().toISOString(),
    legal_name_source:       "driver_license",
    dl_image_url:            body.dlImageBlobUrl,
    funds_source_type:       body.fundsSourceType ?? null,
    funds_max_purchase:      body.fundsMaxPurchase ?? null,
    updated_at:              new Date().toISOString(),
  }
  const { error: contactErr } = await svc.from("contacts")
    .update(contactUpdate)
    .eq("id", tokenRow.contact_id)
    .eq("brokerage_id", tokenRow.brokerage_id)

  if (contactErr) return NextResponse.json({ error: contactErr.message }, { status: 500 })

  // Persist pre-approval / POF docs if provided
  for (const [type, url] of [["pre_approval", body.preApprovalDocUrl], ["pof", body.pofDocUrl]] as const) {
    if (url) {
      await svc.from("documents").insert({
        brokerage_id:   tokenRow.brokerage_id,
        contact_id:     tokenRow.contact_id,
        document_type:  type,
        status:         "complete",
        storage_url:    url,
        metadata:       { uploaded_via: "buyer_intake", token_id: tokenRow.id },
        created_at:     new Date().toISOString(),
      })
    }
  }

  // Mark token submitted
  await svc.from("buyer_intake_tokens").update({
    status:         "submitted",
    submitted_at:   new Date().toISOString(),
    submitted_data: {
      legalFirstName: body.legalFirstName,
      legalMiddleName: body.legalMiddleName,
      legalLastName: body.legalLastName,
      fundsSourceType: body.fundsSourceType,
      fundsMaxPurchase: body.fundsMaxPurchase,
    },
  }).eq("id", tokenRow.id)

  // Notify the agent that intake is complete
  if (tokenRow.agent_user_id) {
    await svc.from("notifications").insert({
      user_id:        tokenRow.agent_user_id,
      brokerage_id:   tokenRow.brokerage_id,
      type:           "buyer_intake_submitted",
      title:          `${body.legalFirstName} ${body.legalLastName} completed buyer intake`,
      body:           `Legal name verified, DL uploaded${body.fundsMaxPurchase ? `, max purchase $${body.fundsMaxPurchase.toLocaleString()}` : ""}. Ready to draft offers.`,
      priority:       "medium",
      entity_type:    "contact",
      entity_id:      tokenRow.contact_id,
      channel:        "in_app",
    })
  }

  return NextResponse.json({ success: true, contactId: tokenRow.contact_id })
}
