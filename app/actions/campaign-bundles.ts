"use server"

/**
 * app/actions/campaign-bundles.ts
 *
 * Wave 38 — CRUD for campaign_bundles + campaign_bundle_items.
 *
 * A bundle is an ordered list of (channel, preset) items the bundle
 * dispatcher fires as ONE coordinated multi-channel send. The compliance
 * gate fires per-preset at preset-save time, NOT per bundle — bundles
 * are pure composition of already-cleared presets.
 *
 * Tier scope mirrors the direct-mail-presets action: an agent sees their
 * own + their team's + their brokerage's bundles; team leads see team +
 * brokerage; broker-admins see all three tiers. Writes are gated on
 * resolvePolicyScopeAccess matching the target scope.
 *
 * `listAvailablePresets()` returns every preset across the 8 preset
 * tables (direct_mail_presets covers postcard + letter) the caller can
 * read, keyed by channel kind. The bundle builder UI uses that to fill
 * the per-item picker without N round-trips.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePolicyScopeAccess, type PolicyScopeAccess, type PolicyScopeTier } from "@/lib/identity/policy-scope"
import { revalidatePath } from "next/cache"

export type BundleChannel =
  | "direct_mail_postcard"
  | "direct_mail_letter"
  | "email"
  | "sms"
  | "voicedrop"
  | "social_post"
  | "podcast_episode"
  | "ad_retarget"
  | "portal_push"

export interface BundleItemRow {
  id:                 string
  bundle_id:          string
  channel:            BundleChannel
  preset_id:          string | null
  order_index:        number
  send_after_minutes: number
}

export interface BundlePerformance {
  /** Total campaign_bundle_dispatches rows for this bundle (lifetime). */
  dispatch_count:      number
  /** Sum(scans_count) across every dispatch — proxy for total
   *  attributable engagement events (QR scans, email opens/clicks,
   *  inbound replies, social engagements, etc.). */
  total_scans:         number
  /** Sum(leads_count) across every dispatch. */
  total_leads:         number
  /** ISO timestamp of the most recent dispatch, or null if never sent. */
  last_dispatched_at:  string | null
}

export interface BundleRow {
  id:           string
  name:         string
  description:  string | null
  /** Was an inline `"agent" | "team" | "brokerage"` copy (×5 in this file, §6) — now the
   *  canonical PolicyScopeTier from lib/identity/policy-scope.ts, whose resolver already
   *  gates every write here. */
  scope_type:   PolicyScopeTier
  scope_id:     string
  is_active:    boolean
  created_at:   string
  items:        BundleItemRow[]
  /** Aggregate dispatch performance (lifetime). Updated daily by the
   *  bundle-attribution-rollup cron. Zero when the bundle has never
   *  fired. */
  performance:  BundlePerformance
}

export interface PresetOption {
  id:         string
  name:       string
  scope_type: PolicyScopeTier
  scope_id:   string
  /** Channel-specific summary the builder UI shows in the picker. */
  summary:    string
}

export interface PresetCatalog {
  direct_mail_postcard: PresetOption[]
  direct_mail_letter:   PresetOption[]
  email:                PresetOption[]
  sms:                  PresetOption[]
  voicedrop:            PresetOption[]
  social_post:          PresetOption[]
  podcast_episode:      PresetOption[]
  ad_retarget:          PresetOption[]
  portal_push:          PresetOption[]
}

/** Build the `or(...)` PostgREST clause for every (scope_type, scope_id)
 *  tuple the caller can read. Mirrors direct-mail-presets so the picker
 *  shows the same set the rest of the OS does. */
function buildScopeFilters(access: PolicyScopeAccess): string[] {
  const filters: string[] = []
  if (access.canEditAgent && access.agentScopeId) {
    filters.push(`and(scope_type.eq.agent,scope_id.eq.${access.agentScopeId})`)
  }
  for (const teamId of access.teamScopeIds) {
    filters.push(`and(scope_type.eq.team,scope_id.eq.${teamId})`)
  }
  if (access.canEditBrokerage && access.brokerageScopeId) {
    filters.push(`and(scope_type.eq.brokerage,scope_id.eq.${access.brokerageScopeId})`)
  }
  return filters
}

export async function listCampaignBundles(): Promise<
  | { success: true; bundles: BundleRow[] }
  | { success: false; error: string }
