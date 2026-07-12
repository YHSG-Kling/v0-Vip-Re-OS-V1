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

    if (!agentId) {
      return { status: "error", providerKey: "gift", error: "Gift channel requires an agent (agents.id) — context did not resolve one" }
    }

    try {
      const giftMod = await import("@/app/actions/ai-client-gifting")

      // ── AI-recommend a gift (gives us name, description, cost, vendor) ──
      // ai-client-gifting expects: { agentId, contactId, occasion, budget?: { min, max } }
      let recommendedGift: {
        name: string
        description: string
        cost: number
        vendor: string
      } | null = null

      const validOccasion = (
        ["closing", "anniversary", "birthday", "referral_thank_you", "holiday", "apology", "congratulations"]
          .includes(occasion) ? occasion : "closing"
      ) as "closing" | "anniversary" | "birthday" | "referral_thank_you" | "holiday" | "apology" | "congratulations"

      if (typeof (giftMod as any).aiRecommendGift === "function") {
        const budget = amountCents != null
          ? { min: Math.round(amountCents * 0.7 / 100), max: Math.round(amountCents / 100) }
          : undefined

        const rec = await (giftMod as any).aiRecommendGift({
          agentId,
          contactId: contact.id,
          occasion: validOccasion,
          budget,
        })

        if (rec?.success) {
          // ai-client-gifting returns { recommendations: [{ name, description, estimatedCost, vendor, ... }] }
          // Use the first recommendation, or honor explicit vendor selection.
          const top = (rec.recommendations?.[0] ?? rec.recommendation) as {
            name?: string; description?: string; estimatedCost?: number; cost?: number; vendor?: string
          } | undefined
          if (top?.name) {
            recommendedGift = {
              name:        top.name,
              description: top.description ?? `${validOccasion} gift for ${contact.first_name ?? "client"}`,
              cost:        top.cost ?? top.estimatedCost ?? (amountCents ? amountCents / 100 : 100),
              vendor:      explicitVendorId ?? top.vendor ?? "tbd",
            }
          }
        }
      }

      if (!recommendedGift) {
        return createPickProviderTask(
          ctx, validOccasion,
          `No gift recommendation available for ${validOccasion} on ${contact.first_name ?? "contact"} — agent must select manually`
        )
      }

      // ── Generate a thank-you / occasion note if not supplied ───────────
      let noteText = customNote
      if (!noteText && typeof (giftMod as any).aiGenerateThankYouNote === "function") {
        try {
          const noteResult = await (giftMod as any).aiGenerateThankYouNote({
            agentId,
            contactId: contact.id,
            occasion: validOccasion,
            giftDescription: recommendedGift.description,
            handwritten: false,
          })
          noteText = noteResult?.note ?? noteResult?.text ?? null
        } catch { /* note is optional */ }
      }

      // ── Place the gift order ───────────────────────────────────────────
      if (typeof (giftMod as any).createGiftOrder === "function") {
        const orderResult = await (giftMod as any).createGiftOrder({
          agentId,
          contactId: contact.id,
          giftDetails: {
            name:         recommendedGift.name,
            description:  recommendedGift.description,
            cost:         recommendedGift.cost,
            vendor:       recommendedGift.vendor,
            occasion:     validOccasion,
            personalNote: noteText ?? undefined,
          },
          deliveryAddress: recipientAddress,
        })

        // If autoPay was false (or payment requires agent action), create a "pay" task
        const orderId = orderResult?.orderId ?? orderResult?.giftOrder?.id ?? orderResult?.id
        const paid = autoPay && (orderResult?.paid || orderResult?.success)

        if (!paid) {
          // B2C GIFTING (owner rule: no fulfillment provider in the middle —
          // the agent buys personally). The task carries SHOPPABLE LINKS for
          // the exact recommended gift so purchase is one click, in the
          // agent's own name, on their own card.
          const { composeShoppableLinks } = await import("@/lib/gifting/shoppable-links")
          const shop = composeShoppableLinks(recommendedGift.name, { budgetMax: recommendedGift.cost || null })
          void Promise.resolve(supabase.from("tasks").insert({
            brokerage_id: brokerageId,
            contact_id:   contact.id,
            assigned_to_agent_id: agentId,
            title: `Pay for ${validOccasion} gift to ${contact.first_name ?? "contact"}`,
            description: `Gift order ${orderId ?? "(pending)"} from ${recommendedGift.vendor} — $${recommendedGift.cost}. ${shop.taskLine}`,
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
          messageId: orderId,
          error: orderResult?.error,
          output: {
            gift_order_id: orderId,
            vendor:        recommendedGift.vendor,
            occasion:      validOccasion,
            cost:          recommendedGift.cost,
            note:          noteText,
            auto_paid:     paid,
          },
        }
      }

      return createPickProviderTask(ctx, validOccasion, "Gift order creation function not yet exported — agent must place manually")
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
  // Even the manual path gets a one-click starting point (B2C — the agent
  // buys personally; searches keyed to the occasion, no provider).
  const { composeShoppableLinks } = await import("@/lib/gifting/shoppable-links")
  const shop = composeShoppableLinks(`${occasion.replace(/_/g, " ")} gift real estate client`)
  const { data: task } = await supabase.from("tasks").insert({
    brokerage_id: brokerageId,
    contact_id:   contact?.id ?? null,
    assigned_to_agent_id: agentId,
    title: `Pick + send ${occasion} gift to ${contact?.first_name ?? "contact"}`,
    description: `${reason} ${shop.taskLine}`,
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
