/**
 * lib/external/llm-html-extractor.ts
 *
 * Schema-bound HTML → structured-JSON extractor via Claude (routed through the **Vercel AI
 * Gateway** for unified billing + healer-observability). Strict system prompt (no markdown, no
 * fabrication, schema-only output), 30k-char input cap, defensive JSON parse, never throws.
 */
import { gatewayChat } from "@/lib/ai/gateway-chat"

// Model is an AI-Gateway slug, e.g. "anthropic/claude-haiku-4-5-20251001". Override via env.
const MODEL = process.env.HTML_EXTRACTOR_MODEL ?? "anthropic/claude-haiku-4-5-20251001"

export interface ExtractFromHtmlParams {
  html: string
  schema: string
  instructions: string
  model?: string
  maxHtmlChars?: number
}

export interface ExtractFromHtmlResult {
  records: Array<Record<string, any>>
  cost:    number  // 0 here — cost telemetry lives at the gateway; left in the shape for callers
  error:   string | null
}

export async function extractFromHtml(params: ExtractFromHtmlParams): Promise<ExtractFromHtmlResult> {
  const html = (params.html ?? "").slice(0, params.maxHtmlChars ?? 30_000)
  if (!html) return { records: [], cost: 0, error: "empty html" }

  const systemPrompt =
    "You are a strict HTML→JSON extractor. " +
    "Return ONLY a single JSON object with the key `records` containing an array of objects that match the user's schema. " +
    "Do NOT wrap the output in markdown. Do NOT fabricate values: omit fields you cannot find rather than guessing. " +
    "Phone numbers must be raw digits or E.164. Emails must be lowercased. Prices must be plain numbers (no $)."
  const userPrompt =
    `INSTRUCTIONS:\n${params.instructions}\n\n` +
    `OUTPUT SCHEMA (each record must match):\n${params.schema}\n\n` +
    `HTML:\n${html}`

  const res = await gatewayChat({
    model: params.model ?? MODEL,
    maxTokens: 2048,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt },
    ],
  })

  if (!res.ok || !res.content) {
    return { records: [], cost: 0, error: res.error ?? "gatewayChat returned no content" }
  }
  const text = res.content.trim()
  let parsed: any
  try { parsed = JSON.parse(text) }
  catch {
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
    try { parsed = JSON.parse(stripped) }
    catch (e) { return { records: [], cost: 0, error: `json parse failed: ${(e as Error).message}` } }
  }
  const records = Array.isArray(parsed) ? parsed
                : Array.isArray(parsed?.records) ? parsed.records
                : []
  return { records, cost: 0, error: null }
}
