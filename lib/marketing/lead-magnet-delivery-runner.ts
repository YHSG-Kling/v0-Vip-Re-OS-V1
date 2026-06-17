// lib/marketing/lead-magnet-delivery-runner.ts
//
// Live side of LEAD-MAGNET DELIVERY — when a contact fills out a lead-magnet form, generate the
// deliverable they asked for (the guide/report copy), CLEAR THE COMPLIANCE GATE (Fair Housing / brand
// voice), and record the delivery as an activity so it's auditable and the existing enrolled sequence/
// messaging path ships it. The deterministic copy is Fair-Housing-safe by construction; an injected AI
// generator may personalize within the same safe frame. Best-effort; never throws into the caller.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { prepareMagnetDeliverable, type MagnetType, type CopyContext, type MagnetDeliverable } from "./lead-magnet-copy"

type Svc = ReturnType<typeof createServiceClient>

export { prepareMagnetDeliverable }

/** Record the magnet delivery as an auditable activity on the contact. Best-effort. */
export async function recordMagnetDelivery(
  args: { brokerageId: string; contactId: string; agentUserId?: string | null; magnetType: MagnetType; deliverable: MagnetDeliverable }, client?: Svc,
): Promise<{ ok: boolean }> {
  const svc = client ?? createServiceClient()
  const { error } = await svc.from("activities").insert({
    brokerage_id: args.brokerageId, contact_id: args.contactId, agent_user_id: args.agentUserId ?? null,
    activity_type: "lead_magnet_delivered", title: `Delivered: ${args.deliverable.title}`,
    description: `${args.magnetType} deliverable sent to the contact who filled out the form.`,
    metadata: { magnet_type: args.magnetType, subject: args.deliverable.subject, body: args.deliverable.body },
  })
  return { ok: !error }
}

/** Convenience: prepare + record the deliverable for a captured magnet lead. Best-effort. */
export async function deliverMagnet(
  args: { brokerageId: string; contactId: string; agentUserId?: string | null; magnetType: MagnetType; ctx?: CopyContext }, client?: Svc,
): Promise<{ delivered: boolean }> {
  const svc = client ?? createServiceClient()
  const deliverable = await prepareMagnetDeliverable(args.magnetType, args.ctx).catch(() => null)
  if (!deliverable) return { delivered: false }
  const r = await recordMagnetDelivery({ ...args, deliverable }, svc)
  return { delivered: r.ok }
}
