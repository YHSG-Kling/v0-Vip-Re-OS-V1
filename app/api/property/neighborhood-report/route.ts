// app/api/property/neighborhood-report/route.ts
// Neighborhood intelligence endpoint. Resolves the caller's brokerage + plan_tier,
// then returns a tier-gated neighborhood report (amenities, walkability, Census
// median value, Fair-Housing-safe AI narrative). Only the most advanced plans
// (brokerage / multi_location) receive the full report; others get { tierGated: true }.

import { NextRequest, NextResponse } from "next/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createClient } from "@/lib/supabase/server"
import { generateNeighborhoodReport } from "@/lib/property/neighborhood-intelligence"

export async function POST(req: NextRequest) {
  const { brokerageId } = await getAgentContext()
  if (!brokerageId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })
  }

  let body: { address?: string; city?: string; state?: string; zip?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { address, city, state, zip } = body
  if (!address || !city || !state || !zip) {
    return NextResponse.json({ error: "address, city, state, and zip are required" }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("plan_tier")
    .eq("id", brokerageId)
    .single()

  const report = await generateNeighborhoodReport({
    brokerageId,
    planTier: brokerage?.plan_tier ?? null,
    address,
    city,
    state,
    zip,
  })

  if (report.tierGated) {
    return NextResponse.json(
      { tierGated: true, message: "Neighborhood intelligence requires the Brokerage or Multi-Location plan." },
      { status: 402 },
    )
  }

  return NextResponse.json(report)
}
