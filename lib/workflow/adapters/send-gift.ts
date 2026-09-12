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
 * NO GIFTING VENDOR? THE TASK STILL CARRIES A REAL RECOMMENDATION.
 *
 * OWNER RULING: "when the gift send has no gifting vendor row, ai makes a
 * suggestion of the gift and a selection of etsy vendors within the task."
 *
 * This path used to hand the agent one generic keyword search —
 * composeShoppableLinks("closing gift real estate client") — which is the same
 * link for every client the brokerage has ever closed. Meanwhile the Gift Studio
 * (lib/gifting/gift-studio.ts) already composes exactly what the ruling asks for
 * and had been doing it since it shipped: memory-grounded picks mined from the
 * contact's own file (tags, notes, occupation, ai_insights, life_events),
 * address-personalized from THEIR closed transaction, deduped against gifts they
 * have already received, budget-respecting — each with a pre-scoped Etsy vendor
 * search and a copy-paste engraving line. Two gifting paths existed and the
 * workflow was on the weaker one.
 *
 * So the fallback now runs the STUDIO's composer. Same facts, same catalog, same
 * links the in-app Gift Studio shows — the agent gets a real recommendation with
 * Etsy vendors to choose from, whether they arrived through the workflow or the
 * studio window.
 */
async function createPickProviderTask(
  ctx: StepContext,
  occasion: string,
  reason: string
): Promise<StepResult> {
  const { contact, brokerageId, agentId, supabase } = ctx

  // ── The contact's own file is what makes the pick individual ──────────────
  let selections: import("@/lib/gifting/gift-studio").GiftSelection[] = []
  try {
    const { composeGiftSelections, mineGiftInterests, mineLifeEvents } =
      await import("@/lib/gifting/gift-studio")

    let facts: any = { occasion: normalizeGiftOccasion(occasion) }
    if (contact?.id) {
      const { data: c } = await supabase
        .from("contacts")
        .select("first_name, last_name, tags, contact_type, notes, occupation, ai_insights, life_events")
        .eq("id", contact.id)
        .maybeSingle()
      const row = c as any
      // Their closed deal supplies the address the engraving line uses.
      const { data: tx } = await supabase
        .from("transactions")
        .select("property_address, close_date")
        .eq("brokerage_id", brokerageId)
        .or(`contact_id.eq.${contact.id},buyer_contact_id.eq.${contact.id}`)
        .eq("status", "closed")
        .order("close_date", { ascending: false })
        .limit(1)
        .maybeSingle()
      // Never gift the same thing twice.
      const { data: past } = await supabase
        .from("client_gifts")
        .select("gift_type")
        .eq("contact_id", contact.id)
        .limit(20)

      facts = {
        occasion: normalizeGiftOccasion(occasion),
        familyName: row?.last_name ?? null,
        firstNames: row?.first_name ?? null,
        homeAddress: (tx as any)?.property_address ?? null,
        closeYear: (tx as any)?.close_date ? new Date((tx as any).close_date).getFullYear() : null,
        persona: Array.isArray(row?.tags) ? row.tags.join(",") : (row?.contact_type ?? null),
        budgetMax: null,
        pastGiftKeys: ((past ?? []) as any[]).map((g) => String(g.gift_type ?? "")),
        interests: mineGiftInterests({
          tags: Array.isArray(row?.tags) ? row.tags : null,
          notes: row?.notes ?? null,
          occupation: row?.occupation ?? null,
          aiInsights: row?.ai_insights != null
            ? (typeof row.ai_insights === "string" ? row.ai_insights : JSON.stringify(row.ai_insights))
            : null,
          contactType: row?.contact_type ?? null,
        }),
        lifeEvents: mineLifeEvents(row?.life_events),
      }
    }
    selections = composeGiftSelections(facts, 3)
  } catch {
    // Composition is best-effort: a task with no picks still beats no task.
  }

  const description = [
    reason,
    selections.length > 0
      ? `AI picks for ${contact?.first_name ?? "this client"} — choose one:`
      : null,
    ...selections.map((s, i) => [
      `${i + 1}. ${s.title} ($${s.priceBand[0]}–$${s.priceBand[1]})`,
      `   Why: ${s.whyThisFits}`,
      s.memoryHook ? `   From their file: ${s.memoryHook}` : null,
      s.personalization ? `   Personalization (copy-paste): ${s.personalization}` : null,
      `   Etsy vendors: ${s.etsyUrl}`,
      `   Amazon: ${s.amazonUrl}`,
    ].filter(Boolean).join("\n")),
    // Only when composition produced nothing — an honest floor, not the default.
    selections.length === 0
      ? (await import("@/lib/gifting/shoppable-links"))
          .composeShoppableLinks(`${occasion.replace(/_/g, " ")} gift real estate client`).taskLine
      : null,
  ].filter(Boolean).join("\n")

  const { data: task } = await supabase.from("tasks").insert({
    brokerage_id: brokerageId,
    contact_id:   contact?.id ?? null,
    assigned_to_agent_id: agentId,
    title: selections.length > 0
      ? `Send ${contact?.first_name ?? "your client"} the ${selections[0].title.toLowerCase()} (or pick another)`
      : `Pick + send ${occasion} gift to ${contact?.first_name ?? "contact"}`,
    description,
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
      // The picks travel in the step output too, so a later step (or the
      // Team Room feed) can show WHAT the AI recommended, not just that it did.
      recommendations: selections.map((s) => ({
        key: s.key, title: s.title, etsyUrl: s.etsyUrl, priceBand: s.priceBand,
      })),
      note: selections.length > 0
        ? `${selections.length} AI gift picks with Etsy vendors on the task: ${reason}`
        : `Manual handling required — task created: ${reason}`,
    },
  }
}

/**
 * The STEP's occasion vocabulary → the Gift Studio's. They are not the same list
 * and the mismatch matters: the step offers `just_because`, which GiftFacts does
 * not admit, and every catalog entry is filtered by occasion — so passing it
 * straight through would return ZERO selections and quietly reduce this back to
 * the generic-link fallback it replaces.
 *
 *   step               studio        why
 *   closing            closing       same
 *   birthday           birthday      same
 *   anniversary        anniversary   same
 *   referral_thank_you referral_thank_you  same (the studio has it too)
 *   just_because       holiday       'holiday' is the studio's broad
 *                                    no-specific-milestone bucket and the
 *                                    widest-covered occasion in the catalog
 */
function normalizeGiftOccasion(occasion: string): import("@/lib/gifting/gift-studio").GiftFacts["occasion"] {
  switch ((occasion ?? "").toLowerCase()) {
    case "closing":            return "closing"
    case "birthday":           return "birthday"
    case "anniversary":        return "anniversary"
    case "referral_thank_you": return "referral_thank_you"
    case "congratulations":    return "congratulations"
    case "holiday":            return "holiday"
    case "just_because":       return "holiday"
    default:                   return "holiday"
  }
}
