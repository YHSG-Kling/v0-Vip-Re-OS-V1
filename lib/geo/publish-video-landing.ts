/**
 * lib/geo/publish-video-landing.ts
 *
 * Wave 39 GEO — publishes a successful render as a public /v/[slug] page.
 * Server-side (DB) wrapper around the pure builders in ./video-landing.
 * Invoked by the Asset Manager publish_video_page action (broker-approved)
 * and idempotent: re-publishing an already-published render returns the
 * existing slug.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { getComposition } from "@/lib/remotion/registry"
import { slugifyTitle, isPublishableRender, isAutoPublishEligible } from "./video-landing"
import { mintTrackedQr, normalizeOrigin, type MintedTrackedQr } from "@/lib/marketing/tracked-qr"

export interface PublishResult {
  ok:     boolean
  slug?:  string
  reason?: string
  /** wave 81D: the page's tracked QR (registered in qr_codes); null when the mint was refused. */
  qr?: { qrCodeId: string; slug: string; scanUrl: string } | null
}

/** ONE idempotency key per public video page — the same code rides every
 *  re-publish, so scans accrue to one row (registry: lib/marketing/tracked-qr.ts). */
export function videoLandingQrLabel(rail: "render" | "project", id: string): string {
  return `video_landing:${rail}:${id}`
}

/**
 * THE PAGE'S QR (wave 81D — owner: "automatic video landing pages … " and
 * "any qrcode that gets created for assets are added to the qrcode management").
 * Minted through the ONE minter at publish time: destination landing_page,
 * target the /v/<slug> page, purpose campaign. Never throws — a page still
 * publishes when the registry refuses (the page shows no QR, honestly).
 */
export async function mintVideoLandingQr(args: { rail: "render" | "project"; id: string; brokerageId: string; slug: string; agentId?: string | null; listingId?: string | null }, client?: ReturnType<typeof createServiceClient>): Promise<MintedTrackedQr | null> {
  return mintTrackedQr({
    brokerageId: args.brokerageId,
    agentId: args.agentId ?? null,
    label: videoLandingQrLabel(args.rail, args.id),
    destinationType: "landing_page",
    targetUrl: `${normalizeOrigin()}/v/${args.slug}`,
    listingId: args.listingId ?? null,
    purpose: "campaign",
  }, client)
}

export async function publishVideoLanding(args: {
  renderId:    string
  brokerageId: string
}): Promise<PublishResult> {
  const svc = createServiceClient()

  const { data: render } = await svc.from("remotion_composition_renders")
    .select("id, brokerage_id, composition_id, render_status, output_url, public_slug, is_published")
    .eq("id", args.renderId)
    .eq("brokerage_id", args.brokerageId)
    .maybeSingle()
  const r = render as {
    id: string; brokerage_id: string; composition_id: string;
    render_status: string; output_url: string | null;
    public_slug: string | null; is_published: boolean
  } | null
  if (!r) return { ok: false, reason: "render not found or tenant mismatch" }

  // Idempotent — already public.
  if (r.is_published && r.public_slug) return { ok: true, slug: r.public_slug }

  const composition = await getComposition(r.composition_id)
  if (!composition) return { ok: false, reason: "composition_not_registered" }

  if (!isPublishableRender({
    renderStatus: r.render_status,
    outputUrl:    r.output_url,
    category:     composition.category,
  })) {
    return { ok: false, reason: `render not publishable (status=${r.render_status}, category=${composition.category})` }
  }

  const slug = slugifyTitle(composition.seo_title, composition.display_name, r.id)

  const { error } = await svc.from("remotion_composition_renders")
    .update({
      public_slug:  slug,
      is_published: true,
      published_at: new Date().toISOString(),
    })
    .eq("id", r.id)
    .eq("brokerage_id", args.brokerageId)
  if (error) return { ok: false, reason: error.message }

  const qr = await mintVideoLandingQr({ rail: "render", id: r.id, brokerageId: args.brokerageId, slug }, svc)
  return { ok: true, slug, qr: qr ? { qrCodeId: qr.qrCodeId, slug: qr.slug, scanUrl: qr.scanUrl } : null }
}

