-- l28-s01-answer-mode.sql — business-hours-aware AI answering. 'always' = the
-- AI owns every inbound call; 'after_hours' = during office hours it greets and
-- offers an immediate transfer to the human agent, after hours it runs the full
-- reception (qualify, book, reassure). Hours live as jsonb:
--   { "timezone": "America/Chicago", "start": "09:00", "end": "18:00", "days": [1,2,3,4,5] }
ALTER TABLE public.ai_identity_profiles ADD COLUMN IF NOT EXISTS ai_answer_mode text NOT NULL DEFAULT 'always'
  CHECK (ai_answer_mode IN ('always','after_hours'));
ALTER TABLE public.ai_identity_profiles ADD COLUMN IF NOT EXISTS business_hours jsonb;