> {
  const access = await resolvePolicyScopeAccess()
  if (!access.brokerageScopeId && !access.canEditAgent && !access.canEditTeam) {
    return { success: false, error: "No scope available" }
  }
  const scopeFilters = buildScopeFilters(access)
  if (scopeFilters.length === 0) return { success: true, bundles: [] }

  const svc = createServiceClient()
  // The OR filter needs SOME brokerage anchor for tenant isolation —
  // every scope tuple still belongs to this brokerage, so we filter on
  // brokerage_id when we know it (admins) and skip when we don't (a
  // solo agent in a brokerage they don't admin still has agent scope
  // tied to the same brokerage_id via the agents.brokerage_id FK).
  const anchorBrokerageId =
    access.brokerageScopeId
    ?? (await (async () => {
      const { getAgentContext } = await import("@/lib/identity/get-agent-context")
      const ctx = await getAgentContext()
      return ctx.brokerageId ?? null
    })())
  if (!anchorBrokerageId) return { success: false, error: "brokerage_unresolved" }

  const { data: bundleRows, error } = await svc
    .from("campaign_bundles")
    .select("id, name, description, scope_type, scope_id, is_active, created_at")
    .eq("brokerage_id", anchorBrokerageId)
    .or(scopeFilters.join(","))
    .order("created_at", { ascending: false })
  if (error) return { success: false, error: error.message }
  const bundles = (bundleRows ?? []) as Array<Omit<BundleRow, "items">>
  if (bundles.length === 0) return { success: true, bundles: [] }

  const bundleIds = bundles.map((b) => b.id)
  const [itemsR, dispatchesR] = await Promise.all([
    svc.from("campaign_bundle_items")
      .select("id, bundle_id, channel, preset_id, order_index, send_after_minutes")
      .in("bundle_id", bundleIds)
      .order("order_index", { ascending: true }),
    // Pull every dispatch row for these bundles and aggregate in JS —
    // PostgREST doesn't support GROUP BY in the JS client. The dispatch
    // table is bounded by the 28d window in practice (older rows still
    // exist but the rollup cron only walks the recent slice), so the
    // dataset stays small enough to aggregate in-process.
    svc.from("campaign_bundle_dispatches")
      .select("bundle_id, scans_count, leads_count, dispatched_at")
      .in("bundle_id", bundleIds),
  ])

  const items = (itemsR.data ?? []) as BundleItemRow[]
  const itemsByBundle = new Map<string, BundleItemRow[]>()
  for (const it of items) {
    const arr = itemsByBundle.get(it.bundle_id) ?? []
    arr.push(it); itemsByBundle.set(it.bundle_id, arr)
  }

  const perfByBundle = new Map<string, BundlePerformance>()
  for (const id of bundleIds) {
    perfByBundle.set(id, { dispatch_count: 0, total_scans: 0, total_leads: 0, last_dispatched_at: null })
  }
  for (const d of (dispatchesR.data ?? []) as Array<{
    bundle_id: string; scans_count: number | null;
    leads_count: number | null; dispatched_at: string | null
  }>) {
    const p = perfByBundle.get(d.bundle_id)
    if (!p) continue
    p.dispatch_count++
    p.total_scans += d.scans_count ?? 0
    p.total_leads += d.leads_count ?? 0
    if (d.dispatched_at && (p.last_dispatched_at === null || d.dispatched_at > p.last_dispatched_at)) {
      p.last_dispatched_at = d.dispatched_at
    }
  }

  return {
    success: true,
    bundles: bundles.map((b) => ({
      ...b,
      items:       itemsByBundle.get(b.id) ?? [],
      performance: perfByBundle.get(b.id) ?? { dispatch_count: 0, total_scans: 0, total_leads: 0, last_dispatched_at: null },
    })),
  }
}

/** Load every preset the caller can pick from, keyed by channel kind.
 *  The bundle builder shows these in the per-item picker. */
export async function listAvailablePresets(): Promise<
  | { success: true; catalog: PresetCatalog }
  | { success: false; error: string }
