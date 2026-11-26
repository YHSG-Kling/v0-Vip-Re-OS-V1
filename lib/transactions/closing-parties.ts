/**
 * lib/transactions/closing-parties.ts — WHO ACTUALLY CLOSES THIS DEAL, WHOM EACH LAWYER REPRESENTS, AND WHO OWNS EACH
 * CLOSING DOCUMENT (wave 156, lane 156D). PURE — no I/O, no model.
 *
 * Owner (2026-11-25, verbatim): "in many states, it is a closing attorney not title." The closing may be run by a closing
 * attorney, a title company, an escrow company or another authorized entity, depending on the jurisdiction and the deal.
 * Decide by FACT, never by stereotype:
 *   · the STATE's rule is the sourced table lib/state-forms/closing-participants.ts (STATE_CLOSING_POLICIES — GA, NC, SC, DE,
 *     MA, WV, RI, CT, NY, each with its source) — read here, never restated. A state with no sourced policy is UNSUPPORTED and
 *     asks its question; no 50-state answer is hardcoded anywhere.
 *   · the SETTLEMENT AGENT is whoever the contract names or the party confirms — recorded, never picked by this module.
 *   · REPRESENTATION is recorded per party. A side-specific role states its side; a settlement attorney, a title company or an
 *     escrow company with no recorded `represents` is UNKNOWN and the deal team is asked. Nothing here ever reads one attorney
 *     as representing everyone — the vocabulary has no such value.
 *
 * SURVIVORS READ (CLAUDE.md §1): assessClosingParticipants / closingStateNote (the state policy), financingKindFor (cash vs
 * financed), the vendor-category tests in lib/kernel/lender-linkage.ts (a lender / title / attorney is a VENDOR CATEGORY —
 * CLAUDE.md §4). The writers are the deal-desk writers in lib/application/transactions.ts (dealDeskWriteContext).
 *
 * LEGAL NOTE (published, not hidden): the state table is a research aid with its sources beside each entry; it is not legal
 * advice. A finding that turns on a legal rule is routed to a human (`requiresHuman`) and names the source; real reliance
 * needs the brokerage's counsel.
 */

import { assessClosingParticipants, closingStateNote, type ClosingParticipantAssessment } from "@/lib/state-forms/closing-participants"
import { financingKindFor } from "@/lib/compliance/checklist-dimensions"
import { isLenderVendorCategory, isTitleVendorCategory } from "@/lib/kernel/lender-linkage"
import { VENDOR_CATEGORIES } from "@/lib/kernel/vendor-categories"

// ─── 1 · THE VOCABULARIES (the m1010 CHECKs — one spelling each, CLAUDE.md §6) ──────────────────────────────────────

/** transaction_participants.party_role — the STRUCTURED closing role (the free-text `role` column stays as it is). */
export const CLOSING_PARTY_ROLES = [
  "buyer_attorney", "seller_attorney", "lender_attorney", "settlement_attorney",
  "title_company", "escrow_company", "lender", "other_settlement_entity",
] as const
export type ClosingPartyRole = (typeof CLOSING_PARTY_ROLES)[number]

/** transaction_participants.represents — WHOM the party acts for. There is deliberately no "all parties" value. */
export const PARTY_REPRESENTS = ["buyer", "seller", "lender", "neutral_settlement_agent"] as const
export type PartyRepresents = (typeof PARTY_REPRESENTS)[number]

/** transaction_title_escrow.settlement_agent_kind. */
export const SETTLEMENT_AGENT_KINDS = ["attorney", "title_company", "escrow_company", "other_authorized_entity"] as const
export type SettlementAgentKind = (typeof SETTLEMENT_AGENT_KINDS)[number]

/** transaction_title_escrow.settlement_agent_basis — where the designation came from. */
export const SETTLEMENT_AGENT_BASES = ["contract_named", "party_confirmed", "agent_entered"] as const
export type SettlementAgentBasis = (typeof SETTLEMENT_AGENT_BASES)[number]

/** transaction_participants.fact_source — where the party's facts came from. Only `party_confirmed` and `vendor_seat` are confirmed. */
export const CLOSING_FACT_SOURCES = ["vendor_seat", "party_confirmed", "agent_entered"] as const
export type ClosingFactSource = (typeof CLOSING_FACT_SOURCES)[number]

