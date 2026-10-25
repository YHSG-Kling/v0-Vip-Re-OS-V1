// lib/compliance/vocabulary-healing.ts
//
// VOCABULARY SELF-HEALING — THE MANAGER PATH (wave 144, lane 144A; owner ruling 1). The server half of
// lib/compliance/adaptive-vocabulary.ts. It owns no store and no queue (LAW 1/2):
//
//   1. REPORT      a person says a label is missing / obsolete / different in their state (the settings
//                  screen, or any manager that hits an unreadable value) → reportVocabularyGap.
//   2. EVALUATE    the data steward's deterministic comparison against the canonical vocabulary
//                  (evaluateVocabularyReport): already resolves? an alias? a kind of an existing term?
//                  which scope — brokerage-wide or the named state? No model call: AI explains, this decides.
//   3. VALIDATE    dependencies (validateVocabularyChange): every new term rolls up to a platform key, a
//                  label never means two things, an alias is never re-pointed, a deactivation counts the
//                  required-document rules that name the term (they keep applying), a state-scoped change
//                  cites an official (.gov / .us) source.
//   4. PROPOSE     ONE improvement_proposals row (subject_kind `policy`, subject_key `adaptive_vocabulary`,
//                  proposer `human`) through the controlled-learning kernel (proposeEvaluatePromote, no
//                  actor) — it evaluates to EVALUATED ("a human decides") and shows on Manager Trust and on
//                  the required-documents settings screen.
//   5. APPROVE     approveVocabularyProposal: a tenant admin — and for a STATE-SCOPED change a compliance
//                  approver — re-validates against the LIVE vocabulary, then decideProposal → promoteProposal
//                  (mergeBrokerageSettings → appendTenantPolicyVersion, inside withActionLedger).
//   6. ATTEST      a state-scoped term is usable only once a compliance approver attests its primary source
//                  (attestVocabularyEntry — a versioned mergeBrokerageSettings write with the session actor,
//                  ledgered as compliance.vocabulary.attest). The approver who approves it attests in the
//                  same action.
//   7. VERIFY      the live vocabulary is re-read and must say what the change said (verifyVocabularyChange).
//
// Readers need no "sync" step: the resolver, the settings pickers, the rule-write validation and the
// required-document matcher read the live overlay on every call.
//
// Tenant: every function takes the brokerageId its CALLER resolved from the session (app/actions/compliance/
// vocabulary.ts) — never a body value. Every read reads its { error } and fails closed.

import "server-only"
import {
  ADAPTIVE_VOCABULARY_POLICY_KEY, attestationPatchFor, evaluateVocabularyReport, loadTenantVocabulary, resolveVocabularyValue,
  validateVocabularyChange, verifyVocabularyChange, vocabularyPatchFor,
  type TenantVocabulary, type VocabularyChange, type VocabularyEvaluation, type VocabularyReport, type VocabularyValidation,
} from "@/lib/compliance/adaptive-vocabulary"
import { isPrimarySourceUrl } from "@/lib/compliance-rules/law-rule-registry"
import {
  COMING_SOON_POLICY_KEY, evaluateComingSoonReadiness, loadComingSoonPolicy, validateComingSoonPolicyReport,
  type ComingSoonPolicyEntry, type ComingSoonPolicyReport,
} from "@/lib/compliance/coming-soon-policy"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import {
  OPEN_STATUSES, decideProposal, listImprovementProposals, loadProposal, promoteProposal, proposeEvaluatePromote,
  type ImprovementProposalRow, type ProposalStatus,
} from "@/lib/kernel/improvement-proposals"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any

/**
 * WHO MAY APPROVE A STATE-SCOPED (REGULATORY) VOCABULARY CHANGE OR ATTEST ITS SOURCE. Derived from the ONE
 * tenant roster by NAMED SUBTRACTION (CLAUDE.md §4), never retyped: minus `team_lead` (a team's lead does not
 * sign the brokerage's legal reading of a state's law) and minus `admin` (an operations seat). What remains is
 * the brokerage's broker of record / owner / broker admin and the compliance officer.
 */
export const VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES: ReadonlySet<string> = new Set(
  [...TENANT_ADMIN_USER_TYPES].filter((t) => t !== "team_lead" && t !== "admin"),
)

export interface VocabularyApprover { userId: string; userType: string | null; isTenantAdmin: boolean }

