// lib/kernel/provider-config-healing.ts
// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT C25 — GOVERNED PROVIDER-CONFIGURATION SELF-HEAL (wave 148, lane 148I; owner ruling 15, 2026-11-01):
//   "some coding self healing is acceptable as long as it doesn't break the rest of the OS such as configuration change of a
//    provider if there was a change in the connection method etc."
//
// NOT A NEW HEALER (LAW 1/2). The rails exist: the adapter declarations list each provider's KNOWN ALTERNATES at config level
// (lib/kernel/provider-adapters.ts — an API version query / header, a declared base URL: code-reviewed, proof-tested), the
// auto-applier applies one (lib/agentic-os/connector-auto-applier.ts applyDeclaredAlternate — the evidence row stores the
// alternate ID, never the config), egress carries the newest APPLIED one (lib/agentic-os/connector-gateway.ts
// loadAppliedAlternate), the provider healer probes and retries (lib/agentic-os/connector-healer.ts healProviderFailure),
// the one proposal writer holds anything else for platform staff (recordHealingProposal), the self-healing policy bounds it
// (lib/kernel/healing-policy.ts), and ruling 14's classifier says what is safe (lib/kernel/improvement-proposals.ts).
// What none of them did: make the configuration change REVERSIBLE and TESTED as one governed act.
//
// healProviderConfiguration(change) —
//   1. CLASSIFY (classifyProviderConfigChange → GovernedChangeVerdict): a DECLARED config-level alternate is a safe
//      `self_healing_repair` (the config is code that was reviewed and tested; the runtime only selects it); a runtime route
//      around a provider is `provider_failover` (routeCapability — never persisted); a credential or auth-scheme change is
//      `credentials`; a code-level change (endpoint shape, a renamed parameter, an UNdeclared alternate) is a
//      `production_source_edit`; a PERSISTED vendor switch for a tenant is `tenant_authority`. Consequential → step 5.
//   2. POLICY — the platform healing ceiling (the providers are platform-level): unreadable → refuse (fail closed); the
//      `failover` remediation class (the playbook provider heals run under) must be allowed; the finding's confidence must
//      clear auto_fix_min_confidence.
//   3. VERSIONED APPLY — the version before (the newest applied alternate, or the base declaration) is read and recorded;
//      the apply writes the new version (a connector_healing_proposals row, old/new in its payload).
//   4. TESTED — the change is verified (the caller's probe / one retry under it); a FAILED verification REVERTS at once:
//      the new version flips applied → reverted and egress falls back to the version before (loadAppliedAlternate reads the
//      newest APPLIED row). Every step is ledgered (provider.config_heal.classify / apply / verify / revert / propose).
//   5. CONSEQUENTIAL — never applied: ONE change request through the one proposal writer carrying the change-control
//      requirements (human approval, a versioned change, passing tests, deployment authorization — CHANGE_CONTROL_HOW). No
//      healer, manager or runtime path edits code, commits, deploys or applies a migration.
// revertProviderConfiguration is the same reversal for a person (the platform healing console) — append-only evidence.

import { CHANGE_CONTROL_HOW, CHANGE_CONTROL_REQUIREMENTS, governedChangeVerdict, type GovernedChangeVerdict } from "@/lib/kernel/improvement-proposals"

type Svc = { from: (t: string) => any }

/** The connector_healing_proposals.status vocabulary (m928 CHECK) — `reverted` is C25's: a version taken back. */
export const HEALING_PROPOSAL_STATUSES = ["pending", "applied", "rejected", "reverted"] as const
export type HealingProposalStatus = (typeof HEALING_PROPOSAL_STATUSES)[number]

const PROVIDER_CONFIG_CHANGE_KINDS = ["declared_config_alternate", "runtime_failover", "persisted_mapping", "credential", "auth_scheme", "code_level"] as const
type ProviderConfigChangeKind = (typeof PROVIDER_CONFIG_CHANGE_KINDS)[number]

interface ProviderConfigChange {
  kind: ProviderConfigChangeKind
  connector: string
  /** declared_config_alternate: the alternate's id on the adapter declaration. */
  alternateId?: string | null
  /** persisted_mapping / runtime_failover: the capability and the provider it would move to. */
  capability?: string | null
  toProvider?: string | null
  summary: string
  /** 0..1 — the finding's confidence (a research finding / a probe verdict). */
  confidence: number
  evidence?: Record<string, unknown>
  /** code_level: which kind of change platform staff would review. */
  proposalKind?: "endpoint_change" | "shape_update" | "param_rename" | "auth_change"
}