/** payoff_status / hoa_estoppel_status / recording_status. */
export const CLOSING_CHECK_STATUSES = ["not_applicable", "needed", "requested", "received", "verified"] as const
export type ClosingCheckStatus = (typeof CLOSING_CHECK_STATUSES)[number]

export const PARTY_ROLE_LABEL: Record<ClosingPartyRole, string> = {
  buyer_attorney: "Buyer's attorney", seller_attorney: "Seller's attorney", lender_attorney: "Lender's attorney",
  settlement_attorney: "Closing (settlement) attorney", title_company: "Title company", escrow_company: "Escrow company",
  lender: "Lender", other_settlement_entity: "Other authorized settlement entity",
}

/** vendor_assignments.assignment_type for counsel on a deal (m1011) — the vendors.category spelling, one vocabulary (CLAUDE.md §6). */
export const COUNSEL_ASSIGNMENT_TYPE = "attorney" as const

const ATTORNEY_ROLES: ReadonlySet<ClosingPartyRole> = new Set(["buyer_attorney", "seller_attorney", "lender_attorney", "settlement_attorney"])
export const isAttorneyRole = (r: unknown): boolean => typeof r === "string" && ATTORNEY_ROLES.has(r as ClosingPartyRole)
const inVocab = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === "string" && (set as readonly string[]).includes(v)
export const isClosingPartyRole = (v: unknown): v is ClosingPartyRole => inVocab(CLOSING_PARTY_ROLES, v)
const isPartyRepresents = (v: unknown): v is PartyRepresents => inVocab(PARTY_REPRESENTS, v)
export const isSettlementAgentKind = (v: unknown): v is SettlementAgentKind => inVocab(SETTLEMENT_AGENT_KINDS, v)
export const isSettlementAgentBasis = (v: unknown): v is SettlementAgentBasis => inVocab(SETTLEMENT_AGENT_BASES, v)
export const isClosingCheckStatus = (v: unknown): v is ClosingCheckStatus => inVocab(CLOSING_CHECK_STATUSES, v)

/** The side a side-specific role names; null = the role itself does not say. */
const ROLE_SIDE: Partial<Record<ClosingPartyRole, PartyRepresents>> = { buyer_attorney: "buyer", seller_attorney: "seller", lender_attorney: "lender" }

/** The vendors.category a role's on-platform seat must carry (a VENDOR CATEGORY, never a user type — CLAUDE.md §4). */
export function vendorCategoryFitsRole(role: ClosingPartyRole, category: string | null | undefined): boolean {
  const c = String(category ?? "").trim().toLowerCase()
  if (ATTORNEY_ROLES.has(role)) return c === "attorney"
  if (role === "title_company" || role === "escrow_company") return isTitleVendorCategory(c) // escrow is a role AT the title company (lib/kernel/vendor-categories.ts)
  if (role === "lender") return isLenderVendorCategory(c)
  return (VENDOR_CATEGORIES as readonly string[]).includes(c)
}

// ─── 2 · RECORDING A PARTY (the rule the writer runs before it writes) ──────────────────────────────────────────────

export interface ClosingPartyDraft {
  partyRole: unknown
  represents?: unknown
  name?: unknown
  vendorId?: unknown
}

/** PURE — is this party record coherent? A refusal writes nothing. Representation is never filled in for the caller. */
export function decideClosingPartyDraft(d: ClosingPartyDraft): { ok: true; partyRole: ClosingPartyRole; represents: PartyRepresents | null } | { ok: false; error: string } {
  if (!isClosingPartyRole(d.partyRole)) return { ok: false, error: `Choose the party's closing role: ${CLOSING_PARTY_ROLES.map((r) => PARTY_ROLE_LABEL[r]).join(", ")}.` }
  if (typeof d.name !== "string" || d.name.trim().length < 2) return { ok: false, error: "Enter the party's legal name or firm name as it appears on their documents." }
  const side = ROLE_SIDE[d.partyRole] ?? null
  if (d.represents != null && d.represents !== "" && !isPartyRepresents(d.represents)) return { ok: false, error: "Choose whom this party represents: the buyer, the seller, the lender, or neutral as settlement agent." }
  const stated = (d.represents == null || d.represents === "") ? null : (d.represents as PartyRepresents)
  if (side && stated && stated !== side) return { ok: false, error: `A ${PARTY_ROLE_LABEL[d.partyRole].toLowerCase()} represents the ${side}; it cannot be recorded as representing the ${stated}. Record a separate party for the other side.` }
  // A side-specific role states its own side; every other role keeps what was recorded — possibly nothing (unknown).
  return { ok: true, partyRole: d.partyRole, represents: stated ?? side }
}

