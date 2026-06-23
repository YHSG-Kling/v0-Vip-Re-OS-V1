// lib/data-guard/guarded-generate.ts
//
// The guarded model-call wrapper — the Data Guard applied to a raw AI SDK generateText call.
// New code that needs generateText directly (not through lib/ai/models.ts) imports THIS instead of
// `generateText` from "ai", so the system / prompt / message text is redacted of high-confidence
// secrets (SSN, EIN, card PAN, bank account/routing) before it reaches the model. The data-guard
// CI ratchet (scripts/data-guard-guard.ts) enforces it: only this file and lib/ai/models.ts may
// touch the raw SDK call; every new caller must route through one of them.

import { generateText } from "ai"
import { redactSensitive } from "./index"

type GenerateTextArgs = Parameters<typeof generateText>[0]

/** Redact a single message's text content (string content or text parts). */
function redactMessage(msg: unknown): unknown {
  if (!msg || typeof msg !== "object") return msg
  const m = msg as { role?: unknown; content?: unknown }
  if (typeof m.content === "string") return { ...m, content: redactSensitive(m.content).text }
  if (Array.isArray(m.content)) {
    return {
      ...m,
      content: m.content.map((part) => {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return { ...part, text: redactSensitive((part as { text: string }).text).text }
        }
        return part
      }),
    }
  }
  return msg
}

/** generateText with the Data Guard applied to system + prompt + messages. Same signature/DX. */
export async function guardedGenerateText(args: GenerateTextArgs): ReturnType<typeof generateText> {
  const safe: GenerateTextArgs = { ...args }
  const a = safe as { system?: unknown; prompt?: unknown; messages?: unknown }
  if (typeof a.system === "string") a.system = redactSensitive(a.system).text
  if (typeof a.prompt === "string") a.prompt = redactSensitive(a.prompt).text
  if (Array.isArray(a.messages)) a.messages = a.messages.map(redactMessage)
  return generateText(safe)
}
