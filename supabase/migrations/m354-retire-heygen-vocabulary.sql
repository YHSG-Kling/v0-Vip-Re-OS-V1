-- m354 — finish the OTHER retired vendor's vocabulary.
--
-- Surfaced by test:vendor-retirement while retiring VAPI: the same owner ruling
-- covers HeyGen ("no HeyGen"), and its client code was removed long ago, but two
-- live CHECKs still admitted it.
--
-- ai_video_projects.video_provider admitted six values. resolveVideoProvider can
-- only ever RETURN two: "upload" passes through and everything else is FORCED to
-- "did", because the avatar/explainer engine is D-ID + ElevenLabs locked. The
-- other four (heygen, google_flow, synthesia, custom) were unreachable by any
-- code path. A CHECK that admits what the application cannot produce is an
-- invitation to write it by hand and an instruction to the next reader that the
-- vendor is still an option.
ALTER TABLE public.ai_video_projects
  DROP CONSTRAINT IF EXISTS ai_video_projects_video_provider_check;
ALTER TABLE public.ai_video_projects
  ADD CONSTRAINT ai_video_projects_video_provider_check
  CHECK (video_provider = ANY (ARRAY['did'::text, 'upload'::text]));

-- platform_credentials.platform let a superadmin connect an account for BOTH
-- retired vendors. Nothing would ever call them, so the credential would sit
-- there looking like a working integration — and until this sweep the
-- setup-readiness probe counted a 'vapi' credential as "SMS configured",
-- meaning a brokerage could be told its texting rail was ready because of a
-- credential for a vendor this OS does not call.
ALTER TABLE public.platform_credentials
  DROP CONSTRAINT IF EXISTS platform_credentials_platform_check;
ALTER TABLE public.platform_credentials
  ADD CONSTRAINT platform_credentials_platform_check
  CHECK (platform = ANY (ARRAY[
    'dotloop','docusign','skyslope','authentisign','formsimplicity','brokermint',
    'showingtime','mls','zillow','realtor_com','idxbroker','listhub','mls_direct',
    'opcity','facebook','instagram','linkedin','buffer','platform_social_facebook',
    'platform_social_instagram','platform_social_linkedin','platform_social_x',
    'platform_social_tiktok','platform_social_youtube','google_flow','did','pexels',
    'twilio','telnyx','bandwidth','sinch','plivo','twilio_subaccount','twilio_byo',
    'twilio_a2p','sendgrid','resend','postmark','mailgun','gmail','outlook',
    'google_calendar','zoom','stripe','plaid','lob','quickbooks','gohighlevel',
    'followupboss','lofty','hubspot','platform_quickbooks','platform_zoom']));

-- The voice engine is ElevenLabs only (owner: "only Twilio and ElevenLabs").
-- Re-declared here so the newest declaration in this directory matches the
-- snapshot after l40-s03 applied it live.
ALTER TABLE public.ai_identity_profiles
  DROP CONSTRAINT IF EXISTS ai_identity_profiles_voice_provider_check;
ALTER TABLE public.ai_identity_profiles
  ADD CONSTRAINT ai_identity_profiles_voice_provider_check
  CHECK (voice_provider = ANY (ARRAY['elevenlabs'::text]));