// ─── 3 · THE DEAL'S CLOSING TEAM, ASSESSED ──────────────────────────────────────────────────────────────────────────

export interface ClosingTeamParticipant {
  id: string
  name: string | null
  company?: string | null
  email?: string | null
  phone?: string | null
  role?: string | null
  party_role?: string | null
  represents?: string | null
  vendor_id?: string | null
  fact_source?: string | null
  fact_confirmed_at?: string | null
}

export interface ClosingTeamFacts {
  stateCode: string | null
  financingType: string | null
  dealType: string | null
  participants: ReadonlyArray<ClosingTeamParticipant>
  settlement: {
    kind?: string | null
    participantId?: string | null
    basis?: string | null
    titleFileNumber?: string | null
    escrowNumber?: string | null
    closingLocation?: string | null
    closingDate?: string | null
    payoffStatus?: string | null
    hoaEstoppelStatus?: string | null
    recordingStatus?: string | null
    titleCompanyName?: string | null
  } | null
  /**
   * The deal's insurance checkpoint as the deal already records it (lib/transactions/lender-insurance-checkpoint.ts
   * loadLenderInsuranceCheckpoint: the lender's requirement on transaction_lenders + the policy on transaction_vendor_services).
   * `unreadable` = the read was refused (said, never "fine"); absent = the caller did not read it.
   */
  insurance?: { state: string; label: string; detail: string; coaching: string | null } | { unreadable: string } | null
  /** the brokerage-wide default closing entity (brokerage settings), when known — reported against the state, never obeyed over it. */
  brokerageClosingEntityType?: string | null
}

export interface ClosingFinding {
  key: string
  severity: "info" | "needs_action" | "needs_human"
  message: string
  /** the source a legal finding rests on (title + URL), when there is one. */
  source?: { title: string; url: string } | null
}

export interface PartyView {
  id: string
  name: string | null
  partyRole: ClosingPartyRole | null
  /** whom the party acts for — `unknown` when nothing was recorded (never "everyone"). */
  represents: PartyRepresents | "unknown"
  onPlatform: boolean
  factsConfirmed: boolean
}

export interface ClosingTeamAssessment {
  financing: "cash" | "financed" | "unknown"
  state: ClosingParticipantAssessment
  stateNote: ReturnType<typeof closingStateNote>
  settlementAgent: { kind: SettlementAgentKind | null; participantId: string | null; basis: SettlementAgentBasis | null; name: string | null }
  parties: PartyView[]
  findings: ClosingFinding[]
  /** something here turns on a legal rule or a fact only a person can confirm — a human decides; nothing is resolved here. */
  requiresHuman: boolean
}

const partyRoleOf = (p: ClosingTeamParticipant): ClosingPartyRole | null => (isClosingPartyRole(p.party_role) ? p.party_role : null)

function representationOf(p: ClosingTeamParticipant): PartyRepresents | "unknown" {
  if (isPartyRepresents(p.represents)) return p.represents
  const r = partyRoleOf(p)
  const side = r ? ROLE_SIDE[r] : null
  return side ?? "unknown"
}

