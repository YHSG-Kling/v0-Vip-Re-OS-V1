"use server"

// app/actions/superadmin/go-live-readiness.ts
// ─────────────────────────────────────────────────────────────────────────────
// "Are we ready for production?" — providers-gated, on-demand (every probe is
// a real vendor call; nothing runs on page load), audited.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"
import { runGoLiveReadiness, type GoLiveReadiness } from "@/lib/platform/go-live-readiness"

export async function getGoLiveReadinessAction(): Promise<{ ok: true; readiness: GoLiveReadiness } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = (data as any)?.platform_role ?? ((data as any)?.user_type === "superadmin" ? "superadmin" : null)
  if (!platformStaffCan(role, "providers")) return { ok: false, error: "Forbidden — platform providers access required" }

  const svc = createServiceClient()
  const readiness = await runGoLiveReadiness(svc)

  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: user.id, actor_email: (data as any)?.email ?? user.email ?? "",
      action: "go_live_readiness.checked", target_type: "platform", target_id: "readiness",
      details: { requiredReady: readiness.requiredReady, requiredTotal: readiness.requiredTotal },
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[go-live-readiness audit] failed:", err) }

  return { ok: true, readiness }
}

/**
 * THE STAGED RENDER PROOF — one click queues a REAL video through the ENTIRE
 * production pipeline (bundle → Chromium render → narration mux → music →
 * bookends → Supabase-hosted upload → branded thumbnail) in the deployed
 * environment. The composition-render-queue cron drains it within minutes;
 * the render row's output_url is the proof. Retires the last environmental
 * assumption in the video stack. Providers-gated + audited; idempotent-safe
 * (each click is its own probe row, entity_type 'render_probe').
 */
export async function queueRenderPipelineProbeAction(): Promise<{ ok: true; renderId: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email, brokerage_id").eq("id", user.id).maybeSingle()
  const role = (data as any)?.platform_role ?? ((data as any)?.user_type === "superadmin" ? "superadmin" : null)
  if (!platformStaffCan(role, "providers")) return { ok: false, error: "Forbidden — platform providers access required" }

  const svc = createServiceClient()
  const { data: b } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  const brokerageId = (data as any)?.brokerage_id ?? (b as any)?.id
  if (!brokerageId) return { ok: false, error: "No brokerage to scope the probe to" }

  const { resolveReelBrand } = await import("@/lib/video/reel-brand")
  const brand = await resolveReelBrand(svc, brokerageId)
  const props: Record<string, unknown> = {
    weekLabel: "Render pipeline probe",
    cards: [
      { value: "LIVE", label: "PRODUCTION RENDER PIPELINE", sub: "bundle · render · narration · music · bookends · storage", kind: "team" },
      { value: "OK", label: "SUPABASE-HOSTED DELIVERY", sub: "this video's URL is the proof", kind: "finance" },
    ],
    oneAsk: "If you can watch this, the video stack is production-ready",
    narration: "This is a staged proof render through the full production video pipeline. If you are hearing this narration over the finished video, text to speech, the audio mux, music, and storage hosting are all working end to end.",
    agentName: "Pipeline Probe", avatarVideoUrl: null, agentPhotoUrl: null,
    brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, brokerageName: brand.brokerageName, showEhoMark: true, logoUrl: brand.logoUrl },
    thumbnail_props: {
      kind: "presentation", title: "Render pipeline probe", subtitle: "Staged production proof", eyebrow: "PROBE",
      agentName: brand.brokerageName,
      brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, brokerageName: brand.brokerageName, showEhoMark: true },
    },
  }
  // Narration through the REAL TTS+storage path when a platform voice exists.
  try {
    const { prepareReelVoiceover } = await import("@/lib/video/reel-voiceover")
    const { FALLBACK_VOICE_ID } = await import("@/lib/voice/elevenlabs-tts")
    const vo = await prepareReelVoiceover({ brokerageId, narration: props.narration as string, voiceId: FALLBACK_VOICE_ID, renderKey: "render-probe" })
    if (vo) props.voiceover_url = vo.url
  } catch { /* probe still proves render+storage without narration */ }

  const { recordRenderQueued } = await import("@/lib/remotion/registry")
  const rq = await recordRenderQueued({
    brokerageId, compositionId: "PartnersMeetingReel",
    entityType: "render_probe", entityId: brokerageId,
    inputProps: props, scopeType: "brokerage", scopeId: brokerageId, requestedVia: "manual",
  })
  if (!rq.ok || !rq.renderId) return { ok: false, error: rq.error ?? "queue failed" }

  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: user.id, actor_email: (data as any)?.email ?? user.email ?? "",
      action: "render_pipeline.probe_queued", target_type: "platform", target_id: rq.renderId,
      details: { brokerageId }, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch { /* audit best-effort */ }
  return { ok: true, renderId: rq.renderId }
}
