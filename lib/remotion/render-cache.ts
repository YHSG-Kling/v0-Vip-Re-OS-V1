// lib/remotion/render-cache.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE WRITE + READ SIDE OF THE RENDER CACHE.
//
// The pure identity lives in composition-cache.ts; this is the part that talks
// to the ledger. Four entry points and the order matters:
//
//   predictFinishInputs   walks the SAME stock-asset cascade the coordinator
//                         will walk (one shared picker — stock-pick.ts), so the
//                         key we look up is the key the render would produce.
//   lookupCachedArtifact  a succeeded render of this tenant with this artifact
//                         key and a live output_url.
//   serveFromCache        completes the queued row against the existing file,
//                         marks cache_hit, and points served_from_render_id at
//                         the pass that actually paid for it.
//   sweepDeterminismLeaks the loop: a composition whose props carry a per-call
//                         nonce can never reuse anything, and the Asset Manager
//                         is the manager that owns the render pipeline, so it
//                         hears about it by name.
//
// TENANCY. Every read here is .eq("brokerage_id", …). A rendered video carries
// a brand kit, an agent's face, and a client's address; the props would almost
// certainly differ across tenants and "almost certainly" is not a boundary.
//
// Never throws. A cache failure must degrade to "render it" — the expensive
// correct answer — never to a failed render.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import { pickStockAsset, type StockPickScope } from "./stock-pick"
import type { RemotionCompositionRow } from "./registry"
import {
  computeFrameKey,
  computeArtifactKey,
  findCachePoisoningProps,
  summarizeCacheEconomics,
  leakBrief,
  NO_FINISH,
  RENDER_CACHE_LEAK_SIGNAL,
  type FinishInputs,
  type CacheEconomics,
  type CachePoisoningFinding,
} from "./composition-cache"
import { resolveCodeRevision } from "./code-revision"
import { shouldApplyBookends } from "./render-decision"
import { compositionSeconds } from "./composition-geometry"

export { RENDER_CACHE_LEAK_SIGNAL }

/**
 * Predict the finish inputs this render will mux.
 *
 * Best-effort by design: when the cascade read fails we return the null finish,
 * which produces a key that will not match the eventual stamp — a MISS, so the
 * render runs. Wrong-but-cheap is not on the table; the failure mode is
 * wasted-but-correct.
 */
export async function predictFinishInputs(
  svc: ReturnType<typeof createServiceClient>,
  scope: StockPickScope,
  composition: RemotionCompositionRow,
  opts: { musicMood?: string | null; narrationAudioUrl?: string | null; applyBookends?: boolean; applyMusic?: boolean } = {},
): Promise<FinishInputs> {
  const finish: FinishInputs = { ...NO_FINISH, narrationAudioUrl: opts.narrationAudioUrl ?? null }
  try {
    const wantsBookends = opts.applyBookends ?? shouldApplyBookends(composition)
    if (wantsBookends && (composition.stock_intro_category || composition.stock_outro_category)) {
      const [intro, outro] = await Promise.all([
        composition.stock_intro_category
          ? pickStockAsset(svc, scope, composition.stock_intro_category)
          : Promise.resolve(null),
        composition.stock_outro_category
          ? pickStockAsset(svc, scope, composition.stock_outro_category)
          : Promise.resolve(null),
      ])
      finish.introClipUrl = intro?.video_url ?? null
      finish.outroClipUrl = outro?.video_url ?? null
    }
    const wantsMusic = (opts.applyMusic ?? true) && opts.musicMood !== "none"
    if (wantsMusic) {
      const music = await pickStockAsset(svc, scope, "music", opts.musicMood ?? null)
      if (music?.video_url) {
        finish.musicTrackUrl = music.video_url
        finish.musicVolumePct = music.music_volume_pct ?? 20
        finish.musicLoop = music.music_loop ?? true
      }
    }
  } catch {
    // Predicting is an optimization; the stamp is the truth.
  }
  return finish
}

export interface CacheProbe {
  /**
   * FALSE when the deployed composition revision cannot be established. The
   * caller must then neither serve from nor write to the cache: without knowing
   * which version of the code is running we cannot tell a reusable artifact from
   * a stale one, and serving a stale cut of a client's listing video is not a
   * recoverable mistake. Rendering anyway costs a minute.
   */
  cacheable: boolean
  frameKey: string
  artifactKey: string
  /** The existing render to serve, when there is one. */
  hit: { renderId: string; outputUrl: string; thumbnailUrl: string | null } | null
  /** Props that make this composition permanently uncacheable, if any. */
  leaks: CachePoisoningFinding[]
}

