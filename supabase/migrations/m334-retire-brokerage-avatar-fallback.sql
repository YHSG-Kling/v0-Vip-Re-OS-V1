-- m334 — retire the brokerage-level avatar fallback columns
--
-- OWNER RULE: every user sets up their own avatar (all except TC and
-- compliance), and "there should be no fallback to brokerage".
--
-- brokerages.did_avatar_url and brokerages.did_actor_id were added by
-- scripts/1027-workflow-os-schema-reconciliation.sql and were the second step of
-- resolveAvatarSource() in lib/did/index.ts: when a caller had neither an actor
-- id nor a photo, the render borrowed the BROKERAGE's face.
--
-- THE INVESTIGATION, BEFORE THE DROP (the consolidation rule — never remove
-- without establishing dependencies first):
--
--   · WRITERS: none. A repo-wide search finds no INSERT, UPDATE, upsert, server
--     action, API route or settings surface that ever sets either column. They
--     were created and never wired.
--   · READERS: one — resolveAvatarSource(), removed in this same change.
--   · DATA: live check against the project — 2 brokerages, 0 with did_avatar_url
--     set, 0 with did_actor_id set. Nothing is lost because nothing was stored.
--
-- So the branch could only ever be skipped, and skipping it fell through to the
-- worse case: a D-ID submit carrying neither actor_id nor source_url, which does
-- not fail — it renders with D-ID's own stock presenter and reports success. An
-- unrelated person's face, delivered to a contact under their agent's name. That
-- fall-through is now a refusal in lib/did/index.ts; these columns go with it so
-- nobody re-introduces the fallback by populating them by hand.
--
-- Reversible by re-adding the columns; there is no data to restore.

ALTER TABLE public.brokerages
  DROP COLUMN IF EXISTS did_avatar_url,
  DROP COLUMN IF EXISTS did_actor_id;

COMMENT ON TABLE public.brokerages IS
  'Tenant root. NOTE: a brokerage does not carry an avatar or a voice for its '
  'agents — every user configures their own twin (Settings → Voice & Avatar), '
  'and no render or live session ever falls back to a brokerage-level face. '
  'default_isa_voice_id is the exception and is NOT a fallback: it is the '
  'brokerage AI ISA''s own voice, an identity in its own right rather than a '
  'substitute for an agent''s.';