const isVocabularyProposal = (r: Pick<ImprovementProposalRow, "subject_kind" | "subject_key">) => r.subject_kind === "policy" && r.subject_key === ADAPTIVE_VOCABULARY_POLICY_KEY
const changeOf = (r: Pick<ImprovementProposalRow, "proposed_change">): VocabularyChange | null => {
  const c = (r.proposed_change ?? {}).vocabulary_change as VocabularyChange | undefined
  return c && typeof c === "object" && typeof c.op === "string" && typeof c.dimension === "string" ? c : null
}
const sameChange = (a: VocabularyChange | null, b: VocabularyChange | null) => !!a && !!b && JSON.stringify({ ...a, reason: "" }) === JSON.stringify({ ...b, reason: "" })

/** How many of this brokerage's required-document rules name the term (a deactivation's dependents). FAIL CLOSED. */
async function countRuleRefs(svc: Svc, brokerageId: string, change: VocabularyChange): Promise<{ ok: true; n: number } | { ok: false; error: string }> {
  if (change.op !== "deactivate" || (change.dimension !== "contract_subtype" && change.dimension !== "representation")) return { ok: true, n: 0 }
  const { data, error } = await svc.from("brokerage_required_documents").select("id").eq("brokerage_id", brokerageId).eq(change.dimension, change.key)
  if (error) return { ok: false, error: `the rules that name "${change.key}" could not be counted (${error.message}) — nothing proposed` }
  return { ok: true, n: (data ?? []).length }
}

export type ReportVocabularyGapResult =
  | { ok: true; outcome: "answered"; evaluation: VocabularyEvaluation }
  | { ok: true; outcome: "proposed"; evaluation: VocabularyEvaluation; validation: VocabularyValidation; proposalId: string; status: ProposalStatus | null; existing: boolean }
  | { ok: false; error: string; evaluation?: VocabularyEvaluation; validation?: VocabularyValidation }

/** Steps 1–4: a person's report → the evaluation → (when it implies a change) ONE validated proposal. Nothing is applied. */
export async function reportVocabularyGap(
  svc: Svc,
  input: { brokerageId: string; reporterUserId: string; report: VocabularyReport; now?: Date },
): Promise<ReportVocabularyGapResult> {
  const live = await loadTenantVocabulary(svc, input.brokerageId)
  if (!live.ok) return { ok: false, error: live.error }
  const evaluation = evaluateVocabularyReport(input.report, live.vocabulary)
  if (evaluation.verdict !== "propose" || !evaluation.change) return { ok: true, outcome: "answered", evaluation }
  const change = evaluation.change

  const refs = await countRuleRefs(svc, input.brokerageId, change)
  if (!refs.ok) return { ok: false, error: refs.error, evaluation }
  const validation = validateVocabularyChange(change, live.vocabulary, { ruleRefs: refs.n })
  if (!validation.ok) return { ok: false, error: `not proposed: ${validation.errors.join("; ")}`, evaluation, validation }

  // ONE open vocabulary proposal at a time (the kernel dedups on the policy key): the same change rides the
  // open row; a DIFFERENT change must not — proposeEvaluatePromote would hand back the other row.
  const list = await listImprovementProposals(svc, input.brokerageId, { limit: 100 })
  if (!list.ok) return { ok: false, error: list.error, evaluation, validation }
  const open = list.rows.find((r) => isVocabularyProposal(r) && OPEN_STATUSES.includes(r.status))
  if (open && !sameChange(changeOf(open), change)) {
    return { ok: false, error: `another vocabulary change is ${open.status} (${String((open.proposed_change ?? {}).summary ?? open.id)}) — approve or reject it first`, evaluation, validation }
  }
  if (open) return { ok: true, outcome: "proposed", evaluation, validation, proposalId: open.id, status: open.status, existing: true }

  const at = (input.now ?? new Date()).toISOString()
  const r = await proposeEvaluatePromote(svc, {
    brokerageId: input.brokerageId,
    subjectKind: "policy",
    subjectKey: ADAPTIVE_VOCABULARY_POLICY_KEY,
    proposer: "human",
    proposedChange: {
      patch: vocabularyPatchFor(change, live.vocabulary, at),
      vocabulary_change: change,
      summary: evaluation.why,
      requires_compliance: validation.requiresCompliance,
      warnings: validation.warnings,
      changed_keys: [ADAPTIVE_VOCABULARY_POLICY_KEY],
    },
    evidenceRefs: [{
      kind: "vocabulary_report", reporter_user_id: input.reporterUserId, dimension: input.report.dimension, label: input.report.label,
      report_kind: input.report.kind, state_code: input.report.stateCode ?? null, source_url: input.report.sourceUrl ?? null, at,
    }],
    actor: null,
  })
  if (!r.proposal.ok) return { ok: false, error: `not proposed: ${r.proposal.error}`, evaluation, validation }
  return { ok: true, outcome: "proposed", evaluation, validation, proposalId: r.proposal.id, status: r.status, existing: r.proposal.existing }
}