/** PURE — ruling 14's class of a provider-configuration change (derived from the change, never from who proposes it). */
export function classifyProviderConfigChange(change: ProviderConfigChange, ctx: { declaredConfigAlternate: boolean }): GovernedChangeVerdict {
  switch (change.kind) {
    case "declared_config_alternate":
      return ctx.declaredConfigAlternate
        ? governedChangeVerdict("self_healing_repair", `${change.alternateId} is a config-level alternate the ${change.connector} adapter DECLARES in code — the runtime only selects reviewed, tested configuration`)
        : governedChangeVerdict("production_source_edit", `${change.alternateId ?? "the alternate"} is not a declared config-level alternate of ${change.connector} — adding one is a code change`)
    case "runtime_failover":
      return governedChangeVerdict("provider_failover", `route ${change.capability ?? "the capability"} around ${change.connector} through routeCapability (health-driven, not persisted)`)
    case "persisted_mapping":
      return governedChangeVerdict("tenant_authority", `persisting ${change.capability ?? "a capability"} onto ${change.toProvider ?? "another provider"} changes who processes the tenant's data — the tenant decides`)
    case "credential":
    case "auth_scheme":
      return governedChangeVerdict("credentials", `${change.connector}: a credential / authentication-scheme change — the account owner reconnects; no healer writes a credential`)
    case "code_level":
    default:
      return governedChangeVerdict("production_source_edit", `${change.connector}: a code-level change (${change.proposalKind ?? "endpoint / shape"}) — a reviewed commit, passing tests and an authorized deploy`)
  }
}

interface ProviderConfigHealDeps {
  /** The platform healing ceiling as an effective policy (default: loadPlatformHealingCeilings → resolveHealingPolicy). */
  policy?: () => Promise<{ readable: boolean; allowedRemediationClasses: readonly string[] | null; autoFixMinConfidence: number; note: string | null }>
  isDeclaredConfigAlternate?: (connector: string, alternateId: string) => boolean
  /** The version in force before (default: connector-gateway loadAppliedAlternate → its proposal row). */
  currentVersion?: (connector: string) => Promise<{ proposalId: string | null; alternateId: string | null }>
  apply?: (svc: Svc, p: { connector: string; alternateId: string; failureSignature: string; evidence: Record<string, unknown> }) => Promise<{ applied: boolean; proposalId: string | null; reason: string }>
  /** The TEST: a probe / one retry under the applied configuration. Absent → unverified → reverted (fail closed). */
  verify?: () => Promise<{ ok: boolean; detail: string }>
  propose?: (svc: Svc, row: { connector: string; failure_signature: string; failure_sample: unknown; proposal_kind: string; proposal_summary: string; proposal_payload: Record<string, unknown>; docs_evidence: unknown[]; confidence: number }) => Promise<{ id: string | null; error: string | null }>
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
  /** The ledger's tenant anchor for a platform-level heal (the tenant whose traffic surfaced it). */
  brokerageId: string
  cycle: string
}

interface ProviderConfigHealReport {
  verdict: GovernedChangeVerdict
  outcome: "applied_and_verified" | "applied_then_reverted" | "change_request" | "refused" | "routed_at_runtime"
  versionBefore: { proposalId: string | null; alternateId: string | null } | null
  versionAfter: { proposalId: string | null; alternateId: string | null } | null
  proposalId: string | null
  reason: string
}

