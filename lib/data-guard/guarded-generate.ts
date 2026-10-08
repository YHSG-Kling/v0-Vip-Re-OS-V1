// lib/data-guard/guarded-generate.ts
//
// The guarded model-call wrapper — the Data Guard applied to a raw AI SDK generateText call.
// New code that needs generateText directly (not through lib/ai/models.ts) imports THIS instead of
// `generateText` from "ai", so the system / prompt / message text is redacted of high-confidence
// secrets (SSN, EIN, card PAN, bank account/routing) before it reaches the model. The data-guard
// CI ratchet (scripts/data-guard-guard.ts) enforces it: only this file and lib/ai/models.ts may
// touch the raw SDK call; every new caller must route through one of them.

import { generateText } from "ai"
import { redactSensitive, classifySensitive, hasSensitive, type SensitivityKind } from "./index"

type GenerateTextArgs = Parameters<typeof generateText>[0]

/** Every text span a call carries (system + prompt + message text), for the audit count. */
function textSpans(a: { system?: unknown; prompt?: unknown; messages?: unknown }): string[] {
  const out: string[] = []
  if (typeof a.system === "string") out.push(a.system)
  if (typeof a.prompt === "string") out.push(a.prompt)
  if (Array.isArray(a.messages)) {
    for (const msg of a.messages) {
      const m = msg as { content?: unknown } | null
      if (!m) continue
      if (typeof m.content === "string") out.push(m.content)
      else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          const t = (part as { text?: unknown } | null)?.text
          if (typeof t === "string") out.push(t)
        }
      }
    }
  }
  return out
}

/**
 * THE DATA GUARD'S AUDIT COUNTER. lib/data-guard/index.ts promised one
 * ("for the Data Guard's audit counter") and nothing ever read redactedCount —
 * a redaction that happened was indistinguishable from one that did not. Before
 * the text is scrubbed, classify it; when anything is found, log the COUNT BY
 * KIND — never the matched value, which is the secret. Pure classification on
 * the hot path (regex only), and the log line is the only side-effect.
 */
function auditSensitive(a: { system?: unknown; prompt?: unknown; messages?: unknown }): void {
  const spans = textSpans(a)
  if (!spans.some(hasSensitive)) return
  const byKind: Partial<Record<SensitivityKind, number>> = {}
  for (const span of spans) {
    for (const f of classifySensitive(span)) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
  }
  const total = Object.values(byKind).reduce((s, n) => s + (n ?? 0), 0)
  console.warn(`[data-guard] redacted ${total} secret span(s) before the model call`, byKind)
}

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
  auditSensitive(a)
  if (typeof a.system === "string") a.system = redactSensitive(a.system).text
  if (typeof a.prompt === "string") a.prompt = redactSensitive(a.prompt).text
  if (Array.isArray(a.messages)) a.messages = a.messages.map(redactMessage)
  return generateText(safe)
}
