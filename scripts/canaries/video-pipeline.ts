/**
 * scripts/canaries/video-pipeline.ts — VIDEO canary (wave 142, lane 142J):
 *   a render is playable only with a FILE, never because a status says success · failed renders retry with a cap
 *   and never when doomed · the stuck-render watchdog on an EMPTY table proves nothing · classification + YouTube ·
 *   landing video slot with a safe omit
 * through the survivors at HEAD: lib/video/playable-video.ts resolvePlayableVideo (remotion_composition_renders:
 * succeeded AND output_url → ready; rendering → in_progress; else none with a reason), lib/remotion/render-decision.ts
 * shouldAutoRequeueFailedRender / isStillComposition / outputContentType (pure), lib/video/video-status.ts (the
 * ONE status vocabulary), lib/video/video-pipeline-reaper.ts sweepStuckVideoRenders (the watchdog), lib/social/
 * publisher.ts publishToYouTube and lib/orchestrator/internal.ts personalVideoTypes. Owner (wave 142): "A render is
 * complete only when the output is PLAYABLE, never because a status column says success"; "all videos that are not
 * personal should also be added to youtube"; "a landing page should include some type of video".
 *
 * MEASURED AT HEAD (the 142F hooks): the resolver resolves a URL and never probes the bytes (no ftyp / EBML /
 * ffprobe anywhere under lib/remotion + lib/video); publishToYouTube hard-codes privacyStatus 'public'; /lm/[slug]
 * omits the player safely but carries no poster / onError fallback and /site/[slug] has no video slot. In-memory
 * only: EVERY live video table holds 0 rows (2026-10-19) — the failure census below is the canary's own fixture.
 */
import { CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, listFiles, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Video pipeline: playable only with a file · capped retries, never doomed · empty watchdog proves nothing · classification + YouTube · landing slot")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — every live video / render table holds 0 rows; a live run proves nothing and a publish is public")
  const B = uuid(), R_OK = uuid(), R_NOFILE = uuid(), R_RUN = uuid(), R_FAIL = uuid(), R_FAIL2 = uuid()
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-video` }],
    remotion_composition_renders: [
      { id: R_OK, brokerage_id: B, composition_id: "ListingPromo", render_status: "succeeded", output_url: `https://media.${CANARY_TAG}.test/renders/${R_OK}.mp4`, thumbnail_url: `https://media.${CANARY_TAG}.test/renders/${R_OK}.png`, error_message: null, retry_count: 0, created_at: hoursAgo(2), updated_at: hoursAgo(1) },
      { id: R_NOFILE, brokerage_id: B, composition_id: "ListingPromo", render_status: "succeeded", output_url: null, thumbnail_url: null, error_message: null, retry_count: 0, created_at: hoursAgo(2), updated_at: hoursAgo(1) },
      { id: R_RUN, brokerage_id: B, composition_id: "ListingPromo", render_status: "rendering", output_url: null, thumbnail_url: null, error_message: null, retry_count: 0, created_at: nowIso(), updated_at: nowIso() },
      { id: R_FAIL, brokerage_id: B, composition_id: "ListingPromo", render_status: "failed", output_url: null, thumbnail_url: null, error_message: "ffmpeg: Invalid data found when processing input (concat)", retry_count: 1, created_at: hoursAgo(3), updated_at: hoursAgo(2) },
      { id: R_FAIL2, brokerage_id: B, composition_id: "NewsletterVideo", render_status: "failed", output_url: null, thumbnail_url: null, error_message: "ffmpeg: Invalid data found when processing input (concat)", retry_count: 2, created_at: hoursAgo(3), updated_at: hoursAgo(2) },
    ],
  })
  setSvc(svc)

  // ── 1 · playable = a file, never a status ──
  const { resolvePlayableVideo } = await import("../../lib/video/playable-video")
  const ok = await resolvePlayableVideo({ renderId: R_OK }, svc as never)
  const noFile = await resolvePlayableVideo({ renderId: R_NOFILE }, svc as never)
  const running = await resolvePlayableVideo({ renderId: R_RUN }, svc as never)
  const nothing = await resolvePlayableVideo({}, svc as never)
  c.step("PLAYABLE ONLY WITH A FILE: a succeeded render WITH an output file resolves ready (its URL + thumbnail); a render whose status says 'succeeded' but holds NO file is NOT ready (none, with a reason) — the status column alone never makes a video; a rendering one is in_progress (wait, never send); no reference → none by name", ok.state === "ready" && ok.videoUrl.endsWith(".mp4") && noFile.state !== "ready" && running.state === "in_progress" && nothing.state === "none" && /no video reference/.test(nothing.reason), `${ok.state} / ${noFile.state}${noFile.state === "none" ? ` (${noFile.reason.slice(0, 60)})` : ""} / ${running.state}`)

  // ── 2 · retries: capped, never doomed (pure) ──
  const { shouldAutoRequeueFailedRender, MAX_AUTO_REQUEUE_ATTEMPTS, isStillComposition, outputContentType } = await import("../../lib/remotion/render-decision")
  const fresh = shouldAutoRequeueFailedRender({ render_status: "failed", retry_count: 0 }, [])
  const spent = shouldAutoRequeueFailedRender({ render_status: "failed", retry_count: MAX_AUTO_REQUEUE_ATTEMPTS }, [])
  const doomed = shouldAutoRequeueFailedRender({ render_status: "failed", retry_count: 0 }, ["narrationUrl"])
  const notFailed = shouldAutoRequeueFailedRender({ render_status: "queued", retry_count: 0 }, [])
  c.step(`RETRY POLICY: a transient failure requeues; ${MAX_AUTO_REQUEUE_ATTEMPTS} spent attempts hand it to a HUMAN; a render still missing required content props is DOOMED and never requeued (it would fail identically — the silent-content class); a non-failed row is a no-op — every skip carries its reason; a 1-frame composition is a PNG, a film an MP4`, fresh.requeue && !spent.requeue && /human/.test(spent.reason) && !doomed.requeue && /doomed/.test(doomed.reason) && !notFailed.requeue && isStillComposition(1) && outputContentType(300) === "video/mp4", "")

  // ── 3 · the watchdog on an EMPTY table proves nothing ──
  const { sweepStuckVideoRenders } = await import("../../lib/video/video-pipeline-reaper")
  const sweep = await sweepStuckVideoRenders(svc as never, { now: new Date() })
  c.step("WATCHDOG, 0 ROWS: the stuck-render sweep over an EMPTY ai_video_projects table scans 0 tenants and escalates nobody WITHOUT an error — a clean sweep over 0 rows is NOT_APPLICABLE / unproven, never a clean bill of health (the readiness rule for every live video count at 2026-10-19)", sweep.tenants === 0 && sweep.scanned === 0 && sweep.escalated === 0 && !sweep.error, JSON.stringify(sweep))
  const renders = svc.tables.remotion_composition_renders ?? []
  const census = new Map<string, number>()
  for (const r of renders.filter((x) => x.render_status === "failed")) census.set(String(r.error_message), (census.get(String(r.error_message)) ?? 0) + 1)
  c.step("FAILURE CENSUS (the reader's shape, on the fixture): failed renders grouped by error signature — 1 signature × 2 renders, 1 of them past the retry cap; render_status / error_message / retry_count are the live columns (census 2026-10-19)", census.size === 1 && [...census.values()][0] === 2 && renders.filter((x) => x.render_status === "failed" && Number(x.retry_count) >= MAX_AUTO_REQUEUE_ATTEMPTS).length === 1, [...census].map(([k, v]) => `${v}× ${k.slice(0, 40)}`).join("; "))

  // ── 4 · one status vocabulary; classification; YouTube; landing slot (pure + stripped) ──
  const { CANONICAL_VIDEO_STATUSES, isCanonicalVideoStatus, normalizeVideoStatus, VIDEO_TERMINAL_STATUSES, RETIRED_VIDEO_STATUS } = await import("../../lib/video/video-status")
  const retired = Object.keys(RETIRED_VIDEO_STATUS)[0]
  c.step(`ONE STATUS VOCABULARY: ${CANONICAL_VIDEO_STATUSES.length} canonical values; completed / published / failed are terminal; a retired spelling ('${retired}') normalises to its canonical survivor and is not itself canonical (§6 — 22 spellings merged)`, CANONICAL_VIDEO_STATUSES.length === 9 && VIDEO_TERMINAL_STATUSES.includes("failed") && isCanonicalVideoStatus("completed") && !!retired && !isCanonicalVideoStatus(retired) && isCanonicalVideoStatus(normalizeVideoStatus(retired)), `${retired} → ${normalizeVideoStatus(retired)}`)
  const orchestrator = strippedRepo("lib/orchestrator/internal.ts") ?? ""
  const publisher = strippedRepo("lib/social/publisher.ts") ?? ""
  const classes = /personalVideoTypes\s*=\s*\[([^\]]*)\]/.exec(orchestrator)?.[1] ?? ""
  c.step("CLASSIFICATION EXISTS: personalVideoTypes names the PERSONAL classes (thank_you, personal, memory_video …) — the set the YouTube rule keys on; the YouTube path is the existing authorized resumable upload (publishToYouTube) behind the tenant's OAuth, not a second uploader", /thank_you/.test(classes) && /personal/.test(classes) && /memory_video/.test(classes) && /publishToYouTube/.test(publisher) && /resumable/i.test(publisher), classes.replace(/\s+/g, "").slice(0, 60))
  const lm = strippedRepo("app/lm/[slug]/page.tsx") ?? ""
  c.step("LANDING SLOT (as it stands): /lm/[slug] renders the <video> ONLY when landing_content.videoUrl is set — a safe omit, never a broken player with an empty src", /landing\.videoUrl\s*&&/.test(lm) && /<video\b/.test(lm), "")
  const probeFiles = [...listFiles("lib/remotion", (f) => /\.ts$/.test(f)), ...listFiles("lib/video", (f) => /\.ts$/.test(f))].filter((f) => /\b(ftyp|EBML|ffprobe)\b/.test(strippedRepo(f) ?? ""))
  console.log(`    measured: byte-level playability probe (ftyp / EBML / ffprobe) under lib/remotion + lib/video = ${probeFiles.length ? probeFiles.join(",") : "NONE — the resolver trusts output_url"}; publisher privacyStatus hard-coded 'public' = ${/privacyStatus:\s*["']public["']/.test(publisher) ? "yes" : "no"}; /site/[slug] <video> = ${/<video\b/.test(strippedRepo("app/site/[slug]/page.tsx") ?? "") ? "yes" : "no"}`)

  // ── WAVE142 HOOK (integrator): 142F — the playable-output probe + failure census reader; landing fallback; the YouTube rule. ──
  for (const h of hooksFor("video-pipeline")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, /PLAYABLE OUTPUT/.test(h.contract) ? "measured above: no byte probe; 'succeeded' + output_url is the whole test" : /LANDING/.test(h.contract) ? "measured above: /lm omits safely but has no poster / onError; /site has no slot" : "measured above: privacyStatus 'public' hard-coded; no non-personal → YouTube rule or tenant setting"); continue }
    c.step(`${h.lane} landed (${at}) — wire its export into this canary (WAVE142 HOOK (integrator): ${h.lane}): ${/PLAYABLE OUTPUT/.test(h.contract) ? "hand the probe a 0-byte object and a bytes-without-ftyp object and assert render_status 'failed' with the reason, then a real header → 'succeeded'; run the census reader over this fixture" : /LANDING/.test(h.contract) ? "render the slot with a missing file and assert the poster / fallback, never a broken player" : "classify a listing promo (public) and a thank-you (personal) and assert only the former reaches the upload with the classification's privacy and the YouTube id recorded on the asset"}`, false, h.contract.slice(0, 120))
  }
  c.blind("No render runs (Remotion / chromium / ffmpeg are not reached); the Lambda / route caps, fonts, codecs and audio sync are lane 142F's investigation from code + the scratchpad notes. The reaper's per-tenant policy ran over 0 rows by design. YouTube is asserted on stripped source (an upload is public).")
  const cl = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length === 0 && cl.residual === 0, cl.cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cl.cleanup, cl.residual)
}