/** C25 — one governed provider-configuration change: classify → policy → versioned apply → test → keep or revert. Never throws. */
export async function healProviderConfiguration(svc: Svc, change: ProviderConfigChange, deps: ProviderConfigHealDeps): Promise<ProviderConfigHealReport> {
  const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
  const step = <T>(name: string, detail: Record<string, unknown>, run: () => Promise<T>, judge: (r: T) => { ok: boolean; note: string }) =>
    ledger<T | null>(
      {
        brokerageId: deps.brokerageId, action: `provider.config_heal.${name}`, actor: { type: "manager", managerKey: "data_steward" },
        subject: { type: "provider", ref: change.connector }, reasonCode: "OS_HEALTH_RECOVERY", reasonDetail: change.summary.slice(0, 500),
        idempotencyKey: `provider_config_heal:${change.connector}:${change.alternateId ?? change.kind}:${name}:${deps.cycle}`,
        riskClass: "LOW_RISK_WRITE", systemSource: "provider_config_heal", policyKey: "self_healing",
        detail: { contract: "C25", change: { ...change, evidence: undefined }, ...detail },
      },
      run,
      {
        settle: (r) => { const j = r === null ? { ok: false, note: "no result" } : judge(r as T); return { status: j.ok ? "executed" : "failed", outcome: j.note.slice(0, 300), error: j.ok ? null : j.note.slice(0, 300), provider: change.connector } },
        // A step that did not run is NEVER a success: a refused claim (the ledger could not record it) and a replay / an
        // in-flight claim (this cycle already ran it) all return null — the caller then applies nothing / keeps nothing.
        replay: (claim) => { if (claim.kind === "refused") console.error(`[provider-config-healing] ${name} for ${change.connector} not run — the action ledger refused: ${claim.error}`); return null },
      },
      { client: svc as never },
    )
  const declared = change.kind === "declared_config_alternate" && !!change.alternateId
    ? (deps.isDeclaredConfigAlternate ?? (await defaultIsDeclared()))(change.connector, change.alternateId)
    : false
  const verdict = classifyProviderConfigChange(change, { declaredConfigAlternate: declared })
  const base = { verdict, versionBefore: null, versionAfter: null, proposalId: null } as const
  await step("classify", { governed_change: verdict }, async () => verdict, () => ({ ok: true, note: `${verdict.class} (${verdict.verdict})` }))

  // 5. CONSEQUENTIAL → one change request, never applied.
  if (verdict.verdict === "consequential") {
    const propose = deps.propose ?? defaultPropose
    const r = await step("propose", { change_control: CHANGE_CONTROL_REQUIREMENTS }, () => propose(svc, {
      connector: change.connector, failure_signature: change.summary.slice(0, 300), failure_sample: [change.evidence ?? {}],
      proposal_kind: "change_request", proposal_summary: `C25 ${verdict.class}: ${change.summary}`.slice(0, 500),
      proposal_payload: { change: { ...change, evidence: undefined }, governed_change: verdict, change_control: CHANGE_CONTROL_HOW },
      docs_evidence: [], confidence: change.confidence,
    }), (x) => ({ ok: !!x.id, note: x.id ? `change request ${x.id}` : `change request not written: ${x.error}` }))
    return { ...base, outcome: "change_request", proposalId: r?.id ?? null, reason: `${verdict.reason} — a change request for platform staff (${CHANGE_CONTROL_REQUIREMENTS.join(", ")}); nothing applied` }
  }
  if (change.kind === "runtime_failover") return { ...base, outcome: "routed_at_runtime", reason: `${verdict.reason} — the router does this per call (self-healing failover playbook); nothing is persisted` }

  // 2. POLICY (platform ceiling; fail closed).
  const policy = await (deps.policy ?? defaultPolicy(svc))()
  if (!policy.readable) return { ...base, outcome: "refused", reason: `the self-healing policy is unreadable (${policy.note ?? "no detail"}) — nothing applied (fail closed)` }
  if (policy.allowedRemediationClasses !== null && !policy.allowedRemediationClasses.includes("failover")) return { ...base, outcome: "refused", reason: "the healing policy does not allow provider remediation (failover) — a person applies it" }
  if (!(change.confidence >= policy.autoFixMinConfidence)) return { ...base, outcome: "refused", reason: `confidence ${change.confidence} is below the policy's auto-fix floor ${policy.autoFixMinConfidence} — a person approves` }

  // 3. VERSIONED APPLY.
  const before = await (deps.currentVersion ?? defaultCurrentVersion(svc))(change.connector).catch(() => ({ proposalId: null, alternateId: null }))
  if (before.alternateId && before.alternateId === change.alternateId) return { ...base, versionBefore: before, versionAfter: before, outcome: "refused", reason: `${change.alternateId} is already the applied version — nothing to change` }
  const apply = deps.apply ?? defaultApply
  const applied = await step("apply", { version_before: before }, () => apply(svc, { connector: change.connector, alternateId: change.alternateId!, failureSignature: change.summary, evidence: { ...(change.evidence ?? {}), version_before: before, contract: "C25" } }),
    (x) => ({ ok: x.applied, note: x.reason }))
  if (!applied?.applied) return { ...base, versionBefore: before, outcome: "refused", reason: `not applied: ${applied?.reason ?? "the apply replayed"}` }
  const after = { proposalId: applied.proposalId, alternateId: change.alternateId ?? null }

  // 4. TESTED — keep on a passing verification; REVERT on a failing (or absent) one.
  const verified = await step("verify", { version_after: after }, async () => (deps.verify ? deps.verify().catch((e: Error) => ({ ok: false, detail: `verification threw: ${e.message}` })) : { ok: false, detail: "no verification was supplied — an untested change is not kept" }),
    (x) => ({ ok: x.ok, note: x.detail }))
  if (verified?.ok) return { ...base, versionBefore: before, versionAfter: after, proposalId: applied.proposalId, outcome: "applied_and_verified", reason: `${change.alternateId} applied and verified (${verified.detail}); version before: ${before.alternateId ?? "the base declaration"}` }
  const reverted = applied.proposalId ? await revertProviderConfiguration(svc, { proposalId: applied.proposalId, actor: "auto", reason: `verification failed: ${verified?.detail ?? "no result"}` }, { ledger, brokerageId: deps.brokerageId, cycle: deps.cycle }) : { ok: false, error: "no version row to revert" }
  return { ...base, versionBefore: before, versionAfter: before, proposalId: applied.proposalId, outcome: "applied_then_reverted", reason: `${change.alternateId} failed its test (${verified?.detail ?? "no result"}) — ${reverted.ok ? `reverted; egress is back on ${before.alternateId ?? "the base declaration"}` : `REVERT FAILED (${reverted.error}) — a person must take it back`}` }
}

