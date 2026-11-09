// lib/commission/cda-coach-rule.ts — THE AI SPLIT COACH, THE PURE HALF (wave 151, lane 151K; closes lane 150XY "Still open 1").
//
// Owner (wave 142, in force): "the AGENT fills the CDA MANUALLY from the approved CDA form in platform Media; AI MUST NOT FILL THE
// CDA (it may explain waterfall figures when asked)." Owner (wave 151, directive 151K): "AI may coach commission calculations but
// does not fill the CDA." CLAUDE.md §5: commission is off agent-facing display — so the coach EXPLAINS THE ARITHMETIC WITHOUT
// PROPOSING A NUMBER: it says what each waterfall step does and in what order, why a line exists, and — in words — where the
// agent's own entered figures disagree with the deterministic check (lib/commission/cda-discrepancy.ts), never what figure to
// type. The engine's computed amounts are never handed to the model; the only figures the model may repeat are the ones the agent
// typed and the contract states (which the CDA page already shows the agent), and a deterministic filter withholds any other.
//
// This module is PURE (no model, no I/O): the brief the model receives, the allowed-figure set, and the filter the model's words
// pass through. The model call lives in app/actions/transactions/cda-coach.ts (the platform's ONE AI entry point, booked to the
// session tenant). Nothing here writes closing_disclosure_agreement — CDA_FILL_RULE.aiFills stays false.

import { CDA_FILL_RULE } from "@/lib/transactions/cda-closing-policy"

/** THE COACH RULE, as data the proof and the UI copy read. */
export const CDA_COACH_RULE = {
  explainsArithmetic: true,
  proposesNumbers: false,
  fillsCda: CDA_FILL_RULE.aiFills, // false
  /** Only the agent's own entered figures and the contract's stated terms may appear in the coach's words. */
  figuresOnlyFromAgentAndContract: true,
} as const

/**
 * The waterfall's steps IN ORDER, named for what each does — the structure the coach explains. Derived from the engine's step
 * modules (lib/commission/waterfall/01-…10-*.ts; 11 validates and persists); the guard holds this list to that directory.
 */
const WATERFALL_STEP_ORDER: ReadonlyArray<{ step: string; explains: string }> = [
  { step: "01-resolve-rate", explains: "the gross commission RATE comes from the agreement in force on the deal's date (a deal override, the agent's agreement, else the brokerage default) — never today's profile" },
  { step: "02-calculate-gross", explains: "the GROSS commission is the rate applied to the governing purchase price (an executed addendum that moved the price moves this line)" },
  { step: "03-apply-gross-adjustments", explains: "approved agent concessions to a client come off the agent's gross BEFORE anything is split — never out of the seller's proceeds" },
  { step: "03b-referral-deduction", explains: "an agreed referral fee (inside agent or outside partner) comes off the top, before the brokerage / agent split" },
  { step: "04-split-agent-brokerage", explains: "what remains splits between agent and brokerage at the agreement's split" },
  { step: "05-apply-agent-adjustments", explains: "adjustments the agreement charges or credits the agent's side" },
  { step: "06-apply-brokerage-adjustments", explains: "adjustments on the brokerage's side" },
  { step: "07-apply-cap", explains: "the brokerage's share counts toward the agent's cap for the anniversary cycle in force; once the cap is met, the agent keeps the full split for the rest of the cycle" },
  { step: "08-team-split", explains: "a team agreement, when one is in force, splits the agent's share with the team lead at the team's terms" },
  { step: "09-revenue-share", explains: "revenue share, where the brokerage opted in and described the model, is funded from the brokerage's share" },
  { step: "10-fees", explains: "outstanding brokerage fees (tech, desk, E&O) are a SEPARATE deduction line after the split — a fee is not a sign the split is wrong" },
]

/** The structure of THIS deal's waterfall — flags only, no amounts: what applies and what does not. */
export interface CoachStructure {
  referralApplies: boolean
  capReached: boolean
  teamSplitApplies: boolean | null
  outstandingFeesExist: boolean
  cdaMode: "cda" | "no_cda"
}

/** The agent's own entered CDA figures and the contract's stated terms — the ONLY figures the coach may repeat. */
export interface CoachFigures {
  agentEntered: { grossCommission: number | null; agentNet: number | null; brokerageNet: number | null }
  contract: { purchasePrice: number | null; commissionPercentage: number | null }
}

/** The deterministic verdict, stripped to WORDS: which line disagrees and how seriously — never the expected number. */
export interface CoachDiscrepancyWords { field: string; severity: "warning" | "blocker" }

