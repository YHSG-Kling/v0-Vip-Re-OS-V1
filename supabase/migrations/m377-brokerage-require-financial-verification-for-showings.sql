-- m377 — the BUYER FINANCIAL GATE becomes a tenant setting.
-- ─────────────────────────────────────────────────────────────────────────────
-- OWNER RULING: "the gate should be included as a setting choice from the tenant
-- if they want to block the financial verification before setting or scheduling
-- a showing."
--
-- ── WHAT WAS ACTUALLY WRONG ─────────────────────────────────────────────────
-- lib/buyer-execution/buyer-execution-engine.ts enforceFinancialGate() is a
-- complete, correct implementation — pre-approval / proof-of-funds / lender
-- intro / agent confirmation, plus expiry — and it was enforced NOWHERE. Its
-- only two callers were themselves unreachable (checkBuyerCanPerformAction had
-- zero callers; the voice path bottomed out in another zero-caller action). The
-- live booking paths — app/actions/showings.ts and app/actions/self-book-showing.ts
-- — had no financial check of any kind. So the gate was a capability the product
-- claimed and never applied.
--
-- The fix is NOT to switch it on for everyone. Requiring a lender's confirmation
-- before a buyer may be shown a house is a real brokerage policy decision with
-- real fair-housing and business consequences, and brokerages differ on it. Some
-- want it absolutely; some show first and qualify later. That is exactly the
-- shape of a tenant setting.
--
-- ── WHY A COLUMN ON brokerages, NOT brokerage_settings.settings ─────────────
-- brokerages already carries this class of tenant policy flag as real, typed,
-- NOT NULL columns — widget_enabled, twins_require_approval, farm_mail_enabled,
-- revenue_share_enabled — and m305 put default_assignment_method there for the
-- same reason. The row always exists (it IS the tenant), so a read needs no
-- upsert dance and can never be undefined-by-absence.
--
-- brokerage_settings was rejected: it is the integration-CREDENTIAL table (ghl
-- api key, esign key, calendar token, idx key) and it is EMPTY in production —
-- zero rows against two live brokerages. A policy that decides whether a showing
-- may be booked must not be a jsonb key in a row that may not exist, where
-- "absent" and "false" are indistinguishable and a typo is a silent policy change.
--
-- ── THE DEFAULT IS THE WHOLE POINT ─────────────────────────────────────────
-- false = today's behaviour, exactly. Nothing is blocked that is not blocked
-- right now. Turning this on is an opt-in decision a broker or admin makes
-- deliberately in Settings, because switching it on is a material live change:
-- buyers who were previously bookable stop being bookable the moment it flips.
-- A NOT NULL DEFAULT false backfills every existing brokerage to current
-- behaviour, so this migration changes nothing until somebody chooses otherwise.
--
-- No CHECK constraint is needed or possible to add meaningfully: boolean NOT NULL
-- already admits exactly the two legal values. (m305 needed a CHECK because its
-- column is free text.)

ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS require_financial_verification_for_showings
  boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN brokerages.require_financial_verification_for_showings IS
  'Tenant policy (m377): when true, a buyer must pass enforceFinancialGate(ctx, ''tour'') — pre-approval, proof of funds, lender intro or agent confirmation, unexpired — before a showing can be requested, created, self-booked or confirmed for them. Enforced in app/actions/showings.ts and app/actions/self-book-showing.ts via checkBuyerCanPerformAction, which also logs each block to the buyer execution event log. DEFAULT false preserves pre-m377 behaviour, where the gate existed but was enforced nowhere; a broker or admin opts in from Settings.';