/**
 * C25's reversal — the applied version flips applied → reverted (COUNTED: an update that matched nothing resolves too), so
 * egress falls back to the newest still-applied version (or the base declaration). The row and its evidence stay. Never throws.
 */
export async function revertProviderConfiguration(
  svc: Svc,
  p: { proposalId: string; actor: "auto" | string; reason: string },
  deps: { ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger; brokerageId?: string | null; cycle?: string } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if ((p.reason ?? "").trim().length < 10) return { ok: false, error: "a reversal carries its reason (at least 10 characters)" }
    const flip = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      const { data, error } = await svc.from("connector_healing_proposals")
        .update({ status: "reverted", notes: `reverted by ${p.actor} at ${new Date().toISOString()}: ${p.reason}`.slice(0, 1000) })
        .eq("id", p.proposalId).eq("status", "applied").select("id")
      if (error) return { ok: false, error: error.message }
      if (!Array.isArray(data) || data.length !== 1) return { ok: false, error: "no applied version matched (already reverted, or never applied)" }
      return { ok: true }
    }
    if (!deps.brokerageId) return await flip()
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    const r = await ledger<{ ok: true } | { ok: false; error: string }>(
      {
        brokerageId: deps.brokerageId, action: "provider.config_heal.revert", actor: p.actor === "auto" ? { type: "manager", managerKey: "data_steward" } : { type: "user", userId: p.actor },
        subject: { type: "connector_healing_proposal", id: p.proposalId }, reasonCode: p.actor === "auto" ? "OS_HEALTH_RECOVERY" : "HUMAN_REQUESTED", reasonDetail: p.reason.slice(0, 500),
        idempotencyKey: `provider_config_revert:${p.proposalId}:${deps.cycle ?? "manual"}`, riskClass: "LOW_RISK_WRITE", systemSource: "provider_config_heal", detail: { contract: "C25", proposal_id: p.proposalId },
      },
      flip,
      { settle: (x) => (x.ok ? { status: "executed", outcome: "reverted" } : { status: "failed", outcome: "not_reverted", error: x.error }), replay: (c) => (c.kind === "refused" ? { ok: false, error: `the ledger refused (${c.error}) — nothing reverted` } : { ok: true }) },
      { client: svc as never },
    )
    return r
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── defaults (lazy — this module stays light) ───────────────────────────────────────────────────

async function defaultIsDeclared(): Promise<(connector: string, alternateId: string) => boolean> {
  const { declaredConfigAlternate } = await import("@/lib/kernel/provider-adapters")
  return (c, a) => !!declaredConfigAlternate(c, a)
}

function defaultPolicy(svc: Svc) {
  return async () => {
    const { loadPlatformHealingCeilings, resolveHealingPolicy } = await import("@/lib/kernel/healing-policy")
    const ceiling = await loadPlatformHealingCeilings(svc as never)
    if (!ceiling.ok) return { readable: false, allowedRemediationClasses: [] as string[], autoFixMinConfidence: 1, note: ceiling.error }
    const r = resolveHealingPolicy(null, ceiling.raw)
    return { readable: true, allowedRemediationClasses: r.allowedRemediationClasses, autoFixMinConfidence: r.autoFixMinConfidence, note: null }
  }
}

function defaultCurrentVersion(svc: Svc) {
  return async (connector: string) => {
    const { data, error } = await svc.from("connector_healing_proposals").select("id, proposal_payload")
      .eq("connector", connector).eq("proposal_kind", "declared_alternate").eq("status", "applied").order("applied_at", { ascending: false }).limit(1).maybeSingle()
    if (error) throw new Error(error.message)
    const row = data as { id: string; proposal_payload: { alternate_id?: string } | null } | null
    return { proposalId: row?.id ?? null, alternateId: row?.proposal_payload?.alternate_id ?? null }
  }
}

async function defaultApply(svc: Svc, p: { connector: string; alternateId: string; failureSignature: string; evidence: Record<string, unknown> }) {
  const { applyDeclaredAlternate } = await import("@/lib/agentic-os/connector-auto-applier")
  return applyDeclaredAlternate(svc, p)
}

async function defaultPropose(svc: Svc, row: Parameters<NonNullable<ProviderConfigHealDeps["propose"]>>[1]) {
  const { recordHealingProposal } = await import("@/lib/agentic-os/connector-healer")
  const r = await recordHealingProposal(svc, row)
  return { id: r.id, error: r.error }
}
