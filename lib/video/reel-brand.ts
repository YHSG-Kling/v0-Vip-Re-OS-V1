// lib/video/reel-brand.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE brand resolver + ONE delivery sweep for the presentation reels (the
// weekly Partners' Meeting show + the monthly board-packet video). KEEP-ONE:
// both producers were about to grow their own brand lookups and their own
// completed-render sweeps — this is the single copy.
//
// Brand comes from the LIVE tenant tables (brokerages.primary_color/logo_url
// + brokerage_brand_settings.accent_color) — never the legacy HeyGen-era
// video_branding_presets. Defaults keep the reels rendering when a tenant
// hasn't finished the brand wizard (navy/amber, the composition defaults).

const HEX = /^#[0-9a-fA-F]{6}$/

export interface ReelBrand {
  primaryColor: string
  accentColor: string
  brokerageName: string
  logoUrl: string | null
  showEhoMark: boolean
}

/** The tenant's video brand from the live brand tables (never HeyGen presets). */
export async function resolveReelBrand(svc: any, brokerageId: string): Promise<ReelBrand> {
  let name = "Your Brokerage", primary: string | null = null, logo: string | null = null, accent: string | null = null
  try {
    const [{ data: b }, { data: bs }] = await Promise.all([
      svc.from("brokerages").select("name, primary_color, logo_url").eq("id", brokerageId).maybeSingle(),
      svc.from("brokerage_brand_settings").select("accent_color").eq("brokerage_id", brokerageId).maybeSingle(),
    ])
    if ((b as any)?.name) name = String((b as any).name)
    primary = (b as any)?.primary_color ?? null
    logo = (b as any)?.logo_url ?? null
    accent = (bs as any)?.accent_color ?? null
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