/**
 * Compute this render's identity and look for an existing artifact.
 *
 * A still composition has no finish pass, so its artifact key is its frame key
 * plus the empty finish — the same function, no special case downstream.
 */
export async function probeRenderCache(
  svc: ReturnType<typeof createServiceClient>,
  input: {
    brokerageId: string
    composition: RemotionCompositionRow
    props: Record<string, unknown> | null | undefined
    finish: FinishInputs
  },
): Promise<CacheProbe> {
  const codeRevision = resolveCodeRevision()
  if (!codeRevision) {
    return { cacheable: false, frameKey: "", artifactKey: "", hit: null, leaks: [] }
  }
  const frameKey = computeFrameKey({
    compositionId: input.composition.composition_id,
    codeRevision,
    geometry: {
      width: input.composition.width,
      height: input.composition.height,
      fps: input.composition.fps,
      durationFrames: input.composition.duration_frames,
    },
    props: input.props,
  })
  const artifactKey = computeArtifactKey(frameKey, input.finish)
  const leaks = findCachePoisoningProps(input.props)
  const hit = await lookupCachedArtifact(svc, input.brokerageId, artifactKey)
  return { cacheable: true, frameKey, artifactKey, hit, leaks }
}

/** The lookup. Tenant-scoped, succeeded-only, newest first. */
export async function lookupCachedArtifact(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  artifactKey: string,
): Promise<{ renderId: string; outputUrl: string; thumbnailUrl: string | null } | null> {
  try {
    const { data } = await svc.from("remotion_composition_renders")
      .select("id, output_url, thumbnail_url, served_from_render_id")
      .eq("brokerage_id", brokerageId)
      .eq("artifact_key", artifactKey)
      .eq("render_status", "succeeded")
      .not("output_url", "is", null)
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!data) return null
    const row = data as { id: string; output_url: string; thumbnail_url: string | null; served_from_render_id: string | null }
    return {
      // Point at the ORIGIN of the file, not at another cache hit — otherwise a
      // long fan-out builds a chain of rows each citing the previous one and the
      // provenance of the artifact gets one hop further away on every reuse.
      renderId: row.served_from_render_id ?? row.id,
      outputUrl: row.output_url,
      thumbnailUrl: row.thumbnail_url,
    }
  } catch {
    return null
  }
}

/**
 * Complete a queued render against an artifact that already exists.
 *
 * Deliberately does NOT re-capture into marketing_assets: the origin render
 * already put this exact asset_url in the library, and captureRenderAsMarketing
 * Asset dedupes on (source_table, source_id) — which is the RENDER id, not the
 * url — so calling it here would add a second library card for one file.
 */
