-- ── APPLIED LIVE 2026-11-03 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 149, lane 149B ──
--
-- m937 — C28 COLLABORATIVE SEARCH: the collaborator's credential and an attributable opinion (owner ruling 6:
-- "the buyer shares the homes they were searching and brings in a family member to give their opinion on the
-- selected properties").
--
-- WHAT WAS THERE (live read 2026-11-03): collaborative_search_members (id, collaborative_search_id, email NOT NULL,
-- name, role owner|editor|viewer, invite_status pending|accepted|declined, accepted_at, invited_at, invite_token TEXT
-- in PLAINTEXT, never expiring, never revocable); property_family_ratings keyed by a caller-posted member_email.
-- ZERO rows in all five family-search tables — nothing to backfill, nothing to migrate.
--
-- WHAT THIS ADDS (survivor extended — no new table):
--   collaborative_search_members.brokerage_id        tenant stamp (FK brokerages, CASCADE)
--   collaborative_search_members.phone               a collaborator invited by mobile number (E.164)
--   collaborative_search_members.scope               'feedback_only' — the only scope a collaborator holds (CHECK)
--   collaborative_search_members.access_token_hash   SHA-256 of the share token (UNIQUE); the raw token is never stored
--   collaborative_search_members.token_expires_at    the link's expiry (the invite email promises 7 days)
--   collaborative_search_members.revoked_at          the buyer closed this person's link
--   collaborative_search_members.invite_channel      email | link (we never text a non-consented number — TCPA)
--   collaborative_search_members.invited_by_user_id  the buyer's users.id (FK users, SET NULL)
--   collaborative_search_members.last_viewed_at      the collaborator opened the homes
--   property_family_ratings.member_id                the member the TOKEN proved (FK members, CASCADE)
--   property_family_ratings.brokerage_id             tenant stamp (FK brokerages, CASCADE)
-- `invite_token` (plaintext) is no longer written by code; dropping it is owner SQL-editor work (DROP COLUMN).
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts, scripts/check-vocabularies.ts
-- (collaborative_search_members.scope, .invite_channel).

ALTER TABLE public.collaborative_search_members
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'feedback_only',
  ADD COLUMN IF NOT EXISTS access_token_hash text,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS invite_channel text,
  ADD COLUMN IF NOT EXISTS invited_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_viewed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaborative_search_members_scope_check') THEN
    ALTER TABLE public.collaborative_search_members
      ADD CONSTRAINT collaborative_search_members_scope_check CHECK (scope = 'feedback_only');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaborative_search_members_invite_channel_check') THEN
    ALTER TABLE public.collaborative_search_members
      ADD CONSTRAINT collaborative_search_members_invite_channel_check CHECK (invite_channel IS NULL OR invite_channel IN ('email', 'link'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaborative_search_members_phone_e164') THEN
    ALTER TABLE public.collaborative_search_members
      ADD CONSTRAINT collaborative_search_members_phone_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaborative_search_members_token_hash_shape') THEN
    ALTER TABLE public.collaborative_search_members
      ADD CONSTRAINT collaborative_search_members_token_hash_shape CHECK (access_token_hash IS NULL OR access_token_hash ~ '^[0-9a-f]{64}$');
  END IF;
  -- A credential without an expiry is a link that works forever.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaborative_search_members_token_expires') THEN
    ALTER TABLE public.collaborative_search_members
      ADD CONSTRAINT collaborative_search_members_token_expires CHECK (access_token_hash IS NULL OR token_expires_at IS NOT NULL);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS collaborative_search_members_token_hash_unique
  ON public.collaborative_search_members (access_token_hash) WHERE access_token_hash IS NOT NULL;

ALTER TABLE public.property_family_ratings
  ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES public.collaborative_search_members(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS property_family_ratings_member_idx ON public.property_family_ratings (member_id);

-- The vote vocabulary the code writes (lib/portal/collaborative-share.ts FAMILY_VOTES — the survivor's own five).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_family_ratings_vote_check') THEN
    ALTER TABLE public.property_family_ratings
      ADD CONSTRAINT property_family_ratings_vote_check CHECK (vote IS NULL OR vote IN ('love', 'like', 'neutral', 'dislike', 'pass'));
  END IF;
END $$;
