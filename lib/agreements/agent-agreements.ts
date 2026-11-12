// lib/agreements/agent-agreements.ts — THE EXECUTED AGENT AGREEMENT: EFFECTIVE DATE, AMENDMENTS AND THE START DATE
// (wave 145, lane 145C; owner rulings 3 and 4, 2026-10-27; cross-lane contract C6).
//
// Owner, verbatim: "There has to be an agents.start date which comes from the agents agreement and the agreement dictates
// the money structure." Source of truth: the executed agent agreement — its effective date and its amendment history —
// never account creation, first login, subscription date or a team-join timestamp unless the agreement says so.
//
// SURVIVORS EXTENDED, nothing parallel (CLAUDE.md §1; m858 says what was measured):
//   · contract_signatures (m481) is THE signed ledger of the agency contract family; m858 gives it the agreement's own
//     effective_date (immutable once recorded) and the amendment link (amends_contract_signature_id). The send/e-sign doors stay
//     app/actions/admin/commission-agreement.ts; this module is the RECORDING half a finance admin uses on executed paper.
//   · agents.start_date + agents.start_date_source (m858, contract C6) — written ONLY by setAgentStartDateFromAgreement below;
//     the database trigger refuses any value its source agreement does not state.
//   · agents.anniversary_date is the seat-provisioning stamp (app/actions/agents.ts writes today's date at seat creation) — it is
//     NOT an agreement fact and is never promoted to the start date here.
//
// WHICH AGREEMENT SETS THE START DATE (stated, never guessed): a BROKERAGE-LEVEL agent agreement — the independent-contractor
// agreement that joins the agent to the brokerage (m481), else, for a brokerage that uses one combined paper, the commission
// agreement. A team_agreement NEVER sets it (a team join is not the start of the brokerage relationship). The system PROPOSES the
// earliest executed base agreement of the first type present; a finance admin CONFIRMS it (and may name another executed
// brokerage-level agreement of the same agent — e.g. a re-join). The cap anniversary may differ: it is the agreement's own term
// (agent_commission_profiles.cap_anniversary_date, m850), read by lib/commission/cap-resolver.ts before the start date.
//
// AI never writes any of this: a person records what the executed paper says; the database refuses anything else.
// Pure rules at the top (proved by scripts/agreement-governance-guard.ts); writers below take the service client and the
// SESSION actor (tenant from the session, never a body field — CLAUDE.md §4), read every { error }, count every write that
// must match (a write that matches nothing also resolves — CLAUDE.md §3), and leave LAW-5 evidence through withActionLedger.

import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"

// ─── Vocabulary (mirrors the live contract_signatures_contract_type_check members it uses — CLAUDE.md §6) ────────────

/** The agency contract family an agent signs (m481). */
export const AGENT_AGREEMENT_TYPES = ["commission_agreement", "independent_contractor", "team_agreement"] as const
export type AgentAgreementType = (typeof AGENT_AGREEMENT_TYPES)[number]

/** Brokerage-level agreements that may set agents.start_date, in PROPOSAL precedence (the m858 trigger admits exactly these). */
export const START_DATE_AGREEMENT_TYPES = ["independent_contractor", "commission_agreement"] as const satisfies readonly AgentAgreementType[]

/** Agreements whose terms the commission profile may be verified against (the m858 profile trigger admits exactly these). */
export const TERMS_AGREEMENT_TYPES = ["commission_agreement", "independent_contractor"] as const satisfies readonly AgentAgreementType[]

export const AGENT_AGREEMENT_LABEL: Record<AgentAgreementType, string> = {
  commission_agreement: "Commission agreement",
  independent_contractor: "Independent contractor agreement",
  team_agreement: "Team agreement",
}

function isAgentAgreementType(v: unknown): v is AgentAgreementType {
  return typeof v === "string" && (AGENT_AGREEMENT_TYPES as readonly string[]).includes(v)
}

