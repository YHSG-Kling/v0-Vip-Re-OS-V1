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
import { generateObjectRouted, type AIModel } from "@/lib/ai/models"
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

/**
 * What this generator SPENT, and whether it spent anything at all.
 *
 * `modelCalled: false` is the canned-fallback path — no gateway key, or the
 * call threw — and it is 0 because nothing was bought, not because nobody
 * looked. A caller that ledgers a run of this generator must take the number
 * from here; the previous shape returned only the replies, so the AI Toolkit's
 * Smart Reply tool had no honest figure available and reported a made-up 250.
 */
export interface SmartReplyUsage {
  modelCalled: boolean
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** true when the provider returned no usage block and the count is a chars/4 estimate. */
  estimated: boolean
  /**
   * THE MODEL THAT ACTUALLY SERVED THE CALL — `null` when none was called.
   *
   * This lane routes on the `smart_reply_generation` row, which pins
   * claude-sonnet with a gpt-4o FALLBACK, and generateObjectRouted switches to
   * that fallback whenever the primary throws. It has always reported which one
   * ran (RoutedUsage.model); this generator dropped it, so its one ledgering
   * caller — the AI Toolkit's Smart Reply tool — had nothing to write but the
   * PINNED model, and stamped "claude-sonnet" on every row including the ones a
   * fallback served. The tokens were real and the model label was not, and
   * cost_cents is priced off the label: claude-sonnet bills $3/$15 per 1M
   * against gpt-4o's $2.50/$10, so a fallback call was over-billed by the
   * difference on a ledger the tenant's overage projection is derived from.
   */
  model: AIModel | null
}

const NO_SPEND: SmartReplyUsage = {
  modelCalled: false, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false, model: null,
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

export async function generateSmartReplies(
  input: BuildContextInput,
): Promise<{ replies: SmartReply[]; usage: SmartReplyUsage }> {
  // Routed via generateObjectRouted: gateway + AI_TASK_ROUTING + fallback + fair-use + cost log.
  // Falls back to canned replies when the gateway key is missing.
  if (!process.env.AI_GATEWAY_API_KEY) return { replies: FALLBACK_REPLIES(input), usage: NO_SPEND }

  try {
    const { object, usage } = await generateObjectRouted({
      feature: "smart_reply_generation",
      schema:  SmartReplySchema,
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
    return {
      replies: object.replies,
      usage: {
        modelCalled: true,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        // generateObjectRouted falls back to its own chars/4 estimate when the
        // provider omits a usage block; it does not tell us which happened, so
        // an output count of exactly 0 alongside a non-empty reply set is the
        // one observable signature of that path.
        estimated: usage.outputTokens === 0,
        // The SERVED model, straight off the routed call — primary on the happy
        // path, `fallback` when the primary threw. Never the routing table's
        // pinned model read from somewhere else.
        model: usage.model,
      },
    }
  } catch (err) {
    console.warn("[smart-replies] LLM failed, using fallback:", err)
    return { replies: FALLBACK_REPLIES(input), usage: NO_SPEND }
  }
}
