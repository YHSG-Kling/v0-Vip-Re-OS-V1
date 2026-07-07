"use server"

// app/actions/superadmin/platform-brand.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PLATFORM BRAND KIT + WATCHED-TOPIC POOL. The app's name is still being
// decided, so name/tagline/colors/CTA domain live on the platform_settings
// singleton (product_brand jsonb) — every self-marketing surface resolves through
// it. The topic pool feeds reels/posts with what the market is talking about:
// manual entries + a creds-gated competitor/trend harvest (Tavily; honest
// "not configured" when the key is absent). Marketing-staff-gated + audited.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { resolveProductBrand, loadProductBrand, validateTopic, type ProductBrand } from "@/lib/platform/product-brand"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"

async function requireMarketing(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = (data as any)?.platform_role ?? ((data as any)?.user_type === "superadmin" ? "superadmin" : null)
  if (!platformStaffCan(role, "marketing")) return { ok: false, error: "Forbidden — platform marketing access required" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "" }
}

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient(); const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "platform_brand", target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[platform-brand audit] failed:", err) }
}

export async function getProductBrandAction(): Promise<{ ok: true; brand: ProductBrand } | { ok: false; error: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  return { ok: true, brand: await loadProductBrand(createServiceClient()) }
}

/** Set the platform's own brand — name, tagline, colors, CTA domain (singleton). */
export async function setProductBrandAction(input: Partial<ProductBrand>): Promise<{ ok: true; brand: ProductBrand } | { ok: false; error: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const current = await loadProductBrand(svc)
  const next = resolveProductBrand({ ...current, ...input })
  const { data: row } = await svc.from("platform_settings").select("id").limit(1).maybeSingle()
  const write = row
    ? await svc.from("platform_settings").update({ product_brand: next, updated_at: new Date().toISOString() }).eq("id", (row as any).id)
    : await svc.from("platform_settings").insert({ product_brand: next })
  if (write.error) return { ok: false, error: write.error.message }
  await audit(auth.userId, auth.email, "platform_brand.updated", "singleton", { name: next.name })
  revalidatePath("/dashboard/superadmin/growth"); revalidatePath("/get-started")
  return { ok: true, brand: next }
}

// ── Topic pool ────────────────────────────────────────────────────────────────

export async function listTopicsAction(): Promise<{ ok: true; topics: any[] } | { ok: false; error: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc.from("platform_content_topics")
    .select("id, source, topic, competitor, url, status, created_at")
    .neq("status", "dismissed").order("created_at", { ascending: false }).limit(50)
  if (error) return { ok: false, error: error.message }
  return { ok: true, topics: data ?? [] }
}

export async function addTopicAction(input: { topic: string; source?: string; competitor?: string; url?: string }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const v = validateTopic({ topic: input.topic, source: input.source ?? "manual", competitor: input.competitor, url: input.url })
  if (!v.ok) return { ok: false, error: v.error }
  const svc = createServiceClient()
  const { error } = await svc.from("platform_content_topics").insert(v.value)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true }
}

export async function dismissTopicAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { error } = await svc.from("platform_content_topics").update({ status: "dismissed" }).eq("id", id)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true }
}

/**
 * Harvest competitor/trend topics via the gated external-search rail (Tavily).
 * HONEST: without TAVILY_API_KEY it reports "not configured" — never fabricates
 * topics. Results land as status 'new' candidates for HUMAN curation (dismiss or
 * let the calendar consume them); deduped by topic text.
 */
export async function harvestCompetitorTopicsAction(): Promise<{ ok: true; added: number } | { ok: false; error: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const key = process.env.TAVILY_API_KEY
  if (!key) return { ok: false, error: "External search not configured (TAVILY_API_KEY) — add topics manually or set the key" }

  const svc = createServiceClient()
  let added = 0
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query: "real estate AI software news MoxiWorks Rave OR Lofty OR RealScout OR \"AI real estate platform\"",
        max_results: 6, days: 14, topic: "news",
      }),
    })
    if (!res.ok) return { ok: false, error: `Search failed (${res.status})` }
    const body = await res.json()
    for (const r of (body?.results ?? []).slice(0, 6)) {
      const title = String(r?.title ?? "").trim()
      if (title.length < 8) continue
      const { count } = await svc.from("platform_content_topics").select("id", { count: "exact", head: true }).eq("topic", title.slice(0, 240))
      if ((count ?? 0) > 0) continue
      const { error } = await svc.from("platform_content_topics").insert({
        source: "competitor", topic: title.slice(0, 240), url: String(r?.url ?? "").slice(0, 500) || null, status: "new",
      })
      if (!error) added++
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "harvest failed" }
  }
  await audit(auth.userId, auth.email, "platform_topics.harvested", "tavily", { added })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true, added }
}