> {
  const access = await resolvePolicyScopeAccess()
  const scopeFilters = buildScopeFilters(access)
  const empty: PresetCatalog = {
    direct_mail_postcard: [],
    direct_mail_letter:   [],
    email:                [],
    sms:                  [],
    voicedrop:            [],
    social_post:          [],
    podcast_episode:      [],
    ad_retarget:          [],
    portal_push:          [],
  }
  if (scopeFilters.length === 0) return { success: true, catalog: empty }

  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  const brokerageId = access.brokerageScopeId ?? ctx.brokerageId
  if (!brokerageId) return { success: false, error: "brokerage_unresolved" }

  const svc = createServiceClient()
  const orFilter = scopeFilters.join(",")
  const baseSelect = "id, name, scope_type, scope_id, is_active"

  const [dmR, emailR, smsR, voicedropR, socialR, podcastR, adR, portalR] = await Promise.all([
    svc.from("direct_mail_presets")
      .select(`${baseSelect}, piece_type, postcard_size, locked_headline, locked_letter_body`)
      .eq("brokerage_id", brokerageId).or(orFilter).eq("is_active", true),
    svc.from("email_presets")
      .select(`${baseSelect}, subject`)
      .eq("brokerage_id", brokerageId).or(orFilter).eq("is_active", true),
    svc.from("sms_presets")
      .select(`${baseSelect}, body`)
      .eq("brokerage_id", brokerageId).or(orFilter).eq("is_active", true),
    svc.from("voicedrop_presets")
      .select(`${baseSelect}, tts_script, audio_url`)
      .eq("brokerage_id", brokerageId).or(orFilter).eq("is_active", true),
    svc.from("social_post_presets")
      .select(`${baseSelect}, caption, target_platforms`)
      .eq("brokerage_id", brokerageId).or(orFilter).eq("is_active", true),
    svc.from("podcast_episode_presets")
      .select(`${baseSelect}, podcast_episode_id, target_distribution_channels`)
      .eq("brokerage_id", brokerageId).or(orFilter).eq("is_active", true),
    svc.from("ad_retarget_presets")
      .select(`${baseSelect}, ad_headline, daily_budget_cents`)
      .eq("brokerage_id", brokerageId).or(orFilter).eq("is_active", true),
    svc.from("portal_push_presets")
      .select(`${baseSelect}, title, priority`)
      .eq("brokerage_id", brokerageId).or(orFilter).eq("is_active", true),
  ])

  const catalog: PresetCatalog = { ...empty }
  for (const r of (dmR.data ?? []) as Array<{
    id: string; name: string; scope_type: PresetOption["scope_type"]; scope_id: string
    piece_type: "postcard" | "letter"; postcard_size: string | null
    locked_headline: string | null; locked_letter_body: string | null
  }>) {
    const opt: PresetOption = {
      id: r.id, name: r.name, scope_type: r.scope_type, scope_id: r.scope_id,
      summary: r.piece_type === "postcard"
        ? `${r.postcard_size ?? ""} · ${r.locked_headline ?? ""}`.trim()
        : (r.locked_letter_body?.slice(0, 80) ?? ""),
    }
    if (r.piece_type === "postcard") catalog.direct_mail_postcard.push(opt)
    else                              catalog.direct_mail_letter.push(opt)
  }
  for (const r of (emailR.data ?? []) as Array<{ id: string; name: string; scope_type: PresetOption["scope_type"]; scope_id: string; subject: string }>) {
    catalog.email.push({ id: r.id, name: r.name, scope_type: r.scope_type, scope_id: r.scope_id, summary: r.subject })
  }
  for (const r of (smsR.data ?? []) as Array<{ id: string; name: string; scope_type: PresetOption["scope_type"]; scope_id: string; body: string }>) {
    catalog.sms.push({ id: r.id, name: r.name, scope_type: r.scope_type, scope_id: r.scope_id, summary: r.body.slice(0, 80) })
  }
  for (const r of (voicedropR.data ?? []) as Array<{ id: string; name: string; scope_type: PresetOption["scope_type"]; scope_id: string; tts_script: string | null; audio_url: string | null }>) {
    catalog.voicedrop.push({
      id: r.id, name: r.name, scope_type: r.scope_type, scope_id: r.scope_id,
      summary: r.audio_url ? "uploaded audio" : (r.tts_script?.slice(0, 80) ?? ""),
    })
  }
  for (const r of (socialR.data ?? []) as Array<{ id: string; name: string; scope_type: PresetOption["scope_type"]; scope_id: string; caption: string; target_platforms: string[] | null }>) {
    catalog.social_post.push({
      id: r.id, name: r.name, scope_type: r.scope_type, scope_id: r.scope_id,
      summary: `${(r.target_platforms ?? []).join(", ")} · ${r.caption.slice(0, 60)}`,
    })
  }
  for (const r of (podcastR.data ?? []) as Array<{ id: string; name: string; scope_type: PresetOption["scope_type"]; scope_id: string; podcast_episode_id: string | null; target_distribution_channels: string[] | null }>) {
    catalog.podcast_episode.push({
      id: r.id, name: r.name, scope_type: r.scope_type, scope_id: r.scope_id,
      summary: r.podcast_episode_id ? `Episode bound · ${(r.target_distribution_channels ?? []).join(", ")}` : "(no episode bound)",
    })
  }
  for (const r of (adR.data ?? []) as Array<{ id: string; name: string; scope_type: PresetOption["scope_type"]; scope_id: string; ad_headline: string | null; daily_budget_cents: number | null }>) {
    catalog.ad_retarget.push({
      id: r.id, name: r.name, scope_type: r.scope_type, scope_id: r.scope_id,
      summary: `${r.ad_headline ?? ""} · $${((r.daily_budget_cents ?? 0) / 100).toFixed(0)}/day`,
    })
  }
  for (const r of (portalR.data ?? []) as Array<{ id: string; name: string; scope_type: PresetOption["scope_type"]; scope_id: string; title: string; priority: string | null }>) {
    catalog.portal_push.push({
      id: r.id, name: r.name, scope_type: r.scope_type, scope_id: r.scope_id,
      summary: `${r.priority ?? "normal"} · ${r.title}`,
    })
  }

  return { success: true, catalog }
}

