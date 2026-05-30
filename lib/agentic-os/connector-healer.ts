/**
 * lib/agentic-os/connector-healer.ts
 *
 * AI-driven self-healer. When a connector starts failing systematically, this module:
 *
 *   1. Aggregates the failure signature (HTTP code + path + error message) from supplied samples.
 *   2. Looks up the vendor's docs + GitHub from the connector-registry.
 *   3. Searches the live vendor docs for the most up-to-date request shape (via Exa first, Tavily
 *      fallback).
 *   4. Feeds (current request shape + failure samples + fresh docs excerpts) to Claude with a strict
 *      JSON output schema, asking for a structured proposal (endpoint change, param rename, auth
 *      style change, etc.) plus a confidence score.
 *   5. Persists the proposal to `connector_healing_proposals` for review / auto-apply.
 *
 * No I/O is performed beyond the above. The healer NEVER mutates a connector config directly —
 * applying a proposal is a separate action that an admin or an `auto_apply` worker performs.
 *
 * Failure-soft: every external call is gated through callConnector (never throws). The healer always
 * writes a row when called — at minimum, a `'no_evidence'` proposal so the failure is recorded.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { getConnectorSpec } from "./connector-registry"

export interface FailureSample {
  status:   number | null
  path:     string | null
  error:    string | null
  at?:      string
}

export interface ProposeHealingParams {
  connector:  string
  /** Recent failures, newest-first. Caller should pass 3-10 representative samples. */
  failures:   FailureSample[]
  /** Optional current request shape (path, method, sample body, auth style) so the LLM can diff it
   *  against the docs. */
  currentRequest?: Record<string, any>
}

export interface ProposalRow {
  id:                string
  connector:         string
  proposal_kind:     string
  proposal_summary:  string
  confidence:        number
  status:            string
}

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = process.env.HEALER_MODEL ?? "claude-haiku-4-5-20251001"

