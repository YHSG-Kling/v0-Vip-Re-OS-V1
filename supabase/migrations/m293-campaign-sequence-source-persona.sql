-- m293-campaign-sequence-source-persona.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- OWNER RULING: "the home value and lead magnet contacts should have a source and
-- the campaign sequence should be keyed on source. persona column should be
-- present. the campaigns should be automatically keyed off when the contact signs
-- up for those campaigns automatically (autonomous)."
--
-- WHAT WAS THERE. Two capture flows looked for their follow-up sequence by a
-- literal no CHECK admitted:
--
--   app/actions/home-value.ts   .or("trigger_event.eq.home_value_submitted,
--                                    sequence_type.eq.seller_nurture")
--   lib/kernel/lead-magnets.ts  .eq("sequence_type", "lead_magnet")
--
-- campaign_sequences.trigger_event admits 14 values and none is
-- home_value_submitted; sequence_type admits drip|nurture|post_close|
-- re_engagement|transaction and neither seller_nurture nor lead_magnet is among
-- them. Both lookups matched nothing on every run, so neither capture ever
-- enrolled anybody.
--
-- Rewriting them onto a real sequence_type would have been WORSE than leaving
-- them dead: with no discriminator on the table, `sequence_type = 'nurture'`
-- picks an arbitrary nurture sequence, so a buyer drip could enrol a home-value
-- seller. This migration adds the discriminator the table was missing.
--
--   source_key  the canonical contacts.source this sequence serves
--               (lib/campaigns/contact-sources.ts owns the vocabulary)
--   persona     who it talks to — buyer | seller | both | lifetime, the same
--               axis engage-contact.ts already derives from contact_type
--
-- Both nullable: an existing hand-built sequence keys on nothing and is simply
-- never auto-selected, which is the safe default. Additive — no row moves and no
-- existing query changes meaning.

ALTER TABLE public.campaign_sequences
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS persona    text;

ALTER TABLE public.campaign_sequences
  DROP CONSTRAINT IF EXISTS campaign_sequences_persona_check;

ALTER TABLE public.campaign_sequences
  ADD CONSTRAINT campaign_sequences_persona_check CHECK (
    persona IS NULL OR persona = ANY (ARRAY['buyer', 'seller', 'both', 'lifetime'])
  );

-- The autonomous enroller's selection path: brokerage + source + persona, active
-- only. Partial index — an unkeyed sequence is never a candidate.
CREATE INDEX IF NOT EXISTS campaign_sequences_source_persona_idx
  ON public.campaign_sequences (brokerage_id, source_key, persona)
  WHERE source_key IS NOT NULL AND is_active = true;

COMMENT ON COLUMN public.campaign_sequences.source_key IS
  'Canonical contacts.source this sequence auto-enrols from (lib/campaigns/contact-sources.ts). NULL = never auto-selected.';
COMMENT ON COLUMN public.campaign_sequences.persona IS
  'Audience: buyer | seller | both | lifetime. NULL = any persona with this source_key.';
