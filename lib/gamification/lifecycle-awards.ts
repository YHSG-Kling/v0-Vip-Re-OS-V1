// lib/gamification/lifecycle-awards.ts
// ─────────────────────────────────────────────────────────────────────────────
// LAYER 6 — LIFECYCLE GAMIFICATION, the database-touching half (wave 103, lane 103C).
//
// The RULES, the once-award and the point values live in award-points.ts (the ONE
// award path, importable from a Client Component). This file is the SERVER half:
// resolving which agents.id an event is about, the reactor hook the event reactor
// calls on every canonical event, and the ONE badge writer (merged here from
// app/actions/gamification.ts's private awardBadge, which now delegates). It
// lazy-imports @/lib/kernel/emit (server-only) and must never be imported from a
// Client Component.

import { KernelEvent } from "@/lib/kernel/events"
import {
  awardAgentPointsOnce,
  planLifecycleAwards,
  isUuid,
  LIFECYCLE_AWARD_RULES,
  type LedgerCapableClient,
  type PointReason,
} from "./award-points"

// ─── AGENT RESOLUTION — agents.id, never users.id (the two are DISJOINT) ──────

export interface MilestoneEventParams {
  event: string
  brokerageId: string
  entityType: string
  entityId: string
  metadata?: Record<string, unknown> | null
  agentUserId?: string | null
}

/** Which agents.id(s) an event is ABOUT. Each branch names the column it crosses. */
async function resolveMilestoneAgents(
  db: LedgerCapableClient,
  p: MilestoneEventParams,
): Promise<{ acting: string[]; mentorAndMentee: string[] }> {
  const meta = (p.metadata ?? {}) as Record<string, unknown>
  const out = { acting: [] as string[], mentorAndMentee: [] as string[] }

  if (isUuid(meta.mentor_agent_id) && isUuid(meta.mentee_agent_id)) {
    out.mentorAndMentee = [meta.mentor_agent_id, meta.mentee_agent_id]
  }
  // 1. An emitter that names the agents.id outright (showings, anniversaries, CE).
  if (isUuid(meta.agent_id)) { out.acting = [meta.agent_id]; return out }

  const one = async (table: string, col: string, id: string): Promise<string | null> => {
    const { data, error } = await db.from(table).select(col).eq("id", id).eq("brokerage_id", p.brokerageId).maybeSingle()
    if (error) { console.error(`[lifecycle-gamification] ${table}.${col} read refused for ${id}: ${error.message}`); return null }
    const v = (data as Record<string, unknown> | null)?.[col]
    return isUuid(v) ? v : null
  }
  const byUser = async (userId: string): Promise<string | null> => {
    // agents.user_id is the ONE crossing from users.id to agents.id (CLAUDE.md §3).
    const { data, error } = await db.from("agents").select("id").eq("user_id", userId).eq("brokerage_id", p.brokerageId).maybeSingle()
    if (error) { console.error(`[lifecycle-gamification] agents.user_id read refused for ${userId}: ${error.message}`); return null }
    return isUuid(data?.id) ? data.id : null
  }

  // 2. Entity-typed resolution — the column that holds the OWNING agent.
  let acting: string | null = null
  switch (p.entityType) {
    case "agent":               acting = isUuid(p.entityId) ? p.entityId : null; break
    case "user":                acting = await byUser(p.entityId); break
    case "transaction":         acting = await one("transactions", "agent_id", p.entityId); break
    case "showing":             acting = await one("showings", "agent_id", p.entityId); break
    case "agent_certification": acting = await one("agent_certifications", "agent_id", p.entityId); break
    case "agent_onboarding":    acting = await one("agent_onboarding", "agent_id", p.entityId); break
    case "agent_ce_completion": acting = await one("agent_ce_completions", "agent_id", p.entityId); break
    case "referral":            acting = await one("referrals", "agent_id", p.entityId); break
    case "contact":
      // REFERRAL_RECEIVED is emitted on the CONTACT with referral_id in metadata; the
      // earning agent is the referral's agent_id (who received it), not the contact's.
      acting = isUuid(meta.referral_id)
        ? await one("referrals", "agent_id", meta.referral_id)
        : await one("contacts", "agent_id", p.entityId)
      break
    default: break
  }
  // 3. The acting user's seat, when the emitter attributed one.
  if (!acting && p.agentUserId) acting = await byUser(p.agentUserId)
  if (acting) out.acting = [acting]
  return out
}

