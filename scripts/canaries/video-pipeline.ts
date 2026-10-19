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
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, listFiles, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Video pipeline: playable only with a file · capped retries, never doomed · empty watchdog proves nothing · classification + YouTube · landing slot")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — every live video / render table holds 0 rows; a live run proves nothing and a publish is public")
  const B = uuid(), R_OK = uuid(), R_NOFILE = uuid(), R_RUN = uuid(), R_FAIL = uuid(), R_FAIL2 = uuid()
  // WIRED 142K (lane 142F): the YouTube rail's rows — an agent (agents.id → users.id), a connected channel, a public
  // listing promo, a personal thank-you addressed to a contact, and the library copy of the promo's file.
  const AG_U = uuid(), AG = uuid(), ACC = uuid(), PROMO = uuid(), PROMO2 = uuid(), THANKS = uuid(), CONTACT = uuid(), ASSET = uuid()
  const PROMO_URL = `https://media.${CANARY_TAG}.test/videos/${PROMO}.mp4`
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  const videoRow = (id: string, over: Record<string, unknown>) => ({ id, brokerage_id: B, agent_id: AG, listing_id: null, marketing_campaign_id: null, title: `${CANARY_TAG} promo`, video_type: "listing_promo", audience_type: "public", usage_intent: "marketing", contact_id: null, approval_status: "approved", status: "completed", compliance_status: "passed", video_url: PROMO_URL, script_content: "A sunny three-bedroom near the park, open Saturday.", video_metadata: {}, created_at: nowIso(), updated_at: nowIso(), ...over })
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-video` }],
    users: [{ id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, platform_role: null }],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
    social_media_accounts: [{ id: ACC, brokerage_id: B, agent_id: AG, platform: "youtube", is_active: true, account_name: `${CANARY_TAG} channel` }],
    ai_video_projects: [
      videoRow(PROMO, {}),
      videoRow(PROMO2, { title: `${CANARY_TAG} promo two`, video_url: `https://media.${CANARY_TAG}.test/videos/${PROMO2}.mp4` }),
      videoRow(THANKS, { title: `${CANARY_TAG} thank you`, video_type: "thank_you", contact_id: CONTACT, video_url: `https://media.${CANARY_TAG}.test/videos/${THANKS}.mp4` }),
    ],
    marketing_assets: [{ id: ASSET, brokerage_id: B, asset_url: PROMO_URL, asset_type: "video", metadata: { note: CANARY_TAG }, created_at: nowIso() }],
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
  // THE RULE (lane 142F landed): the page mounts the ONE slot (LandingVideo) only when a source exists, with the reel's poster.
  c.step("LANDING SLOT (142F landed): /lm/[slug] mounts the ONE video slot (LandingVideo — poster + onError fallback) ONLY when landing_content.videoUrl is set, with the poster read from the reel's own thumbnail (tenant-pinned, a refused read = no poster, never a broken box); no bare <video> on the page", /landing\.videoUrl\s*&&/.test(lm) && /<LandingVideo\b/.test(lm) && /getLandingVideoPoster\(/.test(lm) && !/<video\b/.test(lm), "")
  const probeFiles = [...listFiles("lib/remotion", (f) => /\.ts$/.test(f)), ...listFiles("lib/video", (f) => /\.ts$/.test(f))].filter((f) => /\b(ftyp|EBML|ffprobe)\b/.test(strippedRepo(f) ?? ""))
  console.log(`    measured: byte-level playability probe (ftyp / EBML / ffprobe) under lib/remotion + lib/video = ${probeFiles.length ? probeFiles.join(",") : "NONE — the resolver trusts output_url"}; publisher privacyStatus hard-coded 'public' = ${/privacyStatus:\s*["']public["']/.test(publisher) ? "yes" : "no"}; /site/[slug] <video> = ${/<video\b/.test(strippedRepo("app/site/[slug]/page.tsx") ?? "") ? "yes" : "no"}`)

  // ── WAVE142 HOOK (integrator): 142F — wired 142K: the playable-output probe + the host's refusal + the census + the escalation; the slot RENDERED; the YouTube rule in memory. ──
  for (const h of hooksFor("video-pipeline")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, /PLAYABLE OUTPUT/.test(h.contract) ? "measured above: no byte probe; 'succeeded' + output_url is the whole test" : /LANDING/.test(h.contract) ? "measured above: /lm omits safely but has no poster / onError; /site has no slot" : "measured above: privacyStatus 'public' hard-coded; no non-personal → YouTube rule or tenant setting"); continue }
    if (/PLAYABLE OUTPUT/.test(h.contract)) {
      const { probePlayableOutput, describeUnplayable, UNPLAYABLE_OUTPUT_TOKEN } = await import("../../lib/video/playable-output")
      const { hostRenderedMedia } = await import("../../lib/remotion/media-host")
      const { classifyRenderFailure, censusRenderFailures, describeRenderFailureCensus, RENDER_FAILURE_SIGNATURES } = await import("../../lib/remotion/render-failure-census")
      const { escalateRenderFailure, RENDER_UNPLAYABLE_SIGNAL } = await import("../../lib/remotion/render-escalation")
      const box = (type: string, payload: Buffer = Buffer.alloc(0)) => { const hdr = Buffer.alloc(8); hdr.writeUInt32BE(8 + payload.length, 0); hdr.write(type, 4, "latin1"); return Buffer.concat([hdr, payload]) }
      const mvhd = (duration: number, timescale = 1000) => { const b = Buffer.alloc(100); b.writeUInt32BE(timescale, 12); b.writeUInt32BE(duration, 16); return box("mvhd", b) }
      const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isomiso2mp41", "latin1"))
      const good = Buffer.concat([ftyp, box("moov", mvhd(5000)), box("mdat", Buffer.alloc(64, 1))])
      const zeroDuration = Buffer.concat([ftyp, box("moov", mvhd(0)), box("mdat", Buffer.alloc(64, 1))])
      const noMoov = Buffer.concat([ftyp, box("mdat", Buffer.alloc(64, 1))])
      const truncated = good.subarray(0, good.length - 20)
      const notAContainer = Buffer.from("this is not a container at all, just some bytes that say so", "latin1")
      const empty = probePlayableOutput(Buffer.alloc(0), "video/mp4"), junk = probePlayableOutput(notAContainer, "video/mp4"), missingMoov = probePlayableOutput(noMoov, "video/mp4"), zero = probePlayableOutput(zeroDuration, "video/mp4"), cut = probePlayableOutput(truncated, "video/mp4"), ok = probePlayableOutput(good, "video/mp4"), png = probePlayableOutput(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png")
      const storageCalls: string[] = []
      const storage = (svc as unknown as { storage: { from: (b: string) => unknown } }).storage
      const origFrom = storage.from.bind(storage)
      storage.from = (b: string) => { storageCalls.push(b); return origFrom(b) }
      let refused = "", reachedStorage = ""
      try { await hostRenderedMedia(svc as never, `renders/${CANARY_TAG}/bad.mp4`, noMoov, "video/mp4") } catch (e) { refused = (e as Error).message }
      const storageBeforeGood = storageCalls.length
      try { await hostRenderedMedia(svc as never, `renders/${CANARY_TAG}/good.mp4`, good, "video/mp4") } catch (e) { reachedStorage = (e as Error).message }
      const unplayable = classifyRenderFailure(refused)
      const escalated = await escalateRenderFailure(svc as never, { brokerageId: B, renderId: R_FAIL, compositionId: "ListingPromo", error: refused })
      const notUnplayable = await escalateRenderFailure(svc as never, { brokerageId: B, renderId: R_FAIL2, compositionId: "NewsletterVideo", error: String(renders.find((r) => r.id === R_FAIL2)?.error_message) })
      const signal = (svc.tables.manager_signals ?? []).find((s) => s.brokerage_id === B && s.signal_type === RENDER_UNPLAYABLE_SIGNAL)
      const fixtureCensus = censusRenderFailures(renders.filter((r) => r.render_status === "failed").map((r) => ({ id: String(r.id), composition_id: String(r.composition_id), error_message: r.error_message == null ? null : String(r.error_message), retry_count: Number(r.retry_count) })))
      const buckets = Object.values(fixtureCensus.byBucket)
      const coordinator = strippedRepo("lib/remotion/render-coordinator.ts") ?? "", tick = strippedRepo("app/api/cron/composition-render-queue/route.ts") ?? ""
      c.step(`${h.lane} landed (${at}) — PLAYABLE OUTPUT: the pure container probe refuses an EMPTY object (0 bytes), bytes that are no container, an MP4 with no moov, one whose mvhd duration is 0 and a TRUNCATED file (a box past EOF), and accepts a real ftyp + moov(mvhd 5 s) + mdat (duration 5, container mp4); a non-video type (PNG) is skipped, not judged; THE HOST (hostRenderedMedia — the one host every finished render goes through) REFUSES the unplayable bytes BEFORE storage ('${UNPLAYABLE_OUTPUT_TOKEN}' — 0 storage calls) so no URL ever exists for a 'succeeded' stamp, while the playable bytes reach storage (refused here only by the canary's storage stub); the refusal classifies as unplayable_output and ESCALATES to the Asset Manager in the same request (render_unplayable_escalated from cron_manager — the registered owner, before any cron); an ffmpeg decode failure does NOT escalate (the bounded retry + the OS-health sweep own it); the census folds the fixture's failed rows into one bucket (2, retries exhausted 1) with a root cause + fix per signature; the coordinator's catch stamps failed → escalates, the queue tick carries the census`, !empty.ok && /0 bytes/.test(empty.reasons.join()) && !junk.ok && !missingMoov.ok && /moov/i.test(missingMoov.reasons.join()) && !zero.ok && /duration/i.test(zero.reasons.join()) && !cut.ok && ok.ok && ok.container === "mp4" && ok.durationSeconds === 5 && ok.mp4?.hasMoov === true && ok.mp4?.hasMdat === true && ok.mp4?.firstBox === "ftyp" && png.ok && png.container === "not_video" && refused.includes(UNPLAYABLE_OUTPUT_TOKEN) && /\[media-host\] refusing/.test(refused) && storageBeforeGood === 0 && storageCalls.length === 1 && !reachedStorage.includes(UNPLAYABLE_OUTPUT_TOKEN) && describeUnplayable(missingMoov).includes(UNPLAYABLE_OUTPUT_TOKEN) && unplayable.bucket === "unplayable_output" && escalated.escalated && escalated.bucket === "unplayable_output" && !!signal && signal.to_manager === "asset_manager" && signal.from_manager === "cron_manager" && signal.entity_id === R_FAIL && !notUnplayable.escalated && notUnplayable.bucket !== "unplayable_output" && fixtureCensus.total === 2 && buckets.length === 1 && buckets[0].count === 2 && buckets[0].retryExhausted === 1 && describeRenderFailureCensus(fixtureCensus).length === 1 && RENDER_FAILURE_SIGNATURES.every((s) => s.rootCause && s.evidence && s.fix) && /escalateRenderFailure\(/.test(coordinator) && /["']failed["']/.test(coordinator) && /censusRenderFailures\(/.test(tick), `probe ok ${ok.durationSeconds}s; refused: ${refused.slice(0, 100)}; storage calls ${storageCalls.length}; decode bucket ${notUnplayable.bucket}`)
      continue
    }
    if (/LANDING/.test(h.contract)) {
      const { renderToStaticMarkup } = await import("react-dom/server")
      const { createElement } = await import("react")
      const { LandingVideo } = await import("../../app/components/public-site/LandingVideo")
      const missing = renderToStaticMarkup(createElement(LandingVideo, { src: null, poster: "https://m.test/poster.png", title: "Canary reel", fallbackHref: "/v/canary" }))
      const noPoster = renderToStaticMarkup(createElement(LandingVideo, { src: "", title: "Canary reel" }))
      const playable = renderToStaticMarkup(createElement(LandingVideo, { src: "https://m.test/reel.mp4", poster: "https://m.test/poster.png", title: "Canary reel" }))
      const slotSrc = strippedRepo("app/components/public-site/LandingVideo.tsx") ?? "", siteSrc = strippedRepo("app/site/[slug]/page.tsx") ?? "", listingSrc = strippedRepo("app/listings/[listingId]/page.tsx") ?? ""
      // The PUBLIC landing surfaces (the owner's "landing page"): the lm / site / listing pages and the public-site components.
      // The reel's OWN page (app/v/[slug] — the slot's fallback target) is the player, not a landing page; internal UIs (the
      // avatar widget, the education editor, the studio) keep their own players. Both are published as residues, not counted.
      const PUBLIC_SURFACES = ["app/lm", "app/site", "app/listings", "app/listing", "app/components/public-site", "app/components/listings"]
      const rawVideoTags = listFiles("app", (f) => /\.tsx$/.test(f) && PUBLIC_SURFACES.some((p) => f.startsWith(`${p}/`))).filter((f) => /<video\b/.test(strippedRepo(f) ?? ""))
      const residues = listFiles("app", (f) => /\.tsx$/.test(f) && !PUBLIC_SURFACES.some((p) => f.startsWith(`${p}/`))).filter((f) => /<video\b/.test(strippedRepo(f) ?? ""))
      console.log(`    census: bare <video> outside the landing surfaces (not counted) — ${residues.join(", ") || "none"}; the reel page app/v/[slug]/video-player.tsx is the slot's fallback target and carries its own player (lane 142F / integrator: a broken file breaks there too)`)
      c.step(`${h.lane} landed (${at}) — LANDING VIDEO SLOT, rendered: the ONE slot (LandingVideo) with NO source renders the poster fallback (the poster image, a 'not available' line and the reel's own page link) — never a <video> with an empty src; with no poster a quiet still carries the title; with a real source it renders <video controls> with the poster and NO autoplay, and swaps to the fallback on the player's error (onError → the fallback branch, in source); mounted on /lm/[slug] (asserted above), /site/[slug] (pickSiteHeroVideo — the newest published public reel, its YouTube copy as the fallback link) and /listings/[listingId]; the PUBLIC landing surfaces carry NO other bare <video> tag`, /data-landing-video-fallback="true"/.test(missing) && /<img[^>]*poster\.png/.test(missing) && /not available to play/.test(missing) && /href="\/v\/canary"/.test(missing) && !/<video/.test(missing) && /data-landing-video-fallback/.test(noPoster) && /Canary reel/.test(noPoster) && !/<video/.test(noPoster) && /<video[^>]*controls/.test(playable) && /data-landing-video="true"/.test(playable) && /poster="https:\/\/m\.test\/poster\.png"/.test(playable) && !/autoplay/i.test(playable) && /onError/.test(slotSrc) && /<LandingVideo\b/.test(siteSrc) && /pickSiteHeroVideo\(/.test(siteSrc) && /youtubeUrl/.test(siteSrc) && /<LandingVideo\b/.test(listingSrc) && rawVideoTags.length === 1 && rawVideoTags[0] === "app/components/public-site/LandingVideo.tsx", `raw <video> files: ${rawVideoTags.join(",") || "none"}`)
      continue
    }
    const { classifyPublicVideo, readVideoAutoPublishPolicy, PUBLIC_MARKETING_VIDEO_TYPES, DEFAULT_VIDEO_AUTO_PUBLISH_POLICY } = await import("../../lib/video/public-video")
    const { queueYouTubeAutoPublish, recordYouTubePublishOnAsset, youtubeAutoPublishBrief } = await import("../../lib/video/youtube-publish")
    const promoRow = (svc.tables.ai_video_projects ?? []).find((p) => p.id === PROMO) as Record<string, unknown>, thanksRow = (svc.tables.ai_video_projects ?? []).find((p) => p.id === THANKS) as Record<string, unknown>
    const promoV = classifyPublicVideo(promoRow), thanksV = classifyPublicVideo(thanksRow)
    const reasonOf = (over: Record<string, unknown>) => { const v = classifyPublicVideo({ ...promoRow, ...over }); return v.public ? "public" : v.reason }
    const policyDefault = await readVideoAutoPublishPolicy(svc, B)
    const policyRefused = await readVideoAutoPublishPolicy(canaryClient({}, { refuse: { brokerage_settings: "canary: brokerage_settings refused" } }), B)
    const q1 = await queueYouTubeAutoPublish(svc, PROMO), q2 = await queueYouTubeAutoPublish(svc, PROMO), qThanks = await queueYouTubeAutoPublish(svc, THANKS)
    const postId = q1.queued ? q1.socialPostId : ""
    const post = (svc.tables.social_posts ?? []).find((p) => p.id === postId)
    const promo = () => (svc.tables.ai_video_projects ?? []).find((p) => p.id === PROMO)
    const switchRow = { id: uuid(), brokerage_id: B, settings: { video_auto_publish: { youtube: false } }, created_at: nowIso() }
    ;(svc.tables.brokerage_settings ??= []).push(switchRow)
    const qOff = await queueYouTubeAutoPublish(svc, PROMO2)
    svc.tables.brokerage_settings = (svc.tables.brokerage_settings ?? []).filter((r) => r.id !== switchRow.id)
    const recorded = await recordYouTubePublishOnAsset(svc, { id: postId, brokerage_id: B, platform: "youtube", external_post_id: "yt_canary123", media_urls: [PROMO_URL], post_brief: String(post?.post_brief ?? "") })
    const publisherSrc = strippedRepo("lib/social/publisher.ts") ?? "", cron = strippedRepo("app/api/cron/publish-social-posts/route.ts") ?? "", aggregator = strippedRepo("lib/kernel/approval-queue-aggregator.ts") ?? ""
    c.step(`${h.lane} landed (${at}) — YOUTUBE for NON-PERSONAL videos: the ONE classification (classifyPublicVideo) admits a finished, compliance-passed, APPROVED listing promo as public and refuses BY NAME a thank-you (personal kind), a video addressed to a contact, an in-house audience, the MLS cut and an unapproved cut; the tenant switch defaults ON and an UNREADABLE settings row refuses (never a broadcast on a guess); queueing stages ONE approved social_posts row on the EXISTING YouTube rail (platform youtube, status scheduled, the agent's users.id resolved through agents, idempotent on the brief key — a second queue is alreadyQueued, still one row) and stamps the decision on the asset (privacy from the classification, the rule, the policy key); the personal video is never queued; the tenant switch off refuses; the publish WRITE-BACK records the YouTube id + url on the project (completed → published) AND on the library asset carrying the same file; the publisher's privacy is a PARAMETER (the literal is gone) and the queue runs after HUMAN approval (approval-queue-aggregator) with the write-back on the cron's success branches`, promoV.public && (promoV.public && promoV.privacy === "public") && !thanksV.public && reasonOf({ video_type: "thank_you" }) === "personal_or_client_kind" && reasonOf({ contact_id: CONTACT }) === "addressed_to_a_contact" && reasonOf({ audience_type: "in_house" }) === "in_house_audience" && reasonOf({ usage_intent: "mls" }) === "mls_only_cut" && reasonOf({ approval_status: "pending" }) === "not_approved" && !(PUBLIC_MARKETING_VIDEO_TYPES as readonly string[]).includes("thank_you") && DEFAULT_VIDEO_AUTO_PUBLISH_POLICY.youtube && policyDefault.youtube && policyDefault.readable && !policyRefused.youtube && !policyRefused.readable && q1.queued && !q1.alreadyQueued && q2.queued && q2.alreadyQueued && q2.socialPostId === postId && (svc.tables.social_posts ?? []).filter((p) => p.platform === "youtube").length === 1 && post?.status === "scheduled" && post?.approval_status === "approved" && post?.user_id === AG_U && post?.social_account_id === ACC && post?.post_brief === youtubeAutoPublishBrief(PROMO) && promo()?.video_metadata?.youtube?.privacy === "public" && promo()?.video_metadata?.youtube?.rule === "auto_publish_after_approval" && !qThanks.queued && /personal_or_client_kind/.test(qThanks.reason) && !qOff.queued && /youtube is off/.test(qOff.reason) && recorded.ok && recorded.projectId === PROMO && recorded.assetsStamped === 1 && promo()?.video_metadata?.youtube?.video_id === "yt_canary123" && /youtu/.test(String(promo()?.video_metadata?.youtube?.url)) && promo()?.status === "published" && (svc.tables.marketing_assets ?? []).find((a) => a.id === ASSET)?.metadata?.youtube?.video_id === "yt_canary123" && /privacyStatus\??:\s*["']public["']\s*\|\s*["']unlisted["']\s*\|\s*["']private["']/.test(publisherSrc) && !/privacyStatus:\s*["']public["']\s*,/.test(publisherSrc) && /queueYouTubeAutoPublish\(/.test(aggregator) && /recordYouTubePublishOnAsset\(/.test(cron), `queued ${q1.queued ? postId.slice(0, 8) : q1.reason}; thanks: ${qThanks.queued ? "QUEUED" : qThanks.reason.slice(0, 60)}; off: ${qOff.queued ? "QUEUED" : "refused"}; write-back ${JSON.stringify(recorded).slice(0, 120)}`)
    // Published beside the rule (lane 142F / integrator): the tenant publish cron hands publishToYouTube NO privacyStatus —
    // the parameter defaults to 'public' (lib/social/publisher.ts:315) — so only the classification gate before queueing keeps a
    // personal video off the channel; a human-drafted YouTube post of a personal video would upload public.
    console.log(`    finding (lane 142F, YouTube privacy): publish-social-posts passes privacyStatus = ${/privacyStatus/.test(cron) ? "yes" : "NO (defaults to 'public' in publisher.ts:315; safe only because queueYouTubeAutoPublish refuses every non-public classification first)"}`)
  }
  c.blind("No render runs (Remotion / chromium / ffmpeg are not reached) — the probe ran on synthetic containers and the host's refusal is the one gate exercised (its storage is the canary's refusing stub); the Lambda / route caps, fonts, codecs and audio sync are lane 142F's investigation from code + the scratchpad notes. The reaper's per-tenant policy ran over 0 rows by design. No YouTube call: the queue row and the write-back are what landed (an upload is public).")
  const cl = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length === 0 && cl.residual === 0, cl.cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cl.cleanup, cl.residual)
}
