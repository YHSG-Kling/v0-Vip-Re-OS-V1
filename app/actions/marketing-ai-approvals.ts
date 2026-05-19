"use server"

/**
 * Sprint 9 cont. — Unified AI-marketing-content approval queue.
 *
 * lib/kernel/marketing.ts already writes approval_status='pending' on
 * AI-generated newsletter / blog / podcast / direct mail drafts. Migration
 * 1050 added an is_ai_generated flag to those tables. This action lists
 * + approves + rejects across the four asset types so an admin sees
 * one queue regardless of channel.
 *
 * Asset rows are tenant-scoped via brokerage_id (RLS + explicit filter).
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

async function requireAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: row } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!row?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  const userType = row.user_type as string
  if (!ADMIN_ROLES.has(userType)) return { ok: false, error: "Forbidden" }
  return { ok: true, userId: user.id, brokerageId: row.brokerage_id as string, userType }
}

export type AssetKind = "newsletter" | "blog" | "podcast" | "direct_mail" | "video" | "video_script"

export interface PendingAssetRow {
  kind:            AssetKind
  id:              string
  title:           string
  summary:         string | null
  body_preview:    string | null
  created_at:      string
  is_ai_generated: boolean
  /** Only set for video kinds. 'in_house' vs 'customer_facing'
   *  distinguishes the compliance gate level. */
  audience_type?:  "in_house" | "customer_facing" | null
  /** Only set for video kinds. 'did' is the platform primary. */
  video_provider?: "did" | "heygen" | "upload" | null
}

export async function listPendingMarketingAssetsAction(): Promise<
  | { ok: true; rows: PendingAssetRow[] }
  | { ok: false; error: string }
> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const [nl, bl, pc, dm, vp, vs] = await Promise.all([
    svc.from("newsletter_campaigns")
      .select("id, campaign_name, subject_line, content, created_at, is_ai_generated")
      .eq("brokerage_id", auth.brokerageId).eq("approval_status", "pending_review").limit(50),
    svc.from("blog_posts")
      .select("id, title, excerpt, content, created_at, is_ai_generated")
      .eq("brokerage_id", auth.brokerageId).eq("approval_status", "pending_review").limit(50),
    svc.from("podcast_episodes")
      .select("id, title, description, script, created_at, is_ai_generated")
      .eq("brokerage_id", auth.brokerageId).eq("approval_status", "pending_review").limit(50),
    svc.from("direct_mail_campaigns")
      .select("id, campaign_name, copy_text, created_at, is_ai_generated")
      .eq("brokerage_id", auth.brokerageId).eq("approval_status", "pending_review").limit(50),
    // Sprint 9 cont. v2: full-length AI videos
    // ai_video_projects: no `description` column → read video_metadata
    // jsonb. Also surface audience_type ('in_house'|'customer_facing')
    // and video_provider so admin sees compliance-gate level + provider
    // at-a-glance.
    svc.from("ai_video_projects")
      .select("id, title, video_metadata, script_content, created_at, is_ai_generated, audience_type, video_provider, compliance_status")
      .eq("brokerage_id", auth.brokerageId).eq("approval_status", "pending_review").limit(50),
    // Sprint 9 cont. v2: video scripts library
    svc.from("video_scripts_library")
      .select("id, script_title, script_body, brand_voice_tone, created_at, ai_generated")
      .eq("brokerage_id", auth.brokerageId).eq("approval_status", "pending_review").limit(50),
  ])

  const rows: PendingAssetRow[] = []
  for (const r of (nl.data ?? []) as Array<Record<string, unknown>>) {
    rows.push({
      kind: "newsletter", id: r.id as string,
      title: (r.campaign_name as string) ?? "",
      summary: (r.subject_line as string | null) ?? null,
      body_preview: ((r.content as string | null) ?? "").slice(0, 600),
      created_at: r.created_at as string,
      is_ai_generated: !!r.is_ai_generated,
    })
  }
  for (const r of (bl.data ?? []) as Array<Record<string, unknown>>) {
    rows.push({
      kind: "blog", id: r.id as string,
      title: (r.title as string) ?? "",
      summary: (r.excerpt as string | null) ?? null,
      body_preview: ((r.content as string | null) ?? "").slice(0, 600),
      created_at: r.created_at as string,
      is_ai_generated: !!r.is_ai_generated,
    })
  }
  for (const r of (pc.data ?? []) as Array<Record<string, unknown>>) {
    rows.push({
      kind: "podcast", id: r.id as string,
      title: (r.title as string) ?? "",
      summary: (r.description as string | null) ?? null,
      body_preview: ((r.script as string | null) ?? "").slice(0, 600),
      created_at: r.created_at as string,
      is_ai_generated: !!r.is_ai_generated,
    })
  }
  for (const r of (dm.data ?? []) as Array<Record<string, unknown>>) {
    rows.push({
      kind: "direct_mail", id: r.id as string,
      title: (r.campaign_name as string) ?? "",
      summary: null,
      body_preview: ((r.copy_text as string | null) ?? "").slice(0, 600),
      created_at: r.created_at as string,
      is_ai_generated: !!r.is_ai_generated,
    })
  }
  for (const r of (vp.data ?? []) as Array<Record<string, unknown>>) {
    const meta = (r.video_metadata as Record<string, unknown> | null) ?? null
    rows.push({
      kind: "video", id: r.id as string,
      title: (r.title as string) ?? "(untitled video)",
      summary: meta && typeof meta === "object" && "description" in meta
        ? ((meta as { description?: string }).description ?? null)
        : null,
      body_preview: ((r.script_content as string | null) ?? "").slice(0, 600),
      created_at: r.created_at as string,
      is_ai_generated: !!r.is_ai_generated,
      audience_type:  (r.audience_type  as "in_house" | "customer_facing" | null) ?? null,
      video_provider: (r.video_provider as "did" | "heygen" | "upload" | null) ?? null,
    })
  }
  for (const r of (vs.data ?? []) as Array<Record<string, unknown>>) {
    rows.push({
      kind: "video_script", id: r.id as string,
      title: (r.script_title as string) ?? "(untitled script)",
      summary: r.brand_voice_tone ? `Tone: ${r.brand_voice_tone}` : null,
      body_preview: ((r.script_body as string | null) ?? "").slice(0, 600),
      created_at: r.created_at as string,
      is_ai_generated: !!r.ai_generated,
    })
  }

  rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  return { ok: true, rows }
}

