// lib/remotion/composition-cache.ts
// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC COMPOSITION IDENTITY — the pure core of the render cache.
//
// Every Remotion composition in this repo is already a PURE function of its
// props: audited, zero Math.random, zero Date.now, zero new Date() across
// remotion/**. So the same props against the same code MUST produce the same
// frames — which means a render is cacheable, and the only hard part is naming
// the inputs honestly.
//
// TWO KEYS, because a finished video is produced in two stages:
//
//   FRAME KEY     the Chromium render. composition id + code revision +
//                 geometry + canonical props. This is the expensive part
//                 (bundle + headless browser + encode).
//   ARTIFACT KEY  frame key + the FINISH inputs the coordinator resolves at
//                 mux time: which intro/outro clip, which music track at what
//                 volume, which narration mp3. Two renders with identical
//                 props but a newly uploaded brand intro are DIFFERENT videos,
//                 and a cache that ignored that would serve the old branding.
//
// THE INVARIANT THAT MAKES IT SAFE — **look up on the prediction, stamp on the
// reality.** The pre-render lookup uses the finish inputs we PREDICT (resolved
// from the same stock-asset cascade the coordinator walks). The key we PERSIST
// is computed from the ids the coordinator ACTUALLY used. A misprediction
// (someone uploaded a new intro mid-render) therefore costs one wasted render,
// never a wrong artifact. There is no code path that serves a stale cut.
//
// CODE REVISION — the trap this module exists to avoid. Props alone are not
// identity: edit MarketUpdateReel.tsx and the same props render different
// frames. A hand-maintained version column would be exactly the decorative
// field this codebase keeps finding (declared, never bumped, silently lying),
// so the revision is DERIVED from the deploy: a composition edit ships in a
// commit, and the commit sha is in the environment. That is conservative — a
// deploy invalidates every key — and conservative is the correct direction:
// within a deploy the 40-recipient fan-out still collapses to one render, and
// across a deploy we re-render rather than risk serving last week's frames.
//
// PURE. No I/O, no server-only, no Supabase — the simulator imports it
// directly, and node:crypto is available in every runtime this ships to.

import { createHash } from "node:crypto"

/** How wide a cache is allowed to reach. Never across tenants — see below. */
export const CACHE_SCOPE = "brokerage" as const

/**
 * Props that describe the FINISH pass, not the frames.
 *
 * These are stripped from the frame key and folded into the artifact key
 * instead, so a change of music mood does not force a fresh Chromium render
 * of identical frames — and so a narration swap is still recorded as a
 * different artifact.
 */
export const FINISH_PROP_KEYS = ["voiceover_url", "music_mood"] as const

export interface CompositionGeometry {
  width: number
  height: number
  fps: number
  durationFrames: number
}

export interface FinishInputs {
  introAssetId: string | null
  outroAssetId: string | null
  musicAssetId: string | null
  musicVolumePct: number | null
  musicLoop: boolean | null
  voiceoverUrl: string | null
}

