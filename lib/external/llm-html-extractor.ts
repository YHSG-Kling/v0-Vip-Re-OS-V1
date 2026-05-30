/**
 * lib/external/llm-html-extractor.ts
 *
 * Schema-bound HTML → structured-JSON extractor via Claude (routed through the canonical
 * connector-gateway). Replaces brittle regex parsers that break silently when vendor sites rotate
 * DOM. Usage:
 *
 *   const { records, cost } = await extractFromHtml({
 *     html: scraped.html,
 *     schema: BuyerIntentSchema,
 *     instructions: "Extract every buyer-intent profile / saved-search visible on this page.",
 *   })
 *
 * Returned cost is the LLM input/output token spend in USD (approximate). The function never
 * throws — failures return `{ records: [], cost: 0, error }` so the caller can fall back to the
 * regex path.
 */
import "server-only"

const MODEL = process.env.HTML_EXTRACTOR_MODEL ?? "claude-haiku-4-5-20251001"
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

/** Approximate Claude pricing per 1M tokens, used for cost telemetry only. */
const PRICE_PER_MTOK_INPUT  = 1.00   // Haiku input
const PRICE_PER_MTOK_OUTPUT = 5.00   // Haiku output

export interface ExtractFromHtmlParams {
  /** Raw HTML body to extract from. Caller should trim to the relevant region when possible to keep token cost down. */
  html: string
  /** Plain-text description of the JSON shape we want back. Keep concise; the LLM is told to return
   *  an array of records matching this schema. Example:
   *    "{ name: string; email?: string; phone?: string; searchCriteria?: {beds?:number; budgetMax?:number; city?:string} }" */
  schema: string
  /** Free-text instructions about what to extract (e.g. "only buyer-intent profiles", "ignore ads"). */
  instructions: string
  /** Optional model override. */
  model?: string
  /** Hard cap on input HTML length to keep token cost bounded (chars). Default 30k. */
  maxHtmlChars?: number
}

export interface ExtractFromHtmlResult {
  records: Array<Record<string, any>>
  cost:    number
  error:   string | null
}

export async function extractFromHtml(params: ExtractFromHtmlParams): Promise<ExtractFromHtmlResult> {
  const html = (params.html ?? "").slice(0, params.maxHtmlChars ?? 30_000)
  if (!html) return { records: [], cost: 0, error: "empty html" }
  if (!ANTHROPIC_KEY) return { records: [], cost: 0, error: "missing ANTHROPIC_API_KEY" }

  const model = params.model ?? MODEL
  const systemPrompt =
    "You are a strict HTML→JSON extractor. " +
    "Return ONLY a single JSON object with the key `records` containing an array of objects that match the user's schema. " +
    "Do NOT wrap the output in markdown. Do NOT fabricate values: omit fields you cannot find rather than guessing. " +
    "Phone numbers must be raw digits or E.164. Emails must be lowercased. Prices must be plain numbers (no $)."
  const userPrompt =
    `INSTRUCTIONS:\n${params.instructions}\n\n` +
    `OUTPUT SCHEMA (each record must match):\n${params.schema}\n\n` +
    `HTML:\n${html}`

  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<any>({
    connector: "anthropic",
    baseUrl:   "https://api.anthropic.com/v1",
    path:      "messages",
    method:    "POST",
    auth:      { style: "header", name: "x-api-key", value: ANTHROPIC_KEY },
    headers:   { "anthropic-version": "2023-06-01" },
    body: {
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    },
  })

  if (!res.ok || !res.data) {
    return { records: [], cost: 0, error: res.error ?? "anthropic call failed" }
  }

  const text = (res.data.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n")
    .trim()
  if (!text) return { records: [], cost: 0, error: "empty model response" }

  // Parse the JSON — accept either {"records":[…]} or a bare array (be lenient).
  let parsed: any
  try { parsed = JSON.parse(text) }
  catch {
    // Tolerate code-fence wrapping that some models still emit despite instructions.
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
    try { parsed = JSON.parse(stripped) }
    catch (e) { return { records: [], cost: 0, error: `json parse failed: ${(e as Error).message}` } }
  }
  const records = Array.isArray(parsed) ? parsed
                : Array.isArray(parsed?.records) ? parsed.records
                : []

  const usage = res.data.usage ?? {}
  const inT  = typeof usage.input_tokens  === "number" ? usage.input_tokens  : 0
  const outT = typeof usage.output_tokens === "number" ? usage.output_tokens : 0
  const cost = (inT  / 1_000_000) * PRICE_PER_MTOK_INPUT
             + (outT / 1_000_000) * PRICE_PER_MTOK_OUTPUT

  return { records, cost, error: null }
}
