// app/api/portal/client-action/route.ts
//
// THE CLIENT-AS-ACTOR endpoint — a buyer/seller in the portal makes a request and it flows into the
// SAME manager bench + approval gate the agent uses. Auth-gated to the authenticated contact; the
// dispatcher applies the compliance rules (search open, showing BBA-gated, seller action proposed
// through the gate). Nothing reaches anyone without a human in the loop.

import { createServiceClient } from "@/lib/supabase/service"
import { dispatchClientAction } from "@/lib/portal/client-action-dispatch"
import { requireContactAccess } from "@/lib/portal/require-contact-access"
import { NextResponse } from "next/server"

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { contactId, message, propertyAddress, preferredDates, newPrice } = body as {
      contactId: string
      message: string
      propertyAddress?: string
      preferredDates?: { date: string; time: string }[]
      newPrice?: number
    }
    if (!contactId || !message?.trim()) {
      return NextResponse.json({ error: "contactId and message are required" }, { status: 400 })
    }

    // ── Authorization ─────────────────────────────────────────────────────────
    // The comment above this block claimed the route was "auth-gated to the
    // authenticated contact". It was not: it checked only that SOMEBODY was
    // logged in, then looked the body-named contact up and acted as them. Any
    // authenticated user of any tenant could file a showing request, a price
    // change or a seller action in another brokerage's client's name, and the
    // manager bench would have recorded that client as the actor. Replaced
    // (lane G5 2026-08-28) with the shared portal gate — the same one whose
    // header says it exists so portal routes "cannot be called for an arbitrary
    // contactId" — which admits the contact themselves or same-brokerage staff
    // and fails closed on a refused read.
    const access = await requireContactAccess(contactId)
    if (!access.ok) {
      const status = access.error === "Unauthorized" ? 401
        : access.error === "Contact not found" ? 404
        : access.error === "Forbidden" ? 403
        : 500
      return NextResponse.json({ error: access.error }, { status })
    }

    // contact_type still has to be read; the gate returns tenancy, not the row.
    const service = createServiceClient()
    const { data: contact, error: contactErr } = await service
      .from("contacts")
      .select("id, contact_type")
      .eq("id", contactId)
      .eq("brokerage_id", access.brokerageId)
      .maybeSingle()
    if (contactErr) {
      return NextResponse.json({ error: "Contact lookup failed" }, { status: 500 })
    }
    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 })
    }

    const result = await dispatchClientAction(
      {
        brokerageId:  access.brokerageId,
        contactId,
        contactType:  (contact.contact_type as string | null) ?? null,
        message:      message.trim(),
        propertyAddress,
        preferredDates,
        newPrice,
      },
      service,
    )

    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "client-action failed" },
      { status: 500 },
    )
  }
}
