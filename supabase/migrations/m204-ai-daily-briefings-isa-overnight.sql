-- m204 — AI ISA section on the agent's daily briefing. The briefing covered tasks/
-- deals/listings but had ZERO visibility into the AI ISA's overnight work (qualified
-- handoffs awaiting first touch, unclaimed assignments, escalations, hot conversations
-- in progress). isa_overnight carries the structured section; the generator merges its
-- items into top_priority_actions and the briefing page renders the section.
ALTER TABLE public.ai_daily_briefings
  ADD COLUMN IF NOT EXISTS isa_overnight jsonb;
