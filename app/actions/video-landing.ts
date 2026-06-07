"use server"

/**
 * app/actions/video-landing.ts
 *
 * Wave 39 GEO — broker/agent-facing publish controls for the public
 * /v/[slug] video pages. Available to EVERY subscriber tier (solo agent,
 * team, brokerage, multi-location) — publishing a render to the web is a
 * tier-universal capability, not a paid add-on. Scope rules:
 *   · brokerage admins (canEditBrokerage) manage every render in the tenant
 *   · agents manage only their OWN renders (agent_user_id = their user id)
 *
 * Publishing mints the slug + flips is_published via the same
 * publishVideoLanding helper the Asset Manager publish_video_page action
 * uses, so the agent-driven path and the agentic path stay identical.
 */
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { createServiceClient } from "@/lib/supabase/service"
import { publishVideoLanding, unpublishVideoLanding } from "@/lib/geo/publish-video-landing"

export interface PublishableRender {
  id:            string
  composition_id: string
  display_name:  string
  output_url:    string | null
  thumbnail_url: string | null
  is_published:  boolean
  public_slug:   string | null
  completed_at:  string | null
  is_own:        boolean
}

/** Tenant + ownership gate shared by every mutation: returns the
 *  brokerageId when the caller may act on `renderId`, else null. */
async function authorizeRender(renderId: string): Promise<{ brokerageId: string } | { error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { error: "Unauthorized" }
  const access = await resolvePolicyScopeAccess()

  const svc = createServiceClient()
  const { data } = await svc.from("remotion_composition_renders")
    .select("brokerage_id, agent_user_id")
    .eq("id", renderId)
    .maybeSingle()
  const row = data as { brokerage_id: string; agent_user_id: string | null } | null
  if (!row) return { error: "Render not found" }
  if (row.brokerage_id !== ctx.brokerageId) return { error: "Forbidden — tenant mismatch" }
  // Agents may only touch their own renders; brokerage admins touch all.
  if (!access.canEditBrokerage && row.agent_user_id !== ctx.userId) {
    return { error: "Forbidden — not your render" }
  }
  return { brokerageId: ctx.brokerageId }
}

export async function publishRenderToWeb(renderId: string): Promise<
  { success: true; slug: string; url: string } | { success: false; error: string }
> {
  const auth = await authorizeRender(renderId)
  if ("error" in auth) return { success: false, error: auth.error }
  const res = await publishVideoLanding({ renderId, brokerageId: auth.brokerageId })
  if (!res.ok || !res.slug) return { success: false, error: res.reason ?? "Publish failed" }
  revalidatePath("/dashboard/marketing/video-pages")
  revalidatePath(`/v/${res.slug}`)
  return { success: true, slug: res.slug, url: `/v/${res.slug}` }
}

export async function unpublishRenderFromWeb(renderId: string): Promise<
  { success: true } | { success: false; error: string }
> {
  const auth = await authorizeRender(renderId)
  if ("error" in auth) return { success: false, error: auth.error }
  const res = await unpublishVideoLanding({ renderId, brokerageId: auth.brokerageId })
  if (!res.ok) return { success: false, error: res.reason ?? "Unpublish failed" }
  revalidatePath("/dashboard/marketing/video-pages")
  if (res.slug) revalidatePath(`/v/${res.slug}`)
  return { success: true }
}

/** Lists the caller's publishable renders (succeeded + has artifact),
 *  scoped to their visibility. Brokerage admins see the whole tenant;
 *  agents see only their own. */
export async function listPublishableRenders(): Promise<
  { success: true; renders: PublishableRender[] } | { success: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  const access = await resolvePolicyScopeAccess()
  const svc = createServiceClient()

  let q = svc.from("remotion_composition_renders")
    .select("id, composition_id, agent_user_id, output_url, thumbnail_url, is_published, public_slug, completed_at, render_status")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("render_status", "succeeded")
    .not("output_url", "is", null)
    .order("completed_at", { ascending: false })
    .limit(200)
  if (!access.canEditBrokerage) q = q.eq("agent_user_id", ctx.userId)

  const { data, error } = await q
  if (error) return { success: false, error: error.message }
  const rows = (data ?? []) as Array<{
    id: string; composition_id: string; agent_user_id: string | null
    output_url: string | null; thumbnail_url: string | null
    is_published: boolean; public_slug: string | null; completed_at: string | null
  }>

  // Resolve display names from the registry (one fetch, mapped).
  const { listAllCompositions } = await import("@/lib/remotion/registry")
  const comps = await listAllCompositions()
  const nameById = new Map(comps.map((c) => [c.composition_id, c.display_name]))

  const renders: PublishableRender[] = rows.map((r) => ({
    id:            r.id,
    composition_id: r.composition_id,
    display_name:  nameById.get(r.composition_id) ?? r.composition_id,
    output_url:    r.output_url,
    thumbnail_url: r.thumbnail_url,
    is_published:  r.is_published,
    public_slug:   r.public_slug,
    completed_at:  r.completed_at,
    is_own:        r.agent_user_id === ctx.userId,
  }))
  return { success: true, renders }
}
