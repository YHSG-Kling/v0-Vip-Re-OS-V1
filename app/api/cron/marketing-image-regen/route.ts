/**
 * app/api/cron/marketing-image-regen/route.ts
 *
 * Wave 39 m174 — drains the Asset Manager's image-regeneration queue. When
 * the manager proposes regenerate_asset(kind=image) and the broker
 * approves, the row is flagged marketing_assets.regen_status='requested';
 * this cron re-runs generateImage from the stored metadata.original_prompt
 * and swaps asset_url in place. The image equivalent of the m172
 * composition-render-queue — closes the dead-flag gap where "regenerate
 * this off-brand image" did nothing.
 *
 * One row per tick (image gen + logo composite is ~10-20s). A failure
 * lands regen_status='failed' (NOT retried automatically — the manager
 * decides). Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateImage, type ImagePurpose, type ImageSize } from "@/lib/ai/image-generation"

export const dynamic = "force-dynamic"
export const maxDuration = 120
export const runtime = "nodejs"

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface AssetRow {
  id:            string
  brokerage_id:  string
  agent_user_id: string | null
  asset_name:    string | null
  metadata:      Record<string, unknown> | null
}

export async function GET(req: NextRequest) {
  const headerSecret = req.headers.get("authorization")?.replace("Bearer ", "")
  const querySecret  = new URL(req.url).searchParams.get("secret")
  const expected     = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (headerSecret !== expected && querySecret !== expected) return unauthorized()

  const svc = createServiceClient()

  // Claim one requested row atomically (requested → processing).
  const { data: candidate } = await svc.from("marketing_assets")
    .select("id")
    .eq("regen_status", "requested")
    .order("updated_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  const cand = candidate as { id: string } | null
  if (!cand) return NextResponse.json({ ran_at: new Date().toISOString(), processed: 0 })

  const claim = await svc.from("marketing_assets")
    .update({ regen_status: "processing", updated_at: new Date().toISOString() })
    .eq("id", cand.id)
    .eq("regen_status", "requested")
    .select("id, brokerage_id, agent_user_id, asset_name, metadata")
    .maybeSingle()
  const asset = claim.data as AssetRow | null
  if (!asset) return NextResponse.json({ ran_at: new Date().toISOString(), processed: 0, note: "lost claim race" })

  const meta = asset.metadata ?? {}
  const prompt = String(meta.original_prompt ?? "")
  if (!prompt) {
    await svc.from("marketing_assets").update({ regen_status: "failed" }).eq("id", asset.id)
    return NextResponse.json({ processed: 1, asset_id: asset.id, ok: false, error: "no original_prompt in metadata" }, { status: 200 })
  }

  try {
    // Rebuild brand hints from the tenant so the regen preserves treatment.
    const [{ data: b }, { data: u }] = await Promise.all([
      svc.from("brokerages").select("name, logo_url, brand_primary_color, license_number").eq("id", asset.brokerage_id).maybeSingle(),
      asset.agent_user_id
        ? svc.from("users").select("first_name, last_name").eq("id", asset.agent_user_id).maybeSingle()
        : Promise.resolve({ data: null } as { data: null }),
    ])
    const broker = b as { name: string | null; logo_url: string | null; brand_primary_color: string | null; license_number: string | null } | null
    const usr = u as { first_name: string | null; last_name: string | null } | null
    const isMls = meta.usage_intent === "mls"

    const result = await generateImage({
      prompt,
      purpose: (meta.purpose as ImagePurpose) ?? "social_post",
      size:    (meta.size as ImageSize) ?? "1024x1024",
      brand: {
        brokerageName: broker?.name ?? null,
        primaryColor:  broker?.brand_primary_color ?? null,
        agentName:     usr ? [usr.first_name, usr.last_name].filter(Boolean).join(" ") || null : null,
        logoUrl:       isMls ? null : broker?.logo_url ?? null,
        noLogo:        isMls,
      },
      listingContext: meta.listing_address
        ? { address: String(meta.listing_address) }
        : undefined,
    })

    if (!result.success || !result.imageUrl) {
      await svc.from("marketing_assets").update({ regen_status: "failed" }).eq("id", asset.id)
      return NextResponse.json({ processed: 1, asset_id: asset.id, ok: false, error: result.error ?? "generateImage failed" }, { status: 200 })
    }

    await svc.from("marketing_assets").update({
      asset_url:     result.imageUrl,
      thumbnail_url: result.thumbnailUrl ?? result.imageUrl,
      regen_status:  null,
      updated_at:    new Date().toISOString(),
      metadata: {
        ...meta,
        revised_prompt: result.revisedPrompt,
        regen_count:    (typeof meta.regen_count === "number" ? meta.regen_count : 0) + 1,
        last_regen_at:  new Date().toISOString(),
      },
    }).eq("id", asset.id)

    return NextResponse.json({ ran_at: new Date().toISOString(), processed: 1, asset_id: asset.id, ok: true, image_url: result.imageUrl })
  } catch (e) {
    await svc.from("marketing_assets").update({ regen_status: "failed" }).eq("id", asset.id)
    return NextResponse.json({ processed: 1, asset_id: asset.id, ok: false, error: (e as Error).message }, { status: 500 })
  }
}
