// lib/ai/gateway-chat.ts
// Structured/extraction AI calls (OCR, intent parsing, JSON offers, narratives) route through the
// Vercel AI Gateway's OpenAI-compatible chat/completions endpoint — one egress, one billing/key.
// Content-generation paths use lib/ai/models.ts (generateTextRouted) which layers Them-First +
// compliance; this helper is the raw path for tasks where that post-processing must NOT run.

import { callConnector } from "@/lib/agentic-os/connector-gateway"

export type GatewayChatContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >

export interface GatewayChatMessage {
  role: "system" | "user" | "assistant"
  content: GatewayChatContent
}

export interface GatewayChatResult {
  ok: boolean
  content: string | null
  error: string | null
}

/**
 * One AI chat/completions call through the Vercel AI Gateway. `model` is a gateway slug
 * ("anthropic/claude-sonnet-4-20250514", "openai/gpt-4o-mini", "xai/grok-beta", …). Vision is
 * supported by passing an image_url content part with a data: URL.
 */
export async function gatewayChat(params: {
  model: string
  messages: GatewayChatMessage[]
  maxTokens?: number
  temperature?: number
}): Promise<GatewayChatResult> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) return { ok: false, content: null, error: "AI_GATEWAY_API_KEY is not configured" }

  const res = await callConnector<{ choices?: Array<{ message?: { content?: string } }> }>({
    connector: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    path: "/v1/chat/completions",
    method: "POST",
    auth: { style: "bearer", token: key },
    body: {
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens ?? 1024,
      temperature: params.temperature ?? 0.7,
    },
    timeoutMs: 60_000,
  })

  if (!res.ok) return { ok: false, content: null, error: res.error ?? `HTTP ${res.status}` }
  return { ok: true, content: res.data?.choices?.[0]?.message?.content ?? null, error: null }
}

export interface GatewayChatJSONResult<T> {
  ok:      boolean
  data:    T | null
  /** The raw response text from the model — included on parse failure so the caller can log it. */
  raw:     string | null
  error:   string | null
}

/**
 * Variant of gatewayChat that expects a JSON object in the response. Robust to common gateway →
 * Anthropic translation artifacts (preamble text, ```json fences, surrounding prose) — extracts the
 * first {...} block and parses it. Five callers (home-value, listing-landing, smart-insights ×2,
 * performance-predictor) used to copy this 4-line pattern by hand and two of them drifted to a
 * bare `JSON.parse(content.trim())` that throws on a single fenced response — this helper kills
 * the variant.
 *
 * Returns `{ok:false, error}` on every failure mode (no key, gateway 5xx, empty content, JSON
 * parse failure) so callers can branch on `ok` instead of try/catching different error shapes.
 */
export async function gatewayChatJSON<T = unknown>(params: {
  model: string
  messages: GatewayChatMessage[]
  maxTokens?: number
  temperature?: number
}): Promise<GatewayChatJSONResult<T>> {
  const r = await gatewayChat(params)
  if (!r.ok || !r.content) return { ok: false, data: null, raw: r.content, error: r.error ?? "No content from gateway" }
  const match = r.content.match(/\{[\s\S]*\}/)
  if (!match)                return { ok: false, data: null, raw: r.content, error: "No JSON object found in gateway response" }
  try {
    return { ok: true, data: JSON.parse(match[0]) as T, raw: r.content, error: null }
  } catch (e) {
    return { ok: false, data: null, raw: r.content, error: `JSON parse failed: ${(e as Error).message}` }
  }
}
