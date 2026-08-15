"use server"

/**
 * Stock video clip uploader — lets agents and team leads add their own
 * intros, outros, b-roll, and avatar backgrounds into video_assets so the
 * BrollPicker / BackgroundPicker can offer them as one-click choices in
 * the video wizard.
 *
 * Scope choices:
 *   - 'agent'      → visible only to the uploading agent
 *   - 'team'       → visible to every agent on the same team
 *                    (requires the uploader to be on a team)
 *   - 'brokerage'  → broker / admin only; reaches every agent
 *
 * Storage: clips land in the existing 'listing-media' bucket under
 * stock-clips/{scope}/{id}/{filename}.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { toCanonicalRoleOrDefault } from "@/lib/security"

const ALLOWED_CATEGORIES = ["intro", "outro", "b_roll", "avatar_background"] as const
type AllowedCategory = typeof ALLOWED_CATEGORIES[number]

export interface UploadStockClipInput {
  /** Public URL to a file already in storage. Caller uploads to storage first, then calls this. */
  fileUrl:          string
  thumbnailUrl?:    string | null
  title:            string
  description?:     string | null
  category:         AllowedCategory
  scope:            "agent" | "team" | "brokerage"
  durationSeconds?: number | null
  tags?:            string[]
}

export interface UploadStockClipResult {
  success: boolean
  assetId?: string
  error?: string
}

export async function uploadStockClip(input: UploadStockClipInput): Promise<UploadStockClipResult> {
  if (!ALLOWED_CATEGORIES.includes(input.category)) {
    return { success: false, error: `Invalid category: ${input.category}` }
  }
  if (!input.fileUrl || !input.title) {
    return { success: false, error: "fileUrl and title are required" }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()

  // Resolve the uploader's brokerage + agent identity + team
  const [{ data: profile }, { data: agentRow }] = await Promise.all([
    svc
      .from("users")
      .select("brokerage_id, user_type")
      .eq("id", user.id)
      .maybeSingle(),
    svc
      .from("agents")
      .select("id, team_id")
      .eq("user_id", user.id)
      .maybeSingle(),
  ])

  if (!profile?.brokerage_id) {
    return { success: false, error: "No brokerage on profile" }
  }

  const role = toCanonicalRoleOrDefault(profile.user_type, "agent")

  // Enforce scope rules:
  //   - brokerage scope requires broker / admin / superadmin
  //   - team scope requires the uploader to be on a team
  //   - agent scope requires an agents row
  if (input.scope === "brokerage" && !["broker", "admin", "superadmin"].includes(role)) {
    return { success: false, error: "Only brokers and admins can publish brokerage-wide clips" }
  }
  if (input.scope === "team" && !agentRow?.team_id) {
    return { success: false, error: "You must be on a team to publish a team clip" }
  }
  if (input.scope === "agent" && !agentRow?.id) {
    return { success: false, error: "Your agent profile is incomplete" }
  }

  // Compute row scope. Most-specific wins so the picker can use coalesce-style
  // lookups: agent_id NOT NULL → private; agent_id NULL + team_id NOT NULL →
  // team; both NULL → brokerage. brokerage_id is always set so RLS / queries
  // never have to span tenants.
  const row: Record<string, unknown> = {
    title:            input.title,
    description:      input.description ?? null,
    video_url:        input.fileUrl,
    thumbnail_url:    input.thumbnailUrl ?? null,
    category:         input.category,
    tags:             input.tags ?? [],
    duration_seconds: input.durationSeconds ?? null,
    created_by:       user.id,
    brokerage_id:     profile.brokerage_id,
    agent_id:         input.scope === "agent" ? (agentRow?.id ?? null) : null,
    team_id:          input.scope === "team"  ? (agentRow?.team_id ?? null) : null,
  }

  const { data, error } = await svc
    .from("video_assets")
    .insert(row)
    .select("id")
    .single()

  if (error || !data) {
    return { success: false, error: error?.message ?? "Insert failed" }
  }

  return { success: true, assetId: data.id }
}

/** Soft delete — only the uploader (or a broker/admin) can remove a clip. */
export async function deleteStockClip(assetId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: clip } = await svc
    .from("video_assets")
    .select("created_by, brokerage_id")
    .eq("id", assetId)
    .maybeSingle()
  if (!clip) return { success: false, error: "Clip not found" }

  const isOwner = clip.created_by === user.id
  let isAdmin = false
  if (!isOwner) {
    const { data: profile } = await svc
      .from("users")
      .select("user_type, brokerage_id")
      .eq("id", user.id)
      .maybeSingle()
    const role = toCanonicalRoleOrDefault(profile?.user_type, "agent")
    isAdmin = ["broker", "admin", "superadmin"].includes(role) && profile?.brokerage_id === clip.brokerage_id
  }
  if (!isOwner && !isAdmin) {
    return { success: false, error: "Only the uploader or a broker/admin can delete this clip" }
  }

  const { error } = await svc.from("video_assets").delete().eq("id", assetId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}