/** PURE — the numbers the coach may say: the agent's entries and the contract's terms, in every common written form. */
export function allowedFigureSet(f: CoachFigures): Set<string> {
  const out = new Set<string>()
  const add = (n: number | null) => {
    if (n === null || !Number.isFinite(n)) return
    const r2 = Math.round(n * 100) / 100
    out.add(String(r2)); out.add(String(Math.round(n)))
    out.add(r2.toFixed(2)); out.add(Math.round(n).toLocaleString("en-US")); out.add(r2.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
  }
  add(f.agentEntered.grossCommission); add(f.agentEntered.agentNet); add(f.agentEntered.brokerageNet)
  add(f.contract.purchasePrice); add(f.contract.commissionPercentage)
  return out
}

/** Every money / percentage / large number written in a sentence, normalized the way allowedFigureSet writes them. */
const FIGURE_RE = /(?:\$\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(%|percent)?/g

function figuresIn(sentence: string): string[] {
  const found: string[] = []
  for (const m of sentence.matchAll(FIGURE_RE)) {
    const raw = m[1].replace(/,/g, "")
    const n = Number(raw)
    if (!Number.isFinite(n)) continue
    // a step number (01-10), a page or a count of lines is not a figure; money and percentages are
    const isPct = !!m[2] || (m[0].includes("%"))
    const isMoney = m[0].trim().startsWith("$")
    if (!isPct && !isMoney && n < 1000 && !m[1].includes(".")) continue
    found.push(String(Math.round(n * 100) / 100))
  }
  return found
}

/**
 * PURE — THE FILTER. Each sentence of the model's words is kept only if every figure in it is one the agent typed or the contract
 * states; a sentence carrying any other figure is WITHHELD and replaced by a note. The coach explains; the agent types the number.
 */
export function filterCoachWords(text: string, allowed: Set<string>): { sentences: string[]; withheld: number } {
  const sentences = String(text ?? "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)
  const kept: string[] = []
  let withheld = 0
  for (const s of sentences) {
    const figs = figuresIn(s)
    if (figs.every((f) => allowed.has(f) || allowed.has(Number(f).toLocaleString("en-US")))) kept.push(s)
    else { withheld++; kept.push("[a figure was withheld — the coach explains the arithmetic; the agent types the number]") }
  }
  return { sentences: kept, withheld }
}

/** PURE — the brief the model receives: structure and words, no engine amounts. */
export function buildCoachBrief(input: { structure: CoachStructure; figures: CoachFigures; discrepancies: CoachDiscrepancyWords[]; question?: string | null }): { system: string; prompt: string } {
  const s = input.structure
  const f = input.figures
  const stated = (n: number | null, label: string) => (n === null ? `${label}: not entered` : `${label}: ${n}`)
  const system = [
    "You are a world-class commission-accounting coach for a real-estate brokerage, helping an agent who is FILLING OUT their own Commission Disbursement Authorization (CDA) by hand.",
    "HARD RULES: Explain the ORDER of the arithmetic and WHY each line exists. NEVER propose, compute, estimate or state a dollar amount or percentage other than the figures the agent already entered or the contract already states (listed below). Never tell the agent what number to type. Never say a figure is 'correct' — say what the deterministic check found, in words.",
    "Plain words, short sentences, no headings, no markdown, no lists longer than the steps. If the agent asks for a number, say that you explain the arithmetic and the agent enters the figure from the brokerage's approved CDA form and the agreement on file.",
  ].join("\n")
  const steps = WATERFALL_STEP_ORDER.filter((st) => (st.step === "03b-referral-deduction" ? s.referralApplies : st.step === "08-team-split" ? s.teamSplitApplies !== false : st.step === "10-fees" ? s.outstandingFeesExist : true))
  const prompt = [
    "THE WATERFALL, IN ORDER, for this deal:",
    ...steps.map((st, i) => `${i + 1}. ${st.explains}`),
    "",
    `Cap status: ${s.capReached ? "the agent's cap is met for this cycle — the brokerage's share no longer applies to the agent's split" : "the cap is not met — the brokerage's share applies and counts toward the cap"}.`,
    `Referral: ${s.referralApplies ? "a referral fee applies on this deal and comes off the top" : "no referral applies"}.`,
    `Team: ${s.teamSplitApplies === null ? "unknown" : s.teamSplitApplies ? "a team agreement applies" : "no team split"}.`,
    `Brokerage fees outstanding: ${s.outstandingFeesExist ? "yes — they appear as a separate deduction line" : "none"}.`,
    `CDA mode: ${s.cdaMode === "cda" ? "this brokerage uses a CDA; title disburses as the broker-signed CDA authorizes" : "this brokerage does not use a CDA"}.`,
    "",
    "THE FIGURES THE AGENT ENTERED (the only amounts you may repeat):",
    stated(f.agentEntered.grossCommission, "gross commission"), stated(f.agentEntered.agentNet, "agent net"), stated(f.agentEntered.brokerageNet, "brokerage net"),
    "THE CONTRACT'S STATED TERMS (also repeatable):",
    stated(f.contract.purchasePrice, "purchase price"), stated(f.contract.commissionPercentage, "commission percentage"),
    "",
    input.discrepancies.length
      ? `THE DETERMINISTIC CHECK FOUND: ${input.discrepancies.map((d) => `${d.field.replace(/_/g, " ")} (${d.severity})`).join("; ")}. Explain in words which step of the arithmetic that line depends on and what the agent should re-read on the agreement and the CDA form. Do not state the expected figure.`
      : "THE DETERMINISTIC CHECK FOUND no disagreement between the entered figures and the agreement on file.",
    input.question ? `\nTHE AGENT ASKS: ${String(input.question).slice(0, 500)}` : "",
    "\nWrite the explanation now.",
  ].join("\n")
  return { system, prompt }
}
