// lib/kernel/idle-hands.ts
//
// THE IDLE-HANDS INITIATIVE — managers do proactive work BETWEEN commands and crons.
// Everything so far is agent-initiated (voice) or scheduled (loops). A real team's
// managers don't sit on their hands when the inbox is empty — they look around their
// own domain, find the gap, and put finished work on the boss's desk. Overnight, the
// team fills the approval queue instead of waiting to be asked:
//
//   · Marketing Manager — a listing active 7+ days with NO social post in 7 days →
//     drafts the post (social_posts, approval_status='pending' — the existing social
//     approval gate + publish cron take it from there)
//   · Asset Manager — a deal closed in the last 14 days whose listing has NO just_sold
//     reel → dispatches one on the CANONICAL Remotion+D-ID rail (lifecycle policy +
//     cooldown apply — automatic work NEVER bypasses policy)
//   · Sphere Manager — a closing anniversary within 7 days → proposes the anniversary
//     note into the gate (human approves)
//   · Data Steward — contacts missing email/phone with no pending enrichment → queues
//     the re-run (contact_enrichment_queue, source='idle_hands') — data self-heals
//   · AI ISA — the warmest cooling lead (the stand-up's #3) gets the follow-up
//     PRE-DRAFTED into the gate (proposed, NOT auto-approved — morning auto-draft:
//     "do number three" or one tap sends what the team already typed)
//
// THE IDLE RULE: a manager only takes initiative when it has NO pending business —
// no open proposals of its own waiting on the human. Initiative never piles onto a
// backlog; it fills silence. Every move is idempotent and lands on an existing
// governed rail. NOT server-only (simulator-driven; dispatcher seam injectable).

import { createServiceClient } from "@/lib/supabase/service"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { PromoDispatcher } from "@/lib/kernel/voice-delegation"

type Svc = ReturnType<typeof createServiceClient>

/** Pure: the idle rule — initiative only when the manager's own queue is clear. */
export function isManagerIdle(openProposalsByManager: Record<string, number>, manager: ManagerKey): boolean {
  return (openProposalsByManager[manager] ?? 0) === 0
}

export interface IdleHandsResult {
  socialDrafts: number
  justSoldReels: number
  anniversaryNotes: number
  enrichmentsQueued: number
  reengagePredrafts: number
  skippedBusy: ManagerKey[]
}

/**
 * One pass of initiative for a brokerage. Each manager checks the idle rule, then
 * makes at most a few moves (small batches — initiative, not a flood). All idempotent.
 */