/** PURE — the deal's closing team against the state's sourced rule and the recorded facts. */
export function assessClosingTeam(f: ClosingTeamFacts): ClosingTeamAssessment {
  const kind = financingKindFor(f.financingType)
  const financing: ClosingTeamAssessment["financing"] = kind ?? "unknown"
  // The survivor reads the free-text roles; a structured role is handed to it as its own spelling so both rails count.
  const roles = f.participants.flatMap((p) => [p.role ?? null, p.party_role ?? null])
  const state = assessClosingParticipants({ stateCode: f.stateCode, participantRoles: roles, brokerageClosingEntityType: f.brokerageClosingEntityType ?? null })
  const stateNote = closingStateNote(f.stateCode)
  const findings: ClosingFinding[] = []
  const src = state.policy?.sources[0] ? { title: state.policy.sources[0].title, url: state.policy.sources[0].url } : null

  const parties: PartyView[] = f.participants.filter((p) => partyRoleOf(p) || /attorney|lawyer|title|escrow|settlement|lender/i.test(String(p.role ?? ""))).map((p) => ({
    id: p.id, name: p.name ?? null, partyRole: partyRoleOf(p), represents: representationOf(p), onPlatform: !!p.vendor_id,
    factsConfirmed: p.fact_source === "party_confirmed" || p.fact_source === "vendor_seat",
  }))

  // ── the state ──
  if (state.status === "unsupported") {
    findings.push({ key: "state_unsupported", severity: "needs_human", message: state.question ?? "The state's closing rule is not on file.", source: null })
    if (state.conventionHint) findings.push({ key: "state_convention_hint", severity: "info", message: state.conventionHint })
  }
  for (const g of state.gaps) findings.push({ key: `state_gap:${g.role}`, severity: g.presence === "required" ? "needs_human" : "needs_action", message: g.message, source: src })
  for (const c of state.conflicts) findings.push({ key: "state_conflict", severity: "needs_human", message: c, source: src })

  // ── the settlement agent (recorded, never chosen here) ──
  const s = f.settlement
  const agentKind = isSettlementAgentKind(s?.kind) ? s!.kind as SettlementAgentKind : null
  const agentRow = s?.participantId ? f.participants.find((p) => p.id === s.participantId) ?? null : null
  if (!s) findings.push({ key: "no_settlement_record", severity: "needs_action", message: "No title / escrow / settlement record on this deal yet — add it, then record who conducts the closing as the contract names them." })
  else if (!agentKind) findings.push({ key: "settlement_agent_unnamed", severity: "needs_action", message: "Record who conducts the closing (a closing attorney, a title company, an escrow company or another authorized entity) as the contract names them or the party confirms it. The OS does not pick one." })
  if (s?.participantId && !agentRow) findings.push({ key: "settlement_agent_row_missing", severity: "needs_action", message: "The recorded settlement agent is no longer on the deal's party list — record it again." })
  if (agentKind && agentRow) {
    const r = partyRoleOf(agentRow)
    if (agentKind === "attorney" && r && !isAttorneyRole(r)) findings.push({ key: "settlement_kind_mismatch", severity: "needs_action", message: `The settlement agent is recorded as an attorney, but ${agentRow.name ?? "that party"} is recorded as a ${PARTY_ROLE_LABEL[r].toLowerCase()}.` })
    if (agentKind !== "attorney" && r && isAttorneyRole(r)) findings.push({ key: "settlement_kind_mismatch", severity: "needs_action", message: `${agentRow.name ?? "That party"} is recorded as an attorney but the settlement agent kind is '${agentKind}'. If the attorney's firm is conducting the closing, record the kind as attorney.` })
  }
  if (agentKind && agentKind !== "attorney" && state.policy && state.policy.involvement === "required") {
    findings.push({ key: "state_requires_attorney_closing", severity: "needs_human", source: src,
      message: `${state.policy.stateName}: ${state.policy.summary} The settlement agent is recorded as '${agentKind.replace(/_/g, " ")}'. If that company is an attorney's firm or an attorney supervises the closing, record the attorney; otherwise confirm with the brokerage's counsel before closing.` })
  }
  if (s?.basis === "agent_entered" || (agentKind && !isSettlementAgentBasis(s?.basis))) {
    findings.push({ key: "settlement_agent_unconfirmed", severity: "needs_action", message: "Who conducts the closing was typed in, not taken from the contract or confirmed with them — confirm it with the settlement agent and record the evidence." })
  }

  // ── representation (never inferred) ──
  for (const p of parties) {
    if (p.partyRole && isAttorneyRole(p.partyRole) && p.represents === "unknown") {
      findings.push({ key: `representation_unknown:${p.id}`, severity: "needs_action", message: `${p.name ?? "An attorney"} is on the deal, but whom they represent is not recorded. Ask them — a closing attorney is not assumed to represent the buyer, the seller or the lender.` })
    }
    if (!p.onPlatform && !p.factsConfirmed) {
      findings.push({ key: `party_unconfirmed:${p.id}`, severity: "needs_action", message: `${p.name ?? "A party"} is not on the platform: the deal's agent or coordinator confirms their details directly with them and records the evidence.` })
    }
  }
  // ── financing ──
  const lenders = parties.filter((p) => p.partyRole === "lender")
  if (financing === "financed" && lenders.length === 0) findings.push({ key: "lender_not_recorded", severity: "needs_action", message: "This is a financed deal and no lender is recorded among the closing parties. The lender issues the Closing Disclosure — record the actual lender; it is never filled in for you." })
  if (financing === "unknown") findings.push({ key: "financing_unknown", severity: "needs_action", message: "Whether this deal is cash or financed is not recorded, so the lender-side items cannot be determined." })

  const requiresHuman = findings.some((x) => x.severity === "needs_human")
  return {
    financing, state, stateNote,
    settlementAgent: { kind: agentKind, participantId: agentRow?.id ?? null, basis: isSettlementAgentBasis(s?.basis) ? s!.basis as SettlementAgentBasis : null, name: agentRow?.name ?? (agentKind ? s?.titleCompanyName ?? null : null) },
    parties, findings, requiresHuman,
  }
}

