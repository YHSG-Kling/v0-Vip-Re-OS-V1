/**
 * lib/remotion/render-failure-census.ts — THE RECURRING REMOTION FAILURES, NAMED FROM THE
 * EVIDENCE, AND THE READER THAT WILL SURFACE THE FIRST PRODUCTION ONE (wave 142, lane 142F).
 *
 * OWNER (2026-10-18): "we need to figure out what remotion issues we keep running into."
 *
 * WHAT THE LIVE DATABASE SAYS (integrator census, project hrvaqgvukzxfskkcrwbt, read
 * 2026-10-19): remotion_composition_renders holds 0 rows, ai_video_projects 0,
 * video_assets 0, listing_promo_videos 0, newsletter_video_renders 0, narration_cache 0;
 * remotion_compositions holds the 34 registered compositions. There is NO production
 * render failure on record — the platform has not been operated yet. So every
 * "recurring issue" is a DEVELOPMENT / CI / SANDBOX failure recorded in the lane notes
 * and fixed in code, and this module does two things with that:
 *
 *   1. RENDER_FAILURE_SIGNATURES names each root cause the repo has already paid for,
 *      with the evidence (the note or the commit) and where the fix lives, as a REGEX
 *      over the error_message the pipeline writes — so the first production failure
 *      is classified the moment it is written, not re-investigated from scratch.
 *   2. censusRenderFailures is the READER: the composition-render-queue cron folds the
 *      failed rows it already reads through it on every tick and prints the census
 *      (app/api/cron/composition-render-queue/route.ts `failure_census`), and
 *      scripts/video-pipeline-truth-guard.ts runs the same fold over the live table
 *      when a service key is present. LIVE_RENDER_FAILURE_CENSUS_SQL is the same
 *      question for the integrator's SQL editor.
 *
 * PURE: no I/O, no server-only. The pipeline's error strings are the contract
 * (`[media-host] …`, `claim_refused: …`, `content_props_missing`, ffmpeg's own
 * `ffmpeg exited N`, Remotion's `inputRange must be strictly monotonically increasing`),
 * and each signature's `evidence` says which file or note it was read from.
 */

type RenderFailureBucket =
  | "unplayable_output"
  | "bundle_resolve"
  | "chromium_launch"
  | "frame_interpolation"
  | "ffmpeg_stitch"
  | "content_contract"
  | "claim_refused"
  | "asset_load_timeout"
  | "media_decode"
  | "host_refused"
  | "function_timeout"
  | "memory"
  | "provider"
  | "not_renderable"
  | "unknown"

interface RenderFailureSignature {
  bucket: RenderFailureBucket
  pattern: RegExp
  /** What actually went wrong, in one sentence. */
  rootCause: string
  /** Where it was measured — a file:line, a lane note, or a commit. */
  evidence: string
  /** Where the fix lives, or what the operator does. */
  fix: string
}

/**
 * Ordered most-specific first: a message is classified by the FIRST signature that
 * matches, so `output not playable` (raised inside the host) wins over the generic
 * `[media-host]` host-refusal bucket, and `claim_refused` over a storage word.
 */
