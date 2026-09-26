-- m294-campaign-sequence-persona-correction.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- CORRECTS m293. I conflated two different axes.
--
-- OWNER: "persona is like a first time home buyer, divorce, probate, expired,
-- fsbo, downsizer, senior, etc and contact type is seller, buyer, both,
-- lifetime."
--
-- m293 added `campaign_sequences.persona` with a CHECK of
-- buyer|seller|both|lifetime. That is CONTACT_TYPE. Persona is the situational
-- axis — the life event that brought the person to the market — and it is
-- already declared in lib/kernel/types.ts as the `Persona` union, and already
-- consumed by lib/agents/campaign-orchestrator.ts, which composes each campaign
-- by "trigger + persona + consent state".
--
-- The two axes are independent and a sequence needs BOTH: a downsizing seller
-- and a first-time buyer are different campaigns, and so are a downsizing seller
-- and a divorcing seller.
--
--   contact_type  buyer | seller | both | lifetime      (who they are to us)
--   persona       first_time | divorce | probate | …    (what situation they're in)
--
-- Nothing is lost: m293's column is RENAMED to the name it always meant, so any
-- row already keyed on it keeps working.

ALTER TABLE public.campaign_sequences
  DROP CONSTRAINT IF EXISTS campaign_sequences_persona_check;

ALTER TABLE public.campaign_sequences
  RENAME COLUMN persona TO contact_type;

ALTER TABLE public.campaign_sequences
  ADD CONSTRAINT campaign_sequences_contact_type_check CHECK (
    contact_type IS NULL OR contact_type = ANY (ARRAY['buyer', 'seller', 'both', 'lifetime'])
  );

-- The REAL persona axis, matching lib/kernel/types.ts `Persona`.
ALTER TABLE public.campaign_sequences
  ADD COLUMN IF NOT EXISTS persona text;

ALTER TABLE public.campaign_sequences
  ADD CONSTRAINT campaign_sequences_persona_check CHECK (
    persona IS NULL OR persona = ANY (ARRAY[
      'first_time', 'relocated', 'luxury', 'fsbo', 'probate', 'upsize',
      'downsize', 'military', 'divorce', 'senior', 'expired', 'foreclosure', 'other'
    ])
  );

DROP INDEX IF EXISTS campaign_sequences_source_persona_idx;

-- Selection path: brokerage + source + contact_type + persona, active only.
CREATE INDEX IF NOT EXISTS campaign_sequences_source_audience_idx
  ON public.campaign_sequences (brokerage_id, source_key, contact_type, persona)
  WHERE source_key IS NOT NULL AND is_active = true;

COMMENT ON COLUMN public.campaign_sequences.contact_type IS
  'Who they are to us: buyer | seller | both | lifetime. NULL = any contact_type.';
COMMENT ON COLUMN public.campaign_sequences.persona IS
  'What situation they are in (lib/kernel/types.ts Persona): first_time, divorce, probate, fsbo, downsize, senior, … NULL = any persona.';
