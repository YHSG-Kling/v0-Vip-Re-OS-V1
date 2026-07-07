"use server"

// app/actions/marketing/image-library.ts
// ─────────────────────────────────────────────────────────────────────────────
// SHARED IMAGE LIBRARY actions — stock search (creds-gated Pexels), save-to-
// library, and the union list every picker uses (mine + platform-shared).
// Platform-scope writes are gated to platform marketing staff (platformStaffCan);
// tenant writes ride the caller's brokerage. AI images already land on this same
// rail via generate-marketing-image — this adds stock + curation, NOT a second
// generation path.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"
import { searchPexels, validateLibrarySave, type LibraryImage } from "@/lib/marketing/image-library"

async function callerProfile(): Promise<{ userId: string; userType: string | null; platformRole: string | null } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  return { userId: user.id, userType: (data as any)?.user_type ?? null, platformRole: (data as any)?.platform_role ?? null }
}

function isPlatformMarketing(p: { userType: string | null; platformRole: string | null }): boolean {
  return p.userType === "superadmin"
    || platformStaffCan(p.platformRole, "marketing")
    || platformStaffCan(p.userType, "marketing")
}

// ─── Stock search (any authenticated user; creds-gated provider) ─────────────
// TWO-RAIL key resolution: the tenant's own key (platform_credentials — their
// stock license, their use) wins; the platform env key is the fallback.
export async function searchStockImagesAction(query: string): Promise<
  { ok: true; images: LibraryImage[] } | { ok: false; error: string; notConfigured?: boolean }
> {
  const p = await callerProfile()
  if (!p) return { ok: false, error: "Unauthorized" }
  let tenantKey: string | null = null
  const ctx = await getAgentContext().catch(() => null)
  if (ctx?.isAuthenticated && ctx.brokerageId) {
    const { data: cred } = await createServiceClient().from("platform_credentials")
      .select("api_key").eq("brokerage_id", ctx.brokerageId)
      .eq("platform", "pexels").eq("is_active", true).maybeSingle()
    tenantKey = (cred as any)?.api_key ?? null
  }
  return searchPexels(query, 12, tenantKey)
}

// ─── Tenant stock-provider key (Settings → Stock Library) ────────────────────
const TENANT_ADMIN_TYPES = new Set(["broker", "broker_admin", "admin", "superadmin"])

export async function setStockProviderKeyAction(input: { apiKey: string }): Promise<{ ok: boolean; error?: string }> {
  const p = await callerProfile()
  const ctx = await getAgentContext().catch(() => null)
  if (!p || !ctx?.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!TENANT_ADMIN_TYPES.has(p.userType ?? "")) return { ok: false, error: "Forbidden — brokerage admin only" }
  const apiKey = input.apiKey?.trim()
  if (!apiKey || apiKey.length < 10) return { ok: false, error: "That doesn't look like a valid API key" }
  const svc = createServiceClient()
  const { data: existing } = await svc.from("platform_credentials").select("id")
    .eq("brokerage_id", ctx.brokerageId).eq("platform", "pexels").maybeSingle()
  const row = { brokerage_id: ctx.brokerageId, platform: "pexels", api_key: apiKey, is_active: true, updated_at: new Date().toISOString() }
  const { error } = existing
    ? await svc.from("platform_credentials").update(row).eq("id", (existing as any).id)
    : await svc.from("platform_credentials").insert(row)
  return error ? { ok: false, error: error.message } : { ok: true }
}

export async function getStockProviderStatusAction(): Promise<{ ok: boolean; tenantKeySet: boolean; platformKeySet: boolean }> {
  const ctx = await getAgentContext().catch(() => null)
  let tenantKeySet = false
  if (ctx?.isAuthenticated && ctx.brokerageId) {
    const { data } = await createServiceClient().from("platform_credentials").select("id")
      .eq("brokerage_id", ctx.brokerageId).eq("platform", "pexels").eq("is_active", true).maybeSingle()
    tenantKeySet = !!data
  }
  return { ok: true, tenantKeySet, platformKeySet: !!process.env.PEXELS_API_KEY }
}

