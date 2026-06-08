-- m182 — Wave 39: the agent's own "take" on their listing presentation.
-- Free-text the agent adds in their profile (angle, proof points, niche, story)
-- that the AI narration generator weaves into the pre-listing presentation
-- scripts so the avatar speaks in their voice. Seller-safe (never a price).
alter table public.users add column if not exists presentation_take text;
comment on column public.users.presentation_take is
  'Agent-authored angle/proof-points for their listing presentation narration (seller-safe; never a price).';
