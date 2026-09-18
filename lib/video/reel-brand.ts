// lib/video/reel-brand.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE brand resolver + ONE delivery sweep for the presentation reels (the
// weekly Partners' Meeting show + the monthly board-packet video). KEEP-ONE:
// both producers were about to grow their own brand lookups and their own
// completed-render sweeps — this is the single copy.
//
// Brand comes from the LIVE tenant tables — never the legacy HeyGen-era
// video_branding_presets. Defaults keep the reels rendering when a tenant
// hasn't finished the brand wizard (navy/amber, the composition defaults).
//
// ── MERGED ONTO THE ONE BRAND CASCADE (lane 76D, orphan doctrine §1.1) ──────
// This function used to be a SECOND brand resolver: its own two-table read
// (brokerages.primary_color/logo_url + brokerage_brand_settings.accent_color)
// beside lib/branding/resolve-brand-context.ts resolveBrandContext — the
// resolver scripts/brand-cascade-simulator.ts (test:brand-cascade) proves is
// "THE single brand source of truth every consumer should call". The two
// disagreed in exactly the way that proof exists to catch: the onboarding
// brand WIZARD writes logo + colors to global_settings (per brokerage_id), and
// resolveBrandContext folds that tier in (team → brokerages → global_settings)
// while this read never did — so a tenant whose brand was configured through
// onboarding got navy/amber DEFAULTS on every reel, thumbnail, flyer and door
// hanger this resolver feeds, and an agent on a team never got the team's
// logo/colors their contacts recognise. Same drift test:brand-cascade closed
// for postcards / portal / email in wave 36, still open on the video lane.
//
// Survivor: resolveBrandContext (per-attribute cascade, tenant-scoped at every
// tier — global_settings is read `.eq("brokerage_id", …)`, so no platform
// brand can ever reach a tenant video through it). This is now an ADAPTER to
// the ReelBrand shape the compositions consume, not a resolver. The `svc`
// parameter stays: it resolves the agent's team (agents.team_id) so an
// agent-scoped render inherits the team tier — the same agents→team walk
// lib/remotion/stock-pick.ts and lib/video/broll-picker.ts do for stock assets.

const HEX = /^#[0-9a-fA-F]{6}$/

export interface ReelBrand {
  primaryColor: string
  accentColor: string
  brokerageName: string
  logoUrl: string | null
  showEhoMark: boolean
}

// File-local (not exported): callers pass an object literal; nothing imports the shape.
interface ReelBrandScope {
  /** users.id of the rendering agent — resolves the team tier of the cascade
   *  (teams.logo_url / primary_color / accent_color win over the brokerage's)
   *  and the agent's own tagline source. Omit for brokerage-level reels
   *  (partners' meeting, board packet). */
  agentUserId?: string | null
  /** teams.id when the caller already knows it; otherwise derived from the agent. */
  teamId?: string | null
}

/** The tenant's video brand through the ONE brand cascade (resolveBrandContext),
 *  adapted to the shape every reel composition's `brand` prop consumes. */
export async function resolveReelBrand(svc: any, brokerageId: string, scope: ReelBrandScope = {}): Promise<ReelBrand> {
  let name = "Your Brokerage", primary: string | null = null, logo: string | null = null, accent: string | null = null
  try {
    // The team tier is keyed by teams.id; an agent-scoped render finds it
    // through agents.team_id (users.id → agents.user_id — the two id classes
    // are DISJOINT, CLAUDE.md §3). Best-effort: no team row → brokerage tier.
    let teamId: string | null = scope.teamId ?? null
    if (!teamId && scope.agentUserId) {
      try {
        const { data: agentRow } = await svc.from("agents").select("team_id").eq("user_id", scope.agentUserId).maybeSingle()
        teamId = (agentRow as { team_id?: string | null } | null)?.team_id ?? null
      } catch { /* team resolution is best-effort — the cascade falls to the brokerage tier */ }
    }
    // Dynamic import: resolve-brand-context.ts is `server-only`; this module
    // stays importable by the proofs that read its pure delivery sweep.
    const { resolveBrandContext } = await import("@/lib/branding/resolve-brand-context")
    const ctx = await resolveBrandContext({ brokerageId, teamId, agentUserId: scope.agentUserId ?? null })
    name = ctx.brokerageName
    primary = ctx.visual.primaryColor
    logo = ctx.visual.logoUrl
    accent = ctx.visual.accentColor
  } catch { /* defaults below */ }
  return {
    primaryColor: HEX.test(primary ?? "") ? (primary as string) : "#0F172A",
    accentColor: HEX.test(accent ?? "") ? (accent as string) : "#F59E0B",
    brokerageName: name,
    logoUrl: logo,
    showEhoMark: true,
  }
}