export interface UpsertBundleInput {
  id?:          string
  name:         string
  description?: string | null
  scope_type?:  PolicyScopeTier
  scope_id?:    string
  items:        Array<{
    channel:            BundleChannel
    preset_id:          string
    order_index:        number
    send_after_minutes: number
  }>
}

/** Resolve the (scope_type, scope_id) tuple the caller is targeting and
 *  verify edit-access. Mirrors direct-mail-presets so the same write
 *  guard runs across all preset/bundle CRUD. */
function resolveTargetScope(
  access: PolicyScopeAccess,
  requested: { scope_type?: PolicyScopeTier; scope_id?: string },
): { ok: true; scope_type: PolicyScopeTier; scope_id: string } | { ok: false; error: string } {
  const tier = requested.scope_type ?? (
    access.canEditBrokerage ? "brokerage" :
    access.canEditTeam      ? "team"      :
    "agent"
  )
  if (tier === "agent") {
    if (!access.canEditAgent) return { ok: false, error: "agent_scope_forbidden" }
    const id = requested.scope_id ?? access.agentScopeId
    if (!id) return { ok: false, error: "agent_scope_unresolved" }
    return { ok: true, scope_type: "agent", scope_id: id }
  }
  if (tier === "team") {
    if (!access.canEditTeam) return { ok: false, error: "team_scope_forbidden" }
    // Only default when the caller has exactly one team (team-lead).
    // Brokerage admins see every team and MUST pick explicitly.
    let id = requested.scope_id
    if (!id) {
      if (access.teamScopeIds.length === 1) id = access.teamScopeIds[0]
      else return { ok: false, error: "team_scope_id_required" }
    }
    if (!access.teamScopeIds.includes(id)) return { ok: false, error: "team_not_in_your_scope" }
    return { ok: true, scope_type: "team", scope_id: id }
  }
  if (!access.canEditBrokerage) return { ok: false, error: "brokerage_scope_forbidden" }
  const id = requested.scope_id ?? access.brokerageScopeId
  if (!id) return { ok: false, error: "brokerage_scope_unresolved" }
  return { ok: true, scope_type: "brokerage", scope_id: id }
}

