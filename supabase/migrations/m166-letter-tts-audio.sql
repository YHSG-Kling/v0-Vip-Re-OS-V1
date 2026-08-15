-- m166 — Wave 38 TTS letters.
--
-- Adds a TTS audio version of every direct-mail letter we send. The
-- letter still lands in the recipient's mailbox via Lob; the audio
-- gives the same brokerage's portal contacts a "listen instead of read"
-- surface narrated in the agent's cloned ElevenLabs voice — a real-
-- estate-specific differentiator over the postcard-only competitors.
--
-- Two new nullable columns on direct_mail_campaigns:
--   tts_audio_url  — Vercel Blob URL of the rendered mp3 (public,
--                    delivered via the contact portal)
--   tts_voice_id   — ElevenLabs voice id used for the render. Kept
--                    for traceability when the agent's clone changes
--                    later (older audio still attributable).
--
-- Backfill cron landed under app/api/cron/letter-audio-renderer/
-- walks campaigns where piece_type='letter' AND tts_audio_url IS NULL
-- AND the agent has an elevenlabs_voice_id on agent_voice_profiles.

alter table public.direct_mail_campaigns
  add column if not exists tts_audio_url text,
  add column if not exists tts_voice_id  text;

create index if not exists idx_direct_mail_campaigns_letter_no_audio
  on public.direct_mail_campaigns (brokerage_id, created_at desc)
  where piece_type = 'letter' and tts_audio_url is null;

comment on column public.direct_mail_campaigns.tts_audio_url is
  'Wave 38: Vercel Blob URL of the letter body narrated in the agent''s ElevenLabs voice. NULL until the letter-audio-renderer cron processes the row.';
comment on column public.direct_mail_campaigns.tts_voice_id is
  'Wave 38: ElevenLabs voice id used for tts_audio_url. Kept for audit when the agent''s clone is re-trained.';