/** The finish identity of a render that had no finish pass (a still card). */
export const NO_FINISH: FinishInputs = {
  introAssetId: null, outroAssetId: null, musicAssetId: null,
  musicVolumePct: null, musicLoop: null, voiceoverUrl: null,
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable JSON: object keys sorted recursively, array order PRESERVED.
 *
 * Key order is an artifact of how a producer happened to build the object and
 * must not change the hash; array order is content (slide 1 then slide 2 is a
 * different video from slide 2 then slide 1) and must.
 *
 * undefined is dropped the way JSON.stringify drops it, so `{a:1,b:undefined}`
 * and `{a:1}` are the same props — they render identically, because Remotion
 * falls back to the composition's defaultProps for both.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null"
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter((k) => typeof obj[k] !== "undefined").sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`
  }
  return "null"
}

/** Props with the finish-only keys removed — the frame-relevant subset. */
export function framePropsOf(
  props: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props ?? {})) {
    if ((FINISH_PROP_KEYS as readonly string[]).includes(k)) continue
    out[k] = v
  }
  return out
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

/** Short, readable, and still collision-safe for this domain (2^-128). */
function shortHash(input: string): string {
  return sha256(input).slice(0, 32)
}

// ─────────────────────────────────────────────────────────────────────────────
// Code revision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The identity of the composition CODE currently deployed.
 *
 * Derived, never declared: a composition edit ships in a commit, so the commit
 * sha covers it with no human bookkeeping to forget. Falls back to the Vercel
 * deployment id, then to "dev" — in local development every render shares one
 * revision, which is what makes the cache observable while iterating.
 */
export function buildRevision(env: Record<string, string | undefined> = process.env): string {
  const sha = env.VERCEL_GIT_COMMIT_SHA
  if (sha && sha.length >= 7) return sha.slice(0, 12)
  const dep = env.VERCEL_DEPLOYMENT_ID
  if (dep) return dep.slice(0, 12)
  return "dev"
}

// ─────────────────────────────────────────────────────────────────────────────
// The keys
// ─────────────────────────────────────────────────────────────────────────────

export interface FrameKeyInput {
  compositionId: string
  codeRevision: string
  geometry: CompositionGeometry
  props: Record<string, unknown> | null | undefined
}

/** Identity of the FRAMES a render will produce. */
export function computeFrameKey(input: FrameKeyInput): string {
  const g = input.geometry
  const payload = canonicalJson({
    c: input.compositionId,
    r: input.codeRevision,
    g: [g.width, g.height, g.fps, g.durationFrames],
    p: framePropsOf(input.props),
  })
  return `f1_${shortHash(payload)}`
}

/** Identity of the FINISHED artifact: frames plus everything muxed over them. */
export function computeArtifactKey(frameKey: string, finish: FinishInputs): string {
  const payload = canonicalJson({
    f: frameKey,
    i: finish.introAssetId,
    o: finish.outroAssetId,
    m: finish.musicAssetId,
    v: finish.musicVolumePct,
    l: finish.musicLoop,
    n: finish.voiceoverUrl,
  })
  return `a1_${shortHash(payload)}`
}

/**
 * Identity of a NARRATION clip: the exact script in the exact voice.
 *
 * ElevenLabs does not return bit-identical audio for a repeated request, so
 * "deterministic" here means semantically identical — the same words in the
 * same voice, which is the thing a viewer hears. Reusing it is correct, and it
 * is the only reason the artifact key can ever be stable: while the narration
 * mp3 carried a Date.now() nonce in its path, every render produced a fresh
 * voiceover_url and the artifact key could never repeat.
 */
export function computeNarrationKey(voiceId: string, script: string): string {
  return `n1_${shortHash(canonicalJson({ v: voiceId, s: script.trim() }))}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Determinism leaks — the guard against this bug coming back
// ─────────────────────────────────────────────────────────────────────────────

/** A prop whose VALUE carries a per-call nonce, so its key can never repeat. */
export interface CachePoisoningFinding {
  /** Dotted path into input_props, e.g. "brand.logoUrl" or "slides.0.url". */
  path: string
  reason: "epoch_millis" | "recent_timestamp" | "uuid" | "nonce_suffix"
  /** Trimmed sample so a human can see what to fix. Never the whole payload. */
  sample: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EPOCH_RE = /(?<!\d)1[6-9]\d{11}(?!\d)/
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

/**
 * Find props that make a render permanently uncacheable.
 *
 * This is the detector for the exact defect this build fixes: a value that
 * changes on every call (an epoch-stamped URL, a fresh uuid, a render
 * timestamp) poisons the frame key, so every render is a miss forever and the
 * cache silently does nothing while reporting a healthy 0% hit rate.
 *
 * DELIBERATELY CONSERVATIVE about dates. A market-update reel legitimately
 * shows "week of 2026-07-27" — a plain date is CONTENT, and flagging it would
 * teach the Asset Manager to ignore this. Only a full ISO timestamp (which no
 * composition renders to screen) and a raw epoch-millis are treated as nonces.
 */
export function findCachePoisoningProps(
  props: Record<string, unknown> | null | undefined,
): CachePoisoningFinding[] {
  const out: CachePoisoningFinding[] = []
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > 8 || out.length >= 25) return
    if (typeof value === "number") {
      // A raw epoch-millis number anywhere in props is a per-call nonce.
      if (Number.isInteger(value) && value > 1_600_000_000_000 && value < 2_000_000_000_000) {
        out.push({ path, reason: "epoch_millis", sample: String(value) })
      }
      return
    }
    if (typeof value === "string") {
      if (UUID_RE.test(value.trim())) {
        out.push({ path, reason: "uuid", sample: value.slice(0, 60) })
      } else if (EPOCH_RE.test(value)) {
        // e.g. ".../voiceovers/<id>/render-probe-1753900000000.mp3"
        out.push({ path, reason: "nonce_suffix", sample: value.slice(-60) })
      } else if (ISO_RE.test(value)) {
        out.push({ path, reason: "recent_timestamp", sample: value.slice(0, 60) })
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, path ? `${path}.${i}` : String(i), depth + 1))
      return
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // voiceover_url is a finish input and already excluded from the frame
        // key; flagging its nonce here would be a false positive.
        if ((FINISH_PROP_KEYS as readonly string[]).includes(k)) continue
        walk(v, path ? `${path}.${k}` : k, depth + 1)
      }
    }
  }
  walk(framePropsOf(props), "", 0)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// What the cache is worth
