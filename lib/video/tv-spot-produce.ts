// lib/video/tv-spot-produce.ts
//
// MAKE AN APPROVED PUBLIC-MARKETING VIDEO TV-READY AND RECORD WHAT WAS MEASURED (wave 143, lane 143F; owner:
// "videos are also created for TV ads").
//
//   approved public-marketing video (lib/video/public-video.ts classifyPublicVideo — the SAME gate YouTube uses: a TV
//   spot is a broadcast, so a client's / personal / unapproved / in-house video is refused by name)
//     → the script scanned ONCE MORE by the public-copy fair-housing gate (surface video_script; a "55+" claim needs the
//       tenant's verified exemption) — broadcast copy is the most public copy there is
//     → bytes fetched from the project's own hosted file
//     → lib/video/tv-spot-master.ts masterForTv (16:9 only; 1920×1080 / 29.97 / −24 LKFS / ≤ −2 dBTP; never trims duration)
//     → a caption SIDECAR (SRT + WebVTT) from the script (lib/video/caption-plan.ts — real alignment when it exists,
//       else an even-distribution ESTIMATE that is reported as an estimate)
//     → lib/video/tv-spot.ts evaluateTvSpot on the MEASURED mastered file
//     → hosted by the ONE media host (lib/remotion/media-host.ts — which runs the playability probe)
//     → recorded on ai_video_projects.video_metadata.tv_spot (the social master in video_url is untouched), under
//       withActionLedger evidence marketing.video.tv_spot_master, tenant-pinned and COUNTED.
//
// `ready` means every measurable check passed — it is not a promise a station will accept the file. A 17-second reel
// masters fine and reads `ready:false` (duration) with the reason: the platform never silently cuts a spot.
//
// Tenant comes from the caller (the server action resolves it from the SESSION). Every collaborator is a seam so
// scripts/tv-spot-guard.ts drives the whole path on an in-memory database with REAL ffmpeg bytes.

import "server-only"
import { classifyPublicVideo } from "./public-video"
import { buildCaptionPlan } from "./caption-plan"
import { captionCuesToSrt, captionCuesToWebVtt, evaluateTvSpot, TV_SPOT_SPEC, type TvSpotEvaluation, type TvSpotFacts } from "./tv-spot"
import { masterForTv, type TvMasterOutcome } from "./tv-spot-master"

type Svc = { from: (t: string) => any; storage?: unknown }

export interface TvSpotRecord {
  url: string
  spec_version: string
  ready: boolean
  checks: Array<{ id: string; ok: boolean; required: string; measured: string }>
  warnings: string[]
  mastered_at: string
  trim_db: number | null
  captions: { timing: "alignment" | "even" | "none"; srt: string; vtt: string }
  authority: string
}

export interface ProduceTvSpotDeps {
  fetchBytes?: (url: string) => Promise<Buffer>
  master?: (buffer: Buffer) => Promise<TvMasterOutcome>
  host?: (svc: Svc, path: string, bytes: Buffer, contentType: string) => Promise<string>
  /** The tenant's recorded older-persons exemptions (default: loadOlderPersonsVerifications on svc). */
  olderPersons?: Awaited<ReturnType<typeof import("@/lib/compliance/fair-housing-older-persons-store").loadOlderPersonsVerifications>>
  now?: Date
}

const MAX_SOURCE_BYTES = 300 * 1024 * 1024

