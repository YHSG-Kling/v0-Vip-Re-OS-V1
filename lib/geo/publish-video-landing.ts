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
import { slugifyTitle, isPublishableRender } from "./video-landing"

export interface PublishResult {
  ok:     boolean
  slug?:  string
  reason?: string
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

  return { ok: true, slug }
}