/** TRANSACTION_CLOSED: has this agent closed with either side's contact before this transaction? */
async function isRepeatClientClose(db: LedgerCapableClient, brokerageId: string, transactionId: string, agentId: string): Promise<boolean> {
  const { data: tx, error } = await db.from("transactions").select("id, buyer_contact_id, seller_contact_id")
    .eq("id", transactionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error || !tx) return false
  const contactIds = [tx.buyer_contact_id, tx.seller_contact_id].filter(isUuid)
  if (contactIds.length === 0) return false
  const { data: prior, error: priorErr } = await db.from("transactions").select("id")
    .eq("brokerage_id", brokerageId).eq("agent_id", agentId).in("status", ["closed", "funded"]).neq("id", transactionId)
    .or(contactIds.map((c) => `buyer_contact_id.eq.${c},seller_contact_id.eq.${c}`).join(","))
    .limit(1)
  if (priorErr) { console.error(`[lifecycle-gamification] prior-close read refused for ${transactionId}: ${priorErr.message}`); return false }
  return (prior ?? []).length > 0
}

export interface LifecycleAwardOutcome {
  awarded: Array<{ agentId: string; reason: PointReason; points: number; newTotal: number }>
  alreadyAwarded: number
  badgesAwarded: number
  refused: string[]
}

/**
 * THE REACTOR HOOK. Called by lib/kernel/event-reactor.ts for every canonical event
 * with the service client. Best-effort by contract — the event's own business write
 * has already landed; a refused award is returned in `refused` and logged, never
 * thrown into the fan-out.
 */
export async function awardLifecycleMilestones(
  db: LedgerCapableClient,
  p: MilestoneEventParams,
  now: Date = new Date(),
): Promise<LifecycleAwardOutcome> {
  const out: LifecycleAwardOutcome = { awarded: [], alreadyAwarded: 0, badgesAwarded: 0, refused: [] }
  if (!LIFECYCLE_AWARD_RULES.some((r) => r.event === p.event)) return out

  const agents = await resolveMilestoneAgents(db, p)
  const actingId = agents.acting[0] ?? null
  const repeatClient = p.event === KernelEvent.TRANSACTION_CLOSED && actingId
    ? await isRepeatClientClose(db, p.brokerageId, p.entityId, actingId)
    : false

  const plans = planLifecycleAwards(p.event, { entityId: p.entityId, metadata: p.metadata, now, repeatClient })
  for (const plan of plans) {
    const recipients = plan.party === "mentor_and_mentee" ? agents.mentorAndMentee : agents.acting
    if (recipients.length === 0) {
      out.refused.push(`${plan.reason}: no agents.id resolvable from ${p.entityType} ${p.entityId}`)
      continue
    }
    for (const agentId of recipients) {
      const res = await awardAgentPointsOnce(db, {
        agentId, points: plan.points, reason: plan.reason, referenceType: plan.referenceType,
        referenceId: plan.once.referenceId ?? null, once: plan.once,
      })
      if (!res.ok) { out.refused.push(`${plan.reason} for ${agentId}: ${res.error}`); continue }
      if ("alreadyAwarded" in res) { out.alreadyAwarded++; continue }
      out.awarded.push({ agentId, reason: plan.reason, points: res.pointsAdded, newTotal: res.newTotal })
      // Milestone badges: the catalog rows whose trigger_event names THIS reason (m705
      // seeds them; a tenant may add its own). Threshold badges stay with
      // checkAndAwardBadges — the two awarders never overlap on a trigger_event.
      const badges = await awardEventBadges(db, { agentId, brokerageId: res.brokerageId, triggerEvent: plan.reason })
      out.badgesAwarded += badges.awarded
      out.refused.push(...badges.refused)
    }
  }
  for (const r of out.refused) console.error(`[lifecycle-gamification] ${p.event}: ${r}`)
  return out
}

// ─── BADGES — the ONE badge awarder (merged here from app/actions/gamification.ts) ─

export interface AwardBadgeInput { agentId: string; badgeId: string; reason: string }
export type AwardBadgeResult =
  | { ok: true; alreadyAwarded: true }
  | { ok: true; alreadyAwarded: false; badgeRowId: string; badgeName: string; badgeTier: string | null }
  | { ok: false; error: string }

/**
 * Award one badge, idempotently. The tenant is derived from the AGENT's row (never
 * from the caller), the award is a lifecycle_events row (GAMIFICATION_BADGE_AWARDED)
 * and the agent is told. agent_badges_unique(agent_id, badge_id) is the hard stop
 * beneath the pre-read: a 23505 from a racing twin reads as alreadyAwarded.
 */