/** A field patch merged one nested level onto the live value — the same shape the proposal kernel applies. */
function mergeOneLevel(current: unknown, patch: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const base: Record<string, unknown> = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {}
  for (const [k, v] of Object.entries(patch)) base[k] = { ...((base[k] && typeof base[k] === "object" ? base[k] : {}) as Record<string, unknown>), ...v }
  return base
}

/**
 * A compliance approver's attestation, written as ONE versioned merge of one policy key (mergeBrokerageSettings with the
 * session actor → appendTenantPolicyVersion) inside withActionLedger (action compliance.<subject>.attest, risk LEGAL).
 */
async function ledgeredAttestation(
  svc: Svc, brokerageId: string, policyKey: string, patch: Record<string, Record<string, unknown>>,
  ledger: { subject: string; ref: string; idempotency: string; detail: string; approver: VocabularyApprover; extra: Record<string, unknown> },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { mergeBrokerageSettings } = await import("@/lib/settings/brokerage-settings-merge")
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<{ ok: true } | { ok: false; error: string }>(
    {
      brokerageId, action: `compliance.${ledger.subject}.attest`,
      actor: { type: "user", userId: ledger.approver.userId },
      subject: { type: ledger.subject, ref: ledger.ref },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: ledger.detail.slice(0, 500),
      idempotencyKey: `compliance.${ledger.subject}.attest:${brokerageId}:${ledger.ref}:${ledger.idempotency}`,
      riskClass: "LEGAL", systemSource: "vocabulary_healing", policyKey,
      detail: { ...ledger.extra, approver_user_type: ledger.approver.userType },
    },
    async () => {
      const w = await mergeBrokerageSettings(svc, brokerageId, (cur) => ({ [policyKey]: mergeOneLevel(cur[policyKey], patch) }), {
        policy: { type: "user", userId: ledger.approver.userId, reason: ledger.detail.slice(0, 500) },
      })
      return w.ok ? { ok: true as const } : { ok: false as const, error: w.error }
    },
    {
      settle: (r) => (r.ok ? { status: "executed", outcome: "attested" } : { status: "failed", outcome: "writer_refused", error: r.error }),
      replay: (claim) => (claim.kind === "replay" ? { ok: true as const } : { ok: false as const, error: `the ledger refused the attestation: ${claim.kind}` }),
    },
    { client: svc },
  )
}

/** Step 6: a compliance approver attests a state-scoped term's primary source (versioned + ledgered). */
async function writeAttestation(svc: Svc, brokerageId: string, change: Extract<VocabularyChange, { op: "add" }> | { dimension: VocabularyChange["dimension"]; key: string }, vocab: TenantVocabulary, approver: VocabularyApprover, at: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const term = vocab.terms[`${change.dimension}:${change.key}`]
  if (!term || !term.state_codes) return { ok: false, error: `"${change.key}" is not a state-scoped term of this brokerage` }
  if (!isPrimarySourceUrl(term.source?.url ?? null)) return { ok: false, error: `"${term.label}" cites no official (.gov / .us) source — it cannot be attested` }
  return ledgeredAttestation(svc, brokerageId, ADAPTIVE_VOCABULARY_POLICY_KEY, attestationPatchFor(term, { userId: approver.userId, userType: String(approver.userType ?? "") }, at), {
    subject: "vocabulary", ref: `${term.dimension}:${term.key}`, idempotency: String(term.source?.url ?? ""), approver,
    detail: `compliance attestation of ${term.dimension} "${term.label}" for ${term.state_codes.join(", ")} — source ${term.source?.url}`,
    extra: { dimension: term.dimension, key: term.key, state_codes: term.state_codes, source: term.source },
  })
}

// ── THE MLS COMING-SOON POLICY (handed over by lane 144B) — the same path, always a compliance approver ─────────────

const isComingSoonProposal = (r: Pick<ImprovementProposalRow, "subject_kind" | "subject_key">) => r.subject_kind === "policy" && r.subject_key === COMING_SOON_POLICY_KEY

export type ReportComingSoonPolicyResult =
  | { ok: true; proposalId: string; status: ProposalStatus | null; existing: boolean }
  | { ok: false; error: string; errors?: string[] }

