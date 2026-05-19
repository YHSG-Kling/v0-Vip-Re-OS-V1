-- ============================================================================
-- Migration 1065 — State-specific fair housing protected classes
-- ============================================================================
--
-- WHY:
--   Federal Fair Housing Act covers 7 protected classes. Many states ADD more:
--     CA Gov. Code §12955: source of income, immigration status, ancestry,
--                          marital status, sexual orientation, gender identity,
--                          gender expression, age, genetic info, military/veteran
--     NY Executive Law §296: lawful occupation, lawful source of income,
--                            arrest record, citizenship status
--     MA Ch. 151B: marital status, age, veteran status, source of income
--     MD State Govt §20-705: source of income, sexual orientation
--     CO §24-34-502: source of income, sexual orientation, marital status,
--                    creed, ancestry, military status
--   ...and so on. Exposure: HUD + state AG enforcement = $16,000+ per violation.
--
-- WHAT:
--   1. state_protected_classes table: (state, class, regulation_reference,
--      severity_default). Seeded for top jurisdictions.
--   2. Rule evaluators load brokerage.state → applicable extra classes →
--      augment the federal-class violation check at runtime.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.state_protected_classes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code            text NOT NULL,             -- 'CA','NY','MA',...
  protected_class       text NOT NULL,
  regulation_reference  text NOT NULL,
  severity_default      text NOT NULL DEFAULT 'high'
                        CHECK (severity_default IN ('low','medium','high','critical')),
  patterns              text[] NOT NULL DEFAULT '{}',  -- array of regex/glob hints
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (state_code, protected_class)
);

CREATE INDEX IF NOT EXISTS idx_spc_state ON public.state_protected_classes(state_code, is_active);

ALTER TABLE public.state_protected_classes ENABLE ROW LEVEL SECURITY;

-- Reference data — readable by all authenticated users.
DROP POLICY IF EXISTS spc_read_all ON public.state_protected_classes;
CREATE POLICY spc_read_all ON public.state_protected_classes
  FOR SELECT USING (true);

DROP POLICY IF EXISTS spc_superadmin_write ON public.state_protected_classes;
CREATE POLICY spc_superadmin_write ON public.state_protected_classes
  FOR ALL
  USING (current_user_type() = 'superadmin')
  WITH CHECK (current_user_type() = 'superadmin');

-- ── Seed: top states with materially-broader protected classes ─────────────
INSERT INTO public.state_protected_classes (state_code, protected_class, regulation_reference, severity_default, patterns) VALUES
-- CALIFORNIA — Gov. Code §12955 + Unruh Civil Rights Act §51
  ('CA','source of income',         'CA Gov. Code §12955', 'high', ARRAY['(?:no|don.?t).{0,15}section\s*8','no\s+vouchers','no\s+ssi','no\s+ssdi','no\s+government\s+assist','no\s+housing\s+choice']),
  ('CA','immigration status',       'CA Gov. Code §12955', 'high', ARRAY['(?:citizen|legal\s+status|green\s+card|ssn)\s+(?:required|only)']),
  ('CA','ancestry',                 'CA Gov. Code §12955', 'high', ARRAY[]::text[]),
  ('CA','marital status',           'CA Gov. Code §12955', 'high', ARRAY['married\s+couples?\s+(?:only|preferred)','no\s+single\s+(?:moms?|dads?|parents?)']),
  ('CA','sexual orientation',       'CA Gov. Code §12955', 'high', ARRAY['straight\s+(?:couples?|tenants?)\s+only','no\s+lgbt']),
  ('CA','gender identity',          'CA Gov. Code §12955', 'high', ARRAY[]::text[]),
  ('CA','age',                      'CA Gov. Code §12955 + Unruh §51', 'high', ARRAY['(?:no|adults?\s+only).*(?:children|kids)','55\+\s+only(?!\s+community)']),
  ('CA','military or veteran',      'CA Gov. Code §12955', 'high', ARRAY['no\s+(?:military|veterans?)']),