/**
 * AUTO-PUBLISH a canonical ai_video_projects reel as a public /v/[slug] page.
 *
 * ai_video_projects is the canonical reel record carrying compliance_status +
 * approval_status (remotion_composition_renders carries neither). This is the
 * publish path the auto-publish sweep uses: it enforces the SAME gate the manual
 * Asset Manager publish_video_page enforces on a render, but sourced from the
 * reel's own compliance/approval columns —
 *   status='completed' + compliance_status='passed' + approval_status='approved'
 * so ONLY a finished, compliant, broker-approved reel ever becomes public
 * (a public page is broadcast advertising carrying Fair-Housing / EHO / license
 * disclosures). Idempotent per reel: an already-published reel returns its slug;
 * the public_slug is minted once and reused (link stability).
 *
 * Always tenant-scoped by brokerage_id. Reuses the same slugifyTitle the render
 * path uses, so both publish rails produce identical, stable, human/AI-readable
 * slugs.
 */
export async function publishVideoProjectLanding(args: {
  projectId:   string
  brokerageId: string
}): Promise<PublishResult> {
  const svc = createServiceClient()

  const { data: project } = await svc.from("ai_video_projects")
    .select("id, brokerage_id, agent_id, listing_id, title, video_type, status, compliance_status, approval_status, video_url, public_slug, is_published")
    .eq("id", args.projectId)
    .eq("brokerage_id", args.brokerageId)
    .maybeSingle()
  const p = project as {
    id: string; brokerage_id: string; agent_id: string | null; listing_id: string | null; title: string | null; video_type: string | null;
    status: string; compliance_status: string; approval_status: string;
    video_url: string | null; public_slug: string | null; is_published: boolean
  } | null
  if (!p) return { ok: false, reason: "reel not found or tenant mismatch" }

  // Idempotent — already public.
  if (p.is_published && p.public_slug) return { ok: true, slug: p.public_slug }

  // The gate — finished + compliance-passed + broker-approved + has artifact.
  if (!isAutoPublishEligible({
    status:           p.status,
    complianceStatus: p.compliance_status,
    approvalStatus:   p.approval_status,
    videoUrl:         p.video_url,
    isPublished:      p.is_published,
  })) {
    return {
      ok: false,
      reason: `reel not auto-publishable (status=${p.status}, compliance=${p.compliance_status}, approval=${p.approval_status})`,
    }
  }

  const slug = slugifyTitle(p.title, p.video_type ?? "reel", p.id)

  const { error } = await svc.from("ai_video_projects")
    .update({
      public_slug:  slug,
      is_published: true,
      published_at: new Date().toISOString(),
    })
    .eq("id", p.id)
    .eq("brokerage_id", args.brokerageId)
    .eq("is_published", false)   // fence: never double-publish under a race
  if (error) return { ok: false, reason: error.message }

  // ai_video_projects.agent_id is agents-class (m366) — exactly what qr_codes.agent_id FKs.
  const qr = await mintVideoLandingQr({ rail: "project", id: p.id, brokerageId: args.brokerageId, slug, agentId: p.agent_id, listingId: p.listing_id }, svc)
  return { ok: true, slug, qr: qr ? { qrCodeId: qr.qrCodeId, slug: qr.slug, scanUrl: qr.scanUrl } : null }
}

/** Unpublish — hide the public page. Keeps public_slug so a later
 *  re-publish reuses the same URL (link stability). The /v page query
 *  filters on is_published, so the page 404s while hidden. */
export async function unpublishVideoLanding(args: {
  renderId:    string
  brokerageId: string
}): Promise<PublishResult> {
  const svc = createServiceClient()
  const { data, error } = await svc.from("remotion_composition_renders")
    .update({ is_published: false })
    .eq("id", args.renderId)
    .eq("brokerage_id", args.brokerageId)
    .select("public_slug")
    .maybeSingle()
  if (error) return { ok: false, reason: error.message }
  if (!data) return { ok: false, reason: "render not found or tenant mismatch" }
  return { ok: true, slug: (data as { public_slug: string | null }).public_slug ?? undefined }
}