// ─── Save an image into the library ──────────────────────────────────────────
export async function saveLibraryImageAction(input: {
  name: string
  url: string
  thumbnailUrl?: string
  scope: "platform" | "brokerage"
  alt?: string
  source?: string
  photographer?: string | null
  licenseNote?: string | null
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const p = await callerProfile()
  if (!p) return { ok: false, error: "Unauthorized" }
  const v = validateLibrarySave(input) // enforces the redistribution license line for platform scope
  if (!v.ok) return v

  const svc = createServiceClient()
  let brokerageId: string | null = null
  let visibilityScope = "platform"

  if (v.scope === "platform") {
    if (!isPlatformMarketing(p)) return { ok: false, error: "Forbidden — platform marketing staff only" }
  } else {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
    brokerageId = ctx.brokerageId
    visibilityScope = "brokerage"
  }

  const { data, error } = await svc.from("marketing_assets").insert({
    brokerage_id: brokerageId,
    created_by: p.userId,
    visibility_scope: visibilityScope,
    asset_type: "image",
    asset_name: v.name,
    asset_url: v.url,
    thumbnail_url: input.thumbnailUrl ?? v.url,
    preview_text: (input.alt ?? "").slice(0, 280) || null,
    source_table: "image_library",
    tags: ["library", input.source ?? "unknown"],
    approval_status: "approved",
    metadata: {
      asset_kind: "library_image",
      source: input.source ?? "unknown",
      photographer: input.photographer ?? null,
      license_note: input.licenseNote ?? null,
    },
  }).select("id").single()
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" }
  return { ok: true, id: (data as any).id }
}

// ─── The union list every picker uses: platform-shared + (optionally) mine ────
export interface LibraryAssetRow {
  id: string
  name: string
  url: string
  thumbnailUrl: string | null
  scope: string
  source: string
  photographer: string | null
}

export async function listImageLibraryAction(): Promise<
  { ok: true; assets: LibraryAssetRow[] } | { ok: false; error: string }
> {
  const p = await callerProfile()
  if (!p) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()

  const ctx = await getAgentContext().catch(() => null)
  const brokerageId = ctx?.isAuthenticated ? ctx.brokerageId : null

  let q = svc.from("marketing_assets")
    .select("id, asset_name, asset_url, thumbnail_url, visibility_scope, metadata, brokerage_id")
    .eq("asset_type", "image").eq("approval_status", "approved")
    .order("created_at", { ascending: false }).limit(200)
  q = brokerageId
    ? q.or(`visibility_scope.eq.platform,brokerage_id.eq.${brokerageId}`)
    : q.eq("visibility_scope", "platform")
  const { data, error } = await q
  if (error) return { ok: false, error: error.message }

  return {
    ok: true,
    assets: ((data ?? []) as any[]).map((r) => ({
      id: r.id,
      name: r.asset_name,
      url: r.asset_url,
      thumbnailUrl: r.thumbnail_url ?? null,
      scope: r.visibility_scope,
      source: r.metadata?.source ?? r.metadata?.asset_kind ?? "unknown",
      photographer: r.metadata?.photographer ?? null,
    })),
  }
}

// ─── Remove a library image (own scope only; platform rows need marketing cap) ─
export async function removeLibraryImageAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const p = await callerProfile()
  if (!p) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const { data: row } = await svc.from("marketing_assets")
    .select("id, visibility_scope, brokerage_id").eq("id", id).eq("asset_type", "image").maybeSingle()
  if (!row) return { ok: false, error: "Not found" }

  if ((row as any).visibility_scope === "platform") {
    if (!isPlatformMarketing(p)) return { ok: false, error: "Forbidden — platform marketing staff only" }
  } else {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || ctx.brokerageId !== (row as any).brokerage_id) return { ok: false, error: "Forbidden" }
  }
  const { error } = await svc.from("marketing_assets").delete().eq("id", id)
  return error ? { ok: false, error: error.message } : { ok: true }
}
