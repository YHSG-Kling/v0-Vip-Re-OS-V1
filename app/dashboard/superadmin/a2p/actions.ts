"use server"

// app/dashboard/superadmin/a2p/actions.ts
// ─────────────────────────────────────────────────────────────────────────────
// VOICE INTEGRITY (CNAM + SHAKEN/STIR) — the board's per-tenant register
// button. Same gate + audit idiom as the Mock-A2P verify action
// (app/actions/superadmin/a2p-verify.ts): platform 'providers' capability,
// superadmin_audit_log entry, and a phone_number_events line (source
// 'a2p_registration') so the board's "Last A2P event" column stays honest.
// The runner itself (lib/voice/a2p-registration.runVoiceIntegrityRegistration)
// refuses before campaign approval and without master creds — never fabricates.

import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { requireProviders } from "@/lib/auth/platform-guard"
import { runVoiceIntegrityRegistration, describeVoiceIntegrityState, nextVoiceIntegrityStep } from "@/lib/voice/a2p-registration"

// TOMBSTONE: local requireProviders merged onto lib/auth/platform-guard.ts
// requireProviders (imported above) — §1/§6 SAME BODY census round 3,
// 2026-09-09.

export async function registerVoiceIntegrityAction(brokerageId: string): Promise<{
  ok: boolean; statusLine: string; nextStep: string; error?: string
}> {
  const auth = await requireProviders()
  if (!auth.ok) return { ok: false, statusLine: "", nextStep: "", error: auth.error }
  if (!/^[0-9a-f-]{36}$/i.test(brokerageId)) return { ok: false, statusLine: "", nextStep: "", error: "Invalid brokerage id" }

  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id, name").eq("id", brokerageId).maybeSingle()
  if (!brk) return { ok: false, statusLine: "", nextStep: "", error: "Brokerage not found" }

  const r = await runVoiceIntegrityRegistration(svc, brokerageId)

  // Best-effort activity line for the board's "Last A2P event" column — a
  // failed log write never blocks the honest run result, but it is NOT
  // silenced (the write-sentinel ratchet forbids new '.then(undefined, …)').
  const evt = await svc.from("phone_number_events").insert({
    brokerage_id: brokerageId, phone_number: "a2p",
    event_type: "webhooks_bound", source: "a2p_registration",
    notes: `Voice integrity (CNAM + SHAKEN/STIR) ran → ${r.advancedTo}${r.error ? ` (error: ${r.error.slice(0, 160)})` : ""}`,
  })
  if (evt.error) console.error("[voice-integrity] phone_number_events log failed:", evt.error.message)

  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: auth.userId, actor_email: auth.email,
      action: "voice_integrity.registered", target_type: "brokerage", target_id: brokerageId,
      details: { advancedTo: r.advancedTo, ok: r.ok, error: r.error ?? null, cnam_status: r.state.cnam_status ?? null, shaken_status: r.state.shaken_status ?? null },
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[voice-integrity audit] failed:", err) }

  return {
    ok: r.ok,
    statusLine: `${(brk as any).name}: ${describeVoiceIntegrityState(r.state)}`,
    nextStep: nextVoiceIntegrityStep(r.state),
    error: r.error,
  }
}
