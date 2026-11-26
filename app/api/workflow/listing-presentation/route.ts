/**
 * POST /api/workflow/listing-presentation
 *
 * On-demand listing presentation builder. Agent presses "Prepare for
 * appointment now" and gets the same artifact the daily cron would produce.
 *
 * Body: { appointmentId?: string, listingId?: string, propertyAddress: string,
 *         state: string, city?, zip?, contactId?, bedrooms?, bathrooms?, sqft?,
 *         yearBuilt? }
 *
 * Returns: { presentationId, cmaSnapshot, netSheet, marketingPlan, slideDeck,
 *            packetDocumentId }
 *
 * ITS CALLER, finally. The button this header describes was never built, so the route
 * sat addressed by nothing — and, being session-authed, it could not be an external
 * door either. It is now called by
 * app/components/features/listing-appointment/listing-appt-copilot-panel.tsx
 * ("Prepare now"), on /dashboard/listing-appointments/[runId], which is where an agent
 * sees that the cron-built presentation is missing or that a step failed.
 *
 * WHY NO CALLER COULD EXIST BEFORE: the route refuses without propertyAddress AND
 * state, and every surface that knew about a listing appointment carried the address
 * only. The state was already on the run — workflow_runs.metadata.property_data, written
 * by listing-lifecycle.ts when it fires listing.appointment_set — and was simply never
 * read out; getListingAppointmentPrepDetail now surfaces it. When a run genuinely has no
 * state (the AI-ISA booking path can write {address} alone) the control is disabled with
 * that reason instead of firing a request that can only 400.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { buildListingPresentation } from "@/lib/workflow/intelligence/listing-presentation-builder"

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({})) as {
    appointmentId?: string
    listingId?: string
    propertyAddress?: string
    state?: string
    city?: string
    zip?: string
    contactId?: string
    bedrooms?: number
    bathrooms?: number
    sqft?: number
    yearBuilt?: number
  }

  if (!body.propertyAddress || !body.state) {
    return NextResponse.json({ error: "propertyAddress + state required" }, { status: 400 })
  }

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) return NextResponse.json({ error: "No brokerage on user" }, { status: 422 })

  const result = await buildListingPresentation({
    brokerageId,
    agentUserId:  user.id,
    contactId:    body.contactId ?? null,
    appointmentId: body.appointmentId ?? null,
    // A listing id from a request body is not proof of tenancy — the upgrade
    // read is anchored on the caller's OWN resolved brokerageId, so a foreign
    // listing id simply returns nothing.
    listingId:    body.listingId ?? null,
    propertyAddress: body.propertyAddress,
    state:        body.state,
    city:         body.city ?? null,
    zip:          body.zip  ?? null,
    bedrooms:     body.bedrooms,
    bathrooms:    body.bathrooms,
    sqft:         body.sqft,
    yearBuilt:    body.yearBuilt,
  })

  if (!result.success || !result.result) {
    return NextResponse.json({ error: result.error ?? "Build failed" }, { status: 500 })
  }

  return NextResponse.json(result.result)
}
