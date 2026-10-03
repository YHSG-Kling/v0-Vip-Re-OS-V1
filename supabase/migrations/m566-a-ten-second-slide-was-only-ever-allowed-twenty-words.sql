-- m566 — A TEN-SECOND SLIDE WAS ONLY EVER ALLOWED TWENTY WORDS.
--
-- THE OWNER'S RULING: "fix the geometry on the listingsectionreel".
--
-- WHAT WAS WRONG
-- --------------
-- ListingSectionReel is the composition every non-CMA pre-listing presentation
-- section renders on (lib/listing-presentation/section-render.ts:187). It was
-- registered at 300 frames @ 30fps = 10 SECONDS, on both sides:
--
--   remotion/Root.tsx:700              durationInFrames={300}
--   remotion_compositions (live)       duration_frames = 300, fps = 30
--
-- The narration cap derives the word budget from exactly that geometry
-- (lib/video/script-structure.ts narrationBudget: seconds × (1 − 0.20) at 150
-- wpm, i.e. maxWords = 2 × compositionSeconds). Ten seconds therefore bought
-- TWENTY WORDS — one sentence — for a section whose whole job is to sell the
-- seller on the brokerage before the listing appointment. The narration-capping
-- lane stopped the mid-word audio cut and deliberately left the geometry alone,
-- recording that geometry is load-bearing. This is that follow-up.
--
-- WHY 900 FRAMES (30 s), DERIVED
-- ------------------------------
-- Three bounds, measured rather than guessed:
--
--   FLOOR — the DETERMINISTIC fallback must survive the trim intact. It is what
--   ships whenever the AI gateway is down, and it goes through the same
--   fitNarrationToBudget. Measured over all seven narratable sections with
--   realistic tenant names (buildSectionNarrationScript): 33–46 words, the
--   longest being `credibility` and `cma` at 46 words ≈ 18 spoken seconds. At
--   the old 20-word ceiling, EVERY one of the seven was trimmed — the shortest
--   by 13 words. A floor of 46 words needs ≥ 23 s.
--
--   TARGET — the AI path is briefed to weave the marketing system, the agent's
--   own angle and market context into one spoken paragraph (SECTION_BRIEF in
--   lib/listing-presentation/section-narration.ts). A natural spoken paragraph
--   is 4–5 sentences ≈ 60–75 words. 60 words needs exactly 30 s.
--
--   CEILING — a section is one STATIC slide (remotion/ListingPresentationSlide
--   TitleSlideBody fades in by frame 36 and then holds) with an avatar PIP, and
--   the drip chains 5–7 of them. 30 s × 7 = 3.5 min, inside the 5–8 minute
--   presentation the slide composition was designed for; and 900 frames is the
--   longest duration already registered (PartnersMeetingReel, TeammateExplainerReel),
--   so this adds no new outlier to render cost or to the attention budget.
--
-- 900 is the smallest frame count that satisfies floor and target at once:
-- 900/30 = 30 s → budget 24 s → 60 words. The 46-word fallback now fits with
-- 14 words to spare; the AI gets a real paragraph instead of one sentence.
--
-- NOTHING ABOUT WHAT THE COMPOSITION RENDERS CHANGES. This is why
-- ListingSectionReel is the ONE producer-fed composition whose geometry can move
-- on its own: it has no internal storyboard. Its avatar window is
-- `avatarEndFrame={durationInFrames}` (remotion/ListingSectionReel.tsx:73) and
-- its body is a fade-in-and-hold, so a longer runtime is simply more hold — no
-- dead air, no re-cut. Its five producer-fed siblings all carry module-level
-- frame literals that sum to their registered duration (JustSoldReelSquare
-- COVER/PHOTOS/CTA = 2+8+2 s; OpenHouseAnnounceReel and ComingSoonReel 3+7+2 s;
-- JustListedReel FRAMES.CTA_END = 750; NewsletterDigestVideo FRAMES.OUTRO_END =
-- 600), so lengthening any of THEM without re-cutting the storyboard would
-- freeze the last frame for the extra seconds. They are left alone deliberately.
--
-- WHY THE DATABASE HAS TO MOVE TOO
-- --------------------------------
-- Root.tsx is what Remotion renders; remotion_compositions is what the OS
-- believes — it drives the still/moving fork (duration_frames <= 1 →
-- renderStill), the cost estimate (estimateCompositionCost), the render
-- coordinator's narration pad and the render cache's secondsAvoided.
-- scripts/remotion-setup-guard.ts §3 compares the two field-for-field, so a
-- one-sided change is a red guard by construction. Proven: with Root.tsx alone
-- at 900 the guard failed with
--   "ListingSectionReel.duration_frames Root=900 DB=300".
--
-- The UPDATE asserts its own reach. An UPDATE that matches nothing succeeds
-- silently in exactly the way CLAUDE.md §3 records for DELETE, so this one
-- counts the rows it touched and raises if it is not exactly one.
--
-- m181 IS THE ROW'S SEED AND IT STILL SAYS 300. It is left untouched — a
-- migration is history, not state — and it cannot undo this one: its
-- `on conflict (composition_id) do update set` writes only display_name and
-- is_active, never duration_frames. A rebuild replays m181 then m566 and lands
-- at 900.

DO $$
DECLARE
  touched integer;
  before_frames integer;
BEGIN
  SELECT duration_frames INTO before_frames
    FROM public.remotion_compositions
   WHERE composition_id = 'ListingSectionReel';

  IF before_frames IS NULL THEN
    RAISE EXCEPTION 'm566: remotion_compositions has no ListingSectionReel row to widen';
  END IF;

  UPDATE public.remotion_compositions
     SET duration_frames = 900,
         updated_at      = now()
   WHERE composition_id  = 'ListingSectionReel';

  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'm566: expected to widen exactly 1 composition row, touched %', touched;
  END IF;

  RAISE NOTICE 'm566: ListingSectionReel duration_frames % -> 900 (% s -> 30 s at 30fps)',
    before_frames, round(before_frames / 30.0, 2);
END $$;

-- The fps is NOT touched: seconds is frames/fps and only the frame count is
-- wrong. Guarded here so a future edit cannot quietly buy the same seconds by
-- slowing the composition down.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.remotion_compositions
     WHERE composition_id = 'ListingSectionReel'
       AND duration_frames = 900 AND fps = 30 AND width = 1920 AND height = 1080
  ) THEN
    RAISE EXCEPTION 'm566: post-state is not 900f @ 30fps 1920x1080';
  END IF;
END $$;
