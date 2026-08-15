-- m158 — per-agent voice profile distiller surface.
--
-- Wave 36.5. brand_voice_profile already supports the three-tier
-- (agent/team/brokerage) cascade. What's been missing is the
-- AUTOMATIC pipeline that fills the agent tier from the agent's
-- historical writing — newsletters, blog posts, social posts — so the
-- AI copy generator sounds like THE AGENT, not the brokerage.
--
-- Two non-breaking additions:
--
--   distilled_from_asset_ids  uuid[]  — which historical asset ids
--     contributed to the distilled profile. Empty = manually edited
--     by the agent; the distiller skips manually-edited rows so a
--     subsequent re-distill never overwrites the agent's hand-tuned
--     voice settings.
--
--   distilled_at  timestamptz — when the distiller last wrote this
--     row. Combined with the empty-array semantic, gives the cron a
--     clean idempotency signal (don't re-distill within 30 days).
--
--   tone_examples text[] — 3-6 short canonical sentences the
--     distiller extracted that exemplify the voice. The AI copy
--     prompt embeds these inline so the model has CONCRETE examples
--     of the agent's voice, not just abstract tone tags.
--
-- The cascade resolver (applyBrandVoice) is unchanged — it already
-- reads from this table; the new fields are additive context the
-- copy generator can OPTIONALLY surface.

alter table public.brand_voice_profile
  add column if not exists distilled_from_asset_ids uuid[],
  add column if not exists distilled_at             timestamptz,
  add column if not exists tone_examples            text[];

create index if not exists idx_brand_voice_profile_agent_distilled_at
  on public.brand_voice_profile (agent_id, distilled_at desc)
  where agent_id is not null;

comment on column public.brand_voice_profile.distilled_from_asset_ids is 'Wave 36.5: which historical asset ids the distiller used. Empty = manually edited by the human; distiller never overwrites manual rows.';
comment on column public.brand_voice_profile.distilled_at             is 'Wave 36.5: last distiller run timestamp. Cron skips rows < 30d old.';
comment on column public.brand_voice_profile.tone_examples            is 'Wave 36.5: 3-6 canonical sentences the distiller extracted; the AI copy prompt embeds these inline.';