// ─── 4 · THE ONE DEAL-TEAM CHECKLIST (applies by deal type, financing and state) ────────────────────────────────────

export interface ChecklistItem {
  key: "legal_party_names" | "counsel_contacts" | "title_escrow_numbers" | "appointment_location" | "settlement_date" | "insurance" | "payoff" | "hoa_estoppel" | "recording"
  label: string
  applies: "yes" | "no" | "unknown"
  done: boolean
  detail: string
}

/** PURE. `applies: unknown` is said when the fact that decides it is not on file — never guessed into yes or no. */
export function dealTeamChecklist(f: ClosingTeamFacts, a: ClosingTeamAssessment = assessClosingTeam(f)): ChecklistItem[] {
  const s = f.settlement ?? {}
  const counsel = a.parties.filter((p) => p.partyRole && isAttorneyRole(p.partyRole))
  const counselRows = f.participants.filter((p) => counsel.some((c) => c.id === p.id))
  const st = (v: unknown) => (isClosingCheckStatus(v) ? v : null)
  const checkItem = (key: "payoff" | "hoa_estoppel" | "recording", label: string, v: ClosingCheckStatus | null, appliesHint: ChecklistItem["applies"]): ChecklistItem => {
    const applies = v === "not_applicable" ? "no" : v ? "yes" : appliesHint
    return { key, label, applies, done: v === "verified" || v === "not_applicable", detail: v ? `Status: ${v.replace(/_/g, " ")}.` : "Not recorded yet." }
  }
  const names = f.participants.filter((p) => /^(buyer|seller)$/i.test(String(p.role ?? "").trim()))
  return [
    { key: "legal_party_names", label: "Legal names of buyer(s) and seller(s)", applies: "yes", done: names.length >= 2, detail: names.length >= 2 ? `${names.length} principal(s) recorded.` : "Record each buyer and seller exactly as they will sign." },
    { key: "counsel_contacts", label: "Counsel contacts", applies: counsel.length > 0 || a.state.policy ? "yes" : "unknown",
      done: counselRows.length > 0 && counselRows.every((p) => !!(p.email || p.phone)),
      detail: counselRows.length === 0 ? (a.state.policy ? `${a.state.policy.stateName} involves attorneys at closing — record each attorney and whom they represent.` : "No attorney recorded (add one if any party is represented).") : `${counselRows.length} attorney(s) recorded.` },
    { key: "title_escrow_numbers", label: "Title file / escrow number", applies: "yes", done: !!(s.titleFileNumber || s.escrowNumber), detail: s.titleFileNumber || s.escrowNumber ? `${s.titleFileNumber ? `Title file ${s.titleFileNumber}` : ""}${s.titleFileNumber && s.escrowNumber ? " · " : ""}${s.escrowNumber ? `Escrow ${s.escrowNumber}` : ""}` : "Ask the settlement agent for their file number." },
    { key: "appointment_location", label: "Closing appointment location", applies: "yes", done: !!s.closingLocation, detail: s.closingLocation ? String(s.closingLocation) : "Not scheduled yet." },
    { key: "settlement_date", label: "Settlement date", applies: "yes", done: !!s.closingDate, detail: s.closingDate ? String(s.closingDate) : "Not scheduled yet." },
    insuranceItem(f.insurance ?? null, a.financing),
    // whether the seller has a lien to pay off is a FACT about the seller — unknown until recorded, on every side of the deal
    checkItem("payoff", "Seller's mortgage payoff", st(s.payoffStatus), "unknown"),
    checkItem("hoa_estoppel", "HOA / estoppel letter", st(s.hoaEstoppelStatus), "unknown"),
    checkItem("recording", "Deed / security instrument recording", st(s.recordingStatus), "yes"),
  ]
}

