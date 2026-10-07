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
import { adapterFor, decideProviderHeal, bookAdapterUsage, type HealDecision, type HealSignals, type ProbeVerdict } from "@/lib/kernel/provider-adapters"
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
}

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
    const { data, error: proposalInsErr } = await supabase.from("connector_healing_proposals").insert({
      connector:        params.connector,
      failure_signature: signature,
      failure_sample:   sample,
      ...row,
    }).select("id, connector, proposal_kind, proposal_summary, confidence, status").maybeSingle()
    if (proposalInsErr) console.error(`[connector-healer] healing proposal NOT recorded: ${proposalInsErr.message}`)
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
}

interface ProviderHealReport {
  decision: HealDecision | { step: "propose_unregistered"; reason: string }
  applied: boolean
  retried: boolean
  retryOk: boolean | null
  booked: number
  proposalId: string | null
}

export async function healProviderFailure(input: ProviderHealInput, deps: ProviderHealDeps = {}): Promise<ProviderHealReport> {
  const client = deps.client ?? createServiceClient()
  const now = deps.now ?? new Date()
  const propose = deps.propose ?? proposeConnectorHealing
  const report: ProviderHealReport = { decision: { step: "propose_unregistered", reason: "" }, applied: false, retried: false, retryOk: null, booked: 0, proposalId: null }
  const ledger = <T>(step: string, detail: Record<string, unknown>, run: () => Promise<T>, outcome: (r: T) => { ok: boolean; note: string }) =>
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
        detail,
      },
      run,
      {
        settle: (r) => {
          const o = r === null ? { ok: false, note: "no result" } : outcome(r as T)
          return { status: o.ok ? "executed" : "failed", outcome: o.note.slice(0, 300), provider: input.connector, error: o.ok ? null : o.note }
        },
        replay: () => null,
      },
      { client },
    )

  const adapter = adapterFor(input.connector)
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
    case "apply_declared": {
      const apply = deps.apply ?? applyDeclaredAlternate
      const sig = `HTTP {${input.failures.map((f) => f.status ?? "?").join(",")}} — ${decision.reason}`
      const applied = await ledger("apply", { reason: decision.reason, alternate: decision.alternate.id, ...evidence },
        () => apply(client, { connector: input.connector, alternateId: decision.alternate.id, failureSignature: sig, evidence }),
        (x) => ({ ok: x.applied, note: x.reason }))
      report.applied = !!applied?.applied
      report.proposalId = applied?.proposalId ?? null
      if (!report.applied || !input.retry) return report
      // 2. RETRY ONCE under the applied alternate — ledgered, and booked only when it executed.
      report.retried = true
      const retried = await ledger("retry", { reason: `retry once under ${decision.alternate.id}`, alternate: decision.alternate.id }, () => input.retry!(),
        (x) => ({ ok: x.ok, note: x.ok ? "retry succeeded" : "retry failed" }))
      report.retryOk = retried?.ok ?? false
      const booked = await bookAdapterUsage(adapter, { brokerageId: input.brokerageId, executed: !!retried?.ok, units: retried?.units, systemSource: "provider_self_heal", usageType: "heal_retry" }, { meter: deps.meter })
      report.booked = booked ? 1 : 0
      return report
    }
  }
}
