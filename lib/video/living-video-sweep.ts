// lib/video/living-video-sweep.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE REFRESH — a video notices its own facts moved and remakes itself.
//
// The sweep is cheap on purpose. For each delivered living video it re-derives
// only the DECLARED facts (a couple of indexed reads — no Chromium, no bundle,
// no provider call), hashes them, and compares. Nothing renders unless a
// MATERIAL fact actually moved, so the steady state of this cron is a handful of
// selects that find nothing and cost nothing.
//
// WHY THIS IS THE INTERESTING HALF OF THE RENDER CACHE. m310 made a render
// reusable by giving it an identity. The same technique, pointed at a narrower
// input set, gives a delivered video an identity too — and an identity you can
// recompute is an identity you can check. A stale video is now a comparison, not
// an intuition, and the OS can say WHICH number went wrong rather than only that
// something did.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
// It does not send anything. It re-renders and raises; the existing gated
// delivery path (deliverSellerUpdateReels → proposeClientMessage, human
// approval) is what reaches the seller. A system that both decided a video was
// stale AND mailed the replacement would be one bad fact provider away from
// spamming a client, and the whole design of this OS is that a manager proposes
// and a human disposes.
//
// Never throws. A refresh failure must not take down the cron that also drains
// the render queue.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import {
  LIVING_KINDS,
  computeFactsKey,
  diffLivingFacts,
  isStale,
  describeFactChanges,
  summarizeRefresh,
  LIVING_VIDEO_STALE_SIGNAL,
  type LivingFacts,
  type FactChange,
  type LivingRefreshSummary,
} from "./living-video"

export { LIVING_VIDEO_STALE_SIGNAL }

/**
 * Re-derive a kind's facts for one entity, and requeue its video.
 *
 * Registered per living kind rather than inferred, because both halves are
 * producer-specific: only the producer knows which reads reconstruct its facts,
 * and only the producer knows how to stage a correct replacement (identity, QR,
 * b-roll, narration). The sweep owns the DECISION; the producer owns the WORK.
 */
interface LivingProvider {
  /** Read-only. Returns null when the subject no longer exists (a delisted
   *  listing) — which is a reason to stop checking, not to re-render. */
  factsFor(
    svc: ReturnType<typeof createServiceClient>,
    brokerageId: string,
    subjectId: string,
  ): Promise<LivingFacts | null>
  /** Stage the replacement. Returns the new render id, or a reason it could not. */
  requeue(
    svc: ReturnType<typeof createServiceClient>,
    brokerageId: string,
    subjectId: string,
    staleRenderId: string,
  ): Promise<{ ok: boolean; renderId?: string; reason?: string }>
  /** Pull the subject id out of the stale render row (the listing, not the
   *  contact the video was addressed to). */
  subjectIdOf(row: LivingRenderRow): string | null
  /** The manager accountable for this kind of video. */
  manager: ManagerKey
}

export interface LivingRenderRow {
  id: string
  brokerage_id: string
  living_kind: string | null
  facts_key: string | null
  facts: LivingFacts | null
  entity_id: string | null
  input_props: Record<string, unknown> | null
  completed_at: string | null
}

const PROVIDERS: Record<string, LivingProvider> = {
  seller_weekly_update: {
    manager: "asset_manager",
    subjectIdOf: (row) => ((row.input_props as { listing_id?: string } | null)?.listing_id ?? null),
    async factsFor(svc, brokerageId, listingId) {
      const { sellerUpdateFacts } = await import("@/lib/agents/seller-update-reel-producer")
      return sellerUpdateFacts(svc, brokerageId, listingId)
    },
    async requeue(svc, brokerageId, listingId, staleRenderId) {
      const { requestSellerUpdateReel } = await import("@/lib/agents/seller-update-reel-producer")
      // force: the seven-day window is a spam guard against the CADENCE cron,
      // not a rule that a seller must live with a wrong price until Monday.
      const r = await requestSellerUpdateReel(brokerageId, listingId, svc, {
        force: true, refreshedFromRenderId: staleRenderId,
      })
      return { ok: r.queued, renderId: r.renderId, reason: r.reason }
    },
  },

  buyer_match_reel: {
    // The Shopping Agent owns the buyer relationship, but the RENDER ledger is
    // the Asset Manager's, and what went stale is a render. Kept with the
    // Asset Manager so one manager is accountable for every living video and a
    // broker has one place to look.
    manager: "asset_manager",
    // The subject IS the contact here — a buyer reel is about a person's
    // search, not about one property.
    subjectIdOf: (row) => row.entity_id,
    async factsFor(svc, brokerageId, contactId) {
      const { buyerMatchFacts } = await import("@/lib/agents/buyer-match-reel-producer")
      return buyerMatchFacts(svc, brokerageId, contactId)
    },
    async requeue(svc, brokerageId, contactId, staleRenderId) {
      const { produceBuyerMatchReel } = await import("@/lib/agents/buyer-match-reel-producer")
      const r = await produceBuyerMatchReel(brokerageId, contactId, svc, {
        force: true, refreshedFromRenderId: staleRenderId,
      })
      return { ok: r.queued, renderId: r.renderId, reason: r.reason }
    },
  },
}

export interface RefreshResult extends LivingRefreshSummary {
  ok: boolean
  /** One entry per stale video, so a caller can log what actually moved. */
  changes: Array<{
    renderId: string
    kind: string
    subjectId: string | null
    summary: string
    requeued: boolean
    newRenderId?: string
  }>
  reason?: string
}