/** States of the recorded insurance checkpoint that need nothing more for the closing. */
const INSURANCE_DONE_STATES: ReadonlySet<string> = new Set(["verified", "not_required", "not_applicable_cash", "not_our_side"])

/**
 * PURE — the insurance item from the deal's OWN insurance checkpoint. When the deal records nothing the item says "not recorded yet"
 * and names the next action the checkpoint gives (its coaching: ask the lender for its requirement, record the binder) — never a
 * permanent "unknown". A refused read says so and is not done.
 */
export function insuranceItem(ins: ClosingTeamFacts["insurance"], financing: ClosingTeamAssessment["financing"]): ChecklistItem {
  const label = "Homeowner's insurance"
  if (!ins) return { key: "insurance", label, applies: financing === "cash" ? "no" : "yes", done: false, detail: "Not recorded yet. Next: record the lender's insurance requirement and the policy on the deal's insurance card." }
  if ("unreadable" in ins) return { key: "insurance", label, applies: "yes", done: false, detail: `${ins.unreadable} — not verified, so it is not shown as done.` }
  const applies: ChecklistItem["applies"] = ins.state === "not_applicable_cash" || ins.state === "not_our_side" || ins.state === "not_required" ? "no" : "yes"
  const done = INSURANCE_DONE_STATES.has(ins.state)
  const notYet = ins.state === "requirement_unknown" || ins.state === "financing_unknown" || ins.state === "required_missing"
  return { key: "insurance", label, applies, done, detail: `${notYet ? "Not recorded yet: " : ""}${ins.label}. ${ins.detail}${!done && ins.coaching ? ` Next: ${ins.coaching}` : ""}` }
}

// ─── 5 · WHO OWNS A CLOSING DOCUMENT ────────────────────────────────────────────────────────────────────────────────

/** THE CLOSING-DISCLOSURE RULE, as data the UI copy and the proof read: the lender / settlement agent issues; AI only compares. */
export const CLOSING_STATEMENT_AI_RULE = { mayCompare: true, mayProposeCorrection: true, mayRouteRequest: true, mayIssue: false, mayFabricate: false } as const

export type DocumentOwnerVerdict =
  | { applies: false; reason: string }
  | { applies: true; ownerRole: string; participantId: string | null; participantName: string | null; offPlatform: boolean; route: "assigned_party" | "agent_or_coordinator_obtains"; note: string }

/**
 * PURE — the ACTUAL party responsible for a closing document on THIS deal, from what is recorded. When nobody is recorded the
 * answer is "unassigned — the agent or coordinator obtains it from the verified party": a name is NEVER filled in.
 */