export async function runIdleHands(
  brokerageId: string,
  opts: { now?: Date; promoDispatcher?: PromoDispatcher } = {},
  client?: Svc,
): Promise<IdleHandsResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const result: IdleHandsResult = {
    socialDrafts: 0, justSoldReels: 0, anniversaryNotes: 0,
    enrichmentsQueued: 0, reengagePredrafts: 0, skippedBusy: [],
  }

  // The idle rule's input: open proposals per manager (the human-facing backlog).
  const { data: open } = await supabase.from("agent_client_messages")
    .select("agent_kind").eq("brokerage_id", brokerageId).eq("status", "proposed").limit(500)
  const backlog: Record<string, number> = {}
  for (const p of (open ?? []) as Array<{ agent_kind: string }>) {
    backlog[p.agent_kind] = (backlog[p.agent_kind] ?? 0) + 1
  }

  // ── Marketing Manager: stale listings get a social draft (existing approval gate). ──
  if (isManagerIdle(backlog, "marketing_agent")) {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const { data: stale } = await supabase.from("listings")
      .select("id, address, city, agent_id").eq("brokerage_id", brokerageId)
      .eq("status", "active").lte("created_at", weekAgo).limit(10)
    for (const l of ((stale ?? []) as any[]).slice(0, 3)) {
      const { data: recent } = await supabase.from("social_posts").select("id")
        .eq("listing_id", l.id).gte("created_at", weekAgo).limit(1).maybeSingle()
      if (recent) continue
      const { error } = await supabase.from("social_posts").insert({
        brokerage_id: brokerageId, listing_id: l.id, agent_id: l.agent_id ?? null,
        platform: "all", post_type: "new_listing",
        content: `Still available and worth a look: ${l.address ?? "this home"}${l.city ? ` in ${l.city}` : ""}. Reach out for a private tour.`,
        status: "draft", approval_status: "pending", ai_generated: true,
        post_brief: "IDLE HANDS — Marketing Manager: listing active 7+ days with no social touch this week; keep it in front of buyers.",
      })
      if (!error) result.socialDrafts += 1
    }
  } else result.skippedBusy.push("marketing_agent")

  // ── Asset Manager: recent closings get the just_sold reel (canonical rail, policy ON). ──
  {
    const since = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10)
    const { data: closed } = await supabase.from("transactions")
      .select("id, listing_id, agent_id").eq("brokerage_id", brokerageId)
      .eq("status", "closed").gte("close_date", since).not("listing_id", "is", null).limit(10)
    const dispatcher: PromoDispatcher = opts.promoDispatcher ?? (async (d) => {
      const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
      const r = await dispatchListingPromoVideo({ ...d, eventType: d.eventType })
      return { ok: r.ok, status: r.status, reason: r.reason }
    })
    for (const t of ((closed ?? []) as any[]).slice(0, 3)) {
      const { data: existing } = await supabase.from("listing_promo_videos").select("id")
        .eq("listing_id", t.listing_id).eq("event_type", "just_sold").limit(1).maybeSingle()
      if (existing) continue
      const { data: agentRow } = await supabase.from("agents").select("user_id").eq("id", t.agent_id ?? "").maybeSingle()
      const agentUserId = (agentRow as { user_id: string | null } | null)?.user_id
      if (!agentUserId) continue
      // Automatic initiative NEVER bypasses the lifecycle policy (bypassPolicy=false).
      const r = await dispatcher({
        brokerageId, listingId: t.listing_id, agentUserId,
        eventType: "just_sold", bypassPolicy: false,
      })
      if (r.ok && r.status !== "skipped") result.justSoldReels += 1
    }
  }

  // ── Sphere: closing anniversaries within 7 days → the note, into the gate. ──
  if (isManagerIdle(backlog, "sphere_of_influence")) {
    const { data: anniv } = await supabase.from("transactions")
      .select("id, deal_name, buyer_contact_id, close_date").eq("brokerage_id", brokerageId)
      .eq("status", "closed").not("buyer_contact_id", "is", null).not("close_date", "is", null).limit(500)
    const candidates = ((anniv ?? []) as any[]).filter((t) => {
      const closed = new Date(t.close_date)
      const thisYear = new Date(now.getFullYear(), closed.getMonth(), closed.getDate())
      const days = (thisYear.getTime() - now.getTime()) / 86_400_000
      return now.getFullYear() > closed.getFullYear() && days >= 0 && days <= 7
    })
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    for (const t of candidates.slice(0, 3)) {
      const { data: c } = await supabase.from("contacts")
        .select("first_name, nurture_status").eq("id", t.buyer_contact_id).maybeSingle()
      if (!c || (c as any).nurture_status === "withdrawn") continue
      const { data: already } = await supabase.from("agent_client_messages").select("id")
        .eq("recipient_contact_id", t.buyer_contact_id).ilike("rationale", "IDLE HANDS%anniversary%")
        .gte("proposed_at", new Date(now.getTime() - 30 * 86_400_000).toISOString()).limit(1).maybeSingle()
      if (already) continue
      const res = await proposeClientMessage({
        brokerageId, agentKind: "sphere_of_influence", entityType: "contact",
        entityId: t.buyer_contact_id, recipientContactId: t.buyer_contact_id, audience: "buyer",
        subject: "Happy home anniversary!",
        body: `Hi${(c as any).first_name ? ` ${(c as any).first_name}` : ""} — it's almost a year since ${t.deal_name ?? "your home"} became yours. Hope it's been everything you wanted. If you ever want a fresh look at what it's worth now, just say the word.`,
        rationale: `IDLE HANDS — Sphere Manager: closing anniversary within 7 days; the lifetime relationship gets its moment without anyone asking.`,
        channel: "portal",
      }, supabase)
      if (res.ok) result.anniversaryNotes += 1
    }
  } else result.skippedBusy.push("sphere_of_influence")

  // ── Data Steward: self-healing — missing email/phone → enrichment re-run. ──
  {
    const { data: gaps } = await supabase.from("contacts")
      .select("id").eq("brokerage_id", brokerageId)
      .or("email.is.null,phone.is.null")
      .neq("nurture_status", "withdrawn").limit(20)
    for (const g of ((gaps ?? []) as any[]).slice(0, 5)) {
      const { data: pending } = await supabase.from("contact_enrichment_queue").select("id")
        .eq("contact_id", g.id).in("status", ["pending", "running"]).limit(1).maybeSingle()
      if (pending) continue
      const { error } = await supabase.from("contact_enrichment_queue").insert({
        brokerage_id: brokerageId, contact_id: g.id, source: "idle_hands",
        status: "pending", metadata: { reason: "missing email or phone — self-healing data loop" },
      })
      if (!error) result.enrichmentsQueued += 1
    }
  }

  // ── AI ISA: morning auto-draft — pre-draft the warmest cooling lead's follow-up. ──
  if (isManagerIdle(backlog, "ai_isa")) {
    const { data: contacts } = await supabase.from("contacts")
      .select("id, first_name, last_name, intent_score, engagement_score, last_contacted_at, nurture_status")
      .eq("brokerage_id", brokerageId).not("last_contacted_at", "is", null)
      .order("intent_score", { ascending: false, nullsFirst: false }).limit(50)
    const cutoff = now.getTime() - 14 * 86_400_000
    const cold = ((contacts ?? []) as any[]).find((c) =>
      c.nurture_status !== "withdrawn" && new Date(c.last_contacted_at).getTime() < cutoff)
    if (cold) {
      const { data: already } = await supabase.from("agent_client_messages").select("id")
        .eq("recipient_contact_id", cold.id).eq("status", "proposed")
        .ilike("rationale", "IDLE HANDS%re-engage%").limit(1).maybeSingle()
      if (!already) {
        const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
        const res = await proposeClientMessage({
          brokerageId, agentKind: "ai_isa", entityType: "contact",
          entityId: cold.id, recipientContactId: cold.id, audience: "lead",
          subject: "Thinking of you — anything changed?",
          body: `Hi${cold.first_name ? ` ${cold.first_name}` : ""} — it's been a little while. The market's moved since we last talked; if your plans have too, I'd love to catch you up. No pressure either way.`,
          rationale: `IDLE HANDS — AI ISA: warmest cooling lead (14d+ quiet, propensity-ranked) pre-drafted for re-engage; one tap or 'do number three' sends it.`,
          channel: "portal",
        }, supabase)
        if (res.ok) result.reengagePredrafts += 1
      }
    }
  } else result.skippedBusy.push("ai_isa")

  return result
}