-- NEW YORK — Executive Law §296 + NYC HRL §8-107
  ('NY','lawful source of income',  'NY Executive Law §296(5)(a)(1)', 'high', ARRAY['(?:no|don.?t).{0,15}section\s*8','no\s+vouchers','no\s+housing\s+choice']),
  ('NY','arrest or criminal record','NYC HRL §8-107(11)', 'high', ARRAY['(?:no|don.?t).{0,15}(?:criminal|felons?|convicts?|records?)']),
  ('NY','citizenship status',       'NYC HRL §8-107(5)', 'high', ARRAY['us\s+citizens?\s+only']),
  ('NY','sexual orientation',       'NY Executive Law §296', 'high', ARRAY[]::text[]),
  ('NY','gender identity',          'NY Executive Law §296', 'high', ARRAY[]::text[]),
  ('NY','age',                      'NY Executive Law §296', 'high', ARRAY[]::text[]),
  ('NY','marital status',           'NY Executive Law §296', 'high', ARRAY[]::text[]),
  ('NY','military status',          'NY Executive Law §296', 'high', ARRAY[]::text[]),
-- MASSACHUSETTS — Ch. 151B
  ('MA','marital status',           'MGL Ch. 151B §4', 'high', ARRAY[]::text[]),
  ('MA','sexual orientation',       'MGL Ch. 151B §4', 'high', ARRAY[]::text[]),
  ('MA','gender identity',          'MGL Ch. 151B §4', 'high', ARRAY[]::text[]),
  ('MA','age',                      'MGL Ch. 151B §4', 'high', ARRAY[]::text[]),
  ('MA','source of income',         'MGL Ch. 151B §4', 'high', ARRAY['(?:no|don.?t).{0,15}section\s*8','no\s+vouchers']),
  ('MA','veteran or military',      'MGL Ch. 151B §4', 'high', ARRAY[]::text[]),
  ('MA','genetic information',      'MGL Ch. 151B §4', 'high', ARRAY[]::text[]),
-- MARYLAND
  ('MD','source of income',         'MD State Govt §20-705', 'high', ARRAY['(?:no|don.?t).{0,15}section\s*8']),
  ('MD','sexual orientation',       'MD State Govt §20-705', 'high', ARRAY[]::text[]),
  ('MD','gender identity',          'MD State Govt §20-705', 'high', ARRAY[]::text[]),
  ('MD','marital status',           'MD State Govt §20-705', 'high', ARRAY[]::text[]),
  ('MD','military status',          'MD State Govt §20-705', 'high', ARRAY[]::text[]),
-- COLORADO
  ('CO','source of income',         'CO §24-34-502', 'high', ARRAY[]::text[]),
  ('CO','sexual orientation',       'CO §24-34-502', 'high', ARRAY[]::text[]),
  ('CO','gender identity',          'CO §24-34-502', 'high', ARRAY[]::text[]),
  ('CO','marital status',           'CO §24-34-502', 'high', ARRAY[]::text[]),
  ('CO','creed',                    'CO §24-34-502', 'high', ARRAY[]::text[]),
  ('CO','military status',          'CO §24-34-502', 'high', ARRAY[]::text[]),
-- WASHINGTON
  ('WA','sexual orientation',       'RCW 49.60.222', 'high', ARRAY[]::text[]),
  ('WA','gender identity',          'RCW 49.60.222', 'high', ARRAY[]::text[]),
  ('WA','marital status',           'RCW 49.60.222', 'high', ARRAY[]::text[]),
  ('WA','honorably discharged veteran or military', 'RCW 49.60.222', 'high', ARRAY[]::text[]),
  ('WA','source of income',         'RCW 59.18.255', 'high', ARRAY['(?:no|don.?t).{0,15}section\s*8']),
-- ILLINOIS
  ('IL','source of income',         '775 ILCS 5/3-102', 'high', ARRAY[]::text[]),
  ('IL','sexual orientation',       '775 ILCS 5/3-102', 'high', ARRAY[]::text[]),
  ('IL','marital status',           '775 ILCS 5/3-102', 'high', ARRAY[]::text[]),
  ('IL','military status',          '775 ILCS 5/3-102', 'high', ARRAY[]::text[]),
  ('IL','age (40+)',                '775 ILCS 5/3-102', 'high', ARRAY[]::text[]),
-- NEW JERSEY
  ('NJ','source of income',         'NJSA 10:5-12.5', 'high', ARRAY[]::text[]),
  ('NJ','sexual orientation',       'NJSA 10:5-12', 'high', ARRAY[]::text[]),
  ('NJ','marital status',           'NJSA 10:5-12', 'high', ARRAY[]::text[]),
  ('NJ','civil union status',       'NJSA 10:5-12', 'high', ARRAY[]::text[]),
  ('NJ','military service',         'NJSA 10:5-12', 'high', ARRAY[]::text[])
ON CONFLICT (state_code, protected_class) DO NOTHING;

COMMIT;