/**
 * Sweep delivered living videos and refresh the ones whose facts have moved.
 *
 * Only the NEWEST delivered video per (kind, entity) is checked: older cuts have
 * already been superseded and re-rendering history would be pointless work and a
 * confusing thing for a seller to receive.
 */
export async function refreshLivingVideos(
  opts: { brokerageId?: string; limit?: number } = {},
): Promise<RefreshResult> {
  const empty: RefreshResult = {
    ok: true, examined: 0, stale: 0, refreshed: 0, failed: 0, immaterialOnly: 0, changes: [],
  }
  try {
    const svc = createServiceClient()
    let q = svc.from("remotion_composition_renders")
      .select("id, brokerage_id, living_kind, facts_key, facts, entity_id, input_props, completed_at")
      .not("living_kind", "is", null)
      .eq("render_status", "succeeded")
      .not("output_url", "is", null)
      .order("completed_at", { ascending: false })
      .limit(opts.limit ?? 200)
    if (opts.brokerageId) q = q.eq("brokerage_id", opts.brokerageId)
    const { data, error } = await q
    if (error) return { ...empty, ok: false, reason: error.message }

    const rows = (data ?? []) as LivingRenderRow[]

    // Newest per (brokerage, kind, entity). The query is already newest-first,
    // so the first sighting of a key wins.
    const newest = new Map<string, LivingRenderRow>()
    for (const r of rows) {
      const k = `${r.brokerage_id}:${r.living_kind}:${r.entity_id ?? ""}`
      if (!newest.has(k)) newest.set(k, r)
    }

    const outcomes: Array<{ changes: FactChange[]; requeued: boolean | null }> = []
    const result: RefreshResult = { ...empty, changes: [] }

    for (const row of newest.values()) {
      const kind = row.living_kind!
      const spec = LIVING_KINDS[kind]
      const provider = PROVIDERS[kind]
      // A kind on a render row with no registered spec/provider is a render
      // stamped by code that no longer exists. Skip it rather than guess.
      if (!spec || !provider) continue

      const subjectId = provider.subjectIdOf(row)
      if (!subjectId) continue

      const fresh = await provider.factsFor(svc, row.brokerage_id, subjectId)
      // The subject is gone (delisted, deleted). Not stale — finished.
      if (!fresh) continue

      const freshKey = computeFactsKey(kind, fresh)
      // Fast path: identical key means nothing declared moved, and we skip the
      // diff entirely. This is the steady state and it costs one hash.
      if (freshKey === row.facts_key) {
        outcomes.push({ changes: [], requeued: null })
        continue
      }

      const changes = diffLivingFacts(kind, row.facts ?? {}, fresh)
      if (!isStale(changes)) {
        // Something moved, but nothing a client would care about — days on
        // market ticking, a couple of extra scans. Recorded, never acted on.
        outcomes.push({ changes, requeued: null })
        continue
      }

      const requeue = await provider.requeue(svc, row.brokerage_id, subjectId, row.id)
      outcomes.push({ changes, requeued: requeue.ok })

      const summary = describeFactChanges(kind, changes)
      result.changes.push({
        renderId: row.id, kind, subjectId, summary,
        requeued: requeue.ok, newRenderId: requeue.renderId,
      })

      // THE LOOP: the manager that owns the render hears WHAT went out of date.
      // The Cron Manager carries it because a signal never routes a manager to
      // itself, and the Asset Manager owns remotion_composition_renders.
      await publishManagerSignal({
        brokerageId: row.brokerage_id,
        fromManager: provider.manager === "cron_manager" ? "data_steward" : "cron_manager",
        toManager: provider.manager,
        signalType: LIVING_VIDEO_STALE_SIGNAL,
        message: requeue.ok
          ? `${summary} A refreshed cut is rendering now.`
          : `${summary} The refresh could NOT be staged (${requeue.reason ?? "unknown"}), so the client still has the old video.`,
        entityType: spec.entityType,
        // entity_id is a uuid column; the render's own entity is one, the
        // composition/kind names are not and travel in the payload.
        entityId: row.entity_id,
        payload: {
          living_kind: kind,
          stale_render_id: row.id,
          new_render_id: requeue.renderId ?? null,
          subject_id: subjectId,
          changes: changes.map((c) => ({ field: c.field, from: c.from, to: c.to, material: c.material })),
          requeued: requeue.ok,
        },
        dedupe: false,
      }, svc)
    }

    return { ...result, ...summarizeRefresh(outcomes), ok: true }
  } catch (e) {
    return { ...empty, ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Read side: the living videos a brokerage has, and whether each is current. */
export async function loadLivingVideos(
  brokerageId: string,
  limit = 50,
): Promise<Array<{
  renderId: string; kind: string; label: string; entityId: string | null
  completedAt: string | null; facts: LivingFacts | null; isRefresh: boolean
}>> {
  try {
    const svc = createServiceClient()
    const { data } = await svc.from("remotion_composition_renders")
      .select("id, living_kind, entity_id, facts, completed_at, refreshed_from_render_id")
      .eq("brokerage_id", brokerageId)
      .not("living_kind", "is", null)
      .eq("render_status", "succeeded")
      .order("completed_at", { ascending: false })
      .limit(limit)
    return ((data ?? []) as any[]).map((r) => ({
      renderId: r.id,
      kind: r.living_kind,
      label: LIVING_KINDS[r.living_kind]?.label ?? r.living_kind,
      entityId: r.entity_id,
      completedAt: r.completed_at,
      facts: r.facts,
      isRefresh: !!r.refreshed_from_render_id,
    }))
  } catch {
    return []
  }
}