export async function awardBadgeToAgent(db: LedgerCapableClient, input: AwardBadgeInput): Promise<AwardBadgeResult> {
  const { data: existing, error: existErr } = await db.from("agent_badges").select("id")
    .eq("agent_id", input.agentId).eq("badge_id", input.badgeId).maybeSingle()
  if (existErr) return { ok: false, error: `agent_badges read refused: ${existErr.message}` }
  if (existing) return { ok: true, alreadyAwarded: true }

  const { data: agentData, error: agentErr } = await db.from("agents").select("brokerage_id, user_id").eq("id", input.agentId).single()
  if (agentErr) return { ok: false, error: `agents read refused: ${agentErr.message}` }
  if (!agentData?.brokerage_id) return { ok: false, error: `no brokerage resolvable from agent ${input.agentId}` }

  const { data: newBadge, error } = await db.from("agent_badges").insert({
    brokerage_id: agentData.brokerage_id,
    agent_id: input.agentId,
    badge_id: input.badgeId,
    awarded_reason: input.reason,
    awarded_at: new Date().toISOString(),
  }).select("id, gamification_badges:badge_id(badge_name, badge_tier)").single()
  if (error) {
    if (/23505|duplicate key/i.test(error.message)) return { ok: true, alreadyAwarded: true }
    return { ok: false, error: `agent_badges insert refused: ${error.message}` }
  }
  const def = (newBadge as any).gamification_badges
  const badgeName: string = (Array.isArray(def) ? def[0]?.badge_name : def?.badge_name) ?? "a badge"
  const badgeTier: string | null = (Array.isArray(def) ? def[0]?.badge_tier : def?.badge_tier) ?? null

  // Evidence: the audit row + reactor (the Recruiting → Campaign social-proof handoff
  // keys on this event). Lazy import — the reactor imports THIS module.
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    await emitKernelEvent({
      brokerageId: agentData.brokerage_id,
      event: KernelEvent.GAMIFICATION_BADGE_AWARDED,
      entityType: "agent_badge",
      entityId: newBadge.id,
      agentId: input.agentId,
      metadata: { agent_id: input.agentId, badge_id: input.badgeId, badge_name: badgeName, badge_tier: badgeTier, reason: input.reason },
    })
  } catch (e) {
    console.error(`[awardBadgeToAgent] badge ${newBadge.id} awarded but GAMIFICATION_BADGE_AWARDED did not emit:`, e)
  }
  if (agentData.user_id) {
    const { error: notifyErr } = await db.from("notifications").insert({
      user_id: agentData.user_id, brokerage_id: agentData.brokerage_id,
      type: "gamification_badge_awarded", title: `Badge earned: ${badgeName}`, body: input.reason,
      entity_type: "agent_badge", entity_id: newBadge.id, priority: "low", is_read: false,
    })
    if (notifyErr) console.error(`[awardBadgeToAgent] badge ${newBadge.id} awarded but the agent was not notified: ${notifyErr.message}`)
  }
  return { ok: true, alreadyAwarded: false, badgeRowId: newBadge.id, badgeName, badgeTier }
}

/**
 * Award every active catalog badge whose trigger_event is this milestone reason.
 * Visible rows are the platform defaults (brokerage_id NULL) plus the agent's own
 * tenant's — a service client sees every tenant, so the filter is explicit here.
 */
async function awardEventBadges(
  db: LedgerCapableClient,
  input: { agentId: string; brokerageId: string; triggerEvent: string },
): Promise<{ awarded: number; refused: string[] }> {
  const out = { awarded: 0, refused: [] as string[] }
  const { data: badges, error } = await db.from("gamification_badges").select("id, badge_name")
    .eq("is_active", true).eq("trigger_event", input.triggerEvent)
    .or(`brokerage_id.is.null,brokerage_id.eq.${input.brokerageId}`)
  if (error) { out.refused.push(`gamification_badges read refused: ${error.message}`); return out }
  for (const b of (badges ?? []) as Array<{ id: string; badge_name: string }>) {
    const res = await awardBadgeToAgent(db, { agentId: input.agentId, badgeId: b.id, reason: `Milestone: ${input.triggerEvent}` })
    if (!res.ok) out.refused.push(`badge ${b.badge_name}: ${res.error}`)
    else if (!res.alreadyAwarded) out.awarded++
  }
  return out
}