export function closingDocumentOwner(docType: string, f: ClosingTeamFacts, a: ClosingTeamAssessment = assessClosingTeam(f)): DocumentOwnerVerdict {
  const t = String(docType ?? "").trim().toLowerCase()
  const byRole = (r: ClosingPartyRole) => f.participants.find((p) => p.party_role === r) ?? null
  const agentRow = a.settlementAgent.participantId ? f.participants.find((p) => p.id === a.settlementAgent.participantId) ?? null : null
  const pick = (ownerRole: string, p: ClosingTeamParticipant | null, note: string): DocumentOwnerVerdict =>
    p ? { applies: true, ownerRole, participantId: p.id, participantName: p.name ?? null, offPlatform: !p.vendor_id, route: "assigned_party", note }
      : { applies: true, ownerRole, participantId: null, participantName: null, offPlatform: true, route: "agent_or_coordinator_obtains", note: `${note} Nobody is recorded for it yet — the deal's agent or coordinator obtains it from the verified party and records who that is.` }
  if (/closing_disclosure/.test(t)) {
    if (a.financing === "cash") return { applies: false, reason: "A cash purchase has no lender Closing Disclosure — the settlement agent's settlement statement governs the money." }
    if (a.financing === "unknown") return { applies: true, ownerRole: "lender", participantId: null, participantName: null, offPlatform: true, route: "agent_or_coordinator_obtains", note: "Whether the deal is financed is not recorded — record it before the Closing Disclosure is tracked." }
    return pick("lender", byRole("lender"), "The lender issues the Closing Disclosure (it may deliver it through its settlement agent). AI may compare it and propose a correction request; it never issues one.")
  }
  if (t === "settlement_statement" || t === "alta_settlement_statement" || t === "hud_1") return pick("settlement_agent", agentRow, "The settlement agent prepares the settlement statement.")
  if (t === "title_commitment" || t === "title_report" || t === "title_opinion") {
    const examiner = a.state.policy && a.state.policy.titleSearch.assignedByLaw ? (byRole("settlement_attorney") ?? byRole("buyer_attorney") ?? agentRow) : (byRole("title_company") ?? agentRow)
    return pick(a.state.policy?.titleSearch.assignedByLaw ? "attorney_title_examiner" : "title_company", examiner, a.state.policy ? a.state.policy.titleSearch.note : "The title company or the attorney examining title issues it.")
  }
  if (t === "deed") return pick("deed_preparer", byRole("seller_attorney") ?? byRole("settlement_attorney") ?? agentRow, a.state.policy && a.state.policy.involvement !== "customary" ? `${a.state.policy.stateName}: preparing the deed is attorney work.` : "The seller's attorney or the settlement agent prepares the deed.")
  if (t === "payoff_statement" || t === "payoff_letter") return pick("settlement_agent", agentRow, "The settlement agent orders the seller's payoff from the seller's existing lender.")
  if (t === "hoa_estoppel" || t === "estoppel_letter") return pick("settlement_agent", agentRow, "The settlement agent requests the estoppel from the association.")
  return pick("deal_team", null, "This document has no closing-party owner rule.")
}

// ─── 6 · A SIGNED CHANGED TERM AND THE LENDER'S WAITING PERIOD ──────────────────────────────────────────────────────

/** The changes that REQUIRE a new three-business-day wait under 12 CFR 1026.19(f)(2)(ii) — the revision vocabulary the receipt ledger already carries (m905). */
export const WAIT_RESTARTING_CD_CHANGES = ["apr_changed", "loan_product_changed", "prepayment_penalty_added"] as const

/**
 * PURE — what a signed changed term means for the Closing Disclosure. A changed price, credit, commission or date does NOT by
 * itself restart the TRID waiting period: the creditor must provide a CORRECTED disclosure (12 CFR 1026.19(f)(2)(i)), and only an
 * APR that becomes inaccurate, a changed loan product or an added prepayment penalty requires a new waiting period
 * (1026.19(f)(2)(ii)) — and that determination is the LENDER's, recorded on its receipt (trid_disclosure_receipts.
 * lender_new_wait_determination). Nothing here restarts or waives a wait; ambiguity is routed to a person.
 */
export function closingDisclosureConsequence(input: { changedTerms: readonly string[]; financing: "cash" | "financed" | "unknown" }): {
  correctedStatementRequired: boolean
  correctedCdRequired: boolean
  waitRestartDecidedBy: "lender" | "not_applicable"
  restartsWaitAutomatically: false
  reviewBy: "human"
  note: string
} {
  const money = input.changedTerms.some((k) => /price|credit|commission|contribution|earnest|closing_date|loan|financ|concession|repair/.test(k))
  if (input.financing === "cash") {
    return { correctedStatementRequired: money, correctedCdRequired: false, waitRestartDecidedBy: "not_applicable", restartsWaitAutomatically: false, reviewBy: "human",
      note: money ? "Cash deal: the settlement agent issues a revised settlement statement for the changed terms; there is no lender waiting period." : "No settlement figure changed." }
  }
  return {
    correctedStatementRequired: money, correctedCdRequired: money && input.financing === "financed", waitRestartDecidedBy: "lender", restartsWaitAutomatically: false, reviewBy: "human",
    note: money
      ? "Signed terms changed after the Closing Disclosure: the lender issues a corrected Closing Disclosure. A new three-business-day wait applies only if the APR becomes inaccurate, the loan product changes or a prepayment penalty is added — the lender determines that and the deal team records the lender's determination; nothing restarts or waives the wait automatically."
      : "No Closing Disclosure figure is affected by this change.",
  }
}
