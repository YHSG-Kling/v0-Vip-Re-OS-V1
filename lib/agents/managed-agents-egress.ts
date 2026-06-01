/**
 * lib/agents/managed-agents-egress.ts
 *
 * The single canonical wrapper around Anthropic's Managed Agents API (`/v1/agents`,
 * `/v1/sessions`). Routes through `callConnector` so the egress preserves the same
 * single-egress, healer-observable, never-throws invariants every other vendor call uses.
 *
 * Anthropic Managed Agents are persistent, versioned resources. Agents are created ONCE per
 * brokerage per kind and reused across sessions — the m107 `managed_agents` table tracks
 * the Anthropic IDs so we never re-create on the request path (Anthropic's documented
 * anti-pattern).
 *
 * Beta header: `managed-agents-2026-04-01` (auto-sent by callConnector via headers).
 * Auth: ANTHROPIC_API_KEY (separate from AI_GATEWAY_API_KEY — managed agents endpoints
 * are not proxied by the Vercel AI Gateway; we route directly to api.anthropic.com but
 * still through callConnector for single-egress observability).
 */
import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

const ANTHROPIC_BASE = "https://api.anthropic.com"
const ANTHROPIC_BETA = "managed-agents-2026-04-01"
const ANTHROPIC_VERSION = "2023-06-01"

function getAnthropicKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY
  return key && key.trim() ? key : null
}

function commonHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key":         apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta":    ANTHROPIC_BETA,
  }
}

// ─── Agent creation / lookup ──────────────────────────────────────────────────

export interface CreateAgentInput {
  name:    string
  model:   string
  system?: string
  tools?:        Array<Record<string, unknown>>
  mcp_servers?:  Array<Record<string, unknown>>
  skills?:       Array<Record<string, unknown>>
  metadata?:     Record<string, string>
}

export interface ManagedAgentResource {
  id:      string
  name:    string
  version: string | number | null
  model:   string
}

export interface ManagedAgentResult {
  ok:    boolean
  agent: ManagedAgentResource | null
  error: string | null
}

export async function createManagedAgent(input: CreateAgentInput): Promise<ManagedAgentResult> {
  const key = getAnthropicKey()
  if (!key) return { ok: false, agent: null, error: "ANTHROPIC_API_KEY not configured" }

  const res = await callConnector<{ id?: string; name?: string; version?: string | number; model?: string | { id?: string } }>({
    connector: "anthropic-managed-agents",
    baseUrl:   ANTHROPIC_BASE,
    path:      "/v1/agents",
    method:    "POST",
    headers:   commonHeaders(key),
    body:      input,
    timeoutMs: 60_000,
  })
  if (!res.ok || !res.data?.id) {
    return { ok: false, agent: null, error: res.error ?? `Anthropic agents.create failed (${res.status ?? "?"})` }
  }
  const model = typeof res.data.model === "string" ? res.data.model : res.data.model?.id ?? input.model
  return {
    ok:    true,
    agent: {
      id:      res.data.id,
      name:    res.data.name ?? input.name,
      version: res.data.version ?? null,
      model:   model,
    },
    error: null,
  }
}

// ─── Session creation ──────────────────────────────────────────────────────────

export interface CreateSessionInput {
  /** `agent_abc123` or `{type:"agent", id, version}` */
  agent:          string | { type: "agent"; id: string; version?: string | number }
  environment_id: string
  title?:         string
  resources?:     Array<Record<string, unknown>>
  vault_ids?:     string[]
  metadata?:      Record<string, string>
}

export interface ManagedSessionResource {
  id:      string
  status:  string
  agent:   { id: string; version: string | number | null }
}

export interface ManagedSessionResult {
  ok:      boolean
  session: ManagedSessionResource | null
  error:   string | null
}

export async function createManagedSession(input: CreateSessionInput): Promise<ManagedSessionResult> {
  const key = getAnthropicKey()
  if (!key) return { ok: false, session: null, error: "ANTHROPIC_API_KEY not configured" }

  const res = await callConnector<{ id?: string; status?: string; agent?: { id?: string; version?: string | number } }>({
    connector: "anthropic-managed-agents",
    baseUrl:   ANTHROPIC_BASE,
    path:      "/v1/sessions",
    method:    "POST",
    headers:   commonHeaders(key),
    body:      input,
    timeoutMs: 60_000,
  })
  if (!res.ok || !res.data?.id) {
    return { ok: false, session: null, error: res.error ?? `Anthropic sessions.create failed (${res.status ?? "?"})` }
  }
  return {
    ok: true,
    session: {
      id:     res.data.id,
      status: res.data.status ?? "running",
      agent:  { id: res.data.agent?.id ?? "", version: res.data.agent?.version ?? null },
    },
    error: null,
  }
}

// ─── Send a user.message event ────────────────────────────────────────────────

export interface SendEventInput {
  session_id: string
  events: Array<Record<string, unknown>>
}

export async function sendManagedSessionEvents(input: SendEventInput): Promise<{ ok: boolean; error: string | null }> {
  const key = getAnthropicKey()
  if (!key) return { ok: false, error: "ANTHROPIC_API_KEY not configured" }

  const res = await callConnector<{ ok?: boolean }>({
    connector: "anthropic-managed-agents",
    baseUrl:   ANTHROPIC_BASE,
    path:      `/v1/sessions/${input.session_id}/events`,
    method:    "POST",
    headers:   commonHeaders(key),
    body:      { events: input.events },
    timeoutMs: 60_000,
  })
  return { ok: res.ok, error: res.error }
}

// ─── Retrieve session (status + last events) ──────────────────────────────────

export interface RetrieveSessionResult {
  ok:           boolean
  status:       string | null
  stop_reason:  string | null
  last_message: string | null
  error:        string | null
}

export async function retrieveManagedSession(sessionId: string): Promise<RetrieveSessionResult> {
  const key = getAnthropicKey()
  if (!key) return { ok: false, status: null, stop_reason: null, last_message: null, error: "ANTHROPIC_API_KEY not configured" }

  const res = await callConnector<{ status?: string; stop_reason?: { type?: string } | string }>({
    connector: "anthropic-managed-agents",
    baseUrl:   ANTHROPIC_BASE,
    path:      `/v1/sessions/${sessionId}`,
    method:    "GET",
    headers:   commonHeaders(key),
    timeoutMs: 30_000,
  })
  if (!res.ok) {
    return { ok: false, status: null, stop_reason: null, last_message: null, error: res.error ?? `retrieveSession ${res.status ?? "?"}` }
  }
  const sr = typeof res.data?.stop_reason === "string"
    ? res.data.stop_reason
    : res.data?.stop_reason?.type ?? null
  return { ok: true, status: res.data?.status ?? null, stop_reason: sr, last_message: null, error: null }
}
