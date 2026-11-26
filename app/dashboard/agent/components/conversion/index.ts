// NewlyConvertedContactsPanel is the only conversion surface that ships — it is mounted on
// the agent dashboard (app/dashboard/agent/page.tsx). The three contact-scoped cards that
// used to sit alongside it (HandoffContextCard, FirstHumanTouchCard, ConversionCoachingCard)
// were never rendered anywhere and duplicated QualificationSummaryCard
// (app/crm/components/os/qualification-summary-card.tsx), which renders the persisted
// contacts.isa_handoff_brief on the contact itself — handoff reason, urgency, conversation
// history and suggestedNextStep, generated once by lib/ai-isa/generate-handoff-brief rather
// than re-derived in the browser from ai_isa_qualifications.qualification_signals.
export { NewlyConvertedContactsPanel } from "./newly-converted-contacts-panel"
