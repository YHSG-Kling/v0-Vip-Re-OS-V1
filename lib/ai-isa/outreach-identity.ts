// lib/ai-isa/outreach-identity.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE OUTREACH IDENTITY AUTHORITY — who the AI ISA's avatar/voice REPRESENTS at each stage.
// One source of truth so the video (D-ID avatar), the voice call (VAPI/ElevenLabs clone),
// and the voice drop never disagree on whose face/voice fronts a touch.
//
//   • LEAD  (pre-assignment, brokerage/ISA-owned) → the BROKERAGE identity: the SOLO agent
//     on a solo_agent brokerage, else the broker/owner (the brokerage's face), else any
//     active agent as a last resort. A specific buyers-agent's CLONE is NOT projected onto
//     an unassigned lead (misleading + disclosure risk — buildCallContext enforces the same).
//   • CONTACT / LIFETIME (post-assignment) → the ASSIGNED AGENT (contacts.agent_id) — the
//     relationship belongs to that agent, so the ISA speaks in THEIR cloned voice/avatar.
//
// Returns users.id (what ai_video_projects.agent_id, dispatchVideo.userId, and
// synthVoicemail.agentUserId all key off). NOT pure (resolves against the roster) — but the
// RULE lives here once, imported everywhere, so a leadId≠contactId mix-up can't recur.

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** The brokerage/solo identity that fronts a LEAD's outreach (no assigned agent yet). */
export async function resolveLeadPresenterUserId(
  svc: Svc, brokerageId: string, leadAgentId?: string | null,
): Promise<string | null> {
  // A lead that already has an agent (rare at first-touch) → honor it.
  if (leadAgentId) {
    const { data } = await svc.from("agents").select("user_id").eq("id", leadAgentId).maybeSingle()
    const uid = (data as { user_id: string | null } | null)?.user_id ?? null
    if (uid) return uid
  }
  // Solo-agent brokerage → the solo agent IS the brokerage face.
  const { data: brk } = await svc.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
  if ((brk as { plan_tier?: string } | null)?.plan_tier === "solo_agent") {
    const { data: solo } = await svc.from("agents").select("user_id")
      .eq("brokerage_id", brokerageId).eq("is_active", true).not("user_id", "is", null)
      .order("created_at", { ascending: true }).limit(1).maybeSingle()
    const uid = (solo as { user_id: string | null } | null)?.user_id ?? null
    if (uid) return uid
  }
  // Team / brokerage / multi → the broker / owner (the brokerage's public face).
  const { data: broker } = await svc.from("users").select("id")
    .eq("brokerage_id", brokerageId).in("user_type", ["broker_owner", "broker"])
    .order("created_at", { ascending: true }).limit(1).maybeSingle()
  if ((broker as { id: string } | null)?.id) return (broker as { id: string }).id
  // Last resort — any active agent, so a reel always has a real human face (never fabricated).
  const { data: anyAgent } = await svc.from("agents").select("user_id")
    .eq("brokerage_id", brokerageId).eq("is_active", true).not("user_id", "is", null)
    .order("created_at", { ascending: true }).limit(1).maybeSingle()
  return (anyAgent as { user_id: string | null } | null)?.user_id ?? null
}

/** The ASSIGNED AGENT's user id that fronts a CONTACT / LIFETIME customer's outreach. */
export async function resolveContactPresenterUserId(
  svc: Svc, contactId: string, brokerageId: string,
): Promise<string | null> {
  const { data: c } = await svc.from("contacts").select("agent_id").eq("id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
  const agentId = (c as { agent_id: string | null } | null)?.agent_id ?? null
  if (!agentId) return null
  const { data: a } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  return (a as { user_id: string | null } | null)?.user_id ?? null
}
