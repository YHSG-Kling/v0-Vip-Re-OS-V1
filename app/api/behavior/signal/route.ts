import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { updateBuyerPreferences } from "@/lib/behavior-learning/preference-updater"

export async function POST(req: NextRequest) {
  try {
    // Auth — Supabase JWT
    const supabaseAuth = await createClient()
    const { data: { user }, error: authErr } = await supabaseAuth.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await req.json()
    const { contactId, signalType, mlsNumber, propertyData, sessionId } = body

    if (!contactId || !signalType) {
      return NextResponse.json({ error: "contactId and signalType are required" }, { status: 400 })
    }

    // Get brokerage_id from the authenticated user's profile
    const supabase = createServiceClient()
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("brokerage_id")
      .eq("user_id", user.id)
      .single()

    const brokerageId: string = profile?.brokerage_id ?? ""

    // INSERT buyer_behavior_log
    const { error: insertErr } = await supabase
      .from("buyer_behavior_log")
      .insert({
        brokerage_id:     brokerageId,
        contact_id:       contactId,
        agent_id:         user.id,
        signal_type:      signalType,
        mls_number:       mlsNumber       ?? null,
        property_address: propertyData?.address     ?? null,
        list_price:       propertyData?.listPrice    ?? null,
        bedrooms:         propertyData?.bedrooms     ?? null,
        bathrooms:        propertyData?.bathrooms    ?? null,
        sqft:             propertyData?.sqft         ?? null,
        property_type:    propertyData?.propertyType ?? null,
        city:             propertyData?.city         ?? null,
        zip:              propertyData?.zip          ?? null,
        signal_value:     1,
        session_id:       sessionId ?? null,
        source:           "agent_dashboard",
        metadata:         propertyData ?? {},
      })

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 })
    }

    // Every 10th signal today: recalculate preferences (non-blocking)
    if (brokerageId) {
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)

      const { count } = await supabase
        .from("buyer_behavior_log")
        .select("id", { count: "exact", head: true })
        .eq("contact_id", contactId)
        .eq("brokerage_id", brokerageId)
        .gte("created_at", todayStart.toISOString())

      if (typeof count === "number" && count % 10 === 0) {
        // Fire-and-forget — do not await
        updateBuyerPreferences(contactId, brokerageId).catch(() => {})
      }
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Internal error" }, { status: 500 })
  }
}
