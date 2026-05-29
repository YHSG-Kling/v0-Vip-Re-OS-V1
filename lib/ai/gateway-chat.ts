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
