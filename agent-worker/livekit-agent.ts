/**
 * agent-worker/livekit-agent.ts
 *
 * Phase A LiveKit Agent worker for the on-the-go AI talking assistant.
 *
 * This is a SEPARATE long-running Node process — NOT a Vercel function. Deploy
 * to Fly.io / Render / Railway / a VM. It auto-dispatches into LiveKit rooms
 * created by `/api/livekit/token` and runs the realtime voice loop.
 *
 *   user mic ──► Deepgram STT ──► OpenAI LLM ──► ElevenLabs TTS ──► user
 *
 * Parallel to:
 *   • VAPI ISA (outbound/inbound phone calls) — untouched
 *   • D-ID `AvatarChatWidget` (talking head face) — untouched
 *
 * Required env vars on the worker host:
 *   LIVEKIT_URL              wss://… (same project the Next.js app issues tokens for)
 *   LIVEKIT_API_KEY          server key
 *   LIVEKIT_API_SECRET       server secret
 *   OPENAI_API_KEY           LLM
 *   DEEPGRAM_API_KEY         STT
 *   ELEVENLABS_API_KEY       TTS (uses agent's voice clone if voice_id is in
 *                                 room metadata; falls back to default)
 *   AGENT_SYSTEM_PROMPT      optional override of the assistant persona
 *
 * Room metadata produced by /api/livekit/token includes:
 *   {
 *     userId, agentId, brokerageId, userType, mode,
 *     contactId, context,
 *     elevenlabs_voice_id,    // ← used per-room so each agent's clone speaks
 *     did_avatar_id,
 *   }
 *
 * Recipe pattern: matches the LiveKit Agents Node.js voice-assistant quickstart.
 */

import {
  cli,
  defineAgent,
  llm,
  pipeline,
  WorkerOptions,
  type JobContext,
} from "@livekit/agents"
import * as deepgram from "@livekit/agents-plugin-deepgram"
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs"
import * as openai from "@livekit/agents-plugin-openai"
import * as silero from "@livekit/agents-plugin-silero"

const DEFAULT_SYSTEM_PROMPT = `You are the agent's personal real estate operations assistant.
You help with: pulling up contacts, drafting follow-up notes, summarising recent activity,
scheduling, and answering quick questions about listings, buyers, and transactions.
Keep replies short and natural — this is a hands-free voice conversation, not a chat
window. Confirm action details before performing destructive operations.`

interface RoomMetadata {
  userId?: string
  agentId?: string | null
  brokerageId?: string
  userType?: string
  mode?: string
  contactId?: string | null
  context?: Record<string, unknown> | null
  elevenlabs_voice_id?: string | null
  did_avatar_id?: string | null
}

function parseMetadata(raw: string | undefined): RoomMetadata {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as RoomMetadata
  } catch {
    return {}
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect()

    const meta = parseMetadata(ctx.room.metadata)
    const voiceId = meta.elevenlabs_voice_id ?? process.env.ELEVENLABS_DEFAULT_VOICE_ID
    const systemPrompt = process.env.AGENT_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT

    const initialContext = new llm.ChatContext().append({
      role: llm.ChatRole.SYSTEM,
      text: [
        systemPrompt,
        meta.userId ? `Operator user_id: ${meta.userId}.` : "",
        meta.agentId ? `Operator agent_id: ${meta.agentId}.` : "",
        meta.brokerageId ? `Brokerage: ${meta.brokerageId}.` : "",
        meta.contactId ? `Active contact context: ${meta.contactId}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    })

    const participant = await ctx.waitForParticipant()

    const agent = new pipeline.VoicePipelineAgent(
      await silero.VAD.load(),
      new deepgram.STT(),
      new openai.LLM({ model: "gpt-4o-mini" }),
      new elevenlabs.TTS({ voice: voiceId ? { id: voiceId, name: "agent_clone" } : undefined }),
      { chatCtx: initialContext },
    )

    // Forward live transcripts back to the browser as data messages so the
    // widget can render the rolling conversation.
    agent.on("user_speech_committed", (msg) => {
      ctx.room.localParticipant?.publishData(
        new TextEncoder().encode(JSON.stringify({ type: "transcript", role: "user", text: msg.content })),
        { reliable: true },
      ).catch(() => {})
    })
    agent.on("agent_speech_committed", (msg) => {
      ctx.room.localParticipant?.publishData(
        new TextEncoder().encode(JSON.stringify({ type: "transcript", role: "assistant", text: msg.content })),
        { reliable: true },
      ).catch(() => {})
    })

    agent.start(ctx.room, participant)

    await agent.say("Hi — I'm your assistant. What do you need?", true)
  },
})

// CLI entry — run with `node --import tsx livekit-agent.ts start`
cli.runApp(
  new WorkerOptions({
    agent: new URL(import.meta.url).pathname,
  }),
)
