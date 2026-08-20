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
 *
 * m491 — THE MAILING-LIST ROW. This drain is the path that actually mails a
 * LEAD, and it wrote no `direct_mail_recipients` row: neither here, nor in
 * orchestrateRenderAndSend, nor in dispatchDirectMail. A lead's piece existed
 * only as a campaign row, so the mailing list could not say who was mailed and
 * the Recipients surface was empty for every 1:1 send. m491 gave that table a
 * `lead_id`; the drain now stages the row before spending and stamps it
 * mailed/failed alongside the campaign. Best-effort — the refusal is reported,
 * never swallowed, but it does not withhold a legitimate piece, because the
 * RESPONSE path does not depend on this row (both response writers fall back to
 * `direct_mail_campaigns.lead_id`).
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

    // ── m491: STAGE THE MAILING-LIST ROW BEFORE SPENDING ─────────────────────
    // This drain is the path that ACTUALLY MAILS A LEAD, and it wrote no
    // `direct_mail_recipients` row at all — neither here, nor in
    // orchestrateRenderAndSend, nor in dispatchDirectMail. So a lead's mail piece
    // existed only as a campaign row: the mailing list could not say who was
    // mailed, the Recipients surface showed nothing for the piece, and a returned
    // reply card had no recipient row to point at. m491 gave the table a
    // `lead_id`; this is the writer that fills it.
    //
    // BEST-EFFORT, deliberately: the refusal is REPORTED, never swallowed, but it
    // does not withhold the piece. The response path does not depend on this row
    // (logResponse and the QR route both fall back to `direct_mail_campaigns.lead_id`,
    // which is where a 1:1 campaign names its addressee), so a ledger gap here is
    // a defect to surface, not a reason to cancel a legitimate marketing send.
    //
    // m493/QR — THE INSERT IS ALSO WHERE THE PRINTED OPT-OUT COMES FROM. The
    // token column is NOT NULL with a pgcrypto DEFAULT, so the row is minted
    // with one and the ONLY way to learn it is to select it back off this
    // insert. That is why `.select("id, unsubscribe_token")` and not just "id":
    // the piece cannot be rendered with a working opt-out until this line
    // returns. A re-read afterwards would be a second round trip to the same
    // row for a value the insert already had.
    let recipientRowId: string | null = null
    let unsubscribeToken: string | null = null
    {
      const { data: recRow, error: recErr } = await svc
        .from("direct_mail_recipients")
        .insert({
          brokerage_id:   input.brokerageId,
          campaign_id:    row.id,
          contact_id:     row.contact_id ?? null,
          lead_id:        row.lead_id ?? null,
          first_name:     name.split(" ")[0] ?? name,
          last_name:      name.split(" ").slice(1).join(" "),
          address_line1:  addr.street,
          city:           addr.city,
          state:          addr.state,
          zip:            addr.zip,
          delivery_status: "pending",
        })
        .select("id, unsubscribe_token")
        .maybeSingle()
      if (recErr) {
        console.error(
          `[campaign-drain] direct_mail_recipients insert refused for campaign ${row.id}: ${recErr.message}`,
        )
      }
      const rec = recRow as { id?: string; unsubscribe_token?: string | null } | null
      recipientRowId   = rec?.id ?? null
      unsubscribeToken = rec?.unsubscribe_token ?? null
      // A row with no token means the m493 DEFAULT did not fire — the piece can
      // still mail (the marketing send is legitimate) but it would mail WITHOUT
      // a way for the recipient to stop it, and that is not something to notice
      // only in a printer's proof. Said out loud, once, per piece.
      if (recipientRowId && !unsubscribeToken) {
        console.error(
          `[campaign-drain] recipient ${recipientRowId} came back with no unsubscribe_token; ` +
          `the piece will print no opt-out. Check the m493 DEFAULT on direct_mail_recipients.`,
        )
      }
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
        // The token minted on the recipient row above, carried to the printed
        // piece. This is the half of the owner's "traceable back to their
        // direct mail campaign to unsubscribe" ruling that the mechanism could
        // not satisfy on its own: the resolver and the public surface existed,
        // and nothing put the code where the person could reach it.
        unsubscribeToken,
        systemSource: `campaign_drain:${row.target_audience ?? "approved"}`,
      })

      await svc.from("direct_mail_campaigns").update({
        status: result.success ? "sent" : "failed",
        lob_order_id: result.messageId ?? null,
        mailing_date: result.success ? new Date().toISOString().slice(0, 10) : null,
        pieces_mailed: result.success ? 1 : 0,
      }).eq("id", row.id)

      // m491 — the mailing-list row tells the same truth as the campaign row.
      // `mailed_at` matters beyond reporting: it is what the mail over-touch cap
      // counts on (lib/kernel/deconflict countMailTouches).
      if (recipientRowId) {
        const { error: recStatusErr } = await svc
          .from("direct_mail_recipients")
          .update(
            result.success
              ? { delivery_status: "mailed", mailed_at: new Date().toISOString() }
              : { delivery_status: "failed" },
          )
          .eq("id", recipientRowId)
        if (recStatusErr) {
          console.error(
            `[campaign-drain] recipient status update refused for ${recipientRowId}: ${recStatusErr.message}`,
          )
        }
      }

      if (result.success) out.sent++
      else out.failed++
    } catch {
      await svc.from("direct_mail_campaigns").update({ status: "failed" }).eq("id", row.id)
      if (recipientRowId) {
        await svc.from("direct_mail_recipients").update({ delivery_status: "failed" }).eq("id", recipientRowId)
      }
      out.failed++
    }
  }

  return out
}