/** A contract_signatures row as these rules read it (m858 columns optional: absent before the migration is applied). */
export interface AgentAgreementRow {
  id: string
  agent_id: string | null
  brokerage_id: string | null
  contract_type: string
  esign_status: string | null
  fully_signed_at?: string | null
  effective_date?: string | null
  /** m858 evidence: who recorded the effective date from the executed paper, and when. */
  effective_date_recorded_by?: string | null
  effective_date_recorded_at?: string | null
  amends_contract_signature_id?: string | null
  team_id?: string | null
  document_url?: string | null
  field_values?: unknown
  created_at?: string | null
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** PURE — a real calendar day as yyyy-mm-dd, or null. */
export function calendarDay(v: unknown): string | null {
  if (typeof v !== "string") return null
  const s = v.slice(0, 10)
  if (!YMD.test(s)) return null
  const d = new Date(`${s}T00:00:00.000Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null
}

export const isExecutedAgreement = (r: Pick<AgentAgreementRow, "esign_status">): boolean => r.esign_status === "fully_signed"

// ─── PURE: the agreement in force on a date ──────────────────────────────────────────────────────────────────────────

export interface AgreementInForce {
  row: AgentAgreementRow
  /** The date the row governs from. */
  from: string
  /** effective_date = the date the paper states (m858); execution_date = the effective date is not recorded yet, so the date
   *  it was fully signed stands in — and a finding says so (the date a finance admin must record). */
  basis: "effective_date" | "execution_date"
  findings: string[]
}

/**
 * PURE — the executed agreement of `types` (base or amendment) that governs on `asOf`: the latest whose effective date is on or
 * before `asOf` (ties: the later execution). Rows whose effective date is NOT recorded fall back to their execution date, SAID.
 * Never a draft, a sent-but-unsigned or a voided row.
 */
export function agreementInForce(rows: ReadonlyArray<AgentAgreementRow>, types: readonly string[], asOf: string): AgreementInForce | null {
  const dated = rows
    .filter((r) => types.includes(r.contract_type) && isExecutedAgreement(r))
    .map((r) => {
      const eff = calendarDay(r.effective_date)
      const exec = calendarDay(r.fully_signed_at)
      return { r, from: eff ?? exec, basis: (eff ? "effective_date" : "execution_date") as AgreementInForce["basis"] }
    })
    .filter((x): x is { r: AgentAgreementRow; from: string; basis: AgreementInForce["basis"] } => !!x.from && x.from <= asOf)
    .sort((a, b) => b.from.localeCompare(a.from) || String(b.r.fully_signed_at ?? "").localeCompare(String(a.r.fully_signed_at ?? "")))
  const top = dated[0]
  if (!top) return null
  const findings = top.basis === "execution_date"
    ? [`the executed ${top.r.contract_type.replace(/_/g, " ")} ${top.r.id} has no recorded effective date — its execution date ${top.from} stands in until a finance admin records the date the agreement states`]
    : []
  return { row: top.r, from: top.from, basis: top.basis, findings }
}

/** PURE — the amendment chain of a base agreement, oldest first (the base itself first). Cycles are cut, never followed. */
export function amendmentChain(rows: ReadonlyArray<AgentAgreementRow>, baseId: string): AgentAgreementRow[] {
  const byParent = new Map<string, AgentAgreementRow[]>()
  for (const r of rows) {
    const p = r.amends_contract_signature_id
    if (!p) continue
    byParent.set(p, [...(byParent.get(p) ?? []), r])
  }
  const base = rows.find((r) => r.id === baseId)
  if (!base) return []
  const out: AgentAgreementRow[] = [base]
  const seen = new Set<string>([base.id])
  let frontier = [base.id]
  while (frontier.length) {
    const next: string[] = []
    for (const id of frontier) {
      for (const kid of (byParent.get(id) ?? []).sort((a, b) => String(a.effective_date ?? a.fully_signed_at ?? "").localeCompare(String(b.effective_date ?? b.fully_signed_at ?? "")))) {
        if (seen.has(kid.id)) continue
        seen.add(kid.id)
        out.push(kid)
        next.push(kid.id)
      }
    }
    frontier = next
  }
  return out
}

// ─── PURE: the start date ────────────────────────────────────────────────────────────────────────────────────────────

export type StartDateRefusal =
  | "not_found" | "other_agent" | "other_brokerage" | "not_brokerage_level" | "not_executed" | "no_effective_date"

/** PURE — may this agreement row be agents.start_date_source for this agent? (the m858 trigger's rule, stated once in code). */
export function validateStartDateSource(
  agent: { id: string; brokerage_id: string | null },
  row: AgentAgreementRow | null | undefined,
): { ok: true; startDate: string } | { ok: false; code: StartDateRefusal; error: string } {
  if (!row) return { ok: false, code: "not_found", error: "That agreement is not on record in this brokerage." }
  if (row.agent_id !== agent.id) return { ok: false, code: "other_agent", error: "That agreement belongs to another agent." }
  if (row.brokerage_id !== agent.brokerage_id) return { ok: false, code: "other_brokerage", error: "That agreement is not this brokerage's." }
  if (!(START_DATE_AGREEMENT_TYPES as readonly string[]).includes(row.contract_type)) {
    return { ok: false, code: "not_brokerage_level", error: `A ${row.contract_type.replace(/_/g, " ")} does not set the start date — only the agent's brokerage agreement (independent contractor or commission agreement) does; a team join is not a start date.` }
  }
  if (!isExecutedAgreement(row)) return { ok: false, code: "not_executed", error: "That agreement is not fully signed — only an executed agreement sets the start date." }
  const eff = calendarDay(row.effective_date)
  if (!eff) return { ok: false, code: "no_effective_date", error: "Record the effective date the executed agreement states first — the start date is that date." }
  return { ok: true, startDate: eff }
}

export interface StartDateProposal {
  /** The agreement the system proposes; a finance admin confirms. null = nothing executed and dated yet. */
  proposal: { contractSignatureId: string; startDate: string; contractType: string } | null
  /** Executed brokerage-level agreements whose effective date still has to be recorded before any can be proposed. */
  awaitingEffectiveDate: string[]
  reason: string
}

/**
 * PURE — the start date the executed paper supports: the EARLIEST executed BASE agreement (not an amendment) of the first type in
 * START_DATE_AGREEMENT_TYPES that the agent has, by its recorded effective date. Never account creation, never a team join.
 */
export function proposeAgentStartDate(agentId: string, rows: ReadonlyArray<AgentAgreementRow>): StartDateProposal {
  const mine = rows.filter((r) => r.agent_id === agentId && isExecutedAgreement(r) && !r.amends_contract_signature_id)
  const awaiting = mine.filter((r) => (START_DATE_AGREEMENT_TYPES as readonly string[]).includes(r.contract_type) && !calendarDay(r.effective_date)).map((r) => r.id)
  for (const type of START_DATE_AGREEMENT_TYPES) {
    const dated = mine
      .filter((r) => r.contract_type === type && calendarDay(r.effective_date))
      .sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)))
    if (dated[0]) {
      return {
        proposal: { contractSignatureId: dated[0].id, startDate: calendarDay(dated[0].effective_date) as string, contractType: type },
        awaitingEffectiveDate: awaiting,
        reason: `the effective date of the executed ${type.replace(/_/g, " ")} (${dated[0].id})`,
      }
    }
  }
  return {
    proposal: null,
    awaitingEffectiveDate: awaiting,
    reason: awaiting.length
      ? "an executed brokerage agreement is on file but its effective date is not recorded yet"
      : "no executed brokerage agreement (independent contractor / commission agreement) is on file for this agent",
  }
}