async function defaultFetch(url: string): Promise<Buffer> {
  if (!/^https:\/\//i.test(url)) throw new Error("the project's video file is not an https URL")
  const res = await fetch(url)
  if (!res.ok) throw new Error(`could not fetch the video file (${res.status})`)
  const len = Number(res.headers.get("content-length") ?? 0)
  if (len > MAX_SOURCE_BYTES) throw new Error(`the video file is ${Math.round(len / 1048576)} MB — over the ${MAX_SOURCE_BYTES / 1048576} MB master limit`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_SOURCE_BYTES) throw new Error("the video file is over the master size limit")
  return buf
}

export type ProduceTvSpotResult =
  | { ok: true; ready: boolean; url: string; evaluation: TvSpotEvaluation; record: TvSpotRecord }
  | { ok: false; error: string }

/** The recorded TV result on a project's video_metadata (null when none). PURE. */
export function tvSpotOf(videoMetadata: unknown): TvSpotRecord | null {
  const t = (videoMetadata as { tv_spot?: unknown } | null | undefined)?.tv_spot
  if (!t || typeof t !== "object") return null
  const r = t as Partial<TvSpotRecord>
  return typeof r.url === "string" && typeof r.ready === "boolean" && Array.isArray(r.checks) ? (r as TvSpotRecord) : null
}

export async function produceTvSpotMaster(
  svc: Svc,
  args: { brokerageId: string; videoId: string; actorUserId: string },
  deps: ProduceTvSpotDeps = {},
): Promise<ProduceTvSpotResult> {
  if (!args.brokerageId || !args.videoId || !args.actorUserId) return { ok: false, error: "Missing tenant, video or actor." }
  const { data: row, error: readErr } = await svc.from("ai_video_projects")
    .select("id, brokerage_id, title, video_type, audience_type, usage_intent, contact_id, learning_module_id, approval_status, status, compliance_status, video_url, script_content, video_metadata")
    .eq("id", args.videoId).eq("brokerage_id", args.brokerageId).maybeSingle()
  if (readErr) return { ok: false, error: `Could not read the video: ${readErr.message}` }
  if (!row) return { ok: false, error: "Video not found for this brokerage." }
  const p = row as { id: string; title: string | null; script_content: string | null; video_url: string | null; video_metadata: Record<string, unknown> | null } & Record<string, unknown>

  // A TV spot is a broadcast: the same classification YouTube rides.
  const verdict = classifyPublicVideo(p as never)
  if (!verdict.public) return { ok: false, error: `Not a public marketing video (${verdict.reason}) — a TV spot is broadcast, so client, personal, unapproved or in-house videos are refused.` }

  // The script is public copy: the fair-housing gate once more (a "55+" claim passes only against a verified exemption).
  const script = (p.script_content ?? "").trim()
  if (script) {
    const { scanPublicCopy } = await import("@/lib/kernel/marketing/public-copy-rewrite")
    const { loadOlderPersonsVerifications } = await import("@/lib/compliance/fair-housing-older-persons-store")
    const olderPersons = deps.olderPersons ?? (await loadOlderPersonsVerifications(svc, args.brokerageId))
    const scan = await scanPublicCopy(script, "video_script", { olderPersons })
    if (!scan.ok) return { ok: false, error: `Fair-housing review: the script still says ${scan.findings.map((f) => `"${f.phrase}"`).join(", ")} — resolve it before a TV master is made.` }
  }

  let source: Buffer
  try { source = await (deps.fetchBytes ?? defaultFetch)(String(p.video_url)) } catch (e) { return { ok: false, error: (e as Error).message } }
  const mastered = await (deps.master ?? masterForTv)(source)
  if (!mastered.ok) return { ok: false, error: mastered.error }

  // Captions: a sidecar from the script. Alignment is not stored on the project, so the timing is an honest ESTIMATE.
  const f = mastered.facts
  const fps = f.fps && f.fps > 0 ? f.fps : 30000 / 1001
  const totalFrames = Math.round((f.durationSeconds ?? 0) * fps)
  const plan = script && totalFrames > 0 ? buildCaptionPlan(script, totalFrames, fps, { maxWordsPerCue: 6 }) : { cues: [], timingSource: "empty" as const }
  const timing: TvSpotFacts["captions"]["timing"] = plan.cues.length === 0 ? "none" : plan.timingSource === "alignment" ? "alignment" : "even"
  const srt = captionCuesToSrt(plan.cues, fps), vtt = captionCuesToWebVtt(plan.cues, fps)
  const evaluation = evaluateTvSpot({ ...f, captions: { present: plan.cues.length > 0, timing } })

  const host = deps.host ?? (async (s: Svc, path: string, bytes: Buffer, contentType: string) => (await import("@/lib/remotion/media-host")).hostRenderedMedia(s, path, bytes, contentType))
  let url: string
  try { url = await host(svc, `${args.brokerageId}/tv-spots/${args.videoId}.mp4`, mastered.buffer, "video/mp4") } catch (e) { return { ok: false, error: (e as Error).message } }

  const now = (deps.now ?? new Date()).toISOString()
  const record: TvSpotRecord = {
    url, spec_version: TV_SPOT_SPEC.version, ready: evaluation.ready,
    checks: evaluation.checks.map((c) => ({ id: c.id, ok: c.ok, required: c.required, measured: c.measured })),
    warnings: evaluation.warnings, mastered_at: now, trim_db: mastered.trimDb,
    captions: { timing, srt, vtt }, authority: TV_SPOT_SPEC.authority,
  }
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const stamped = await withActionLedger<{ ok: true } | { ok: false; error: string }>(
    {
      brokerageId: args.brokerageId,
      action: "marketing.video.tv_spot_master",
      actor: { type: "user", userId: args.actorUserId },
      subject: { type: "ai_video_project", id: args.videoId },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `human request: TV master of video ${args.videoId} (${evaluation.ready ? "ready" : `not ready: ${evaluation.failed.map((c) => c.id).join(", ")}`})`,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "video_tv_spot",
      detail: { spec_version: TV_SPOT_SPEC.version, ready: evaluation.ready, failed: evaluation.failed.map((c) => c.id), url },
    },
    async () => {
      const { data, error } = await svc.from("ai_video_projects")
        .update({ video_metadata: { ...(p.video_metadata ?? {}), tv_spot: record }, updated_at: now })
        .eq("id", args.videoId).eq("brokerage_id", args.brokerageId).select("id")
      if (error) return { ok: false as const, error: `Could not record the TV master: ${error.message}` }
      if ((data ?? []).length !== 1) return { ok: false as const, error: "Could not record the TV master: no row matched this brokerage + id." }
      return { ok: true as const }
    },
    {
      settle: (r) => r.ok ? { status: "executed", outcome: evaluation.ready ? "ready" : "not_ready", providerRef: url } : { status: "failed", outcome: "stamp_refused", error: r.error },
      replay: (claim) => ({ ok: false as const, error: `ledger refused the TV master record: ${claim.kind}` }),
    },
    { client: svc as never },
  )
  if (!stamped.ok) return { ok: false, error: stamped.error }
  return { ok: true, ready: evaluation.ready, url, evaluation, record }
}