/** @proofSeam scripts/video-pipeline-truth-guard.ts classifies a recorded message per signature and holds every entry to a root cause + evidence + fix. */
export const RENDER_FAILURE_SIGNATURES: readonly RenderFailureSignature[] = [
  {
    bucket: "unplayable_output",
    pattern: /output not playable|unplayable/i,
    rootCause: "The bytes handed to the host were not a playable container (empty, truncated, no moov/mdat, zero duration) — before wave 142 these were hosted and stamped succeeded.",
    evidence: "lib/video/playable-output.ts probePlayableOutput, run inside lib/remotion/media-host.ts hostRenderedMedia for every video/* upload",
    fix: "The row is failed with the probe's reasons and escalated to the Asset Manager (lib/remotion/render-escalation.ts); the queue retries once (transient), then a human looks at the composition.",
  },
  {
    bucket: "content_contract",
    pattern: /content_props_missing|missing required content|content contract|composition_not_registered|composition disappeared/i,
    rootCause: "A producer staged a render without the composition's CLAIM props; Remotion merges {} over Studio defaultProps, so the render would have come out confident and wrong (123 Main Street at $625,000).",
    evidence: "lib/remotion/content-contract.ts + render-composition/route.ts §2c (the backstop; cancelled, not failed)",
    fix: "The producer threads the facts (director-content.ts); the row is CANCELLED with the missing prop names and never auto-retried (shouldAutoRequeueFailedRender refuses a doomed retry).",
  },
  {
    bucket: "claim_refused",
    pattern: /claim_refused|claim REFUSED/i,
    rootCause: "The queued→rendering claim was REFUSED (PGRST204 on a column, a PostgREST 5xx, a multi-row maybeSingle) and used to read as 'nothing queued' — the same oldest row was picked forever.",
    evidence: "app/api/internal/remotion/render-composition/route.ts :100-117 (commit 0b37d7b28: 'three render routes read a refused claim as nothing to do')",
    fix: "The route answers 500 with the refusal; the cron's own response carries it. Check the column list in the claim's .update()/.select() against the live schema.",
  },
  {
    bucket: "asset_load_timeout",
    pattern: /delayRender\(\) was called but not cleared|A delayRender\(\)|not cleared after \d+ ?ms|remotion\.dev\/docs\/timeout/i,
    rootCause: "A delayRender() handle — an <Img> still loading (SafeImg), the ProductPromoReel's Google font via loadFont(), a <Video>/<Audio> element's metadata — was not cleared within the renderer's timeoutInMilliseconds (the installed default, 30 000 ms; the render route sets none), so Remotion aborted the WHOLE render: a slow or blocked asset host, a bucket that answers late, or the sandbox proxy refusing the fetch.",
    evidence: "node_modules/remotion@4.0.521 dist/cjs/delay-render.js:42 (the exact message: 'was called but not cleared after ${timeout}ms. See https://remotion.dev/docs/timeout for help.'); remotion/components/SafeImg.tsx:29-32 (delayRenderRetries={1}, the 30 s default named); remotion/ProductPromoReel.tsx:36 loadFont; app/api/internal/remotion/render-composition/route.ts:290 (no timeoutInMilliseconds override). The official page is linked from the message itself — WebFetch of remotion.dev was refused in this sandbox (DNS), so the installed package is the citation.",
    fix: "SafeImg gives up after ONE retry (cancelRender) so a dead photo fails loud instead of hanging 30 s per frame; a slow host is transient for the queue's one bounded retry; raise timeoutInMilliseconds on renderMedia only for a composition PROVEN to load remote media, never globally (it multiplies the 300 s route cap exposure).",
  },
  {
    bucket: "media_decode",
    pattern: /Error loading image with src|Could not (extract|get) (a )?frame|Failed to (load|decode) (the )?(media|audio|video|image)|MEDIA_ERR|NotSupportedError|OffthreadVideo|cancelRender/i,
    rootCause: "A referenced asset could not be fetched or decoded by the headless browser: a photo that 404s on a public bucket (SafeImg cancels after one retry), a D-ID result URL that expired before the frame was reached, or an mp4/audio codec Chromium cannot decode inside one of the 24 compositions that mount <Video>/<Audio>/<OffthreadVideo>.",
    evidence: "remotion/components/SafeImg.tsx:12 (the cancelRender text 'Error loading image with src:'); 24 files under remotion/ mount <Video>/<Audio>/<OffthreadVideo> (grep 2026-10-19); lib/did/result-url-rehost-sweep.ts (provider URLs expire → re-hosted on our bucket before any render reads them)",
    fix: "Re-host provider media before it is staged into input_props (the D-ID rehost sweep + hostRenderedMedia), conform every muxed source (lib/video/stitch-graph.ts), and treat a 404 as TERMINAL — the auto-requeue must not re-fetch a file that is gone.",
  },
  {
    bucket: "bundle_resolve",
    pattern: /Can't resolve|Cannot find module|Module not found|bundle\(.*\) failed|webpack/i,
    rootCause: "A file under remotion/ imported an app module through the `@/` alias (or a server/app graph); the Remotion bundler's webpack resolves relative imports to PURE lib modules only, so the production bundle did not compile and every render died at getBundle.",
    evidence: "lane 85E notes: `bundle({entryPoint: remotion/index.ts}) … failed with Can't resolve '@/lib/format/math' / '@/lib/remotion/content-contract'`; commit 29acdca03 'Remotion bundle compiles again'; commit 187aaa2bb (a server producer reached a Remotion component file)",
    fix: "Relative imports from remotion/** to pure lib modules only; test:remotion-setup holds the bundle; the bundle cache evicts a rejected promise so the next tick retries (lib/remotion/bundle-cache.ts).",
  },
  {
    bucket: "chromium_launch",
    pattern: /chromium|chrome-|browserExecutable|executablePath|Failed to launch|ERR_TUNNEL_CONNECTION_FAILED|Target closed|Protocol error|Could not find (a )?browser|spawn .*ENOENT.*chrom/i,
    rootCause: "The headless browser could not be launched or could not reach the network: on Vercel the @sparticuz/chromium-min pack must download (CHROMIUM_PACK_URL, pinned v149), in CI the Playwright cache must exist, and in this sandbox the agent proxy refuses chromium's CONNECT.",
    evidence: "lib/remotion/chromium-executable.ts (three inline copies merged, lane 78B); lane 78 notes: `https://example.com failed with net::ERR_TUNNEL_CONNECTION_FAILED — the sandbox's agent proxy refuses chromium's CONNECT`; wave 93 CI: 'real Chromium timed out launching in test:capture-dns-pin'",
    fix: "resolveChromiumExecutable is the ONE resolver (serverless → the pack; local → Remotion-managed or CHROMIUM_EXECUTABLE_PATH); a launch failure is transient for the queue's bounded auto-requeue.",
  },
  {
    bucket: "frame_interpolation",
    pattern: /inputRange must be strictly monotonically increasing|outputRange|interpolate\(/i,
    rootCause: "A composition built an interpolate() inputRange that was not strictly increasing (a fade longer than the clip collapsed [0, fadeIn, dur, dur]) — Remotion throws for the frame and the WHOLE render fails.",
    evidence: "remotion/components/KenBurnsPhoto.tsx:63 (the comment records the exact failing range [0,10,36,36]; fixed lane 86B); commit 7db8dde60 'every interpolate clamps'",
    fix: "Clamp both extrapolations and guard degenerate ranges (fadeIn >= dur → constant); scripts/video-timeline-integrity-guard.ts walks every composition.",
  },
  {
    bucket: "ffmpeg_stitch",
    pattern: /ffmpeg exited|ffmpeg failed|filter_complex|xfade|acrossfade|\bconcat\b|\btpad\b|ffmpeg-static|Invalid argument|Error (initializing|reinitializing) filters/i,
    rootCause: "The post-render ffmpeg pass (bookend stitch, narration mux, music bed, loudness master) failed: historically a segment with NO audio stream made `[i:a]` invalid and killed the whole stitch, a tpad placed after a trim added nothing (5.7 s of picture lost), renders came out BT.601 against BT.709 clips, and hard cuts clicked mid-waveform.",
    evidence: "lib/video/stitch-graph.ts header (lane 86B measurements) + lib/video/composite-attribution.ts concatIntroOutro; lane 86B notes items 3 and 5",
    fix: "Every segment is conformed (fps, yuv420p, BT.709, 48 kHz), silent sources are synthesized in-graph, joins are dissolves on handles; a failed pass keeps the unstitched buffer (best-effort) — so an ffmpeg failure in the error_message means the FIRST pass (the render itself) or the host raised it.",
  },
  {
    bucket: "function_timeout",
    pattern: /FUNCTION_INVOCATION_TIMEOUT|Task timed out|timed out|ETIMEDOUT|\b504\b|maxDuration|exceeded.*time/i,
    rootCause: "The synchronous Vercel render route is capped at 300 s (maxDuration) and bundle + Chromium + encode + ffmpeg passes compete for one instance: a 15 s reel measured 115 s at scale 0.5 / concurrency 2 on a dev box, and the 706-frame memory film ran 40 minutes with motion blur on.",
    evidence: "app/api/internal/remotion/render-composition/route.ts (maxDuration 300, concurrency 1); lane 86B / 90E2 notes (render times, the blur-window finding, 3.3× saving from the blur rule); remotion/LAMBDA_DEPLOYMENT.md (the parked Lambda path)",
    fix: "Blur only where the purpose model allows, 30 fps for social, concurrency 1 on Vercel, the bundle cache; a timeout is transient for ONE bounded retry; sustained timeouts are the Lambda migration the deployment note documents.",
  },
  {
    bucket: "memory",
    pattern: /heap out of memory|Ineffective mark-compacts|ENOMEM|out of memory|SIGABRT|exit code 13[47]|killed/i,
    rootCause: "A V8 heap or container memory limit. Every exit-134 / 'Ineffective mark-compacts' in this repo's history is the TypeScript or next-build compile (CI), not a render — but a Vercel function below the ~1.6 GB the Sparticuz pack recommends can die the same way mid-encode.",
    evidence: ".github/workflows/build.yml measurement notes (compile-phase heap aborts); lane 78 notes: 'Sparticuz recommends ≥512 MB, ideally 1600 MB RAM'",
    fix: "Function memory on the render routes; never more than one render per instance (the cron serializes); the row is transient for one retry.",
  },
  {
    bucket: "host_refused",
    pattern: /\[media-host\]|upload refused|no URL could be issued|storage_orphaned_objects|bucket|refusing to store/i,
    rootCause: "Supabase Storage refused the finished bytes (missing bucket, bucket limit, mime, a signing failure) — the Vercel Blob fallback that used to swallow this behind `catch {}` was removed on the owner's ruling, so the refusal is loud.",
    evidence: "lib/remotion/media-host.ts header (2026-08-26 ruling); lib/storage/file-limits.ts checkUpload",
    fix: "Read the reason in error_message (bucket + limit are named); the stored object, when the URL issue failed, is removed or recorded on storage_orphaned_objects.",
  },
  {
    bucket: "provider",
    pattern: /D-ID|\bdid\b.*(failed|error)|elevenlabs|\b429\b|rate limit|InsufficientCredits|ImageModeration/i,
    rootCause: "An upstream media provider (D-ID avatar, ElevenLabs narration) refused or failed; the structured D-ID error classes separate terminal (402/451/400) from transient (429/5xx).",
    evidence: "lib/did/contract.ts classifyDidError (MAINTENANCE_DOMAINS.did_integration)",
    fix: "Terminal classes stop retrying and name the human action; transient ones ride the poller's bounded retry.",
  },
  {
    bucket: "not_renderable",
    pattern: /composition_not_reachable_at_tier|composition_inactive/i,
    rootCause: "Nothing broke: the composition is inactive or above the tenant's tier — the row is CANCELLED, not failed.",
    evidence: "app/api/internal/remotion/render-composition/route.ts §2 / §2b",
    fix: "None (by design); it is listed so a census never mistakes a cancellation for a failure.",
  },
]

interface RenderFailureClassification {
  bucket: RenderFailureBucket
  signature: RenderFailureSignature | null
}

/** Classify ONE error_message. `unknown` when no signature matches (printed, never hidden). */
export function classifyRenderFailure(errorMessage: string | null | undefined): RenderFailureClassification {
  const msg = (errorMessage ?? "").trim()
  if (!msg) return { bucket: "unknown", signature: null }
  for (const s of RENDER_FAILURE_SIGNATURES) {
    if (s.pattern.test(msg)) return { bucket: s.bucket, signature: s }
  }
  return { bucket: "unknown", signature: null }
}

interface RenderCensusRow {
  id: string
  composition_id: string | null
  error_message: string | null
  retry_count: number | null
}

interface RenderFailureCensusBucket {
  count: number
  /** Rows whose bounded auto-retries are spent (a human must look). */
  retryExhausted: number
  compositions: string[]
  sampleRenderIds: string[]
  sampleError: string | null
  rootCause: string | null
  fix: string | null
}

interface RenderFailureCensus {
  total: number
  byBucket: Partial<Record<RenderFailureBucket, RenderFailureCensusBucket>>
}

/** The auto-requeue bound the queue applies (lib/remotion/render-decision.ts MAX_AUTO_REQUEUE_ATTEMPTS = 2). */
const RETRY_EXHAUSTED_AT = 2

/** Fold failed render rows into the census. PURE; an empty input is an honest empty census. */
export function censusRenderFailures(rows: readonly RenderCensusRow[]): RenderFailureCensus {
  const byBucket: Partial<Record<RenderFailureBucket, RenderFailureCensusBucket>> = {}
  for (const r of rows) {
    const c = classifyRenderFailure(r.error_message)
    const b = (byBucket[c.bucket] ??= {
      count: 0, retryExhausted: 0, compositions: [], sampleRenderIds: [], sampleError: null,
      rootCause: c.signature?.rootCause ?? null, fix: c.signature?.fix ?? null,
    })
    b.count++
    if ((r.retry_count ?? 0) >= RETRY_EXHAUSTED_AT) b.retryExhausted++
    if (r.composition_id && !b.compositions.includes(r.composition_id)) b.compositions.push(r.composition_id)
    if (b.sampleRenderIds.length < 3) b.sampleRenderIds.push(r.id)
    if (!b.sampleError && r.error_message) b.sampleError = r.error_message.slice(0, 240)
  }
  return { total: rows.length, byBucket }
}

/** One log line per non-empty bucket, for the cron's console and the proof's report. */
export function describeRenderFailureCensus(census: RenderFailureCensus): string[] {
  const lines: string[] = []
  for (const [bucket, b] of Object.entries(census.byBucket) as Array<[RenderFailureBucket, RenderFailureCensusBucket]>) {
    lines.push(`${bucket}: ${b.count} (retries exhausted ${b.retryExhausted}) — ${b.compositions.join(", ") || "no composition"}${b.sampleError ? ` — e.g. ${b.sampleError}` : ""}`)
  }
  return lines
}

/**
 * The integrator's live census — the SAME fold as censusRenderFailures, as SQL. The
 * regexes are the signature patterns above spelled for Postgres (case-insensitive).
 * Read-only. On 2026-10-19 the table held 0 rows, so this returns no rows until the
 * platform has rendered in production.
 * @proofSeam scripts/video-pipeline-truth-guard.ts holds the SQL to the same bucket vocabulary the code classifies.
 */
export const LIVE_RENDER_FAILURE_CENSUS_SQL = `
select
  case
    when error_message ~* 'output not playable|unplayable' then 'unplayable_output'
    when error_message ~* 'content_props_missing|missing required content|composition_not_registered' then 'content_contract'
    when error_message ~* 'claim_refused' then 'claim_refused'
    when error_message ~* 'delayRender\\(\\) was called but not cleared|not cleared after [0-9]+ ?ms|remotion\\.dev/docs/timeout' then 'asset_load_timeout'
    when error_message ~* 'Error loading image with src|Could not (extract|get) (a )?frame|Failed to (load|decode)|MEDIA_ERR|NotSupportedError|OffthreadVideo|cancelRender' then 'media_decode'
    when error_message ~* 'Can''t resolve|Cannot find module|Module not found|webpack' then 'bundle_resolve'
    when error_message ~* 'chromium|browserExecutable|Failed to launch|ERR_TUNNEL|Target closed|Protocol error' then 'chromium_launch'
    when error_message ~* 'inputRange must be strictly monotonically increasing|interpolate' then 'frame_interpolation'
    when error_message ~* 'ffmpeg exited|ffmpeg failed|filter_complex|xfade|acrossfade|ffmpeg-static' then 'ffmpeg_stitch'
    when error_message ~* 'FUNCTION_INVOCATION_TIMEOUT|Task timed out|timed out|ETIMEDOUT|504|maxDuration' then 'function_timeout'
    when error_message ~* 'heap out of memory|Ineffective mark-compacts|ENOMEM|SIGABRT' then 'memory'
    when error_message ~* '\\[media-host\\]|upload refused|no URL could be issued|refusing to store' then 'host_refused'
    when error_message ~* 'D-ID|elevenlabs|429|rate limit' then 'provider'
    when error_message ~* 'composition_not_reachable_at_tier|composition_inactive' then 'not_renderable'
    else 'unknown'
  end as bucket,
  count(*) as renders,
  count(*) filter (where coalesce(retry_count, 0) >= 2) as retries_exhausted,
  array_agg(distinct composition_id) as compositions,
  min(created_at) as first_seen, max(created_at) as last_seen,
  (array_agg(left(error_message, 240) order by created_at desc))[1] as latest_error
from remotion_composition_renders
where render_status in ('failed', 'cancelled')
group by 1 order by renders desc;
`.trim()