export interface ReelDeliveryResult { completed: number; notified: number; signaled: number }

/**
 * Generic sweep: COMPLETED reels of one entity_type in the window → one
 * notification per broker admin, deduped forever by the render-id marker —
 * PLUS one OUTCOME SIGNAL per delivered render (wave 58 — the video-loop audit
 * named this the missing half: these two reels render/poll/retry through the
 * SAME registry rail every other video-producing pipeline uses, but delivery
 * dead-ended at an in-app notification with no asset_manager announcement onto
 * the inter-manager bus, unlike every ai_video_projects-linked render, which
 * lib/kernel/video-coordination.ts announces on completion). `toManager` +
 * `signalType` are supplied by the caller because the two reels this sweep
 * serves have DIFFERENT owning managers (lib/kernel/manager-registry.ts:
 * partners_meeting → campaign_orchestrator, board_packet → finance_manager) —
 * never a shared/default target, per "be careful which managers you assign
 * FROM and TO" (wave 49). fromManager is ALWAYS "asset_manager" — the asset
 * owner publishing, same convention as video-coordination.ts. Deduped on
 * entity_id=render id (independent of the notification dedup above, so a
 * signal still fires even if every admin notification was already sent by an
 * earlier pass — e.g. after a temporary manager-registry hiccup).
 */
export async function deliverCompletedReels(
  svc: any,
  p: {
    entityType: string
    sinceIso: string
    notificationType: string
    title: string
    bodyIntro: string
    /** The manager this entityType's OUTCOME signal announces to. Never
     *  "asset_manager" itself — publishManagerSignal refuses a self-route. */
    toManager: import("@/lib/kernel/manager-registry").ManagerKey
    /** manager_signals.signal_type for this reel's completion announcement. */
    signalType: string
  },
): Promise<ReelDeliveryResult> {
  const out: ReelDeliveryResult = { completed: 0, notified: 0, signaled: 0 }
  const { data: renders } = await svc.from("remotion_composition_renders")
    .select("id, brokerage_id, output_url")
    .eq("entity_type", p.entityType)
    .eq("render_status", "succeeded").not("output_url", "is", null)
    .gte("created_at", p.sinceIso).limit(200)
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  for (const ren of ((renders ?? []) as any[])) {
    out.completed += 1
    const marker = `[reel:${ren.id}]`
    const { data: dup } = await svc.from("notifications").select("id")
      .eq("brokerage_id", ren.brokerage_id).ilike("body", `%${marker}%`).limit(1).maybeSingle()
    if (!dup) {
      const { data: admins } = await svc.from("users").select("id")
        .eq("brokerage_id", ren.brokerage_id).in("user_type", ["broker", "admin"]).limit(5)
      for (const u of ((admins ?? []) as any[])) {
        await svc.from("notifications").insert({
          user_id: u.id, brokerage_id: ren.brokerage_id, type: p.notificationType,
          title: p.title,
          body: `${p.bodyIntro} Watch: ${ren.output_url} ${marker}`,
          priority: "medium", channel: "in_app", is_read: false,
        }).then(undefined, () => {})
        out.notified += 1
      }
    }
    // THE OUTCOME SIGNAL — separately deduped (entity_id = this render's id),
    // so it still fires exactly once even on a re-run where the notification
    // dedup above already short-circuited.
    const signal = await publishManagerSignal({
      brokerageId:  ren.brokerage_id,
      fromManager:  "asset_manager",
      toManager:    p.toManager,
      signalType:   p.signalType,
      message:      `${p.title} — ${ren.output_url}`,
      entityType:   p.entityType,
      entityId:     ren.id,
      payload:      { output_url: ren.output_url },
    })
    if (signal.ok) out.signaled += 1
  }
  return out
}