/** A person records their MLS's coming-soon rule (with its published source) → ONE validated proposal. Nothing is applied. */
export async function reportComingSoonPolicy(
  svc: Svc,
  input: { brokerageId: string; reporterUserId: string; report: ComingSoonPolicyReport; now?: Date },
): Promise<ReportComingSoonPolicyResult> {
  const at = (input.now ?? new Date()).toISOString()
  const v = validateComingSoonPolicyReport(input.report, at)
  if (!v.ok) return { ok: false, error: "not proposed — the rule must be stated from the MLS's own published rules", errors: v.errors }
  const list = await listImprovementProposals(svc, input.brokerageId, { limit: 100 })
  if (!list.ok) return { ok: false, error: list.error }
  const open = list.rows.find((r) => isComingSoonProposal(r) && OPEN_STATUSES.includes(r.status))
  const comparable = (e: ComingSoonPolicyEntry | undefined) => (e ? JSON.stringify({ ...e, updated_at: null, source: { ...e.source, verified_on: null } }) : "")
  const sameEntry = (r: ImprovementProposalRow) => comparable((r.proposed_change ?? {}).coming_soon_entry as ComingSoonPolicyEntry | undefined) === comparable(v.entry)
  if (open && !sameEntry(open)) return { ok: false, error: `another coming-soon rule is ${open.status} — approve or reject it first` }
  if (open) return { ok: true, proposalId: open.id, status: open.status, existing: true }
  const r = await proposeEvaluatePromote(svc, {
    brokerageId: input.brokerageId, subjectKind: "policy", subjectKey: COMING_SOON_POLICY_KEY, proposer: "human",
    proposedChange: {
      patch: { mls: { [v.entry.mls_slug]: v.entry } }, coming_soon_entry: v.entry, requires_compliance: true, changed_keys: [COMING_SOON_POLICY_KEY],
      summary: `${v.entry.mls_name} (${v.entry.state_codes.join(", ")}): coming soon ${v.entry.permitted ? "permitted" : "not permitted"}${v.entry.max_days !== null ? `, max ${v.entry.max_days} days` : ""}, showings ${v.entry.showings_permitted ? "permitted" : "not permitted"}${v.entry.mls_submission_within_business_days !== null ? `, MLS within ${v.entry.mls_submission_within_business_days} business day(s) of public marketing` : ""} — ${v.entry.source.rule_ref}`,
    },
    evidenceRefs: [{ kind: "mls_rule_report", reporter_user_id: input.reporterUserId, mls_name: v.entry.mls_name, source_url: v.entry.source.url, rule_ref: v.entry.source.rule_ref, at }],
    actor: null,
  })
  if (!r.proposal.ok) return { ok: false, error: `not proposed: ${r.proposal.error}` }
  return { ok: true, proposalId: r.proposal.id, status: r.status, existing: r.proposal.existing }
}