// ─── Writers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Db = { from: (t: string) => any }

export interface AgreementActor {
  userId: string
  agentId: string | null
  /** The SESSION's tenant — never a body field (§4). */
  brokerageId: string
  userType: string
  isTenantPrincipal?: boolean
}

const financeAdmin = (a: AgreementActor) => isBrokerageFinanceAdmin({ user_type: a.userType, is_tenant_principal: a.isTenantPrincipal })

/** A missing m858 column — reported by name rather than as a generic failure (fail closed: nothing is written). */
function m858Missing(message: string | undefined): boolean {
  return /effective_date_recorded|amends_contract_signature_id|start_date_source|start_date|agreement_signature_id|\beffective_date\b/.test(String(message ?? "")) &&
    /column|schema cache|does not exist/i.test(String(message ?? ""))
}

async function ledgered<T extends { ok: boolean; error?: string }>(
  db: Db,
  entry: { brokerageId: string; action: string; actor: AgreementActor; subjectType: string; subjectId: string | null; ref: string | null; reasonDetail: string; detail: Record<string, unknown> },
  run: () => Promise<T>,
): Promise<T> {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<T>(
    {
      brokerageId: entry.brokerageId,
      action: entry.action,
      actor: { type: "user", userId: entry.actor.userId, agentId: entry.actor.agentId },
      subject: { type: entry.subjectType, id: entry.subjectId, ref: entry.ref },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: entry.reasonDetail.slice(0, 500),
      riskClass: "FINANCIAL",
      systemSource: "agent_agreement",
      detail: entry.detail,
    },
    run,
    {
      settle: (r) => (r.ok ? { status: "executed", outcome: "recorded" } : { status: "failed", outcome: "refused", error: r.error ?? null }),
      replay: (claim) => ({ ok: false, error: `already ${claim.kind === "in_flight" ? "in flight" : "recorded"}` }) as unknown as T,
    },
    { client: db as never },
  )
}

