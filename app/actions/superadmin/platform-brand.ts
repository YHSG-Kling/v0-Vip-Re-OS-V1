"use server"

// app/actions/superadmin/platform-brand.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PLATFORM BRAND KIT + WATCHED-TOPIC POOL. The app's name is still being
// decided, so name/tagline/colors/CTA domain live on the platform_settings
// singleton (product_brand jsonb) — every self-marketing surface resolves through
// it. The topic pool feeds reels/posts with what the market is talking about:
// manual entries + a creds-gated competitor/trend harvest (Tavily; honest
// "not configured" when the key is absent). Marketing-staff-gated + audited.

import { createServiceClient } from "@/lib/supabase/service"
// (the next/headers import left with its last reader — nothing in this module reads request headers; the line stays so the file:line references into this module hold)
import { revalidatePath } from "next/cache"
import { resolveProductBrand, loadProductBrand, validateTopic, type ProductBrand } from "@/lib/platform/product-brand"
import { requireMarketing } from "@/lib/auth/platform-guard"

// TOMBSTONE: local requireMarketing merged onto lib/auth/platform-guard.ts
// requireMarketing (imported above) — §1/§6 SAME BODY census round 3,
// 2026-09-09.

// WAVE 155 (lane 155R23 — LAW 5, no tenant): the platform brand and the topic pool belong to NO brokerage, so their record is the
// platform's evidence door (lib/platform/staff-action-gate.ts recordPlatformEvidence → superadmin_audit_log), never an invented
// tenant. FIXED on the way: this helper wrote target_id "singleton" into a uuid column and never read the insert's error, so
// every brand-change audit row was refused and nobody was told; the door files a non-uuid id under details.target_ref and READS
// the refusal.
async function audit(actorUserId: string, actorEmail: string | null | undefined, action: string, targetId: string | null, details: Record<string, unknown>, targetType = "platform_brand") {
  const { recordPlatformEvidence } = await import("@/lib/platform/staff-action-gate")
  return recordPlatformEvidence({ actorUserId, actorEmail: actorEmail ?? null, action, targetType, targetId, details })
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
  // THE POOL ROTATES ON used_at. platform-content.ts stamps used_at when the
  // calendar or a video draft consumes a topic (:63, :123) and nothing read it
  // back, so a consumed topic sat in this list forever and, at limit 50, the
  // oldest used entries eventually crowded out fresh 'new' ones. A used topic
  // now ages out of the list 30 days after it was used; 'new' rows, and used
  // rows from before the column was stamped (used_at IS NULL), are unaffected.
  const usedCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data, error } = await svc.from("platform_content_topics")
    .select("id, source, topic, competitor, url, status, used_at, created_at")
    .neq("status", "dismissed")
    .or(`status.neq.used,used_at.is.null,used_at.gte.${usedCutoff}`)
    .order("created_at", { ascending: false }).limit(50)
  if (error) return { ok: false, error: error.message }
  return { ok: true, topics: data ?? [] }
}

export async function addTopicAction(input: { topic: string; source?: string; competitor?: string; url?: string }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const v = validateTopic({ topic: input.topic, source: input.source ?? "manual", competitor: input.competitor, url: input.url })
  if (!v.ok) return { ok: false, error: v.error }
  const svc = createServiceClient()
  const { data: added, error } = await svc.from("platform_content_topics").insert(v.value).select("id")
  if (error) return { ok: false, error: error.message }
  // LAW 5 (lane 155R23): one platform evidence row after the write — the platform's topic pool has no tenant.
  const topicId = ((added ?? []) as Array<{ id: string }>)[0]?.id ?? null
  await audit(auth.userId, null, "platform_topics.added", topicId, { source: v.value.source ?? "manual", competitor: v.value.competitor ?? null }, "platform_content_topic")
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true }
}

export async function dismissTopicAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  // COUNTED (CLAUDE.md §3, lane 155R23): an UPDATE that matches nothing resolves exactly like one that worked — a wrong or
  // already-gone id used to answer "dismissed". `.select("id")` and count; zero rows is a refusal, not a success.
  const { data: dismissed, error } = await svc.from("platform_content_topics").update({ status: "dismissed" }).eq("id", id).select("id")
  if (error) return { ok: false, error: error.message }
  if (((dismissed ?? []) as unknown[]).length === 0) return { ok: false, error: "That topic was not found — nothing was dismissed." }
  await audit(auth.userId, null, "platform_topics.dismissed", id, {}, "platform_content_topic")
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
    // Wave 139 (139B) — this was a SECOND, raw Tavily client (api_key in the body, no gateway, no
    // outcome row). Merged onto the survivor lib/external/tavily-client.ts tavilySearch (which gained
    // `topic`), so the call leaves through the ONE connector gateway like every other Tavily search.
    const { tavilySearch } = await import("@/lib/external/tavily-client")
    const body = await tavilySearch({
      query: "real estate AI software news MoxiWorks Rave OR Lofty OR RealScout OR \"AI real estate platform\"",
      maxResults: 6, days: 14, topic: "news", includeAnswer: false,
    })
    if (!body.results.length) return { ok: false, error: "Search returned no results (or the search provider refused — see api_response_logs service_key tavily)" }
    for (const r of body.results.slice(0, 6)) {
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
