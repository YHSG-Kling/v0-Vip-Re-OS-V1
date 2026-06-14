// app/api/portal/client-action/route.ts
//
// THE CLIENT-AS-ACTOR endpoint — a buyer/seller in the portal makes a request and it flows into the
// SAME manager bench + approval gate the agent uses. Auth-gated to the authenticated contact; the
// dispatcher applies the compliance rules (search open, showing BBA-gated, seller action proposed
// through the gate). Nothing reaches anyone without a human in the loop.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchClientAction } from "@/lib/portal/client-action-dispatch"
import { NextResponse } from "next/server"

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    // ── Auth gate ──────────────────────────────────────────────────────────────
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

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

    // ── Verify the caller has access to this contact + resolve tenancy/type ──────
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, brokerage_id, contact_type")
      .eq("id", contactId)
      .maybeSingle()
    if (!contact?.brokerage_id) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 })
    }

    const result = await dispatchClientAction(
      {
        brokerageId:  contact.brokerage_id as string,
        contactId,
        contactType:  (contact.contact_type as string | null) ?? null,
        message:      message.trim(),
        propertyAddress,
        preferredDates,
        newPrice,
      },
      createServiceClient(),
    )

    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "client-action failed" },
      { status: 500 },
    )
  }
}