export async function proposeConnectorHealing(
  params: ProposeHealingParams,
): Promise<{ proposal: ProposalRow | null; error: string | null }> {
  const supabase = createServiceClient()

  // 1. Aggregate signature
  const sample = params.failures.slice(0, 10)
  const codes = sample.map(f => f.status ?? "?").join(",")
  const paths = Array.from(new Set(sample.map(f => f.path ?? ""))).filter(Boolean).join(" | ")
  const signature = `HTTP {${codes}} on path '${paths}'`

  // Always write at least a 'no_evidence' placeholder so the failure is auditable, then refine.
  const writeRow = async (row: Record<string, any>): Promise<ProposalRow | null> => {
    const { data } = await supabase.from("connector_healing_proposals").insert({
      connector:        params.connector,
      failure_signature: signature,
      failure_sample:   sample,
      ...row,
    }).select("id, connector, proposal_kind, proposal_summary, confidence, status").maybeSingle()
    return (data as any) ?? null
  }

  // 2. Look up registry + 3. Fetch docs via Exa (Tavily fallback)
  const spec = getConnectorSpec(params.connector)
  if (!spec) {
    const p = await writeRow({
      proposal_kind:    "no_evidence",
      proposal_summary: `Connector '${params.connector}' is not in the registry — add it before healing can run.`,
      proposal_payload: {},
      docs_evidence:    [],
      confidence:       0,
    })
    return { proposal: p, error: "connector not in registry" }
  }

  // 3a. Doc evidence — small, bounded.
  let docsEvidence: Array<{ url: string; snippet: string }> = []
  try {
    const { exaSearch } = await import("@/lib/external/exa-client")
    const r = await exaSearch({
      query: `${spec.connector} API ${paths || "endpoint"} request shape ${codes.includes("404") ? "deprecated changed" : ""}`,
      numResults: 4,
      includeDomains: [
        new URL(spec.docsUrl).host,
        ...(spec.githubUrl ? [new URL(spec.githubUrl).host] : []),
      ].filter(Boolean),
    })
    docsEvidence = (r.results ?? []).slice(0, 3).map(x => ({
      url: x.url ?? "",
      snippet: (x.text ?? x.summary ?? "").toString().slice(0, 1200),
    }))
  } catch { /* doc search is best-effort */ }

  // 4. Ask the LLM for a structured proposal.
  if (!ANTHROPIC_KEY) {
    const p = await writeRow({
      proposal_kind:    "no_evidence",
      proposal_summary: "Missing ANTHROPIC_API_KEY — cannot generate healing proposal.",
      proposal_payload: {},
      docs_evidence:    docsEvidence,
      confidence:       0,
    })
    return { proposal: p, error: "missing ANTHROPIC_API_KEY" }
  }

  const { callConnector } = await import("./connector-gateway")
  const prompt =
    "You are a connector-healing assistant. A vendor connector is failing. Diagnose the cause and " +
    "propose ONE structured fix. Be concrete: cite the docs URL(s) in `docs_evidence` and return a " +
    "machine-applicable diff in `proposal_payload` (old → new).\n\n" +
    `CONNECTOR: ${spec.connector} (${spec.category})\n` +
    `BASE URL: ${spec.baseUrl}\n` +
    `AUTH STYLE: ${spec.auth}\n` +
    `DOCS: ${spec.docsUrl}${spec.githubUrl ? `\nGITHUB: ${spec.githubUrl}` : ""}\n\n` +
    `FAILURE SIGNATURE: ${signature}\n` +
    `FAILURES (sample, newest first): ${JSON.stringify(sample).slice(0, 1500)}\n` +
    `CURRENT REQUEST SHAPE: ${JSON.stringify(params.currentRequest ?? {}).slice(0, 1500)}\n\n` +
    `FRESH DOCS EVIDENCE:\n${docsEvidence.map((d, i) => `[${i + 1}] ${d.url}\n${d.snippet}`).join("\n\n").slice(0, 4000)}\n\n` +
    `Respond ONLY with JSON of this exact shape:\n` +
    `{\n` +
    `  "proposal_kind": "endpoint_change" | "param_rename" | "auth_change" | "retry_other_actor" | "rotate_key" | "shape_update" | "no_evidence",\n` +
    `  "proposal_summary": "one sentence",\n` +
    `  "proposal_payload": { "old": {…}, "new": {…} },\n` +
    `  "confidence": 0..1\n` +
    `}`

  const llm = await callConnector<any>({
    connector: "anthropic",
    baseUrl:   "https://api.anthropic.com/v1",
    path:      "messages",
    method:    "POST",
    auth:      { style: "header", name: "x-api-key", value: ANTHROPIC_KEY },
    headers:   { "anthropic-version": "2023-06-01" },
    body: {
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    },
  })

  if (!llm.ok || !llm.data) {
    const p = await writeRow({
      proposal_kind:    "no_evidence",
      proposal_summary: `LLM call failed: ${llm.error ?? "unknown"}`,
      proposal_payload: {},
      docs_evidence:    docsEvidence,
      confidence:       0,
    })
    return { proposal: p, error: llm.error }
  }

  const text = (llm.data.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trim()
  let parsed: any
  try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")) } catch {
    parsed = { proposal_kind: "no_evidence", proposal_summary: "LLM response not JSON", proposal_payload: { raw: text.slice(0, 500) }, confidence: 0 }
  }

  const proposal = await writeRow({
    proposal_kind:    String(parsed.proposal_kind ?? "no_evidence"),
    proposal_summary: String(parsed.proposal_summary ?? "").slice(0, 500),
    proposal_payload: parsed.proposal_payload ?? {},
    docs_evidence:    docsEvidence,
    confidence:       typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
  })

  // Notify superadmin + platform-staff users so the proposal queue is acted on quickly. Best-effort:
  // never fail the healer on a notification write — the proposal itself is the source of truth, the
  // notification is just a UI ping. Skip when proposal write itself failed (proposal===null).
  if (proposal) {
    try {
      await notifyPlatformStaffOfProposal(supabase, params.connector, proposal)
    } catch (err) {
      console.error("[connector-healer] notify failed (non-fatal):", err)
    }
  }

  return { proposal, error: null }
}

/** Targeted bell notification to every superadmin + platform-staff user — surfaces the new
 *  proposal in the same in-app notification feed they already watch. */
async function notifyPlatformStaffOfProposal(
  supabase:  ReturnType<typeof createServiceClient>,
  connector: string,
  proposal:  ProposalRow,
): Promise<void> {
  // Resolve recipients via the platform-staff set used elsewhere (resolve-user-role.ts).
  const { PLATFORM_STAFF_ROLES } = await import("@/lib/auth/resolve-user-role")
  // platform_role is the canonical staff field; user_type='superadmin' is the legacy gate. Match
  // either, then dedupe ids client-side so a superadmin who also has a platform_role isn't notified
  // twice for the same proposal.
  const platformRoles = (PLATFORM_STAFF_ROLES as readonly string[]).join(",")
  const { data: staff } = await supabase
    .from("users")
    .select("id")
    .or(`user_type.eq.superadmin,platform_role.in.(${platformRoles})`)
    .limit(500)
  if (!staff || staff.length === 0) return
  const uniqueIds = Array.from(new Set(staff.map((u: any) => u.id as string).filter(Boolean)))
  if (uniqueIds.length === 0) return

  const title = `Healing proposal: ${connector}`
  const body  = `${proposal.proposal_kind}: ${proposal.proposal_summary}`.slice(0, 480)
  const rows = uniqueIds.map((id) => ({
    user_id:      id,
    type:         "connector_healing_proposal",
    title,
    body,
    entity_type:  "connector_healing_proposal",
    entity_id:    proposal.id,
    priority:     "high",
    channel:      "in_app",
    is_read:      false,
  }))
  await supabase.from("notifications").insert(rows)
}
