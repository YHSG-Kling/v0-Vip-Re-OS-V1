-- m310 — DETERMINISTIC, CACHEABLE COMPOSITION OF VIDEO.
-- ─────────────────────────────────────────────────────────────────────────────
-- Applied live. The audit that produced it:
--
--   compositions   ALREADY DETERMINISTIC. remotion/** has zero Math.random,
--                  zero Date.now, zero new Date() — every composition is a pure
--                  function of its props. So the frames were always cacheable;
--                  nothing ever cached them.
--   render ledger  remotion_composition_renders held input_props and output_url
--                  but NO identity for the render. recordRenderQueued inserts a
--                  fresh row unconditionally, so a market-update reel wanted by
--                  40 recipients ran 40 full Chromium bundles + encodes and
--                  wrote 40 copies of byte-equivalent video to storage.
--   narration      prepareReelVoiceover re-synthesized ElevenLabs TTS on every
--                  call and hosted the mp3 at
--                  `voiceovers/<brokerage>/<key>-${Date.now()}.mp3`. Identical
--                  script + identical voice = a fresh paid synthesis, a fresh
--                  stored object, and a fresh URL. That nonce is also what made
--                  an artifact cache IMPOSSIBLE: voiceover_url is muxed into the
--                  finished video, so a per-call URL poisons the key forever.
--                  The narration cache is therefore not a nice-to-have alongside
--                  the render cache — it is its precondition.
--   tier gate      canAccessComposition() was called from exactly one place:
--                  beginCoordinatedRender, which has ZERO callers. The live
--                  render path resolved callerTier and never gated on it, so a
--                  solo_agent brokerage could render ProductPromoReel
--                  (tier_access = {platform} — the platform's own product
--                  marketing). Collected the tier, never honoured it.
--
-- Two keys, because a finished video is produced in two stages: the frame key
-- names the Chromium render, the artifact key adds the finish inputs the
-- coordinator muxes over it (intro/outro clip, music track + volume + loop,
-- narration mp3). We LOOK UP on the predicted finish inputs and STAMP on the
-- ones actually used, so a misprediction costs a wasted render and never a
-- wrong artifact. See lib/remotion/composition-cache.ts.

-- ── The render ledger learns its own identity ────────────────────────────────
ALTER TABLE remotion_composition_renders
  ADD COLUMN IF NOT EXISTS frame_key text,
  ADD COLUMN IF NOT EXISTS artifact_key text,
  -- Set on a cache HIT: the render this row was served from, so the reuse is
  -- traceable to the pass that actually paid for it.
  ADD COLUMN IF NOT EXISTS served_from_render_id uuid
    REFERENCES remotion_composition_renders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cache_hit boolean NOT NULL DEFAULT false;

-- The lookup index. brokerage_id LEADS: a rendered artifact is tenant property
-- and is never served across tenants, even though the props (which carry the
-- brand kit) would almost certainly differ anyway. "Almost certainly" is not a
-- tenancy boundary — the scope is.
CREATE INDEX IF NOT EXISTS remotion_renders_artifact_key
  ON remotion_composition_renders (brokerage_id, artifact_key, completed_at DESC)
  WHERE artifact_key IS NOT NULL AND render_status = 'succeeded' AND output_url IS NOT NULL;

-- Frame-key lookup for the determinism-leak sweep (same frames, many keys).
CREATE INDEX IF NOT EXISTS remotion_renders_frame_key
  ON remotion_composition_renders (brokerage_id, composition_id, frame_key)
  WHERE frame_key IS NOT NULL;

COMMENT ON COLUMN remotion_composition_renders.frame_key IS
  'Identity of the FRAMES: composition id + deploy code revision + geometry + canonical frame-relevant props. Stamped from what was actually rendered.';
COMMENT ON COLUMN remotion_composition_renders.artifact_key IS
  'Identity of the FINISHED file: frame_key + the finish inputs actually muxed (intro/outro/music asset ids, music volume + loop, narration url). The cache lookup key.';
COMMENT ON COLUMN remotion_composition_renders.cache_hit IS
  'TRUE when this render served an existing artifact instead of rendering. Its output_url is shared with served_from_render_id, and it is NOT re-captured into marketing_assets.';

-- ── Narration reuse: the precondition for a stable artifact key ──────────────
CREATE TABLE IF NOT EXISTS narration_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,

  -- The ElevenLabs voice the script was spoken in (the agent's clone or the
  -- named assistant's voice — the same ids the phone lane speaks with).
  voice_id text NOT NULL,
  -- computeNarrationKey(voice_id, script): sha256 over the exact trimmed script
  -- and voice. Semantic identity, not byte identity — ElevenLabs does not
  -- return identical audio twice, and the same words in the same voice are the
  -- thing a viewer actually hears.
  script_hash text NOT NULL,
  -- Kept for the audit trail and for a human debugging a mis-cached clip.
  script_preview text,
  script_chars integer NOT NULL DEFAULT 0,

  audio_url text NOT NULL,
  -- ElevenLabs per-character alignment when the timestamped path succeeded —
  -- reused so a cache hit still gets word-accurate captions. NULL = the plain
  -- synthesis path, captions even-distribute honestly.
  alignment jsonb,

  -- Which render first paid for this clip, and how often it has been reused.
  first_render_key text,
  hit_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One clip per (tenant, voice, script). Tenant-scoped: a brokerage never hears
-- another brokerage's narration, and a voice clone is licensed per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS narration_cache_key
  ON narration_cache (brokerage_id, voice_id, script_hash);

CREATE INDEX IF NOT EXISTS narration_cache_reuse
  ON narration_cache (brokerage_id, hit_count DESC);

ALTER TABLE narration_cache ENABLE ROW LEVEL SECURITY;

-- Tenant staff read their own; only the service role writes (producers + crons).
CREATE POLICY narration_cache_select ON narration_cache
  FOR SELECT USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE narration_cache IS
  'Reusable ElevenLabs narration, keyed on (brokerage, voice, script hash). Exists for two reasons: identical narration used to cost a fresh paid synthesis every render, and the old Date.now()-stamped mp3 path made the render artifact key un-repeatable, so the render cache could never hit. asset_manager owns it.';
