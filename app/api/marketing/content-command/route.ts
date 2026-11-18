// app/api/marketing/content-command/route.ts
// THE CONTENT COMMAND CENTER'S ACTION DOOR (wave 154, lane 154G2 — directive G7.3, owner ruling R8).
// ONE CLICK → the EXISTING canonical writer the catalog names (lib/marketing/content-catalog.ts CATALOG_ACTION_WRITERS).
// Why a route and not a server action beside the reader: the writers' graphs (the Command Center decision door alone is 68
// modules) would otherwise land on app/dashboard/marketing/studio/page.tsx, the heaviest app entry (test:proxy-graph-budget,
// 1300). This entry reaches only what the page already reached through the writers; the page keeps the light read.
// Caller: app/dashboard/marketing/studio/components/content-command-center.tsx (same-origin fetch).
// Order: same-origin check → session (tenant, seat, scope from getAgentContext — never the body) → the row RE-READ under
// that session → planContentAction refuses anything not offered right now (a failed render, a mail piece whose QR has no live
// destination, a decision the seat cannot make) → the writer, which applies its own gate as it always has → READBACK.

import { NextResponse, type NextRequest } from "next/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import type { CatalogWriterId, ContentActionInput } from "@/lib/marketing/content-catalog"

export const dynamic = "force-dynamic"

type WriterResult = { ok: boolean; error?: string | null }
const asResult = (r: any): WriterResult => ({ ok: !!(r?.ok ?? r?.success), error: r?.error ?? r?.message ?? null })

/** One entry per canonical writer — the guard holds each module / export equal to CATALOG_ACTION_WRITERS. */
const CATALOG_WRITER_CALLS: Record<Exclude<CatalogWriterId, "route_omnipresence_run">, (a: any, who: { userId: string; brokerageId: string }) => Promise<WriterResult>> = {
  approve_asset: async (a) => asResult(await (await import("@/app/actions/marketing-studio")).approveAsset(a.id)),
  reject_asset: async (a) => asResult(await (await import("@/app/actions/marketing-studio")).rejectAsset(a.id, a.reason ?? undefined)),
  create_topic_asset: async (a) => asResult(await (await import("@/app/actions/marketing-studio")).createAsset({ assetType: a.assetType, assetName: a.assetName, sourceTable: a.sourceTable, sourceId: a.sourceId, previewText: a.previewText })),
  approve_social: async (a) => asResult(await (await import("@/app/actions/social-media-automation")).approveSocialPost(a.id)),
  reject_social: async (a) => asResult(await (await import("@/app/actions/social-media-automation")).rejectSocialPost(a.id, undefined, a.reason ?? "Rejected in the Content Command Center")),
  approve_video: async (a) => asResult(await (await import("@/app/dashboard/marketing/video-staging/actions")).approveStagedVideoAction(a.id)),
  approve_queue: async (a) => asResult(await (await import("@/app/actions/command-center")).approveAgentAction({ queue: a.queue, actionId: a.actionId })),
  reject_queue: async (a) => asResult(await (await import("@/app/actions/command-center")).rejectAgentAction({ queue: a.queue, actionId: a.actionId })),
  publish_blog: async (a, who) => asResult(await (await import("@/app/actions/blog")).publishBlogPost(who.userId, a.postId)),
  publish_podcast: async (a) => asResult(await (await import("@/app/actions/podcast-generation")).publishPodcastEpisode(a.episodeId, a.channels)),
  release_direct_mail: async (a, who) => asResult(await (await import("@/app/actions/direct-mail")).sendCampaign({ campaignId: a.campaignId, actorUserId: who.userId, brokerageId: who.brokerageId })),
  prepare_direct_mail: async (a, who) => asResult(await (await import("@/app/actions/direct-mail")).createMailCampaign({ brokerageId: who.brokerageId, createdBy: who.userId, campaignName: a.campaignName, targetAudience: a.targetAudience, quantity: a.quantity, copyText: a.copyText })),
  render_avatar_clip: async (a) => asResult(await (await import("@/app/actions/custom-video")).createDescribedVideoAction({ audience: a.audience, goal: a.goal, host: a.host, title: a.title, topicId: a.topicId })),
  route_refurbish: async (a) => asResult(await (await import("@/lib/repurpose/actions")).refurbishCompetitorIdea({ competitorContentId: a.competitorContentId, outputFormats: a.outputFormats })),
  route_omnipresence: async (a, who) => {
    const { createRepurposePipeline, executePipeline } = await import("@/lib/repurpose/actions")
    const created = await createRepurposePipeline({ pipelineName: a.pipelineName, sourceType: a.sourceType, sourceId: a.sourceId, outputFormats: a.outputFormats, brokerageId: who.brokerageId })
    if (!created.success || !created.pipelineId) return { ok: false, error: created.error ?? "The repurpose pipeline wasn't created." }
    return asResult(await executePipeline({ pipelineId: created.pipelineId, brokerageId: who.brokerageId, sourceType: a.sourceType, sourceId: a.sourceId }))
  },
  assign_task: async (a) => asResult(await (await import("@/app/actions/tasks")).createTask({ title: a.title, contactId: a.contactId, priority: a.priority })),
  change_qr_destination: async (a) => {
    const { resolveWriteContext } = await import("@/lib/platform/acting-context")
    const ctx = await resolveWriteContext()
    if (!ctx.ok || !ctx.brokerageId) return { ok: false, error: ctx.ok ? "Your workspace couldn't be confirmed. Sign in again." : ctx.error }
    const { editQrDestination } = await import("@/lib/marketing/qr-governance")
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? null
    return asResult(await editQrDestination({ qrCodeId: a.qrCodeId, targetUrl: a.targetUrl, reason: a.reason }, { brokerageId: ctx.brokerageId, userId: ctx.userId, agentId: ctx.agentId ?? null, userType: ctx.userType }, { origin: appUrl, appOrigins: [appUrl] }))
  },
}

