import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  translateEvent,
  PROJECTABLE_EVENT_TYPES,
} from "@/lib/portal-stream/event-translator"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"

/**
 * Portal Event Stream Projector
 *
 * Scans unprojected lifecycle_events of types in PROJECTABLE_EVENT_TYPES
 * and writes a customer/agent-facing portal_event_stream row for each.
 *
 * Idempotency: uq_pes_source_event unique index on (source_event_id)
 * means re-running the projector is safe — duplicate inserts are skipped.
 *
 * GET = scheduled (runs every minute via Vercel cron).
 * POST = admin on-demand reprojection (useful when adding new event types
 *        or fixing a translation).
 */

const BATCH_SIZE = 200
const LOOKBACK_MINUTES = 90

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "portal-stream-projector",
    cron_path: "/app/api/cron/portal-stream-projector/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const svc = createServiceClient()
  const summary = { scanned: 0, inserted: 0, skipped: 0, errors: 0 }
  const since = new Date(Date.now() - LOOKBACK_MINUTES * 60_000).toISOString()

  try {
    const { data: events } = await svc
      .from("lifecycle_events")
      .select("id, event_type, entity_type, entity_id, brokerage_id, metadata, created_at")
      .in("event_type", PROJECTABLE_EVENT_TYPES)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE)

    summary.scanned = events?.length ?? 0

    for (const ev of (events ?? []) as Array<{
      id: string; event_type: string; entity_type: string | null; entity_id: string;
      brokerage_id: string; metadata: Record<string, unknown> | null; created_at: string
    }>) {
      try {
        // Skip if already projected (idempotency)
        const { data: existing } = await svc
          .from("portal_event_stream")
          .select("id")
          .eq("source_event_id", ev.id)
          .maybeSingle()
        if (existing) { summary.skipped++; continue }

        // Resolve contact_id + agent + property from entity
        const resolved = await resolveEntityContext(svc, ev.entity_type, ev.entity_id)
        if (!resolved.contactId) { summary.skipped++; continue }

        const translation = translateEvent({
          eventType:       ev.event_type,
          metadata:        ev.metadata,
          entityType:      ev.entity_type,
          propertyAddress: resolved.propertyAddress,
          agentFirstName:  resolved.agentFirstName,
        })
        if (!translation) { summary.skipped++; continue }

        await svc.from("portal_event_stream").insert({
          brokerage_id:          ev.brokerage_id,
          contact_id:            resolved.contactId,
          agent_user_id:         resolved.agentUserId,
          transaction_id:        resolved.transactionId,
          listing_id:            resolved.listingId,
          source_event_id:       ev.id,
          event_type:            ev.event_type,
          customer_copy:         translation.customerCopy,
          customer_icon:         translation.customerIcon,
          agent_copy:            translation.agentCopy,
          agent_action_required: translation.agentActionRequired,
          agent_action_label:    translation.agentActionLabel,
          severity:              translation.severity,
          metadata:              ev.metadata ?? {},
          occurred_at:           ev.created_at,
        })
        summary.inserted++
      } catch (e) {
        console.error(`[portal-stream-projector] event ${ev.id}:`, e)
        summary.errors++
      }
    }

    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: summary.inserted,
      metadata:          summary,
    })
    return NextResponse.json({ message: "Projection complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Projector failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * POST: admin reprojection. Reprocesses recent events even if they're
 * already projected — useful for testing new translations.
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  // Same path as GET — the unique index quietly skips duplicates.
  return GET(request)
}

async function resolveEntityContext(
  svc: ReturnType<typeof createServiceClient>,
  entityType: string | null,
  entityId: string,
): Promise<{
  contactId:       string | null
  agentUserId:     string | null
  agentFirstName:  string | null
  transactionId:   string | null
  listingId:       string | null
  propertyAddress: string | null
}> {
  const out = {
    contactId:       null as string | null,
    agentUserId:     null as string | null,
    agentFirstName:  null as string | null,
    transactionId:   null as string | null,
    listingId:       null as string | null,
    propertyAddress: null as string | null,
  }

  if (entityType === "transaction") {
    const { data } = await svc
      .from("transactions")
      .select("id, contact_id, agent_id, property_address, listing_id")
      .eq("id", entityId)
      .maybeSingle()
    if (data) {
      out.contactId       = (data.contact_id as string | null) ?? null
      out.agentUserId     = (data.agent_id as string | null) ?? null
      out.transactionId   = (data.id as string)
      out.listingId       = (data.listing_id as string | null) ?? null
      out.propertyAddress = (data.property_address as string | null) ?? null
    }
  } else if (entityType === "listing") {
    const { data } = await svc
      .from("listings")
      .select("id, agent_id, contact_id, address")
      .eq("id", entityId)
      .maybeSingle()
    if (data) {
      out.contactId       = (data.contact_id as string | null) ?? null
      out.agentUserId     = (data.agent_id as string | null) ?? null
      out.listingId       = (data.id as string)
      out.propertyAddress = (data.address as string | null) ?? null
    }
  } else if (entityType === "offer") {
    const { data } = await svc
      .from("offers")
      .select("id, contact_id, agent_id, listing_id")
      .eq("id", entityId)
      .maybeSingle()
    if (data) {
      out.contactId   = (data.contact_id as string | null) ?? null
      out.agentUserId = (data.agent_id as string | null) ?? null
      out.listingId   = (data.listing_id as string | null) ?? null
      if (out.listingId) {
        const { data: l } = await svc.from("listings").select("address").eq("id", out.listingId).maybeSingle()
        out.propertyAddress = (l?.address as string | null) ?? null
      }
    }
  } else if (entityType === "contact") {
    const { data } = await svc
      .from("contacts")
      .select("id, agent_id")
      .eq("id", entityId)
      .maybeSingle()
    if (data) {
      out.contactId   = (data.id as string)
      out.agentUserId = (data.agent_id as string | null) ?? null
    }
  }

  // Resolve agent first name for customer-facing copy
  if (out.agentUserId) {
    const { data: agent } = await svc
      .from("users")
      .select("first_name")
      .eq("id", out.agentUserId)
      .maybeSingle()
    out.agentFirstName = (agent?.first_name as string | null) ?? null
  }

  return out
}