async function readAgreement(db: Db, brokerageId: string, id: string): Promise<{ ok: true; row: AgentAgreementRow | null } | { ok: false; error: string }> {
  const { data, error } = await db.from("contract_signatures").select("*").eq("id", id).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `agreement_read_refused: ${error.message}` }
  return { ok: true, row: (data ?? null) as AgentAgreementRow | null }
}

/**
 * RECORD THE EFFECTIVE DATE an executed agreement states. Finance admins only; the row must be this brokerage's, of the agent
 * agreement family, FULLY SIGNED, with no effective date recorded yet (compare-and-swap on `effective_date IS NULL` — a second
 * recording, or a change, matches nothing and is refused: an executed change is an AMENDMENT, recordAgentAgreementAmendment).
 */
export async function recordAgreementEffectiveDate(
  db: Db,
  actor: AgreementActor,
  input: { contractSignatureId: string; effectiveDate: string },
): Promise<{ ok: true; row: AgentAgreementRow } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!financeAdmin(actor)) return { ok: false, error: "forbidden: only the brokerage's finance admins record what an executed agreement states" }
  const eff = calendarDay(input.effectiveDate)
  if (!eff) return { ok: false, error: "effective_date_invalid: give the date the agreement states it takes effect, as yyyy-mm-dd" }
  const cur = await readAgreement(db, actor.brokerageId, input.contractSignatureId)
  if (!cur.ok) return cur
  const row = cur.row
  if (!row) return { ok: false, error: "agreement_not_found" }
  if (!isAgentAgreementType(row.contract_type)) return { ok: false, error: "not_an_agent_agreement" }
  if (!isExecutedAgreement(row)) return { ok: false, error: "not_executed: record the effective date of a FULLY SIGNED agreement only" }
  if (calendarDay(row.effective_date)) return { ok: false, error: `already_recorded: this agreement's effective date is ${row.effective_date} — an executed change is recorded as an amendment` }

  let updated: AgentAgreementRow | null = null
  const now = new Date().toISOString()
  const res = await ledgered(
    db,
    {
      brokerageId: actor.brokerageId, action: "finance.agent_agreement.effective_date_recorded", actor,
      subjectType: "contract_signature", subjectId: row.id, ref: row.agent_id,
      reasonDetail: `effective date ${eff} recorded from the executed ${row.contract_type.replace(/_/g, " ")}`,
      detail: { contract_signature_id: row.id, agent_id: row.agent_id, contract_type: row.contract_type, effective_date: eff, fully_signed_at: row.fully_signed_at ?? null },
    },
    async () => {
      const { data, error } = await db
        .from("contract_signatures")
        .update({ effective_date: eff, effective_date_recorded_by: actor.userId, effective_date_recorded_at: now, updated_at: now })
        .eq("id", row.id)
        .eq("brokerage_id", actor.brokerageId)
        .eq("esign_status", "fully_signed")
        .is("effective_date", null)
        .select("*")
      if (error) return { ok: false, error: m858Missing(error.message) ? `m858 (agent agreement effective dates) is not applied: ${error.message}` : `effective_date_refused: ${error.message}` }
      const rows = (data ?? []) as AgentAgreementRow[]
      if (rows.length !== 1) return { ok: false, error: "not_recorded: the agreement changed under you (already dated, voided, or not in this brokerage)" }
      updated = rows[0]
      return { ok: true }
    },
  )
  if (!res.ok || !updated) return { ok: false, error: res.error ?? "not_recorded" }
  return { ok: true, row: updated }
}

