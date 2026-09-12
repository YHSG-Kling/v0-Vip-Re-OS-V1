-- ═══════════════════════════════════════════════════════════════════════════
-- m376 — VENDOR INSURANCE VERIFICATION. The certificate of insurance becomes a
--        real record with a shape the database enforces.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- OWNER ASK: "vendor insurance verification" — a brokerage must not refer a
-- vendor whose liability coverage has lapsed.
--
-- ── WHAT ALREADY EXISTED, AND WHY NO NEW COLUMNS ARE ADDED ─────────────────
-- The audit that preceded this migration found the capability HALF-BUILT, not
-- absent:
--
--   · `vendor_directory` NO LONGER EXISTS. m355 absorbed it into `vendors` and
--     dropped it ("ONE VENDOR SYSTEM"). `vendors` is the canonical and only
--     vendor record — 16 tables FK to vendors(id), nothing FKs anywhere else.
--   · vendors.compliance_credentials (jsonb) ALREADY holds the insurance and
--     license expiry dates.
--   · lib/kernel/vendor-doc-compliance.ts ALREADY computes the verdict from
--     those dates — 60/30/7-day reminders, INSURANCE EXPIRED → hard suspend,
--     LICENSE EXPIRED → 14-day grace then suspend — and the daily
--     vendor-orchestration cron ALREADY runs it for every brokerage.
--
-- So adding carrier/policy/coverage/expiry COLUMNS would create a SECOND place
-- an expiry date lives, disagreeing with the one the live cron reads. That is
-- precisely the drift m353/m354/m355/m374 exist to kill, and lib/kernel/
-- manager-registry.ts records the ruling verbatim: "NO parallel table —
-- credentials live on the vendor". The richer certificate-of-insurance fields
-- therefore extend the EXISTING credential record; jsonb needs no DDL for that.
--
-- ── WHAT DOES NEED DDL: THE VOCABULARY, WHICH WAS UNENFORCED ───────────────
-- Nothing constrained the bag, and two silent-lapse bugs followed directly:
--
--   1. TYPO'D CREDENTIAL TYPE DOWNGRADES A HARD SUSPEND.
--      evaluateCredential hard-suspends on exactly the literal 'insurance'
--      (HARD_SUSPEND_TYPES). ANY other key falls through to the license branch
--      and gets a 14-DAY GRACE. So a bag written as {"insurnace":{...}} turns
--      "coverage lapsed, off the bench today" into "flagged, still bookable for
--      two more weeks" — with no error anywhere. The TypeScript union on
--      setVendorComplianceCredential guards the one caller; the DATABASE
--      guarded nothing.
--
--   2. AN UNPARSEABLE EXPIRY READS AS COMPLIANT.
--      daysUntil() returns NULL for anything Date.parse cannot read, and NULL
--      is deliberately (and correctly) treated as "no expiry on file → no
--      action, never a fabricated lapse". That honest rule becomes a hazard the
--      moment garbage can reach the column: "12/31/25" or "" makes a vendor
--      whose insurance died a year ago evaluate as perfectly fine, forever.
--
-- Both are closed here by making the bad value UNREPRESENTABLE rather than
-- merely discouraged. The check functions are IMMUTABLE and applied uniformly
-- to all four credential types, so no single type can drift weaker than another
-- through a copy-paste slip in a 4-branch inline expression.
--
-- Live at apply time: vendors=1, of which 0 have compliance_credentials. Every
-- constraint below is therefore free today. THAT IS WHY IT GOES IN NOW.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The credential RECORD shape ─────────────────────────────────────────
-- One certificate of insurance / licence / bond, as stored under its type key.
-- The key list IS the vocabulary: a misspelt field name (expires vs expiry) is
-- the same silent-lapse class as a misspelt type, so it is rejected too.
--
--   carrier          text   — the insurer's name
--   policy_number    text   — the policy identifier on the certificate
--   coverage_amount  number — liability limit in whole USD, >= 0
--   effective_date   date   — ISO yyyy-mm-dd, when coverage began
--   expiry           date   — ISO yyyy-mm-dd, when coverage lapses. THE field
--                             lib/kernel/vendor-doc-compliance.ts acts on.
--   url              text   — link to the stored certificate document
--   verified_at      ts     — when a human confirmed this certificate
--   verified_by      uuid   — WHICH ID SPACE: users.id, the same space
--                             vendors.verified_by holds (both are written from
--                             supabase.auth.getUser().id). NOT agents.id, NOT
--                             contacts.id. A jsonb field cannot carry an FK, so
--                             §4 puts the real FK on vendors.verified_by to
--                             pin the space in the schema itself.
--
-- A JSON null (or an absent key) means "not on file" and is ACCEPTED — that is
-- the honest state the evaluator already models, and forbidding it would force
-- callers to invent a date.
CREATE OR REPLACE FUNCTION vendor_credential_record_ok(rec jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_typeof(rec) = 'object'
     AND (rec - 'carrier' - 'policy_number' - 'coverage_amount' - 'effective_date'
              - 'expiry' - 'url' - 'verified_at' - 'verified_by') = '{}'::jsonb
     -- Dates must be ISO-leading, which is exactly what Date.parse reads back
     -- deterministically. CASE, not AND, so evaluation order is GUARANTEED —
     -- Postgres does not promise short-circuit within AND.
     AND (CASE WHEN rec ->> 'expiry'         IS NULL THEN true
               ELSE rec ->> 'expiry'         ~ '^\d{4}-\d{2}-\d{2}' END)
     AND (CASE WHEN rec ->> 'effective_date' IS NULL THEN true
               ELSE rec ->> 'effective_date' ~ '^\d{4}-\d{2}-\d{2}' END)
     AND (CASE WHEN rec ->> 'verified_at'    IS NULL THEN true
               ELSE rec ->> 'verified_at'    ~ '^\d{4}-\d{2}-\d{2}' END)
     AND (CASE WHEN jsonb_typeof(rec -> 'coverage_amount') = 'number'
               THEN (rec ->> 'coverage_amount')::numeric >= 0
               ELSE rec -> 'coverage_amount' IS NULL END)
$$;

COMMENT ON FUNCTION vendor_credential_record_ok(jsonb) IS
  'm376 — shape of ONE entry in vendors.compliance_credentials. Pins the field vocabulary and forces every date to be ISO-leading so daysUntil() can never silently read a lapsed vendor as compliant.';

-- ── 2. The credential BAG: the type vocabulary ─────────────────────────────
-- These four literals ARE CredentialType in lib/kernel/vendor-doc-compliance.ts.
-- 'insurance' is load-bearing: it is the sole member of HARD_SUSPEND_TYPES, so
-- only this exact spelling suspends a vendor the day coverage lapses.
CREATE OR REPLACE FUNCTION vendor_credential_bag_ok(bag jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_catalog
AS $$
  SELECT bag IS NULL
      OR ( jsonb_typeof(bag) = 'object'
       AND (bag - 'license' - 'insurance' - 'certification' - 'bond') = '{}'::jsonb
       AND (bag -> 'insurance'     IS NULL OR vendor_credential_record_ok(bag -> 'insurance'))
       AND (bag -> 'license'       IS NULL OR vendor_credential_record_ok(bag -> 'license'))
       AND (bag -> 'certification' IS NULL OR vendor_credential_record_ok(bag -> 'certification'))
       AND (bag -> 'bond'          IS NULL OR vendor_credential_record_ok(bag -> 'bond')) )
$$;

COMMENT ON FUNCTION vendor_credential_bag_ok(jsonb) IS
  'm376 — vendors.compliance_credentials vocabulary: license | insurance | certification | bond, and nothing else. A typo''d type key would fall out of HARD_SUSPEND_TYPES and downgrade an insurance lapse to a 14-day grace; this makes that unrepresentable.';

ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_compliance_credentials_shape;
ALTER TABLE vendors ADD CONSTRAINT vendors_compliance_credentials_shape
  CHECK (vendor_credential_bag_ok(compliance_credentials));

COMMENT ON COLUMN vendors.compliance_credentials IS
  'Certificate-of-insurance / licence / bond records, keyed by credential type (license|insurance|certification|bond — CHECKed by vendors_compliance_credentials_shape since m376). Each record: carrier, policy_number, coverage_amount, effective_date, expiry, url, verified_at, verified_by (users.id). lib/kernel/vendor-doc-compliance.ts computes the verdict from `expiry`; insurance expiry is a HARD SUSPEND. NO parallel table — credentials live on the vendor.';

-- ── 3. The sweep's index ───────────────────────────────────────────────────
-- runVendorDocCompliance scans exactly this predicate, per brokerage, daily:
--   .eq("brokerage_id", …).not("compliance_credentials", "is", null)
-- Partial, so it indexes only vendors that actually carry a credential.
CREATE INDEX IF NOT EXISTS idx_vendors_compliance_sweep
  ON vendors (brokerage_id)
  WHERE compliance_credentials IS NOT NULL;

-- ── 4. Pin the id space of the verifier ────────────────────────────────────
-- vendors.verified_by has been written since m2xx with supabase.auth.getUser().id
-- — a users.id — but carried NO foreign key, so nothing stopped an agents.id or
-- a contacts.id being written into it. Those are DISTINCT ID SPACES; a stray
-- agents.id here names the wrong person as the approver of a vendor's insurance,
-- which is the signature the brokerage would show a regulator. ON DELETE SET
-- NULL, not CASCADE: deleting a departed broker must never delete the vendor.
ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_verified_by_fkey;
ALTER TABLE vendors ADD CONSTRAINT vendors_verified_by_fkey
  FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL;

-- ── 5. LOUD VERIFICATION — RAISE if the migration did not achieve its goal ──
DO $$
DECLARE
  probe uuid;
  n     integer;
  ok    boolean;
BEGIN
  -- 5a. Both check functions exist and are IMMUTABLE (a VOLATILE function
  --     cannot back a CHECK, so this is the load-bearing property).
  SELECT count(*) INTO n
    FROM pg_proc
   WHERE proname IN ('vendor_credential_record_ok', 'vendor_credential_bag_ok')
     AND provolatile = 'i';
  IF n <> 2 THEN
    RAISE EXCEPTION 'm376 FAILED: expected 2 IMMUTABLE credential check functions, found %', n;
  END IF;

  -- 5b. The constraint exists on vendors.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.vendors'::regclass
       AND conname  = 'vendors_compliance_credentials_shape'
       AND contype  = 'c'
  ) THEN
    RAISE EXCEPTION 'm376 FAILED: vendors_compliance_credentials_shape is missing';
  END IF;

  -- 5c. The FK on verified_by exists and points at users.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid  = 'public.vendors'::regclass
       AND conname   = 'vendors_verified_by_fkey'
       AND contype   = 'f'
       AND confrelid = 'public.users'::regclass
  ) THEN
    RAISE EXCEPTION 'm376 FAILED: vendors.verified_by is not FK-bound to users(id)';
  END IF;

  -- 5d. The partial index exists.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'vendors'
       AND indexname = 'idx_vendors_compliance_sweep'
  ) THEN
    RAISE EXCEPTION 'm376 FAILED: idx_vendors_compliance_sweep is missing';
  END IF;

  -- 5e. BEHAVIOURAL PROOF, not just presence. Assert the constraint ACCEPTS a
  --     full certificate of insurance and REJECTS each hazard it exists to
  --     stop. Everything here runs against the real function.
  ok := vendor_credential_bag_ok(
    '{"insurance":{"carrier":"Acme Mutual","policy_number":"GL-1","coverage_amount":1000000,
                   "effective_date":"2026-01-01","expiry":"2027-01-01",
                   "url":"https://example.test/coi.pdf",
                   "verified_at":"2026-08-06T00:00:00.000Z",
                   "verified_by":"00000000-0000-0000-0000-000000000000"}}'::jsonb);
  IF NOT ok THEN
    RAISE EXCEPTION 'm376 FAILED: a complete, valid certificate of insurance was REJECTED';
  END IF;

  IF vendor_credential_bag_ok('{"insurnace":{"expiry":"2020-01-01"}}'::jsonb) THEN
    RAISE EXCEPTION 'm376 FAILED: a typo''d credential type was accepted — the hard-suspend downgrade is still reachable';
  END IF;

  IF vendor_credential_bag_ok('{"insurance":{"expires":"2020-01-01"}}'::jsonb) THEN
    RAISE EXCEPTION 'm376 FAILED: a typo''d field name was accepted — the expiry would be invisible to the sweep';
  END IF;

  IF vendor_credential_bag_ok('{"insurance":{"expiry":"12/31/2025"}}'::jsonb) THEN
    RAISE EXCEPTION 'm376 FAILED: an unparseable expiry was accepted — a lapsed vendor would read as compliant';
  END IF;

  IF vendor_credential_bag_ok('{"insurance":{"coverage_amount":-5}}'::jsonb) THEN
    RAISE EXCEPTION 'm376 FAILED: a negative coverage amount was accepted';
  END IF;

  IF vendor_credential_bag_ok('{"insurance":{"coverage_amount":"1000000"}}'::jsonb) THEN
    RAISE EXCEPTION 'm376 FAILED: a stringly-typed coverage amount was accepted';
  END IF;

  -- The honest states MUST stay representable: no bag at all, and a credential
  -- with no expiry on file. Forbidding either would force a caller to fabricate
  -- a date, which is the failure mode this whole lane exists to prevent.
  IF NOT vendor_credential_bag_ok(NULL) THEN
    RAISE EXCEPTION 'm376 FAILED: a vendor with no credentials on file is no longer representable';
  END IF;
  IF NOT vendor_credential_bag_ok('{"insurance":{"carrier":"Acme Mutual"}}'::jsonb) THEN
    RAISE EXCEPTION 'm376 FAILED: a credential with no expiry on file is no longer representable';
  END IF;

  -- 5f. And prove the CONSTRAINT (not merely the function) actually bites on a
  --     real row. Rolled back via the savepoint — no test data survives.
  SELECT id INTO probe FROM vendors LIMIT 1;
  IF probe IS NOT NULL THEN
    BEGIN
      UPDATE vendors SET compliance_credentials = '{"insurnace":{"expiry":"2020-01-01"}}'::jsonb
       WHERE id = probe;
      RAISE EXCEPTION 'm376 FAILED: the table accepted a typo''d credential type on a live row';
    EXCEPTION WHEN check_violation THEN
      NULL;  -- 23514 — exactly what we wanted.
    END;
  END IF;

  RAISE NOTICE 'm376 OK — credential vocabulary pinned, dates forced parseable, verified_by FK-bound to users(id), sweep index present.';
END $$;

COMMIT;