// ─────────────────────────────────────────────────────────────────────────────

export interface CacheEconomics {
  renders: number
  hits: number
  /** Hits as a percentage of renders. 0 renders → 0, never NaN on an empty OS. */
  hitRatePct: number
  /** Chromium+encode seconds avoided, summed from the compositions actually hit. */
  secondsAvoided: number
  /** Dollars avoided, from the registry's own per-composition estimate. */
  usdAvoided: number
  /** Narration clips reused instead of re-synthesized. */
  narrationReuses: number
}

export function summarizeCacheEconomics(rows: Array<{
  cacheHit: boolean
  /** Registry cost estimate for the composition this render was for. */
  estimatedUsd: number
  /** Output seconds (duration_frames / fps). */
  outputSeconds: number
}>, narrationReuses = 0): CacheEconomics {
  const hits = rows.filter((r) => r.cacheHit)
  const secondsAvoided = hits.reduce((s, r) => s + (Number.isFinite(r.outputSeconds) ? r.outputSeconds : 0), 0)
  const usdAvoided = hits.reduce((s, r) => s + (Number.isFinite(r.estimatedUsd) ? r.estimatedUsd : 0), 0)
  return {
    renders: rows.length,
    hits: hits.length,
    hitRatePct: rows.length === 0 ? 0 : Number(((hits.length / rows.length) * 100).toFixed(1)),
    secondsAvoided: Number(secondsAvoided.toFixed(1)),
    usdAvoided: Number(usdAvoided.toFixed(3)),
    narrationReuses,
  }
}

/** The signal a determinism leak publishes. Catalogued in signal-registry. */
export const RENDER_CACHE_LEAK_SIGNAL = "render_determinism_leak" as const

/** Human sentence for the Asset Manager's inbox. */
export function leakBrief(compositionId: string, findings: CachePoisoningFinding[]): string {
  const paths = findings.slice(0, 4).map((f) => `${f.path || "(root)"} (${f.reason})`).join(", ")
  const more = findings.length > 4 ? ` and ${findings.length - 4} more` : ""
  return `${compositionId} can never reuse a render: its props carry per-call values at ${paths}${more}. `
    + `Every render of this composition is a fresh Chromium pass even when the content is identical. `
    + `Move the changing value into input_props.voiceover_url (a finish input) or out of the props entirely.`
}
