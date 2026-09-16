-- m640-net-worth-and-credit-score-range-get-typed-columns.sql
-- ── WRITTEN, NOT APPLIED. The integrator applies this. ──
--
-- Lane 67C carry (d): PeopleData's net_worth_range and credit_score_range
-- (lib/external/peopledata-client.ts skipTraceWithPeopleData ->
-- PeopleDataEnrichment.netWorth / .creditScoreRange) have been written into
-- leads.enrichment_profile / contacts.enrichment_profile jsonb since the
-- orchestrator's `profile` object was built (lib/lead-pipeline/
-- enrichment-orchestrator.ts ~:574/577: `net_worth: enriched.netWorth`,
-- `credit_score_range: enriched.creditScoreRange`) with NO reader anywhere in
-- the tree ever pulling `.net_worth` / `.credit_score_range` back OUT of that
-- blob — a writer with no reader (CLAUDE.md §1). Every sibling financial
-- fact PeopleData returns (household_income, home_owner_status, home_value)
-- was already promoted to a first-class contacts column by
-- lib/lead-pipeline/enrichment-column-map.ts::peopleDataProfileToContactColumns
-- and read by lib/contacts/persona-builder.ts; these two were left behind.
--
-- NOT the same concept as contacts.credit_score_band (app/actions/
-- credit-copilot.ts / app/credit-pipeline/page.tsx): that column is the
-- AGENT-TRACKED band during a credit-repair coaching pipeline, hand-set and
-- hand-advanced by a human. `credit_score_range` here is PeopleData's own
-- third-party market-intelligence ESTIMATE, captured passively at enrichment
-- time and never written by the credit-pipeline flow — same relationship as
-- `home_value_estimate` (provider estimate) vs a human-entered value
-- elsewhere. Different column, never merged, never overwritten by the other.
--
-- leads does NOT get these columns — same posture the file already documents
-- for household_income ("Leads carry a SUBSET of the contact columns...the
-- rest stay in enrichment_profile jsonb and are extracted at lead->contact
-- promotion"). A lead's financial profile is promoted to first-class columns
-- only once it becomes a contact; leads keeps the jsonb-only audit trail.
--
-- Readers built the same wave: lib/lead-pipeline/enrichment-column-map.ts
-- peopleDataProfileToContactColumns() now promotes both; the write happens on
-- every contact enrichment (lib/lead-pipeline/enrichment-orchestrator.ts Step
-- 6a contact branch, unchanged call site — it already spreads whatever that
-- function returns). lib/contacts/persona-builder.ts PersonaFacts gained
-- netWorth/creditScoreRange and uses them as financial-capacity buying
-- triggers / financing-concern pain points (deriveBuyingTriggers /
-- derivePainPoints), read by the three existing client_detailed_personas
-- consumers (lead-scoring persona join, open-house follow-up, persona-aware
-- content generation) — no new consumer needed, the existing ones just see a
-- richer PersonaFacts input.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS net_worth_range TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS credit_score_range TEXT;

COMMENT ON COLUMN contacts.net_worth_range IS
  'PeopleData-estimated household net worth range (e.g. "$250K-$500K"), promoted from enrichment_profile.net_worth by peopleDataProfileToContactColumns. Passive third-party estimate, never agent-edited.';
COMMENT ON COLUMN contacts.credit_score_range IS
  'PeopleData-estimated credit score range (e.g. "650-700"), promoted from enrichment_profile.credit_score_range by peopleDataProfileToContactColumns. NOT the same as credit_score_band, which is the agent-tracked credit-repair pipeline band (app/actions/credit-copilot.ts) — this column is a passive provider estimate, never written by that flow.';
