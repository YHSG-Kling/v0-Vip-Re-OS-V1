// lib/intelligence/loan-milestone-sync.ts
//
// LOAN-MILESTONE SYNC (pure) — financing is where deals quietly die and buyers get anxious in the
// dark. A human team keeps the buyer, the agent, and the lender on the SAME page as the loan moves;
// this decides, for each loan milestone, what the Deal Coordinator should do — reassure the buyer with
// a gated update, prompt the agent to act, or escalate a denial/delay. Sensitive milestones (a denial)
// NEVER auto-message the buyer — they route to the agent's judgment. Pure (no I/O), unit-tested.

export type LoanMilestone =
  | "application_submitted" | "pre_approval" | "conditional_approval"
  | "appraisal_ordered" | "appraisal_complete" | "clear_to_close" | "funded"
  | "denied" | "delay"

export type SyncAudience = "buyer" | "agent" | "both" | "none"
export type SyncTone = "reassure" | "action" | "celebrate" | "urgent"

export interface LoanSyncInput {
  milestone: LoanMilestone
  /** days to the scheduled close (null when unknown). */
  daysToClose: number | null
}

export interface LoanSyncPlan {
  notify: boolean
  audience: SyncAudience
  tone: SyncTone
  /** the gated buyer-facing update (null when the buyer should NOT be auto-messaged). */
  buyerMessage: string | null
  /** the internal note/prompt for the agent (null when none). */
  agentNote: string | null
  reason: string
}

/** Decide the loan-milestone sync play. Pure. */
export function planLoanMilestoneSync(input: LoanSyncInput): LoanSyncPlan {
  const closing = typeof input.daysToClose === "number" && input.daysToClose >= 0 ? input.daysToClose : null
  const soon = closing !== null && closing <= 14

  switch (input.milestone) {
    case "application_submitted":
      return { notify: true, audience: "buyer", tone: "reassure", reason: "loan application is in — set expectations so the buyer isn't anxious",
        buyerMessage: "Great news — your loan application is officially in with the lender. Over the next couple of weeks they'll verify your details and order the appraisal. I'll keep you posted at every step, and you can always reach out with any question. Nothing you need to do right now.",
        agentNote: "Loan application submitted — buyer reassurance sent; watch for appraisal/conditions." }

    case "pre_approval":
    case "conditional_approval":
      return { notify: true, audience: "both", tone: "celebrate", reason: "approval milestone — celebrate + name the remaining conditions",
        buyerMessage: "Exciting update — your loan is approved (with the usual conditions the lender will finalize). We're right on track. I'll let you know the moment we have the clear-to-close. Onward!",
        agentNote: "Loan conditionally approved — confirm outstanding conditions with the lender and keep the timeline moving." }

    case "appraisal_ordered":
      return { notify: true, audience: "buyer", tone: "reassure", reason: "appraisal ordered — keep the buyer informed",
        buyerMessage: "Quick update — the appraisal has been ordered. This is a normal, expected step where a licensed appraiser confirms the home's value for the lender. I'll share the result as soon as it's back.",
        agentNote: "Appraisal ordered — watch for the result; flag any value gap early." }

    case "appraisal_complete":
      return { notify: true, audience: "buyer", tone: "reassure", reason: "appraisal back — reassure and move forward",
        buyerMessage: "The appraisal is complete and we're moving forward. The lender is finishing their review toward the clear-to-close. We're close — I'll be in touch with next steps shortly.",
        agentNote: "Appraisal complete — confirm no value gap; push toward clear-to-close." }

    case "clear_to_close":
      return { notify: true, audience: "both", tone: "celebrate", reason: "clear to close — the big one; celebrate + closing prep",
        buyerMessage: "The best news yet — you're CLEAR TO CLOSE! 🎉 The lender has fully approved your loan. I'll walk you through the final steps: reviewing your closing disclosure, your final figures, and scheduling the signing. We're almost home.",
        agentNote: "CLEAR TO CLOSE — coordinate signing, final walkthrough, and the closing disclosure review." }

    case "funded":
      return { notify: true, audience: "both", tone: "celebrate", reason: "loan funded — the deal is done",
        buyerMessage: "It's official — your loan has funded and the keys are yours! 🏡 Congratulations, and welcome home. I'm here for anything you need from here on.",
        agentNote: "Loan funded — kick off the closing testimonial + lifetime/sphere handoff." }

    case "denied":
      // SENSITIVE — never auto-message the buyer; this needs the agent's judgment + a human call.
      return { notify: true, audience: "agent", tone: "urgent", reason: "loan denied — sensitive; route to the agent, never an automated buyer message",
        buyerMessage: null,
        agentNote: "⚠ Loan DENIED — do NOT auto-message the buyer. Call them personally; explore alternative financing / lenders and salvage the deal if possible." }

    case "delay":
      return { notify: true, audience: "both", tone: soon ? "urgent" : "action", reason: soon ? "loan delay close to closing — urgent coordination" : "loan delay — get ahead of it",
        buyerMessage: "A quick, honest heads-up: the lender needs a little more time on a couple of items. This is more common than people think and we're on it. I'll have a clear update for you very soon — no need to worry.",
        agentNote: soon ? "⚠ Loan DELAY with closing near — coordinate an extension and align all parties NOW." : "Loan delay — chase the outstanding items with the lender and keep the buyer calm." }
  }
}

/** The transaction_lenders columns that signal a financing milestone (live schema). */
export interface LenderState {
  pre_approval_date?: string | null
  appraisal_ordered_date?: string | null
  appraisal_completed_date?: string | null
  clear_to_close_date?: string | null
  /** free-text underwriting status — the only signal for denied / funded / conditional. */
  underwriting_status?: string | null
}

/** PURE. Derive the FURTHEST-ALONG loan milestone a lender row has reached (or null when financing has
 *  not started — honest skip, no message). Structured date columns win; underwriting_status text is the
 *  only source for denied / funded / conditional-approval states that have no dedicated column. Checked
 *  most-advanced → least so a row that is clear-to-close reports clear_to_close, not appraisal. The
 *  runner hands the result to syncLoanMilestone, which is idempotent per (contact, milestone) — so the
 *  furthest milestone fires once and never re-notifies. */
export function deriveLoanMilestone(l: LenderState): LoanMilestone | null {
  const u = (l.underwriting_status ?? "").toLowerCase()
  if (/(deni|declin|reject|turned down)/.test(u)) return "denied"
  if (/fund/.test(u)) return "funded"
  if (l.clear_to_close_date || /(clear[ _-]?to[ _-]?close|cleared to close|\bctc\b)/.test(u)) return "clear_to_close"
  if (l.appraisal_completed_date) return "appraisal_complete"
  if (l.appraisal_ordered_date) return "appraisal_ordered"
  if (/(condition|approv)/.test(u)) return "conditional_approval"
  if (l.pre_approval_date) return "pre_approval"
  return null
}