export async function serveFromCache(
  svc: ReturnType<typeof createServiceClient>,
  renderId: string,
  probe: CacheProbe,
): Promise<{ ok: boolean; outputUrl?: string; reason?: string }> {
  if (!probe.hit) return { ok: false, reason: "no cached artifact" }
  try {
    const { error } = await svc.from("remotion_composition_renders")
      .update({
        render_status: "succeeded",
        output_url: probe.hit.outputUrl,
        thumbnail_url: probe.hit.thumbnailUrl,
        frame_key: probe.frameKey,
        artifact_key: probe.artifactKey,
        cache_hit: true,
        served_from_render_id: probe.hit.renderId,
        completed_at: new Date().toISOString(),
      })
      .eq("id", renderId)
    // A rejected write here would leave the row 'rendering' forever while we
    // reported a hit — the exact class of silent failure this OS keeps finding.
    if (error) return { ok: false, reason: error.message }
    return { ok: true, outputUrl: probe.hit.outputUrl }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Stamp identity onto a render that is about to run (so a concurrent sibling
 *  can see what is in flight) without claiming it succeeded. */
export async function stampRenderKeys(
  svc: ReturnType<typeof createServiceClient>,
  renderId: string,
  keys: { frameKey: string; artifactKey: string },
): Promise<void> {
  try {
    await svc.from("remotion_composition_renders")
      .update({ frame_key: keys.frameKey, artifact_key: keys.artifactKey })
      .eq("id", renderId)
  } catch { /* identity is an optimization; the render is the deliverable */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// What it saved, and what is stopping it saving more
// ─────────────────────────────────────────────────────────────────────────────

export interface CacheBoard extends CacheEconomics {
  /** Compositions that can never reuse a render, with the offending prop paths. */
  leaks: Array<{ compositionId: string; findings: CachePoisoningFinding[]; renders: number }>
  /** Most-reused narration clips, so the saving is visible and not asserted. */
  /**
   * ORPHAN DOCTRINE §1.2 — BUILD THE MISSING HALF (no duplicate existed).
   *
   * `narration_cache.last_used_at` (written on every cache HIT,
   * lib/video/reel-voiceover.ts:158, and on store, :182) and
   * `.first_render_key` (:182 — the render that first paid ElevenLabs for this
   * audio) were read by NOBODY. This board is the one surface that exists to
   * say what the narration cache is worth, and it could only ever say which
   * rows are hot. It could not say which are COLD — rows holding hosted audio
   * that nothing has asked for in months, which is the pruning question — nor
   * which render originally paid for a clip, which is the provenance question
   * asked whenever a cached narration turns out to be wrong.
   */
  topNarration: Array<{ preview: string; hits: number; chars: number; lastUsedAt: string | null; firstRenderKey: string | null }>
  /** Cache rows not used in 90 days — hosted audio nobody is reusing. */
  coldNarrationRows: number
}

/**
 * The Asset Manager's cache board for one brokerage. Reads only; never throws.
 */
export async function loadCacheBoard(
  brokerageId: string,
  opts: { sinceDays?: number } = {},
): Promise<CacheBoard> {
  const empty: CacheBoard = {
    renders: 0, hits: 0, hitRatePct: 0, secondsAvoided: 0, usdAvoided: 0,
    narrationReuses: 0, leaks: [], topNarration: [], coldNarrationRows: 0,
  }
  try {
    const svc = createServiceClient()
    const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 24 * 60 * 60 * 1000).toISOString()

    const [rendersR, compsR, narrR] = await Promise.all([
      svc.from("remotion_composition_renders")
        .select("id, composition_id, cache_hit, input_props, render_status")
        .eq("brokerage_id", brokerageId)
        .eq("render_status", "succeeded")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(500),
      svc.from("remotion_compositions").select("composition_id, duration_frames, fps, requires_did_avatar, requires_voiceover"),
      svc.from("narration_cache")
        .select("script_preview, script_chars, hit_count, last_used_at, first_render_key")
        .eq("brokerage_id", brokerageId)
        .order("hit_count", { ascending: false })
        .limit(200),
    ])

    const comps = new Map<string, { duration_frames: number; fps: number; requires_did_avatar: boolean; requires_voiceover: boolean }>()
    for (const c of (compsR.data ?? []) as any[]) comps.set(c.composition_id, c)

    const { estimateCompositionCost } = await import("./registry")
    const rows = (rendersR.data ?? []) as Array<{
      id: string; composition_id: string; cache_hit: boolean; input_props: Record<string, unknown> | null
    }>

    const econRows = rows.map((r) => {
      const c = comps.get(r.composition_id)
      const outputSeconds = c ? compositionSeconds(c) : 0
      // composition_id IS THE POINT, not padding. estimateCompositionCost
      // (lib/remotion/registry.ts) answers "is this composition narrated?" from
      // the ONE set — consumesVoiceover, lib/remotion/content-contract.ts — and
      // falls back to the row's `requires_voiceover` MIRROR only when the caller
      // hands a partial row with no id. This was that caller: it built the row
      // from four fields and dropped the id it had already used as the map key,
      // so the cache board alone priced narration off the m168-seeded mirror
      // while app/actions/composition-library.ts:99 (a whole row) priced it off
      // the set. One fact, two answers (§6) — and a wrong one here is a wrong
      // "$ avoided" on the Asset Manager's board. The id is `r.composition_id`
      // by construction: it is the key that found `c`.
      const estimatedUsd = c
        ? estimateCompositionCost({
            composition_id: r.composition_id,
            duration_frames: c.duration_frames, fps: c.fps,
            requires_did_avatar: c.requires_did_avatar, requires_voiceover: c.requires_voiceover,
          } as RemotionCompositionRow).totalUsd
        : 0
      return { cacheHit: !!r.cache_hit, estimatedUsd, outputSeconds }
    })

    // Leaks, grouped per composition — one entry per composition, not per render,
    // because the fix is in the producer and applies to all of them.
    const leakMap = new Map<string, { findings: CachePoisoningFinding[]; renders: number }>()
    for (const r of rows) {
      const findings = findCachePoisoningProps(r.input_props)
      if (findings.length === 0) continue
      const prev = leakMap.get(r.composition_id)
      if (prev) { prev.renders++; continue }
      leakMap.set(r.composition_id, { findings, renders: 1 })
    }

    const narration = (narrR.data ?? []) as Array<{
      script_preview: string | null; script_chars: number; hit_count: number
      last_used_at: string | null; first_render_key: string | null
    }>
    const econ = summarizeCacheEconomics(econRows, narration.reduce((s, n) => s + (n.hit_count ?? 0), 0))
    // COLD = never used, or last used more than 90 days ago. A null stamp on a
    // row that predates the column is counted cold rather than assumed fresh:
    // "nobody checked" must not render as "checked and fine" (§4).
    const coldCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const coldNarrationRows = narration.filter((n) => !n.last_used_at || n.last_used_at < coldCutoff).length

    return {
      ...econ,
      leaks: [...leakMap.entries()]
        .map(([compositionId, v]) => ({ compositionId, ...v }))
        .sort((a, b) => b.renders - a.renders),
      coldNarrationRows,
      topNarration: narration
        .filter((n) => (n.hit_count ?? 0) > 0)
        .slice(0, 5)
        .map((n) => ({
          preview: (n.script_preview ?? "").slice(0, 90),
          hits: n.hit_count,
          chars: n.script_chars,
          lastUsedAt: n.last_used_at ?? null,
          firstRenderKey: n.first_render_key ?? null,
        })),
    }
  } catch {
    return empty
  }
}

/**
 * THE LOOP — a composition that can never reuse a render reaches the manager
 * that owns the render pipeline.
 *
 * The Asset Manager owns remotion_composition_renders (manager-registry
 * TABLE_MANAGER), so it is the accountable party; the Cron Manager carries the
 * observation onto the bus because a signal never routes a manager to itself.
 * Deduped on the composition in the payload, and the signal stays OPEN if no
 * handler consumes it, so a human sees it on the Command Center feed rather
 * than it evaporating.
 */
export async function sweepDeterminismLeaks(
  opts: { brokerageId?: string; limit?: number } = {},
): Promise<{ ok: boolean; examined: number; raised: number; failed: number; reason?: string }> {
  const out = { ok: true, examined: 0, raised: 0, failed: 0 } as {
    ok: boolean; examined: number; raised: number; failed: number; reason?: string
  }
  try {
    const svc = createServiceClient()
    let q = svc.from("remotion_composition_renders")
      .select("id, brokerage_id, composition_id, input_props")
      .eq("render_status", "succeeded")
      .not("frame_key", "is", null)
      .order("created_at", { ascending: false })
      .limit(opts.limit ?? 200)
    if (opts.brokerageId) q = q.eq("brokerage_id", opts.brokerageId)
    const { data, error } = await q
    if (error) return { ...out, ok: false, reason: error.message }

    const rows = (data ?? []) as Array<{
      id: string; brokerage_id: string; composition_id: string; input_props: Record<string, unknown> | null
    }>
    out.examined = rows.length

    // One raise per (brokerage, composition) per sweep.
    const seen = new Set<string>()
    for (const r of rows) {
      const key = `${r.brokerage_id}:${r.composition_id}`
      if (seen.has(key)) continue
      const findings = findCachePoisoningProps(r.input_props)
      if (findings.length === 0) continue
      seen.add(key)

      // Recency dedupe on the bus: a standing leak must not re-raise every tick.
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const { data: prior } = await svc.from("manager_signals")
        .select("id")
        .eq("brokerage_id", r.brokerage_id)
        .eq("signal_type", RENDER_CACHE_LEAK_SIGNAL)
        .eq("payload->>composition_id", r.composition_id)
        .gte("created_at", cutoff)
        .limit(1)
        .maybeSingle()
      if (prior) continue

      const published = await publishManagerSignal({
        brokerageId: r.brokerage_id,
        fromManager: "cron_manager",
        toManager: "asset_manager",
        signalType: RENDER_CACHE_LEAK_SIGNAL,
        message: leakBrief(r.composition_id, findings),
        entityType: "remotion_composition",
        // entity_id is a uuid column — a composition id is a text name, so it
        // travels in the payload. (The lesson from the capability-dark loop.)
        entityId: null,
        payload: {
          composition_id: r.composition_id,
          example_render_id: r.id,
          findings: findings.slice(0, 10),
        },
        dedupe: false,
      }, svc)
      if (published.ok) out.raised++
      else out.failed++
    }
    return out
  } catch (e) {
    return { ...out, ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
