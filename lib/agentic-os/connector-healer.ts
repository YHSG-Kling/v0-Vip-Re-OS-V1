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
import { loadProviderHealth, loadAppliedAlternate } from "./connector-gateway"
import { applyDeclaredAlternate } from "./connector-auto-applier"
import { withActionLedger } from "@/lib/kernel/action-ledger"
import { adapterFor, decideProviderHeal, bookAdapterUsage, type HealDecision, type HealSignals, type ProbeVerdict, type ProviderAdapter } from "@/lib/kernel/provider-adapters"
import { runBoundedModel, type BoundedModelDeps } from "@/lib/kernel/self-healing"
import { HEALING_POLICY_DEFAULTS, HEALING_POLICY_KEY } from "@/lib/kernel/healing-policy"
import { z } from "zod"
import type { MeterVendorInput } from "@/lib/vendor-governance/meter-vendor"

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
  /** Wave 138B — the provider-setup research already ran (cited, cost-capped): write the proposal
   *  from it instead of searching + asking a model a second time. */
  researched?: { proposalKind: string; summary: string; finding: Record<string, unknown>; citations: Citation[]; confidence: number }
}

interface Citation { url: string; title: string | null; snippet: string }

export interface ProposalRow {
  id:                string
  connector:         string
  proposal_kind:     string
  proposal_summary:  string
  confidence:        number
  status:            string
}