/** Same-origin only (a cookie-authenticated POST): the browser's Origin must name this host. No Origin ⇒ refused (fail closed). */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin")
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host")
  if (!origin || !host) return false
  try { return new URL(origin).host === host } catch { return false }
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ success: false, error: "This action can only be started from your workspace." }, { status: 403 })
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) return NextResponse.json({ success: false, error: "Sign in to act on your content." }, { status: 401 })
  let input: ContentActionInput
  try { input = (await req.json()) as ContentActionInput } catch { return NextResponse.json({ success: false, error: "Choose an item first." }, { status: 400 }) }
  if (!input || typeof input.sourceType !== "string" || typeof input.sourceId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.sourceId) || typeof input.action !== "string") {
    return NextResponse.json({ success: false, error: "Choose an item first." }, { status: 400 })
  }
  const [{ createServiceClient }, { resolveCatalogViewer, readContentCatalog, planContentAction }] = await Promise.all([import("@/lib/supabase/service"), import("@/lib/marketing/content-catalog")])
  const db = createServiceClient()
  const viewer = await resolveCatalogViewer(db, { userId: ctx.userId, brokerageId: ctx.brokerageId, userType: ctx.userType || "agent" })
  const before = await readContentCatalog(db, viewer, { sourceType: input.sourceType, sourceId: input.sourceId, perSourceLimit: 1 })
  const plan = planContentAction(before.rows[0] ?? null, input)
  if (!plan.ok) return NextResponse.json({ success: false, error: plan.error }, { status: 409 })
  if (plan.writer === "route_omnipresence_run") return NextResponse.json({ success: false, error: "That action isn't available for this item right now." }, { status: 409 })
  const res = await CATALOG_WRITER_CALLS[plan.writer](plan.args, { userId: viewer.userId, brokerageId: viewer.brokerageId })
  // READBACK: the status shown after the click is the canonical row's, re-read — never the button's optimism.
  const after = await readContentCatalog(db, viewer, { sourceType: input.sourceType, sourceId: input.sourceId, perSourceLimit: 1 })
  return NextResponse.json({ success: res.ok, error: res.ok ? undefined : res.error ?? "That didn't go through.", status: after.rows[0]?.status ?? null, row: after.rows[0] ?? null })
}
