// lib/intelligence/open-house-lead-routing-runner.ts
//
// Live side of OPEN-HOUSE LEAD ROUTING — after an open house wraps and attendees are scored, hand the
// hot, unrepresented buyer leads from the Listing Concierge's event to the AI ISA over the bus, so
// they enter the buyer pipeline instead of dying as a dashboard count. One handoff signal per event
// (carrying the hot leads). Idempotent per event. Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { selectOpenHouseHandoffs, type OpenHouseAttendeeLite } from "./open-house-lead-routing"

type Svc = ReturnType<typeof createServiceClient>

export interface HandoffOpenHouseArgs {
  brokerageId: string
  eventId: string
  listingId?: string | null
  propertyAddress?: string | null
  attendees: OpenHouseAttendeeLite[]
  minScore?: number
}

export async function handoffOpenHouseLeads(args: HandoffOpenHouseArgs, client?: Svc): Promise<{ handed: number }> {
  const svc = client ?? createServiceClient()
  const hot = selectOpenHouseHandoffs(args.attendees, { minScore: args.minScore })
  if (hot.length === 0) return { handed: 0 }

  // Idempotent — one handoff per event.
  const { data: prior } = await svc.from("manager_signals")
    .select("id").eq("brokerage_id", args.brokerageId)
    .eq("signal_type", "open_house_lead_handoff").eq("entity_id", args.eventId).limit(1).maybeSingle()
  if (prior) return { handed: 0 }

  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const names = hot.slice(0, 5).map((h) => h.name ?? "a buyer").join(", ")
    const r = await publishManagerSignal({
      brokerageId: args.brokerageId, fromManager: "listing_concierge", toManager: "ai_isa",
      signalType: "open_house_lead_handoff",
      message: `${hot.length} hot buyer${hot.length === 1 ? "" : "s"} from the open house at ${args.propertyAddress ?? "a listing"} — qualify and work them: ${names}.`,
      entityType: "open_house", entityId: args.eventId,
      payload: {
        listingId: args.listingId ?? null,
        leads: hot.map((h) => ({ attendeeId: h.attendeeId, contactId: h.contactId, name: h.name, score: h.score, reason: h.reason })),
      },
    }, svc)
    return { handed: (r as any).ok ? hot.length : 0 }
  } catch {
    return { handed: 0 }
  }
}
