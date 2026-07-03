// lib/video/module-voice.ts
//
// VOICE BY AUDIENCE for learning-module videos — a contact-facing explainer speaks in the AGENT's own
// cloned voice (it's their relationship); an agent-facing one in the brokerage's ASSISTANT voice. The
// module→video publish records the decision in video_metadata.voice (via voiceForAudience); the render
// worker calls resolveVideoVoiceId to turn that into the actual voice id. Kept out of the server-only
// presenter-media module so it stays unit-testable.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** The brokerage's ASSISTANT voice (the AI ISA/assistant clone) — used for AGENT-facing videos. */
export async function resolveAssistantVoiceId(brokerageId: string, client?: Svc): Promise<string | null> {
  const svc = client ?? createServiceClient()
  if (!brokerageId) return null
  const { data } = await svc.from("brokerages").select("default_isa_voice_id").eq("id", brokerageId).maybeSingle()
  return (data as { default_isa_voice_id?: string | null } | null)?.default_isa_voice_id ?? null
}

/**
 * Resolve which voice a learning-module video renders in. assistant → the brokerage assistant voice
 * (fallback to the presenter voice when unset); anything else → the agent's own presenter voice.
 */
export async function resolveVideoVoiceId(
  args: { voiceKind: "agent_own" | "assistant" | null | undefined; presenterVoiceId: string | null; brokerageId: string },
  client?: Svc,
): Promise<string | null> {
  if (args.voiceKind === "assistant") {
    const assistant = await resolveAssistantVoiceId(args.brokerageId, client)
    return assistant ?? args.presenterVoiceId ?? null
  }
  return args.presenterVoiceId ?? null
}
