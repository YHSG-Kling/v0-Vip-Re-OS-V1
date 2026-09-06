-- m305 — the brokerage's DEFAULT assignment method becomes the admin's decision.
-- ─────────────────────────────────────────────────────────────────────────────
-- A BROKER COULD CHOOSE HOW A *MATCHED* LEAD ROUTES AND NOT HOW MOST OF THEM DO.
--
-- assignment_rules let an admin choose a method per rule. But a rule only fires
-- when its conditions match, and the interesting case is the ordinary one: a new
-- contact — especially a newly CONVERTED lead — that no rule covers. For that
-- lead both routers did the same thing, and it was hardcoded:
--
--   lib/lead-assignment/contact-assignment.ts   selectAgentByCapacity(...)
--   lib/lead-assignment/assignment-engine.ts    loadBalanceFallback(...)
--
-- Capacity-aware load balancing, always, with no way to change it. A brokerage
-- that runs a strict round-robin — the most common floor-time convention in the
-- business — could not have one. A brokerage that wants every unmatched lead
-- held for a human to place could not have that either. The method that decides
-- the MAJORITY of assignments was the one nobody could configure.
--
-- ── THE COLUMN ──────────────────────────────────────────────────────────────
-- A real column, not a key in brokerage_settings.settings, for one reason: it
-- can be CHECK-constrained. The jsonb blob admits any string, so a typo becomes
-- a silently wrong routing policy that nobody notices until leads pile on one
-- agent. The CHECK below makes that impossible, and it is the SAME five values
-- assignment_rules.rule_type admits, so per-rule and default use one vocabulary.
--
-- 'load_balance' is the default because it is what the code did before this
-- migration: existing behaviour is preserved exactly until an admin changes it.
--
-- 'manual' is deliberately allowed. It means "assign nobody unless a rule says
-- so" — a legitimate choice for a brokerage whose owner places every lead
-- personally. It DOES break the old "no contact is ever left unrouted"
-- invariant, which is why choosing it is an explicit, labelled decision in the
-- settings UI rather than a default, and why an unassigned contact under this
-- policy is recorded as a manual hold instead of failing silently.

ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS default_assignment_method text NOT NULL DEFAULT 'load_balance';

ALTER TABLE brokerages DROP CONSTRAINT IF EXISTS brokerages_default_assignment_method_check;

ALTER TABLE brokerages ADD CONSTRAINT brokerages_default_assignment_method_check CHECK (
  default_assignment_method = ANY (ARRAY[
    'round_robin', 'load_balance', 'geo_based', 'specialization', 'manual'
  ])
);

COMMENT ON COLUMN brokerages.default_assignment_method IS
  'How a new contact or converted lead is assigned when NO assignment_rule matches — the admin''s decision, set in Settings. Shares assignment_rules.rule_type''s vocabulary exactly (m305). Before this the fallback was hardcoded capacity-based load balancing, so the method deciding most assignments was the one nobody could configure. ''manual'' means hold for a person and deliberately leaves the contact unassigned.';
