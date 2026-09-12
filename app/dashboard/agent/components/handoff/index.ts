// The agent-side FIRST-TOUCH ACKNOWLEDGEMENT surface, mounted on the agent
// dashboard (app/dashboard/agent/page.tsx). It is the only caller of
// acknowledgeLeadHandoffAction — the writer of assignment_log.claimed, which
// three intelligence surfaces read as "this handoff is still awaiting first
// touch" (daily-briefing-generator, isa-overnight handoffs_unclaimed,
// user-type-briefs/team-lead).
//
// NOT the same thing as NewlyConvertedContactsPanel next door: that card lists
// contacts promoted in the last 7 days off `contacts.created_at` and has no
// write at all. This one reads the HANDOFF LEDGER (assignment_log, claimed =
// false) and closes it.
export { NewContactHandoffPanel } from "./new-contact-handoff-panel"
