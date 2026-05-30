/**
 * lib/inbox/smart-replies.ts
 *
 * Generates 3 quick-reply suggestions for the inbound message in front of the
 * agent. The suggestions cover three intents:
 *   1. Affirm + commit  — short positive acknowledgement with a next step
 *   2. Clarify          — ask the one question that unblocks the next step
 *   3. Soft hold        — empathetic delay if the agent isn't ready to commit
 *
 * Each suggestion is brand-voice-aware (Them First) and respects compliance
 * rails (no commitments around price, never names other parties).
 */

import "server-only"
import { generateObject } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { z } from "zod"

const SmartReplySchema = z.object({
  replies: z
    .array(
      z.object({
        intent: z.enum(["affirm", "clarify", "soft_hold"]),
        body: z.string().min(1).max(280),
      }),
    )
    .length(3),
})

export type SmartReply = z.infer<typeof SmartReplySchema>["replies"][number]

interface BuildContextInput {
  inboundBody: string
  channel: "sms" | "email" | "in_app" | "portal"
  contactName?: string | null
  contactType?: string | null
  recentThread?: Array<{ direction: "inbound" | "outbound"; body: string }>
}

const FALLBACK_REPLIES: (input: BuildContextInput) => SmartReply[] = (input) => {
  const name = input.contactName?.split(" ")[0] ?? "there"
  return [
    {
      intent: "affirm",
      body: `Thanks ${name} — got it. I'll get back to you with the next step shortly.`,
    },
    {
      intent: "clarify",
      body: `Quick question so I can help fast — what's most important to you right now?`,
    },
    {
      intent: "soft_hold",
      body: `Appreciate you reaching out, ${name}. Let me check on a couple of things and circle back.`,
    },
  ]
}

export async function generateSmartReplies(input: BuildContextInput): Promise<SmartReply[]> {
  // Routed through Vercel AI Gateway. Falls back to canned replies when the gateway key is missing.
  if (!process.env.AI_GATEWAY_API_KEY) return FALLBACK_REPLIES(input)

  try {
    const { object } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: SmartReplySchema,
      system:
        "You are a real estate agent's reply assistant. Produce three short replies to the inbound message. " +
        "Lead with empathy / acknowledgement (Them First). Never quote prices, never speak for the other side, " +
        "never make hard commitments on inspection / appraisal / closing dates. Keep each reply under 240 characters. " +
        "Match the channel tone — SMS is casual; email is more formal.",
      prompt: [
        `Channel: ${input.channel}`,
        input.contactName ? `Contact: ${input.contactName}` : "",
        input.contactType ? `Contact type: ${input.contactType}` : "",
        "",
        input.recentThread?.length
          ? "Recent thread (oldest first):\n" +
            input.recentThread
              .slice(-4)
              .map((m) => `${m.direction === "inbound" ? "Them" : "You"}: ${m.body}`)
              .join("\n")
          : "",
        "",
        `Inbound message to reply to:\n${input.inboundBody}`,
      ]
        .filter(Boolean)
        .join("\n"),
    })
    return object.replies
  } catch (err) {
    console.warn("[smart-replies] LLM failed, using fallback:", err)
    return FALLBACK_REPLIES(input)
  }
}