// AI-Gateway model slug — every Claude call routes through Vercel AI Gateway for unified billing
// + healer self-observability. Override via env.
const MODEL = process.env.HEALER_MODEL ?? "anthropic/claude-haiku-4-5-20251001"

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
    const r = await recordHealingProposal(supabase, { connector: params.connector, failure_signature: signature, failure_sample: sample, ...row } as HealingProposalInsert)
    return r.row
  }

  // Wave 138B — the research step already found + cited the change: record it, notify, done.
  if (params.researched) {
    const rs = params.researched
    const proposal = await writeRow({
      proposal_kind:    rs.proposalKind,
      proposal_summary: rs.summary.slice(0, 500),
      proposal_payload: { finding: rs.finding, source: "provider_setup_research" },
      docs_evidence:    rs.citations,
      confidence:       Math.max(0, Math.min(1, rs.confidence)),
    })
    if (proposal) await notifyPlatformStaffOfProposal(supabase, params.connector, proposal).catch((err) => console.error("[connector-healer] notify failed (non-fatal):", err))
    return { proposal, error: proposal ? null : "proposal not recorded" }
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

  // 4. Ask the LLM for a structured proposal via the Vercel AI Gateway.
  if (!process.env.AI_GATEWAY_API_KEY) {
    const p = await writeRow({
      proposal_kind:    "no_evidence",
      proposal_summary: "Missing AI_GATEWAY_API_KEY — cannot generate healing proposal.",
      proposal_payload: {},
      docs_evidence:    docsEvidence,
      confidence:       0,
    })
    return { proposal: p, error: "missing AI_GATEWAY_API_KEY" }
  }

  const { gatewayChat } = await import("@/lib/ai/gateway-chat")
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

  const llm = await gatewayChat({
    model: MODEL,
    maxTokens: 1024,
    messages: [{ role: "user", content: prompt }],
  })

  if (!llm.ok || !llm.content) {
    const p = await writeRow({
      proposal_kind:    "no_evidence",
      proposal_summary: `LLM call failed: ${llm.error ?? "unknown"}`,
      proposal_payload: {},
      docs_evidence:    docsEvidence,
      confidence:       0,
    })
    return { proposal: p, error: llm.error }
  }

  const text = llm.content.trim()
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

interface HealingProposalInsert {
  connector: string
  failure_signature: string
  failure_sample: unknown
  proposal_kind: string
  proposal_summary: string
  proposal_payload: Record<string, unknown>
  docs_evidence: unknown[]
  confidence: number
}

/**
 * THE ONE healing-proposal writer (connector_healing_proposals): the provider healer above and the
 * self-healing troubleshooter's exhausted playbooks (lib/kernel/self-healing.ts, kind
 * 'playbook_exhausted' — not on the auto-applier's SAFE_KINDS, so it always waits for platform staff).
 * Reads its error; never throws.
 */
export async function recordHealingProposal(client: { from: (table: string) => any }, row: HealingProposalInsert): Promise<{ id: string | null; error: string | null; row: ProposalRow | null }> {
  const { data, error } = await client.from("connector_healing_proposals").insert({ ...row, failure_signature: row.failure_signature.slice(0, 300), proposal_summary: row.proposal_summary.slice(0, 500) })
    .select("id, connector, proposal_kind, proposal_summary, confidence, status").maybeSingle()
  if (error) console.error(`[connector-healer] healing proposal NOT recorded: ${error.message}`)
  return { id: (data as ProposalRow | null)?.id ?? null, error: error?.message ?? (data ? null : "no row"), row: (data as ProposalRow | null) ?? null }
}

/** Targeted bell notification to every superadmin + platform-staff user — surfaces the new
 *  proposal in the same in-app notification feed they already watch. */
async function notifyPlatformStaffOfProposal(
  supabase:  ReturnType<typeof createServiceClient>,
  connector: string,
  proposal:  ProposalRow,
): Promise<void> {
  const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
  await notifyPlatformStaff(supabase, {
    type:       "connector_healing_proposal",
    title:      `Healing proposal: ${connector}`,
    body:       `${proposal.proposal_kind}: ${proposal.proposal_summary}`,
    entityType: "connector_healing_proposal",
    entityId:   proposal.id,
    priority:   "high",
  })
}

// ─── PROVIDER SELF-HEALING (wave 137, lane 137C — owner ruling) ─────────────────────────────────
// "On a provider failure, FIRST probe whether the provider is down; if it is UP, check whether its
// SDK / MCP / endpoint changed recently (a newer version, a deprecation, a changed shape) or a better
// recommended route exists; apply the declared change (adapter version / endpoint / alternate route),
// retry, and record evidence; code-level changes become a connector healing proposal."
// The DECISION is pure (lib/kernel/provider-adapters.ts decideProviderHeal); this executes it through
// the survivors: the router (routeCapability — failover is the router routing around a provider in a
// `failing` cool-down), the auto-applier (applyDeclaredAlternate), the proposal writer
// (proposeConnectorHealing above). Every step is ledgered (withActionLedger, reason OS_HEALTH_RECOVERY,
// actor data_steward — the steward of connector_healing_proposals / connector_health_log) and the one
// retry a heal makes is booked through the adapter's usage booking (one booking per executed call).

type HealLedgerClient = { from: (table: string) => any }

// ─── PROVIDER SETUP RESEARCH (wave 138, lane 138B — owner: "provider self-healing includes SEARCHING
// THE INTERNET for the provider's correct current setup (docs, changelog, status page, SDK/MCP version),
// metered through the existing research capability, with citations as evidence; config-level fixes
// apply + retry; code-level fixes become a healing proposal carrying the researched evidence").
// The research capability survivor is lib/providers/dispatch.ts dispatchWebSearch (Exa, tenant-
// attributed, booked to vendor_usage_tracking via meterVendorSpend); the extraction is ONE bounded
// model call (lib/kernel/self-healing.ts runBoundedModel — Gateway, structured, cost-capped, booked).
// A finding is only ever APPLIED when it names a CONFIG-level alternate the adapter ALREADY DECLARES
// (the web can point at a fix; it can never point egress at an undeclared endpoint — the applier
// re-validates against the declaration). Everything else is a proposal for platform staff.

const RESEARCH_RESULTS_PER_QUERY = 4
/** DEFAULT per-heal research ceiling (USD) — searches + the extraction call. The effective cap is the tenant's
 *  self-healing policy under the platform ceiling (lib/kernel/healing-policy.ts loadHealingPolicy, wave 139F) —
 *  every caller (app/api/cron/connector-health, lib/kernel/os-health.ts failover) passes THAT, never this.
 *  @proofSeam scripts/healing-policy-guard.ts asserts the legacy constant is exactly the policy default. */
export const PROVIDER_RESEARCH_CAP_USD = HEALING_POLICY_DEFAULTS.provider_research_cap_usd

const FindingSchema = z.object({
  change: z.enum(["version_change", "endpoint_change", "auth_change", "shape_change", "outage", "none"]),
  newVersion: z.string().max(80).nullable(),
  newBaseUrl: z.string().max(300).nullable(),
  summary: z.string().max(600),
  citations: z.array(z.number().int().min(1).max(20)).max(8),
  confidence: z.number().min(0).max(1),
})
type ProviderSetupFinding = z.infer<typeof FindingSchema>

type SearchFn = (p: { brokerageId: string; query: string; includeDomains?: string[]; numResults: number; provider: string }) => Promise<{ ok: boolean; results: Array<{ url: string | null; title: string | null; text?: string | null; summary?: string | null }>; costUsd: number; reason: string }>
type DeclaredAlternate = ProviderAdapter["api"]["alternates"][number]

/** PURE — the research queries for one adapter: its docs host first, then changelog / status / SDK. */
/** @proofSeam the proof asserts the docs host + version land in the queries */
export function providerResearchQueries(adapter: ProviderAdapter): Array<{ query: string; includeDomains?: string[] }> {
  let host: string | null = null
  try { host = adapter.api.docsUrl ? new URL(adapter.api.docsUrl).host : null } catch { host = null }
  const sdk = [adapter.api.sdk, adapter.api.mcp].filter(Boolean).join(" ")
  return [
    { query: `${adapter.provider} API ${adapter.api.version} deprecation changelog breaking change`, ...(host ? { includeDomains: [host] } : {}) },
    { query: `${adapter.provider} API status incident ${sdk ? `${sdk} latest version` : "latest version"}` },
  ]
}

/** PURE — a researched version / base URL resolves ONLY to a CONFIG-level alternate the adapter declares. */
/** @proofSeam the proof asserts a cited finding maps to the declared alternate and nothing else */
export function matchDeclaredConfigAlternate(adapter: ProviderAdapter, f: Pick<ProviderSetupFinding, "change" | "newVersion" | "newBaseUrl">, appliedAlternateId: string | null): DeclaredAlternate | null {
  if (f.change !== "version_change" && f.change !== "endpoint_change") return null
  const tok = (s: string) => s.toLowerCase().split(/[\s=&?,;:/]+/).map((t) => t.replace(/^v(?=\d)/, "")).filter(Boolean)
  const current = new Set(tok(adapter.api.version))
  const wanted = f.newVersion ? tok(f.newVersion).filter((t) => !current.has(t) && /\d/.test(t)) : []
  for (const a of adapter.api.alternates) {
    if (a.level !== "config" || a.id === appliedAlternateId) continue
    if (f.newBaseUrl && a.baseUrl && a.baseUrl.replace(/\/+$/, "") === f.newBaseUrl.replace(/\/+$/, "")) return a
    const own = new Set([...tok(a.version ?? ""), ...Object.values(a.query ?? {}).flatMap(tok)].filter((t) => !current.has(t)))
    if (wanted.length && wanted.every((t) => own.has(t))) return a
  }
  return null
}

type ResearchOutcome =
  | { ok: true; finding: ProviderSetupFinding; citations: Citation[]; costUsd: number }
  | { ok: false; reason: string; costUsd: number }

async function researchProviderSetup(adapter: ProviderAdapter, input: ProviderHealInput, capUsd: number, deps: ProviderHealDeps): Promise<ResearchOutcome> {
  const queries = providerResearchQueries(adapter)
  const { exaSearchListCost } = await import("@/lib/external/exa-client")
  const estSearch = queries.length * exaSearchListCost(RESEARCH_RESULTS_PER_QUERY)
  if (!(capUsd > 0) || estSearch >= capUsd) return { ok: false, reason: `cost cap: searches alone estimate $${estSearch.toFixed(4)} ≥ cap $${Math.max(0, capUsd).toFixed(4)} — not researched`, costUsd: 0 }
  const search: SearchFn = deps.search ?? (async (p) => {
    const { dispatchWebSearch } = await import("@/lib/providers/dispatch")
    const r = await dispatchWebSearch({ brokerageId: p.brokerageId, query: p.query, includeDomains: p.includeDomains, numResults: p.numResults, purpose: "provider_setup_research", metadata: { provider: p.provider } })
    return { ok: r.ok, results: r.results, costUsd: r.costUsd, reason: r.reason }
  })
  let spent = 0
  const hits: Citation[] = []
  for (const q of queries) {
    const r = await search({ brokerageId: input.brokerageId, query: q.query, includeDomains: q.includeDomains, numResults: RESEARCH_RESULTS_PER_QUERY, provider: adapter.provider })
      .catch((e: Error) => ({ ok: false, results: [] as Array<{ url: string | null; title: string | null; text?: string | null }>, costUsd: 0, reason: e.message }))
    spent += Number(r.costUsd) || 0
    if (!r.ok) continue
    for (const h of r.results) if (h.url && !hits.some((x) => x.url === h.url)) hits.push({ url: h.url, title: h.title ?? null, snippet: String(h.text ?? (h as { summary?: string | null }).summary ?? "").replace(/\s+/g, " ").slice(0, 700) })
  }
  if (!hits.length) return { ok: false, reason: "research found no source (search unavailable or empty)", costUsd: spent }
  const sources = hits.slice(0, 8)
  const m = await runBoundedModel({
    brokerageId: input.brokerageId, feature: "provider_setup_research", capUsd: capUsd - spent, schema: FindingSchema,
    system: "You extract ONE provider-setup finding from numbered web sources. Report only what a source states; cite source numbers; never invent a version, URL or change. If the sources do not establish a change, return change \"none\".",
    prompt:
      `PROVIDER: ${adapter.provider}\nCODE SPEAKS: ${adapter.api.version} at ${adapter.api.baseUrl}\nDOCS: ${adapter.api.docsUrl ?? "-"}\nSDK/MCP: ${adapter.api.sdk ?? "-"} / ${adapter.api.mcp ?? "-"}\n` +
      `FAILURES: ${JSON.stringify(input.failures.slice(0, 5)).slice(0, 1200)}\n\nSOURCES:\n${sources.map((h, n) => `[${n + 1}] ${h.title ?? "Untitled"} — ${h.url}\n${h.snippet}`).join("\n\n").slice(0, 6000)}`,
  }, deps.researchModel ?? {})
  const costUsd = spent + m.costUsd
  if (!m.ok) return { ok: false, reason: m.reason, costUsd }
  const cited = [...new Set(m.object.citations)].map((n) => sources[n - 1]).filter((c): c is Citation => !!c)
  if (m.object.change !== "none" && !cited.length) return { ok: false, reason: "the finding cited no real source — discarded (never act on an uncited claim)", costUsd }
  return { ok: true, finding: m.object, citations: cited, costUsd }
}

interface ProviderHealInput {
  /** Gateway service key or provider name (adapterFor resolves either). */
  connector: string
  /** The tenant whose call failed — the ledger rows are that tenant's audit. */
  brokerageId: string
  failures: FailureSample[]
  /** Unit of "once" for the ledger (e.g. the cron tick date). */
  cycle: string
  /** The ONE retry after an applied alternate. Absent → no retry is made (and nothing is booked). */
  retry?: () => Promise<{ ok: boolean; units?: number }>
  /** Wave 138B — research budget for a provider that is UP but failing / drifting. Absent → no research. */
  research?: {
    capUsd: number
    /** Wave 139F — the policy's auto-fix-vs-approval threshold: a researched config alternate whose finding is
     *  LESS confident than this is proposed (a human approves), never auto-applied. Absent → 0 (138B behaviour). */
    autoApplyMinConfidence?: number
  }
}

interface ProviderHealDeps {
  client?: HealLedgerClient
  now?: Date
  /** The live probe (connector-probe.ts probeConnector) verdict — null when the provider has no probe spec. */
  probe?: () => Promise<ProbeVerdict>
  derivedHealth?: (serviceKey: string) => Promise<{ state: string; routeAround: boolean; reason: string } | null>
  shapeChange?: (connector: string) => Promise<{ addedKeys: string[]; removedKeys: string[] } | null>
  appliedAlternateId?: (connector: string) => Promise<string | null>
  apply?: typeof applyDeclaredAlternate
  propose?: (p: ProposeHealingParams) => Promise<{ proposal: ProposalRow | null; error: string | null }>
  meter?: (input: MeterVendorInput) => Promise<boolean>
  /** Wave 138B seams — the research capability and the bounded extraction model. */
  search?: SearchFn
  researchModel?: BoundedModelDeps
  /** Test seam for a synthetic adapter declaration (production resolves adapterFor). */
  resolveAdapter?: (connector: string) => ProviderAdapter | null
}

interface ProviderHealReport {
  decision: HealDecision | { step: "propose_unregistered"; reason: string }
  applied: boolean
  retried: boolean
  retryOk: boolean | null
  booked: number
  proposalId: string | null
  /** Wave 138B — the cited finding the research step produced (null when it did not run / found none). */
  research: { finding: ProviderSetupFinding; citations: Citation[]; costUsd: number } | null
}

export async function healProviderFailure(input: ProviderHealInput, deps: ProviderHealDeps = {}): Promise<ProviderHealReport> {
  const client = deps.client ?? createServiceClient()
  const now = deps.now ?? new Date()
  const propose = deps.propose ?? proposeConnectorHealing
  const report: ProviderHealReport = { decision: { step: "propose_unregistered", reason: "" }, applied: false, retried: false, retryOk: null, booked: 0, proposalId: null, research: null }
  const ledger = <T>(step: string, detail: Record<string, unknown>, run: () => Promise<T>, outcome: (r: T) => { ok: boolean; note: string; costUsd?: number }) =>
    withActionLedger<T | null>(
      {
        brokerageId: input.brokerageId,
        action: `provider.heal.${step}`,
        actor: { type: "manager", managerKey: "data_steward" },
        subject: { type: "provider", ref: input.connector },
        reasonCode: "OS_HEALTH_RECOVERY",
        reasonDetail: String(detail.reason ?? "").slice(0, 500),
        idempotencyKey: `provider_heal:${input.brokerageId}:${input.connector}:${step}:${input.cycle}`,
        riskClass: "LOW_RISK_WRITE",
        systemSource: "provider_self_heal",
        // LAW 5 (139F): a heal that carries a research budget ran under the self-healing policy — stamp which.
        ...(input.research ? { policyKey: HEALING_POLICY_KEY } : {}),
        detail,
      },
      run,
      {
        settle: (r) => {
          const o: { ok: boolean; note: string; costUsd?: number } = r === null ? { ok: false, note: "no result" } : outcome(r as T)
          return { status: o.ok ? "executed" : "failed", outcome: o.note.slice(0, 300), provider: input.connector, error: o.ok ? null : o.note, costUsd: o.costUsd ?? null }
        },
        replay: () => null,
      },
      { client },
    )

  const adapter = (deps.resolveAdapter ?? adapterFor)(input.connector)
  if (!adapter) {
    // No (valid) adapter declaration — the pre-137 path: an LLM-assisted proposal for platform staff.
    const reason = `${input.connector} has no valid adapter declaration — proposal only`
    report.decision = { step: "propose_unregistered", reason }
    const r = await ledger("propose", { reason }, () => propose({ connector: input.connector, failures: input.failures }),
      (x) => ({ ok: !!x.proposal, note: x.proposal ? `proposal ${x.proposal.id}` : `proposal not written: ${x.error}` }))
    report.proposalId = r?.proposal?.id ?? null
    return report
  }

  // 1. PROBE FIRST — is it down? (live probe + the gateway's derived health), then the drift evidence.
  const serviceKey = adapter.health.serviceKeys.includes(input.connector) ? input.connector : adapter.health.serviceKeys[0]
  const signals = await ledger("probe", { reason: "probe the provider before any remedy", adapter: adapter.provider, version: adapter.api.version }, async (): Promise<HealSignals> => ({
    probe: deps.probe ? await deps.probe().catch(() => null) : null,
    derived: await (deps.derivedHealth ?? ((k: string) => loadProviderHealth(k, now)))(serviceKey).catch(() => null),
    shapeChange: deps.shapeChange ? await deps.shapeChange(input.connector).catch(() => null) : null,
    appliedAlternateId: deps.appliedAlternateId
      ? await deps.appliedAlternateId(input.connector).catch(() => null)
      : (await loadAppliedAlternate(input.connector, client))?.alternate.id ?? null,
    now,
  }), (x) => ({ ok: true, note: `probe=${x.probe ?? "n/a"} derived=${x.derived?.state ?? "n/a"}` }))
  const s: HealSignals = signals ?? { probe: null, derived: null, shapeChange: null, appliedAlternateId: null, now }
  const decision = decideProviderHeal(adapter, s)
  report.decision = decision
  const evidence = { adapter: adapter.provider, version: adapter.api.version, probe: s.probe, derived: s.derived, shapeChange: s.shapeChange, decision }

  /** Apply ONE declared config alternate through the auto-applier, then retry ONCE (booked). */
  const applyAndRetry = async (alternate: DeclaredAlternate, reason: string, extra: Record<string, unknown> = {}): Promise<ProviderHealReport> => {
    const apply = deps.apply ?? applyDeclaredAlternate
    const sig = `HTTP {${input.failures.map((f) => f.status ?? "?").join(",")}} — ${reason}`
    const applied = await ledger("apply", { reason, alternate: alternate.id, ...evidence, ...extra },
      () => apply(client, { connector: input.connector, alternateId: alternate.id, failureSignature: sig, evidence: { ...evidence, ...extra } }),
      (x) => ({ ok: x.applied, note: x.reason }))
    report.applied = !!applied?.applied
    report.proposalId = applied?.proposalId ?? null
    if (!report.applied || !input.retry) return report
    // 2. RETRY ONCE under the applied alternate — ledgered, and booked only when it executed.
    report.retried = true
    const retried = await ledger("retry", { reason: `retry once under ${alternate.id}`, alternate: alternate.id }, () => input.retry!(),
      (x) => ({ ok: x.ok, note: x.ok ? "retry succeeded" : "retry failed" }))
    report.retryOk = retried?.ok ?? false
    const booked = await bookAdapterUsage(adapter, { brokerageId: input.brokerageId, executed: !!retried?.ok, units: retried?.units, systemSource: "provider_self_heal", usageType: "heal_retry" }, { meter: deps.meter })
    report.booked = booked ? 1 : 0
    return report
  }

  // 1b. UP but failing / drifting with no declared remedy → RESEARCH the provider's current setup
  //     (cost-capped, metered, cited). Never for a refused credential (a credential is a human's call).
  const upAndUnremedied = (decision.step === "propose" && decision.proposalKind !== "rotate_key") || (decision.step === "none" && input.failures.length > 0)
  if (upAndUnremedied && input.research) {
    const capUsd = input.research.capUsd
    const rs = await ledger("research", { reason: `research ${adapter.provider}'s current setup (docs / changelog / status / SDK) — cap $${capUsd}`, adapter: adapter.provider, version: adapter.api.version },
      () => researchProviderSetup(adapter, input, capUsd, deps),
      (x) => x.ok ? { ok: true, note: `${x.finding.change}: ${x.finding.summary} [${x.citations.length} cited]`, costUsd: x.costUsd } : { ok: false, note: x.reason, costUsd: x.costUsd })
    if (rs?.ok && rs.finding.change !== "none") {
      report.research = { finding: rs.finding, citations: rs.citations, costUsd: rs.costUsd }
      const researched = { finding: rs.finding, citations: rs.citations }
      const alt = matchDeclaredConfigAlternate(adapter, rs.finding, s.appliedAlternateId)
      if (alt && rs.finding.confidence >= (input.research.autoApplyMinConfidence ?? 0)) return applyAndRetry(alt, `researched ${rs.finding.change} (${rs.finding.newVersion ?? rs.finding.newBaseUrl}) matches declared config alternate ${alt.id}`, { researched })
      if (rs.finding.change !== "outage") {
        const proposalKind = rs.finding.change === "auth_change" ? "auth_change" : rs.finding.change === "shape_change" ? "shape_update" : "endpoint_change"
        const r = await ledger("propose", { reason: `researched code-level ${rs.finding.change} — a proposal carrying ${rs.citations.length} citation(s)`, ...evidence, researched },
          () => propose({ connector: input.connector, failures: input.failures, currentRequest: { adapterVersion: adapter.api.version, baseUrl: adapter.api.baseUrl }, researched: { proposalKind, summary: rs.finding.summary, finding: rs.finding, citations: rs.citations, confidence: rs.finding.confidence } }),
          (x) => ({ ok: !!x.proposal, note: x.proposal ? `proposal ${x.proposal.id} (${proposalKind}, researched)` : `proposal not written: ${x.error}` }))
        report.proposalId = r?.proposal?.id ?? null
        return report
      }
      // outage → the router's derived health owns it; the cited finding stays on the research row.
    }
  }

  switch (decision.step) {
    case "failover":
    case "escalate":
    case "none": {
      await ledger(decision.step, { reason: decision.reason, ...evidence }, async () => decision, () => ({ ok: decision.step !== "escalate", note: decision.reason }))
      if (decision.step === "escalate") {
        const r = await propose({ connector: input.connector, failures: input.failures }).catch(() => null)
        report.proposalId = r?.proposal?.id ?? null
      }
      return report
    }
    case "propose": {
      const r = await ledger("propose", { reason: decision.reason, ...evidence },
        () => propose({ connector: input.connector, failures: input.failures, currentRequest: { adapterVersion: adapter.api.version, baseUrl: adapter.api.baseUrl, proposalKind: decision.proposalKind } }),
        (x) => ({ ok: !!x.proposal, note: x.proposal ? `proposal ${x.proposal.id} (${decision.proposalKind})` : `proposal not written: ${x.error}` }))
      report.proposalId = r?.proposal?.id ?? null
      return report
    }
    case "apply_declared":
      return applyAndRetry(decision.alternate, decision.reason)
  }
}
