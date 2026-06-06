-- Rich enrichment profile (JSONB) on leads + contacts so the full PDL / Perplexity / external
-- enrichment payload can be persisted downstream — employer, title, age, income, net worth,
-- household, education, socials, life events, etc. The canonical relational columns
-- (email, phone, mailing_*, *_verified) still live as first-class fields for fast gates; the
-- JSONB blob holds everything else so the AI ISA, AI Mesh, and dashboards can read it without
-- another enrichment call. Default '{}' so legacy rows are queryable.
ALTER TABLE leads    ADD COLUMN IF NOT EXISTS enrichment_profile jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_profile jsonb NOT NULL DEFAULT '{}'::jsonb;
