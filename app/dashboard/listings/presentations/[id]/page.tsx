/**
 * /dashboard/listings/presentations/[id]
 *
 * Listing presentation viewer. Renders the slide deck assembled by the
 * Sprint J builder (lib/workflow/intelligence/listing-presentation-builder.ts).
 * Server component fetches the presentation row + handoffs to the client
 * viewer for slide navigation.
 */

import { notFound, redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import PresentationViewer, { type Presentation } from "./presentation-viewer"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ListingPresentationPage({ params }: PageProps) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?redirect=/dashboard/listings/presentations/${id}`)

  const { data: pres } = await supabase
    .from("listing_presentations")
    .select("*")
    .eq("id", id)
    .maybeSingle()

  if (!pres) notFound()

  // Resolve agent name + brokerage name for the title slide
  let agentName: string | null = null
  if (pres.agent_user_id) {
    const { data: u } = await supabase
      .from("users").select("first_name, last_name").eq("id", pres.agent_user_id).maybeSingle()
    if (u) agentName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || null
  }
  let brokerageName: string | null = null
  if (pres.brokerage_id) {
    const { data: b } = await supabase
      .from("brokerages").select("name").eq("id", pres.brokerage_id).maybeSingle()
    if (b) brokerageName = b.name ?? null
  }

  const presentation: Presentation = {
    id:                pres.id,
    propertyAddress:   pres.property_address ?? null,
    state:             pres.state ?? null,
    appointmentAt:     pres.appointment_at ?? null,
    builtAt:           pres.built_at ?? pres.created_at,
    cmaSnapshot: {
      low:  Number(pres.cma_low_value  ?? 0),
      mid:  Number(pres.cma_mid_value  ?? 0),
      high: Number(pres.cma_high_value ?? 0),
      confidence: Number(pres.cma_confidence ?? 0),
      narrative: pres.cma_narrative ?? "",
    },
    netSheet:          (pres.net_sheet      as Presentation["netSheet"]) ?? [],
    marketingPlan:     (pres.marketing_plan as Presentation["marketingPlan"]),
    slideDeck:         (pres.slide_deck     as Presentation["slideDeck"]) ?? [],
    packetDocumentId:  pres.packet_document_id ?? null,
    status:            pres.status ?? "ready",
    agentName,
    brokerageName,
  }

  return <PresentationViewer presentation={presentation} />
}