const TABLE_BY_KIND: Record<AssetKind, string> = {
  newsletter:    "newsletter_campaigns",
  blog:          "blog_posts",
  podcast:       "podcast_episodes",
  direct_mail:   "direct_mail_campaigns",
  video:         "ai_video_projects",
  video_script:  "video_scripts_library",
}

export async function approveMarketingAssetAction(
  kind: AssetKind, id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const table = TABLE_BY_KIND[kind]
  const { data: row } = await svc.from(table).select("brokerage_id").eq("id", id).maybeSingle()
  if (!row) return { ok: false, error: "Not found" }
  if (row.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden" }

  // Some marketing tables (newsletter_campaigns) don't carry updated_at;
  // keep the update minimal to the column we know exists everywhere.
  const { error } = await svc.from(table)
    .update({ approval_status: "approved" })
    .eq("id", id)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/admin/marketing-approvals")
  return { ok: true }
}

export async function rejectMarketingAssetAction(
  kind: AssetKind, id: string, reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  if (!reason || reason.trim().length < 5) {
    return { ok: false, error: "Rejection reason required (5+ chars)" }
  }

  const svc = createServiceClient()
  const table = TABLE_BY_KIND[kind]
  const { data: row } = await svc.from(table).select("brokerage_id").eq("id", id).maybeSingle()
  if (!row) return { ok: false, error: "Not found" }
  if (row.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden" }

  // rejected_reason exists on direct_mail_campaigns; some tables only have
  // approval_status. Set both defensively — the kernel ignores unknowns.
  const { error } = await svc.from(table)
    .update({
      approval_status: "rejected",
      rejected_reason: reason.trim(),
    })
    .eq("id", id)
  if (error) {
    // Retry without rejected_reason for tables that don't have it
    const { error: retryErr } = await svc.from(table)
      .update({ approval_status: "rejected" })
      .eq("id", id)
    if (retryErr) return { ok: false, error: retryErr.message }
  }

  revalidatePath("/dashboard/admin/marketing-approvals")
  return { ok: true }
}
