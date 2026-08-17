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
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

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
  // TRUE ADMIN GATE (operational: marketing clips) — repointed to the ONE tenant
  // roster, asked of the raw user_type (the predicate accepts every legacy input
  // spelling the canonicalizer does). 'superadmin' was dead: 0 live rows store
  // that users.user_type.
  if (input.scope === "brokerage" && !isAdminOrBroker({ user_type: profile.user_type })) {
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

/**
 * Remove a clip from the stock library — only the uploader, or a broker/admin in
 * the SAME brokerage, can remove one.
 *
 * WIRED (w4s1) — `app/dashboard/videos/components/BrollPicker.tsx`. That picker
 * could upload clips (`uploadStockClip`) but nothing could ever remove one, so a
 * mistyped title, a wrong-scope upload, or an unusable take was permanent and kept
 * being offered as a one-click choice in the video wizard.
 *
 * This is a HARD delete. The doc comment used to say "soft delete", which was
 * simply untrue — `video_assets` has no `deleted_at` column (verified live), and
 * the statement below is `.delete()`. Saying "soft" invited a caller to assume the
 * row was recoverable.
 *
 * NOT a duplicate of `app/actions/stock-library.ts:deleteStockAsset`, despite both
 * deleting from `video_assets`. The two lanes use DIFFERENT scope models that both
 * exist on the live table: this one scopes by `created_by` / `agent_id` / `team_id`
 * / `brokerage_id` (what `uploadStockClip` and the BrollPicker write), while
 * `deleteStockAsset` scopes by `scope_type` / `scope_id` (what
 * `registerStockAsset` and the stock-library settings page write). A row written by
 * one lane has NULLs in the other lane's scope columns, so `deleteStockAsset`
 * evaluates every branch of its `canEditScope` to false on a BrollPicker clip and
 * always answers "scope_forbidden". Neither can delete the other's rows; deleting
 * either function would strand its lane's assets permanently.
 */
export async function deleteStockClip(assetId: string): Promise<{ success: boolean; error?: string }> {
  if (!assetId) return { success: false, error: "assetId required" }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  // `error` is destructured deliberately: supabase-js RESOLVES a refused read, and
  // treating a refusal as "clip not found" is only correct because we then refuse.
  // Reported separately so a real failure is not mislabeled as a missing row.
  const { data: clip, error: readErr } = await svc
    .from("video_assets")
    .select("created_by, brokerage_id")
    .eq("id", assetId)
    .maybeSingle()
  if (readErr) return { success: false, error: "Could not verify this clip" }
  if (!clip) return { success: false, error: "Clip not found" }

  const isOwner = clip.created_by === user.id
  let isAdmin = false
  if (!isOwner) {
    const { data: profile } = await svc
      .from("users")
      .select("user_type, brokerage_id")
      .eq("id", user.id)
      .maybeSingle()
    // TRUE ADMIN GATE — same repoint as the upload gate above.
    isAdmin = isAdminOrBroker({ user_type: profile?.user_type }) && profile?.brokerage_id === clip.brokerage_id
  }
  if (!isOwner && !isAdmin) {
    return { success: false, error: "Only the uploader or a broker/admin can delete this clip" }
  }

  const { error } = await svc.from("video_assets").delete().eq("id", assetId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}