async function approveComingSoonProposal(svc: Svc, input: { brokerageId: string; row: ImprovementProposalRow; approver: VocabularyApprover; now?: Date }): Promise<ApproveVocabularyResult> {
  const { row, approver } = input
  if (!VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has(String(approver.userType ?? ""))) {
    return { ok: false, error: `an MLS coming-soon rule is approved by a compliance approver (${[...VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES].join(", ")})` }
  }
  const at = (input.now ?? new Date()).toISOString()
  const entry = (row.proposed_change ?? {}).coming_soon_entry as ComingSoonPolicyEntry | undefined
  const recheck = entry ? validateComingSoonPolicyReport({
    mlsName: entry.mls_name, stateCodes: entry.state_codes, permitted: entry.permitted, maxDays: entry.max_days, showingsPermitted: entry.showings_permitted,
    mlsSubmissionWithinBusinessDays: entry.mls_submission_within_business_days, sourceUrl: entry.source?.url ?? null, ruleRef: entry.source?.rule_ref ?? null, sourceTitle: entry.source?.title ?? null,
  }, at) : null
  if (!entry || !recheck?.ok) return { ok: false, error: "the proposal carries no valid coming-soon rule — reject it", errors: recheck && !recheck.ok ? recheck.errors : [] }
  const actor = { type: "user" as const, userId: approver.userId, isTenantAdmin: true, userType: approver.userType ?? null, reason: `MLS coming-soon rule approved: ${String(row.proposed_change?.summary ?? entry.mls_name)}`.slice(0, 500) }
  if (row.status === "EVALUATED") {
    const d = await decideProposal(svc, { brokerageId: input.brokerageId, id: row.id, decision: "approve", actor, reason: actor.reason })
    if (!d.ok) return { ok: false, error: d.error }
  }
  const p = await promoteProposal(svc, { brokerageId: input.brokerageId, id: row.id, actor })
  if (!p.ok) return { ok: false, error: p.error }
  const a = await ledgeredAttestation(svc, input.brokerageId, COMING_SOON_POLICY_KEY,
    { mls: { [entry.mls_slug]: { ...entry, attestation: { user_id: approver.userId, user_type: String(approver.userType ?? ""), at } } } },
    { subject: "coming_soon_policy", ref: entry.mls_slug, idempotency: row.id, approver, detail: `compliance attestation of ${entry.mls_name}'s coming-soon rule (${entry.source.rule_ref}) — ${entry.source.url}`, extra: { mls_slug: entry.mls_slug, state_codes: entry.state_codes, source: entry.source } })
  if (!a.ok) return { ok: false, error: `PROMOTED (${p.policyVersionRef ?? "new version"}) but not attested: ${a.error}` }
  const after = await loadComingSoonPolicy(svc, input.brokerageId)
  if (!after.ok) return { ok: false, error: `PROMOTED but not verified: ${after.error}` }
  const verdict = evaluateComingSoonReadiness(after.policy, { mlsSlug: entry.mls_slug })
  return { ok: true, policyVersionRef: p.policyVersionRef, attested: true, verified: verdict.status === "attested", why: verdict.status === "attested" ? `${entry.mls_name}'s coming-soon rule is attested and read at the coming-soon door` : verdict.blockers.join("; ") }
}

export type ApproveVocabularyResult =
  | { ok: true; policyVersionRef: string | null; attested: boolean; verified: boolean; why: string }
  | { ok: false; error: string; errors?: string[] }

/** Steps 5–7: approve → promote through the kernel → (state-scoped add) attest → verify against the live value. */
export async function approveVocabularyProposal(
  svc: Svc,
  input: { brokerageId: string; proposalId: string; approver: VocabularyApprover; now?: Date },
): Promise<ApproveVocabularyResult> {
  const { approver } = input
  if (!approver.isTenantAdmin) return { ok: false, error: "only a broker, owner, admin, team lead or compliance officer approves a vocabulary change" }
  const got = await loadProposal(svc, input.brokerageId, input.proposalId)
  if (!got.ok) return { ok: false, error: got.error }
  const row = got.row
  if (row.status !== "EVALUATED" && row.status !== "APPROVED") return { ok: false, error: `the proposal is ${row.status}` }
  if (isComingSoonProposal(row)) return approveComingSoonProposal(svc, { brokerageId: input.brokerageId, row, approver, now: input.now })
  if (!isVocabularyProposal(row)) return { ok: false, error: "that proposal is not a vocabulary change" }
  const change = changeOf(row)
  if (!change) return { ok: false, error: "the proposal carries no vocabulary change — reject it" }

  const live = await loadTenantVocabulary(svc, input.brokerageId)
  if (!live.ok) return { ok: false, error: live.error }
  const refs = await countRuleRefs(svc, input.brokerageId, change)
  if (!refs.ok) return { ok: false, error: refs.error }
  const validation = validateVocabularyChange(change, live.vocabulary, { ruleRefs: refs.n })
  if (!validation.ok) return { ok: false, error: "the change no longer validates against the live vocabulary — reject it and report again", errors: validation.errors }
  if (validation.requiresCompliance && !VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has(String(approver.userType ?? ""))) {
    return { ok: false, error: `a state-scoped change needs a compliance approver (${[...VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES].join(", ")}) — the platform never enables a state rule on an operator's say-so` }
  }
  // A retire / reactivate carries a snapshot of the brokerage term; if the live term moved since, the snapshot is stale.
  if ((change.op === "deactivate" || change.op === "reactivate") && live.vocabulary.terms[`${change.dimension}:${change.key}`]) {
    const stored = ((row.proposed_change?.patch as Record<string, Record<string, Record<string, unknown>>> | undefined)?.terms ?? {})[`${change.dimension}:${change.key}`] ?? {}
    const strip = (o: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !["active", "deactivated_at", "reactivated_at", "reason"].includes(k)).sort()))
    if (strip(stored) !== strip(live.vocabulary.terms[`${change.dimension}:${change.key}`] as unknown as Record<string, unknown>)) {
      return { ok: false, error: "the term changed after this proposal was recorded — reject it and report again" }
    }
  }

  const actor = { type: "user" as const, userId: approver.userId, isTenantAdmin: true, userType: approver.userType ?? null, reason: `vocabulary change approved from the required-documents settings: ${String(row.proposed_change?.summary ?? change.op)}`.slice(0, 500) }
  if (row.status === "EVALUATED") {
    const d = await decideProposal(svc, { brokerageId: input.brokerageId, id: row.id, decision: "approve", actor, reason: actor.reason })
    if (!d.ok) return { ok: false, error: d.error }
  }
  const p = await promoteProposal(svc, { brokerageId: input.brokerageId, id: row.id, actor })
  if (!p.ok) return { ok: false, error: p.error }

  const at = (input.now ?? new Date()).toISOString()
  let attested = false
  if (change.op === "add" && change.stateCodes && change.stateCodes.length) {
    const afterPromote = await loadTenantVocabulary(svc, input.brokerageId)
    if (!afterPromote.ok) return { ok: false, error: `PROMOTED (${p.policyVersionRef ?? "new version"}) but not attested: ${afterPromote.error}` }
    const a = await writeAttestation(svc, input.brokerageId, change, afterPromote.vocabulary, approver, at)
    if (!a.ok) return { ok: false, error: `PROMOTED (${p.policyVersionRef ?? "new version"}) but not attested: ${a.error}` }
    attested = true
  }
  const after = await loadTenantVocabulary(svc, input.brokerageId)
  if (!after.ok) return { ok: false, error: `PROMOTED (${p.policyVersionRef ?? "new version"}) but not verified: ${after.error}` }
  const v = verifyVocabularyChange(change, after.vocabulary)
  return { ok: true, policyVersionRef: p.policyVersionRef, attested, verified: v.ok, why: v.why }
}