/**
 * RECORD AN EXECUTED AMENDMENT of an agent agreement (owner ruling 4: "an executed change applies from its effective date").
 * A NEW contract_signatures row of the same family, pointing at the agreement it amends, carrying the executed document, the
 * date it was fully executed and the date it takes effect. The original is never edited. Finance admins only; the amended
 * agreement must itself be executed. The changed terms are recorded as the amendment's field_values (the canonical term keys
 * lib/commission/agreement-onboarding.ts reads) — the profile is then VERIFIED against it through the same human step.
 */
export async function recordAgentAgreementAmendment(
  db: Db,
  actor: AgreementActor,
  input: { amendsContractSignatureId: string; executedOn: string; effectiveDate: string; documentUrl: string; fieldValues?: Record<string, unknown> | null; note?: string | null },
): Promise<{ ok: true; row: AgentAgreementRow } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!financeAdmin(actor)) return { ok: false, error: "forbidden: only the brokerage's finance admins record an executed amendment" }
  const exec = calendarDay(input.executedOn)
  const eff = calendarDay(input.effectiveDate)
  if (!exec) return { ok: false, error: "executed_on_invalid: the date the amendment was fully signed, yyyy-mm-dd" }
  if (!eff) return { ok: false, error: "effective_date_invalid: the date the amendment says it takes effect, yyyy-mm-dd" }
  if (exec > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) return { ok: false, error: "executed_on_invalid: an amendment cannot have been signed in the future" }
  const url = String(input.documentUrl ?? "").trim()
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "document_required: an amendment is recorded from the executed document — give its stored URL" }
  const cur = await readAgreement(db, actor.brokerageId, input.amendsContractSignatureId)
  if (!cur.ok) return cur
  const base = cur.row
  if (!base) return { ok: false, error: "agreement_not_found" }
  if (!isAgentAgreementType(base.contract_type)) return { ok: false, error: "not_an_agent_agreement" }
  if (!isExecutedAgreement(base)) return { ok: false, error: "not_executed: only an executed agreement can be amended" }

  let inserted: AgentAgreementRow | null = null
  const res = await ledgered(
    db,
    {
      brokerageId: actor.brokerageId, action: "finance.agent_agreement.amendment_recorded", actor,
      subjectType: "contract_signature", subjectId: base.id, ref: base.agent_id,
      reasonDetail: `executed amendment of the ${base.contract_type.replace(/_/g, " ")} (signed ${exec}, effective ${eff})${input.note ? `: ${input.note}` : ""}`,
      detail: { amends: base.id, agent_id: base.agent_id, contract_type: base.contract_type, executed_on: exec, effective_date: eff, changed_terms: Object.keys(input.fieldValues ?? {}) },
    },
    async () => {
      const now = new Date().toISOString()
      const { data, error } = await db
        .from("contract_signatures")
        .insert({
          brokerage_id: actor.brokerageId,
          agent_id: base.agent_id,
          team_id: base.team_id ?? null,
          contract_type: base.contract_type,
          // provider_name is NOT NULL — "none": recorded from executed paper, not dispatched by a provider (the m481 honest state)
          provider_name: "none",
          esign_status: "fully_signed",
          fully_signed_at: `${exec}T12:00:00.000Z`,
          document_url: url,
          field_values: input.fieldValues ?? {},
          amends_contract_signature_id: base.id,
          effective_date: eff,
          effective_date_recorded_by: actor.userId,
          effective_date_recorded_at: now,
        })
        .select("*")
      if (error) return { ok: false, error: m858Missing(error.message) ? `m858 (agent agreement amendments) is not applied: ${error.message}` : `amendment_refused: ${error.message}` }
      const rows = (data ?? []) as AgentAgreementRow[]
      if (rows.length !== 1) return { ok: false, error: `amendment_not_recorded (${rows.length} rows written)` }
      inserted = rows[0]
      return { ok: true }
    },
  )
  if (!res.ok || !inserted) return { ok: false, error: res.error ?? "amendment_not_recorded" }
  await notifyAgentOfAgreementChange(db, actor.brokerageId, (inserted as AgentAgreementRow).agent_id, `An executed amendment to your ${AGENT_AGREEMENT_LABEL[base.contract_type as AgentAgreementType].toLowerCase()} was recorded`, `It takes effect ${eff}. Deals are priced on the agreement in force on their date — earlier deals keep the terms they were priced on.`)
  return { ok: true, row: inserted }
}

