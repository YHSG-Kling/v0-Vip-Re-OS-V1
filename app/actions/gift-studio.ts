"use server"

/**
 * app/actions/gift-studio.ts — the Gift Studio's in-window flow.
 *
 * getGiftStudioAction: recent closings still ungifted + the AI-composed,
 * deal-grounded selections for a chosen contact (the address from THEIR
 * closed transaction prefills the engraving line).
 * orderGiftSelectionAction: the in-window order — a client_gifts row +
 * the agent task carrying the personalization block and the pre-scoped
 * buy links. One command center: everything composed inside; the final
 * purchase click is the only external hop.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { composeGiftSelections, type GiftSelection, type GiftFacts } from "@/lib/gifting/gift-studio"

async function loadMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: row } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!row?.brokerage_id) return null
  return { userId: user.id, brokerageId: (row as any).brokerage_id as string }
}

export interface GiftableClosing {
  contactId: string
  name: string
  address: string | null
  closeDate: string | null
}

export async function getGiftStudioAction(input?: { contactId?: string; occasion?: GiftFacts["occasion"] }): Promise<
  | { ok: true; closings: GiftableClosing[]; selections: GiftSelection[]; selectedContactId: string | null }
  | { ok: false; error: string }
> {
  const m = await loadMember()
  if (!m) return { ok: false, error: "Not authenticated" }
  const svc = createServiceClient()

  // Recent closings (90d) that haven't been gifted yet — the studio's queue.
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const { data: txs } = await svc.from("transactions")
    .select("id, contact_id, buyer_contact_id, property_address, close_date")
    .eq("brokerage_id", m.brokerageId)
    .eq("status", "closed")
    .gte("close_date", since.slice(0, 10))
    .order("close_date", { ascending: false })
    .limit(30)
  const contactIds = Array.from(new Set(((txs ?? []) as any[])
    .flatMap((t) => [t.contact_id, t.buyer_contact_id]).filter(Boolean))) as string[]

  const gifted = new Set<string>()
  if (contactIds.length > 0) {
    const { data: gifts } = await svc.from("client_gifts")
      .select("contact_id").in("contact_id", contactIds).gte("created_at", since)
    for (const g of ((gifts ?? []) as any[])) gifted.add(g.contact_id)
  }
  const nameById = new Map<string, string>()
  if (contactIds.length > 0) {
    const { data: cs } = await svc.from("contacts")
      .select("id, first_name, last_name").eq("brokerage_id", m.brokerageId).in("id", contactIds)
    for (const c of ((cs ?? []) as any[])) {
      nameById.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(" ") || "Client")
    }
  }
  const closings: GiftableClosing[] = ((txs ?? []) as any[])
    .map((t) => ({ contactId: (t.contact_id ?? t.buyer_contact_id) as string, address: t.property_address ?? null, closeDate: t.close_date ?? null }))
    .filter((c) => c.contactId && nameById.has(c.contactId) && !gifted.has(c.contactId))
    .map((c) => ({ ...c, name: nameById.get(c.contactId)! }))
    .filter((c, i, arr) => arr.findIndex((x) => x.contactId === c.contactId) === i)
    .slice(0, 12)

  // Selections for the chosen (or first) contact — deal-grounded.
  const selectedContactId = input?.contactId ?? closings[0]?.contactId ?? null
  let selections: GiftSelection[] = []
  if (selectedContactId) {
    const closing = closings.find((c) => c.contactId === selectedContactId)
    const { data: contact } = await svc.from("contacts")
      .select("first_name, last_name, tags, contact_type")
      .eq("id", selectedContactId).eq("brokerage_id", m.brokerageId).maybeSingle()
    const { data: past } = await svc.from("client_gifts")
      .select("gift_type").eq("contact_id", selectedContactId).limit(20)
    const c = contact as any
    selections = composeGiftSelections({
      occasion: input?.occasion ?? "closing",
      familyName: (c?.last_name as string | null) ?? null,
      firstNames: (c?.first_name as string | null) ?? null,
      homeAddress: closing?.address ?? null,
      closeYear: closing?.closeDate ? new Date(closing.closeDate).getFullYear() : null,
      persona: Array.isArray(c?.tags) ? c.tags.join(",") : (c?.contact_type ?? null),
      budgetMax: null,
      pastGiftKeys: ((past ?? []) as any[]).map((g) => String(g.gift_type ?? "")),
    })
  }

  return { ok: true, closings, selections, selectedContactId }
}

export async function orderGiftSelectionAction(input: {
  contactId: string
  selection: GiftSelection
  occasion?: string
}): Promise<{ ok: true; taskCreated: boolean } | { ok: false; error: string }> {
  const m = await loadMember()
  if (!m) return { ok: false, error: "Not authenticated" }
  const svc = createServiceClient()

  // Tenant check + the agent who owns the relationship.
  const { data: contact } = await svc.from("contacts")
    .select("id, first_name, agent_id").eq("id", input.contactId).eq("brokerage_id", m.brokerageId).maybeSingle()
  if (!contact) return { ok: false, error: "Contact not found" }
  const agentId = ((contact as any).agent_id as string | null) ?? null

  // The order row — the studio's ledger (dedupe key for the queue).
  await svc.from("client_gifts").insert({
    brokerage_id: m.brokerageId,
    agent_id: agentId,
    contact_id: input.contactId,
    gift_type: input.selection.key,
    gift_name: input.selection.title,
    gift_description: input.selection.title,
    personalization_note: input.selection.personalization,
    occasion: input.occasion ?? "closing",
    status: "ordered",
    source: "gift_studio",
  }).then(() => {}, () => {})

  // The purchase task — personalization block + pre-scoped buy links inline.
  const { error } = await svc.from("tasks").insert({
    brokerage_id: m.brokerageId,
    contact_id: input.contactId,
    assigned_to_agent_id: agentId,
    title: `Order the ${input.occasion ?? "closing"} gift for ${(contact as any).first_name ?? "your client"}`,
    description: [
      input.selection.title,
      input.selection.personalization ? `Personalization (copy-paste): ${input.selection.personalization}` : null,
      `Budget: $${input.selection.priceBand[0]}–$${input.selection.priceBand[1]}`,
      `Buy: Etsy ${input.selection.etsyUrl} · Amazon ${input.selection.amazonUrl}`,
    ].filter(Boolean).join("\n"),
    due_date: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    assignee_type: "agent",
    source: "gift_studio",
    status: "pending",
    created_at: new Date().toISOString(),
  })
  return { ok: true, taskCreated: !error }
}
