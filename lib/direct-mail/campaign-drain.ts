/**
 * lib/direct-mail/campaign-drain.ts
 *
 * THE APPROVED-CAMPAIGN DRAIN — the direct-mail loop's missing terminal
 * (2026-07 audit: the same class of dead-end the newsletter and email
 * lanes had). Plays stage direct_mail_campaigns rows GATED
 * (approval_status 'pending', status 'planning' — welcome kits, AI-ISA
 * lead-intro postcards, listing-appt-prep pieces); the approval queue
 * flips them approved… and NOTHING mailed them. Approval is the last
 * human stop — each kind must leave it PUBLISHABLE or the loop dead-ends.
 *
 * The drain walks approved 'planning' rows that carry their RECIPIENT
 * (contact_id or lead_id) and no lob_order_id yet, and dispatches each
 * through the EXISTING orchestrateRenderAndSend — the same rail the
 * lifecycle reactor and the 1:1 approval channel ride, so the Fair
 * Housing gate, de-confliction, CASS/verified-address gates, autonomy
 * posture, and Lob spend controls ALL apply per piece. The SAME row is
 * stamped (lob_order_id, status sent/failed, mailing_date,
 * pieces_mailed) — no duplicate campaign rows.
 *
 * AUDIENCE rows (no recipient link — 'farm' etc.) are the farm/lifecycle
 * dispatchers' domain and are skipped with an honest reason, never a
 * simulated send. NOT server-only (simulator-driven).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export interface CampaignDrainResult {
  scanned: number
  sent: number
  failed: number
  skippedAudience: number
  skippedNoAddress: number
}

export async function runDirectMailCampaignDrain(
  svc: Svc,
  input: { brokerageId: string; limit?: number },
): Promise<CampaignDrainResult> {
  const out: CampaignDrainResult = { scanned: 0, sent: 0, failed: 0, skippedAudience: 0, skippedNoAddress: 0 }

  const { data: rows } = await svc
    .from("direct_mail_campaigns")
    .select("id, brokerage_id, agent_id, contact_id, lead_id, campaign_name, copy_text, piece_type, preset_id, target_audience, qr_code_id")
    .eq("brokerage_id", input.brokerageId)
    .eq("approval_status", "approved")
    .eq("status", "planning")
    .is("lob_order_id", null)
    .order("created_at", { ascending: true })
    .limit(input.limit ?? 20)

  for (const row of ((rows ?? []) as any[])) {
    out.scanned++

    // Audience campaigns (farm etc.) belong to their own dispatchers.
    if (!row.contact_id && !row.lead_id) {
      out.skippedAudience++
      continue
    }

    // Resolve the recipient's name + deliverable address.
    let name = "Neighbor"
    let addr: { street: string; city: string; state: string; zip: string } | null = null
    if (row.contact_id) {
      const { resolveMailingAddressForContact } = await import("@/lib/contacts/resolve-mailing-address")
      addr = await resolveMailingAddressForContact({ contactId: row.contact_id, brokerageId: input.brokerageId })
      const { data: c } = await svc.from("contacts").select("first_name, last_name").eq("id", row.contact_id).maybeSingle()
      name = [(c as any)?.first_name, (c as any)?.last_name].filter(Boolean).join(" ") || name
    } else if (row.lead_id) {
      const { data: l } = await svc.from("leads")
        .select("first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, mailing_address_verified")
        .eq("id", row.lead_id).maybeSingle()
      const lead = l as any
      if (lead?.mailing_address_verified && lead.mailing_address && lead.mailing_city && lead.mailing_state && lead.mailing_zip) {
        addr = { street: lead.mailing_address, city: lead.mailing_city, state: lead.mailing_state, zip: lead.mailing_zip }
      }
      name = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || name
    }
    if (!addr) {
      // Honest terminal: without a deliverable address the piece can't mail.
      // EGRESS LEDGER: the refusal is a recorded fact (Exception Center +
      // digest see it) — mail to a half-address is money burned, and fixing
      // the SOURCE address is a human call.
      await svc.from("direct_mail_campaigns")
        .update({ status: "failed" })
        .eq("id", row.id)
      try {
        const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
        await recordSelfHeal(svc, {
          brokerageId: input.brokerageId, domain: "data_flow",
          subject: `mail:${row.contact_id ?? row.lead_id ?? row.id}`,
          action: "none", outcome: "escalated",
          detail: { flow: "egress_rejected", connector: "lob", missing: ["verified_mailing_address"], reason: "direct-mail piece refused — no CASS-verified full address on the recipient; fix the source record" },
        })
      } catch { /* the failed status is the record of truth */ }
      out.skippedNoAddress++
      continue
    }

    // The brokerage's Lob fallback template (the reactor's resolution).
    const { data: brk } = await svc.from("brokerages")
      .select("lob_fallback_template_id").eq("id", input.brokerageId).maybeSingle()
    const fallbackTpl = ((brk as any)?.lob_fallback_template_id as string | null) ?? ""
    if (!fallbackTpl) {
      out.failed++
      await svc.from("direct_mail_campaigns").update({ status: "failed" }).eq("id", row.id)
      continue
    }

    // ONE real dispatch through the shared rail — every gate applies.
    try {
      // The staged play resolved the agent as agents.id on the row; the
      // copy context wants the agent's users.id for brand/license lines.
      let agentUserId: string | null = null
      if (row.agent_id) {
        const { data: a } = await svc.from("agents").select("user_id").eq("id", row.agent_id).maybeSingle()
        agentUserId = ((a as any)?.user_id as string | null) ?? null
      }
      const { orchestrateRenderAndSend } = await import("@/lib/direct-mail/orchestrate-send")
      const result = await orchestrateRenderAndSend({
        brokerageId: input.brokerageId,
        contactId: row.contact_id ?? undefined,
        leadId: row.lead_id ?? undefined,
        userId: agentUserId ?? undefined,
        agentId: row.agent_id ?? undefined,
        recipientName: name,
        mailingAddress: addr.street,
        city: addr.city,
        state: addr.state,
        zip: addr.zip,
        pieceType: ((row.piece_type as string | null) ?? "postcard") as any,
        copyCtx: {
          brokerageId: input.brokerageId,
          agentUserId,
          contactId: row.contact_id ?? null,
          persona: "sphere",
        } as any,
        fallbackTemplateId: fallbackTpl,
        systemSource: `campaign_drain:${row.target_audience ?? "approved"}`,
      })

      await svc.from("direct_mail_campaigns").update({
        status: result.success ? "sent" : "failed",
        lob_order_id: result.messageId ?? null,
        mailing_date: result.success ? new Date().toISOString().slice(0, 10) : null,
        pieces_mailed: result.success ? 1 : 0,
      }).eq("id", row.id)

      if (result.success) out.sent++
      else out.failed++
    } catch {
      await svc.from("direct_mail_campaigns").update({ status: "failed" }).eq("id", row.id)
      out.failed++
    }
  }

  return out
}