/**
 * SET agents.start_date FROM AN EXECUTED AGREEMENT (contract C6 — the only writer). Finance admins only; the agreement must pass
 * validateStartDateSource (the m858 trigger re-checks it). Counted UPDATE; ledgered with the agreement as evidence.
 */
export async function setAgentStartDateFromAgreement(
  db: Db,
  actor: AgreementActor,
  input: { agentId: string; contractSignatureId: string },
): Promise<{ ok: true; startDate: string; contractSignatureId: string } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!financeAdmin(actor)) return { ok: false, error: "forbidden: only the brokerage's finance admins set an agent's start date" }
  const { data: agent, error: agentErr } = await db.from("agents").select("*").eq("id", input.agentId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (agentErr) return { ok: false, error: `agent_read_refused: ${agentErr.message}` }
  if (!agent) return { ok: false, error: "agent_not_found" }
  const cur = await readAgreement(db, actor.brokerageId, input.contractSignatureId)
  if (!cur.ok) return cur
  const v = validateStartDateSource({ id: (agent as { id: string }).id, brokerage_id: (agent as { brokerage_id: string | null }).brokerage_id }, cur.row)
  if (!v.ok) return { ok: false, error: `${v.code}: ${v.error}` }
  const before = { start_date: (agent as Record<string, unknown>).start_date ?? null, start_date_source: (agent as Record<string, unknown>).start_date_source ?? null }

  const res = await ledgered(
    db,
    {
      brokerageId: actor.brokerageId, action: "finance.agent_agreement.start_date_set", actor,
      subjectType: "agent", subjectId: input.agentId, ref: input.contractSignatureId,
      reasonDetail: `agent start date ${v.startDate} from the executed ${cur.row!.contract_type.replace(/_/g, " ")} ${input.contractSignatureId}`,
      detail: { agent_id: input.agentId, start_date: v.startDate, start_date_source: input.contractSignatureId, before },
    },
    async () => {
      const { data, error } = await db
        .from("agents")
        .update({ start_date: v.startDate, start_date_source: input.contractSignatureId, updated_at: new Date().toISOString() })
        .eq("id", input.agentId)
        .eq("brokerage_id", actor.brokerageId)
        .select("id")
      if (error) return { ok: false, error: m858Missing(error.message) ? `m858 (agents.start_date) is not applied: ${error.message}` : `start_date_refused: ${error.message}` }
      if (((data ?? []) as unknown[]).length !== 1) return { ok: false, error: "start_date_not_set: the agent is no longer in this brokerage" }
      return { ok: true }
    },
  )
  if (!res.ok) return { ok: false, error: res.error ?? "start_date_not_set" }
  return { ok: true, startDate: v.startDate, contractSignatureId: input.contractSignatureId }
}

/** The agent's executed / pending agreement rows, tenant-pinned (a refused read is a refusal, never "none"). */
export async function listAgentAgreements(
  db: Db,
  brokerageId: string,
  agentIds?: readonly string[],
): Promise<{ ok: true; rows: AgentAgreementRow[] } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "no_tenant" }
  let q = db.from("contract_signatures").select("*").eq("brokerage_id", brokerageId).in("contract_type", [...AGENT_AGREEMENT_TYPES])
  if (agentIds && agentIds.length) q = q.in("agent_id", [...agentIds])
  const { data, error } = await q.order("created_at", { ascending: true }).limit(2000)
  if (error) return { ok: false, error: `agreements_read_refused: ${error.message}` }
  return { ok: true, rows: (data ?? []) as AgentAgreementRow[] }
}

async function notifyAgentOfAgreementChange(db: Db, brokerageId: string, agentId: string | null, title: string, body: string): Promise<void> {
  if (!agentId) return
  try {
    const { data: a, error } = await db.from("agents").select("user_id").eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
    const userId = (a as { user_id?: string | null } | null)?.user_id
    if (error || !userId) return
    const { error: nErr } = await db.from("notifications").insert({
      user_id: userId, brokerage_id: brokerageId, type: "agent_agreement_changed", title: title.slice(0, 200), body: body.slice(0, 480),
      entity_type: "agent", entity_id: agentId, priority: "high", channel: "in_app", is_read: false,
    })
    if (nErr) console.error("[agent-agreements] agent notice not written:", nErr.message)
  } catch (e) {
    console.error("[agent-agreements] agent notice failed:", e instanceof Error ? e.message : String(e))
  }
}