/** Step 6 on its own: attest a state-scoped term that was promoted without one (e.g. from the Manager Trust panel). */
export async function attestVocabularyEntry(
  svc: Svc,
  input: { brokerageId: string; dimension: VocabularyChange["dimension"]; key: string; approver: VocabularyApprover; now?: Date },
): Promise<{ ok: true; why: string } | { ok: false; error: string }> {
  if (!VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has(String(input.approver.userType ?? ""))) return { ok: false, error: "only a compliance approver attests a state-scoped term" }
  const live = await loadTenantVocabulary(svc, input.brokerageId)
  if (!live.ok) return { ok: false, error: live.error }
  const r = resolveVocabularyValue(input.dimension, input.key, live.vocabulary)
  if (!r || r.origin !== "tenant" || !r.pendingAttestation) return { ok: false, error: `"${input.key}" is not a state-scoped term awaiting attestation` }
  const a = await writeAttestation(svc, input.brokerageId, { dimension: input.dimension, key: r.key }, live.vocabulary, input.approver, (input.now ?? new Date()).toISOString())
  if (!a.ok) return a
  const after = await loadTenantVocabulary(svc, input.brokerageId)
  if (!after.ok) return { ok: false, error: `attested but not verified: ${after.error}` }
  const v = resolveVocabularyValue(input.dimension, r.key, after.vocabulary)
  return v?.usable ? { ok: true, why: `"${v.label}" is attested and offered for new work` } : { ok: false, error: "attested but the term is still not usable" }
}

export interface VocabularyProposalView {
  id: string
  status: ProposalStatus
  summary: string
  change: VocabularyChange | null
  requiresCompliance: boolean
  warnings: string[]
  createdAt: string
}

/** This brokerage's vocabulary proposals (newest first) — the settings screen's queue. */
export async function listVocabularyProposals(svc: Svc, brokerageId: string): Promise<{ ok: true; rows: VocabularyProposalView[] } | { ok: false; error: string }> {
  const list = await listImprovementProposals(svc, brokerageId, { limit: 100 })
  if (!list.ok) return { ok: false, error: list.error }
  return {
    ok: true,
    rows: list.rows.filter((r) => isVocabularyProposal(r) || isComingSoonProposal(r)).slice(0, 25).map((r) => ({
      id: r.id, status: r.status, summary: String((r.proposed_change ?? {}).summary ?? ""), change: changeOf(r),
      requiresCompliance: (r.proposed_change ?? {}).requires_compliance === true,
      warnings: Array.isArray((r.proposed_change ?? {}).warnings) ? ((r.proposed_change ?? {}).warnings as unknown[]).map(String) : [],
      createdAt: r.created_at,
    })),
  }
}
