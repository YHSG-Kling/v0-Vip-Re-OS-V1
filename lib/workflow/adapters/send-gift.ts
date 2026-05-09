/**
 * Send Gift adapter — closing/holiday/anniversary/birthday/just-because gifts.
 *
 * Uses the existing gifting infrastructure (app/actions/ai-client-gifting.ts):
 *   - aiRecommendGift()        AI-recommends gifts based on contact persona + occasion
 *   - createGiftOrder()        Routes the order to a vendor (vendor marketplace) and pays
 *   - aiGenerateThankYouNote() Generates a personalized note to enclose
 *
 * Step config:
 *   gift_occasion:        'closing' | 'birthday' | 'anniversary' | 'just_because' | 'referral_thank_you'
 *   gift_provider_id:     uuid           — optional; specific vendor (skips AI recommendation)
 *   gift_amount_cents:    integer        — optional budget cap
 *   gift_custom_note:     text           — optional override; AI generates if omitted
 *   gift_recipient_address: 'auto' | text — 'auto' pulls from contact record
 *   gift_auto_pay:        boolean        — true = charge the agent's saved card; false = create a "pay" task
 *
 * Output: { gift_order_id, vendor_id, amount_cents, status }
 *
 * If no vendor is configured (vendor marketplace not yet populated for this
 * brokerage), falls back to creating a TASK on the agent: "Pick a closing gift
 * provider for {{contact}}" so the workflow doesn't silently fail.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const sendGiftAdapter: ChannelAdapter = {
  channel: "send_gift",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, contact, brokerageId, agentId, agentUserId, supabase } = ctx

    if (!contact?.id) {
      return { status: "error", providerKey: "gift", error: "No contact for gift" }
    }

    const occasion = (step as any).gift_occasion ?? "just_because"
    const customNote = (step as any).gift_custom_note ?? null
    const explicitVendorId = (step as any).gift_provider_id ?? null
    const amountCents = (step as any).gift_amount_cents ?? null
    const autoPay = (step as any).gift_auto_pay ?? false

    // Resolve recipient address
    let recipientAddress: string | null = null
    const addrConfig = (step as any).gift_recipient_address ?? "auto"
    if (addrConfig === "auto") {
      const { data: c } = await supabase
        .from("contacts")
        .select("first_name, last_name, mailing_address, city, state, zip_code")
        .eq("id", contact.id)
        .maybeSingle()
      const cr = c as { mailing_address?: string; city?: string; state?: string; zip_code?: string; first_name?: string; last_name?: string } | null
      if (cr?.mailing_address) {
        recipientAddress = `${cr.first_name ?? ""} ${cr.last_name ?? ""}\n${cr.mailing_address}, ${cr.city ?? ""}, ${cr.state ?? ""} ${cr.zip_code ?? ""}`.trim()
      }
    } else if (typeof addrConfig === "string") {
      recipientAddress = addrConfig
    }

    if (!recipientAddress) {
      // Without an address we can't send a physical gift — fall through to a task
      return createPickProviderTask(ctx, occasion, "No mailing address on contact — agent must collect address before gift can be sent")
    }

    try {
      const giftMod = await import("@/app/actions/ai-client-gifting")

      // ── AI-recommend a gift if no vendor was specified ─────────────────
      let vendorId = explicitVendorId
      let recommendedGift: { name?: string; price_cents?: number; vendor_id?: string } | null = null

      if (!vendorId && typeof (giftMod as any).aiRecommendGift === "function") {
        const rec = await (giftMod as any).aiRecommendGift({
          brokerageId,
          contactId: contact.id,
          occasion,
          budgetCents: amountCents,
        })
        if (rec?.success && rec.recommendation) {
          recommendedGift = rec.recommendation
          vendorId = rec.recommendation?.vendor_id ?? null
        }
      }

      // ── If no vendor available, create a task for the agent ────────────
      if (!vendorId) {
        return createPickProviderTask(
          ctx, occasion,
          `Vendor marketplace returned no recommendation for ${occasion} gift on ${contact.first_name ?? "contact"} — agent must select manually`
        )
      }

      // ── Generate a thank-you / occasion note if not supplied ───────────
      let noteText = customNote
      if (!noteText && typeof (giftMod as any).aiGenerateThankYouNote === "function") {
        try {
          const noteResult = await (giftMod as any).aiGenerateThankYouNote({
            brokerageId,
            contactId: contact.id,
            occasion,
            agentUserId,
          })
          noteText = noteResult?.note ?? null
        } catch { /* note is optional */ }
      }

      // ── Place the gift order ───────────────────────────────────────────
      if (typeof (giftMod as any).createGiftOrder === "function") {
        const orderResult = await (giftMod as any).createGiftOrder({
          brokerageId,
          agentId,
          agentUserId,
          contactId: contact.id,
          vendorId,
          occasion,
          amountCents: amountCents ?? recommendedGift?.price_cents ?? null,
          customNote: noteText,
          shippingAddress: recipientAddress,
          autoPay,
        })

        // If autoPay was false (or payment requires agent action), create a "pay" task
        if (!autoPay || !orderResult?.paid) {
          void Promise.resolve(supabase.from("tasks").insert({
            brokerage_id: brokerageId,
            contact_id:   contact.id,
            assigned_to_agent_id: agentId,
            title: `Pay for ${occasion} gift to ${contact.first_name ?? "contact"}`,
            description: `Gift order ${orderResult?.orderId ?? "(pending)"} from ${recommendedGift?.name ?? "vendor"} — ${(amountCents ?? 0) / 100} USD. Click through to confirm payment.`,
            due_date: new Date(Date.now() + 2 * 86_400_000).toISOString(),
            assignee_type: "agent",
            source: "workflow_sequence",
            source_enrollment_id: ctx.enrollmentId,
            status: "pending",
            created_at: new Date().toISOString(),
          })).catch(() => {})
        }

        return {
          status: orderResult?.success ? "sent" : "error",
          providerKey: "gift",
          messageId: orderResult?.orderId,
          error: orderResult?.error,
          output: {
            gift_order_id: orderResult?.orderId,
            vendor_id: vendorId,
            occasion,
            amount_cents: amountCents ?? recommendedGift?.price_cents ?? null,
            note: noteText,
            auto_paid: autoPay && orderResult?.paid,
          },
        }
      }

      // createGiftOrder not yet exported — record intent + task agent
      return createPickProviderTask(ctx, occasion, "Gift order creation function not yet exported — agent must place manually")
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: "error", providerKey: "gift", error: msg }
    }
  },
}

/**
 * Fallback path — creates a task for the agent to handle the gift manually
 * and returns a "sent" status (the workflow continues; the gift just
 * requires human action).
 */
async function createPickProviderTask(
  ctx: StepContext,
  occasion: string,
  reason: string
): Promise<StepResult> {
  const { contact, brokerageId, agentId, supabase } = ctx
  const { data: task } = await supabase.from("tasks").insert({
    brokerage_id: brokerageId,
    contact_id:   contact?.id ?? null,
    assigned_to_agent_id: agentId,
    title: `Pick + send ${occasion} gift to ${contact?.first_name ?? "contact"}`,
    description: reason,
    due_date: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    assignee_type: "agent",
    source: "workflow_sequence",
    source_enrollment_id: ctx.enrollmentId,
    status: "pending",
    created_at: new Date().toISOString(),
  }).select("id").single()

  return {
    status: "sent",
    providerKey: "gift",
    messageId: task?.id,
    output: {
      gift_order_id: null,
      task_id: task?.id,
      occasion,
      note: `Manual handling required — task created: ${reason}`,
    },
  }
}