export async function upsertCampaignBundle(input: UpsertBundleInput): Promise<{
  success: boolean
  bundleId?: string
  error?: string
}> {
  const access = await resolvePolicyScopeAccess()
  if (!access.brokerageScopeId && !access.canEditAgent && !access.canEditTeam) {
    return { success: false, error: "No scope available" }
  }
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  const brokerageId = access.brokerageScopeId ?? ctx.brokerageId
  if (!brokerageId) return { success: false, error: "brokerage_unresolved" }

  if (!input.name?.trim()) return { success: false, error: "name required" }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { success: false, error: "at least one item required" }
  }

  const scope = resolveTargetScope(access, { scope_type: input.scope_type, scope_id: input.scope_id })
  if (!scope.ok) return { success: false, error: scope.error }

  const svc = createServiceClient()

  const row = {
    brokerage_id: brokerageId,
    name:         input.name.trim(),
    description:  input.description ?? null,
    scope_type:   scope.scope_type,
    scope_id:     scope.scope_id,
    is_active:    true,
    updated_at:   new Date().toISOString(),
  }

  let bundleId: string
  if (input.id) {
    const { data: existing } = await svc.from("campaign_bundles")
      .select("brokerage_id, scope_type, scope_id")
      .eq("id", input.id).maybeSingle()
    const ex = existing as { brokerage_id: string; scope_type: string; scope_id: string } | null
    if (!ex) return { success: false, error: "bundle_not_found" }
    if (ex.brokerage_id !== brokerageId) return { success: false, error: "tenant_mismatch" }
    const canEditExisting =
      (ex.scope_type === "agent"     && access.canEditAgent     && ex.scope_id === access.agentScopeId) ||
      (ex.scope_type === "team"      && access.canEditTeam      && access.teamScopeIds.includes(ex.scope_id)) ||
      (ex.scope_type === "brokerage" && access.canEditBrokerage && ex.scope_id === access.brokerageScopeId)
    if (!canEditExisting) return { success: false, error: "scope_forbidden_existing" }

    const { error } = await svc.from("campaign_bundles").update(row).eq("id", input.id)
    if (error) return { success: false, error: error.message }
    bundleId = input.id
    // Replace items: simpler than diffing, and items are small.
    await svc.from("campaign_bundle_items").delete().eq("bundle_id", bundleId)
  } else {
    const { data, error } = await svc.from("campaign_bundles").insert(row).select("id").single()
    if (error) {
      if (error.code === "23505") return { success: false, error: `A bundle named "${row.name}" already exists.` }
      return { success: false, error: error.message }
    }
    bundleId = data.id as string
  }

  // Insert items. order_index uses the position in the array (zero-
  // indexed) so the UI's drag ordering is the source of truth.
  const itemRows = input.items.map((it, idx) => ({
    bundle_id:          bundleId,
    brokerage_id:       brokerageId,
    channel:            it.channel,
    preset_id:          it.preset_id,
    order_index:        idx,
    send_after_minutes: Math.max(0, it.send_after_minutes | 0),
  }))
  const { error: insErr } = await svc.from("campaign_bundle_items").insert(itemRows)
  if (insErr) return { success: false, error: insErr.message }

  revalidatePath("/settings/campaign-bundles")
  return { success: true, bundleId }
}

export async function deactivateCampaignBundle(bundleId: string): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.brokerageScopeId && !access.canEditAgent && !access.canEditTeam) {
    return { success: false, error: "No scope available" }
  }
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  const brokerageId = access.brokerageScopeId ?? ctx.brokerageId
  if (!brokerageId) return { success: false, error: "brokerage_unresolved" }

  const svc = createServiceClient()
  const { data: row } = await svc.from("campaign_bundles")
    .select("scope_type, scope_id")
    .eq("id", bundleId).eq("brokerage_id", brokerageId).maybeSingle()
  const r = row as { scope_type: string; scope_id: string } | null
  if (!r) return { success: false, error: "bundle_not_found" }
  const canEditScope =
    (r.scope_type === "agent"     && access.canEditAgent     && r.scope_id === access.agentScopeId) ||
    (r.scope_type === "team"      && access.canEditTeam      && access.teamScopeIds.includes(r.scope_id)) ||
    (r.scope_type === "brokerage" && access.canEditBrokerage && r.scope_id === access.brokerageScopeId)
  if (!canEditScope) return { success: false, error: "scope_forbidden" }

  const { error } = await svc.from("campaign_bundles")
    .update({ is_active: false })
    .eq("id", bundleId)
  if (error) return { success: false, error: error.message }
  revalidatePath("/settings/campaign-bundles")
  return { success: true }
}
