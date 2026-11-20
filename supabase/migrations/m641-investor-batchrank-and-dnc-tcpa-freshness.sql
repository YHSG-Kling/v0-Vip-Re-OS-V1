-- supabase/migrations/m641-investor-batchrank-and-dnc-tcpa-freshness.sql
--
-- ── APPLIED LIVE 2026-09-16 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m641_investor_batchrank_and_dnc_tcpa_freshness) ──
--
-- Lane 68A (wave 68). Two independent additive changes, one migration:
--
-- (1) OPTIONAL BatchRank ranking on the investor off-market candidates the wave-67
--     BatchData rail (m638) already writes. Owner ruling researched at batchdata.io/
--     buy-box-api + batchdata.io/batchrank (2026-09-16): BatchRank is an AI
--     sale-propensity score PER PROPERTY (High/Medium/Low), custom-priced, an
--     OPTIONAL add-on layer over Property Search results — never the source of the
--     candidates (that stays quickList + valuation.estimatedValue + equityPercent +
--     general.propertyTypeDetail filters). Written by the runner ONLY when
--     lib/external/batchdata-batchrank.ts::rankCandidatesWithBatchRank actually ran
--     (BATCHDATA_BATCHRANK_ENABLED=true AND a token provisioned) — both columns stay
--     NULL otherwise, which is the honest "not ranked" state, not a fabricated zero.
--     Read by: the InvestorDealsPanel (band only — never the raw score, matching the
--     owner-redaction posture on this same surface) and getInvestorDealMatch's sort.
--
-- (2) FRESH DNC/TCPA SCRUB timestamp on contacts. Owner ruling verbatim: "we do want
--     to make sure that the phone/scrub and email before using it." The outbound TCPA
--     gate (lib/communication/tcpa-gate.ts) already reads contacts.dnc_status; this
--     adds the FRESHNESS clock that column was missing — a stored dnc_status with no
--     verified_at was untrustworthy after ANY amount of time, not staleness-checked at
--     all. Stamped by lib/compliance/phone-scrub-runner.ts's intake scrub (a future,
--     integrator-owned wire-up — see the lane report) and by the gate itself on every
--     live re-check it performs. contacts.email_verified / email_verification_date
--     already exist (m-unknown, pre-existing) and needed NO new column — the email
--     side of this same ruling reuses them as-is.

ALTER TABLE public.investor_offmarket_candidates
  ADD COLUMN IF NOT EXISTS batchrank_score numeric,
  ADD COLUMN IF NOT EXISTS batchrank_band  text;

ALTER TABLE public.investor_offmarket_candidates
  DROP CONSTRAINT IF EXISTS investor_offmarket_candidates_batchrank_band_check;
ALTER TABLE public.investor_offmarket_candidates
  ADD CONSTRAINT investor_offmarket_candidates_batchrank_band_check
  CHECK (batchrank_band IS NULL OR batchrank_band IN ('high', 'medium', 'low'));

COMMENT ON COLUMN public.investor_offmarket_candidates.batchrank_score IS
  'OPTIONAL BatchRank sale-propensity numeric score (0-100-ish, provider-defined) — NULL when BatchRank was not run (disabled by default, custom-priced). Written by lib/buyer-search/investor-offmarket-runner.ts when lib/external/batchdata-batchrank.ts::rankCandidatesWithBatchRank returns ranked:true.';
COMMENT ON COLUMN public.investor_offmarket_candidates.batchrank_band IS
  'high | medium | low — the investor-facing band derived from batchrank_score. This is the column the redacted investor reader surfaces (never the raw score) and getInvestorDealMatch sorts candidates by when present.';

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS dnc_verified_at timestamptz;

COMMENT ON COLUMN public.contacts.dnc_verified_at IS
  'Wave 68 — when contacts.dnc_status (and the TCPA-litigator disposition folded into phone_status) was last CONFIRMED against a live DNC/TCPA source (BatchData check_dnc_status/check_tcpa_status, or the intake skip-trace scrub). lib/communication/tcpa-gate.ts::enforceTCPACompliance treats a verdict older than DNC_TCPA_SCRUB_STALENESS_DAYS (30) — or this column being NULL — as stale and re-verifies live before any outbound call/SMS, failing closed when BatchData is unconfigured. Stamped by the gate itself and (integrator follow-up) by lib/compliance/phone-scrub-runner.ts at intake.';
