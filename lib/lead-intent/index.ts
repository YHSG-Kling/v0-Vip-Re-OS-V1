/**
 * lib/lead-intent — the inbound-intent door for LEADS.
 *
 * One entry point, `evaluateInboundLeadSignal`, shared by every channel a lead
 * can reach the brokerage on (inbound calls, texts, email, direct-mail
 * responses). It records the message, honours "don't contact me", and hands
 * clear positive intent to the EXISTING conversion lane — it does not contain a
 * converter, a scorer or an assignment rule of its own.
 *
 * Assignment (WHICH agent receives the converted contact) is decided downstream
 * by lib/lead-assignment/assignment-engine.ts `evaluateAndAssignLead`, reached
 * through `acceptAIISAHandoff`. Nothing in this directory picks an agent.
 */

export {
  evaluateInboundLeadSignal,
  type InboundLeadChannel,
  type InboundLeadSignal,
  type InboundLeadOutcome,
  type InboundLeadIntentResult,
} from "./inbound-lead-intent"

export {
  applyLeadOptOut,
  type LeadOptOutChannel,
  type LeadOptOutSource,
  type ApplyLeadOptOutParams,
  type ApplyLeadOptOutResult,
} from "./lead-opt-out"
