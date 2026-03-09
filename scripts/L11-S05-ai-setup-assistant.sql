-- L11-S05: AI Setup Assistant
-- Creates help_topics_kb table and alters onboarding_ai_chats for chat history

-- ============================================================================
-- help_topics_kb — Knowledge base for AI assistant
-- ============================================================================
CREATE TABLE IF NOT EXISTS help_topics_kb (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  topic_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('license', 'brand', 'tech_stack', 'training', 'certification', 'general')),
  tags TEXT[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  content_embedding VECTOR(1536), -- Activated in L12 RAG sprint
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint: topic_key unique per brokerage (NULL brokerage = platform-wide)
CREATE UNIQUE INDEX IF NOT EXISTS help_topics_kb_topic_key_brokerage_idx 
  ON help_topics_kb (topic_key, COALESCE(brokerage_id, '00000000-0000-0000-0000-000000000000'));

-- Full-text search index for KB lookup
CREATE INDEX IF NOT EXISTS help_topics_kb_fts_idx 
  ON help_topics_kb USING gin(to_tsvector('english', content));

-- RLS for help_topics_kb
ALTER TABLE help_topics_kb ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'help_topics_kb_select' AND tablename = 'help_topics_kb') THEN
    CREATE POLICY help_topics_kb_select ON help_topics_kb FOR SELECT
      USING (is_active = true AND (brokerage_id IS NULL OR brokerage_id IN (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )));
  END IF;
END $$;

-- ============================================================================
-- Alter onboarding_ai_chats to support chat history
-- ============================================================================
-- Add new columns if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'onboarding_ai_chats' AND column_name = 'agent_onboarding_id') THEN
    ALTER TABLE onboarding_ai_chats ADD COLUMN agent_onboarding_id UUID REFERENCES agent_onboarding(id);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'onboarding_ai_chats' AND column_name = 'messages') THEN
    ALTER TABLE onboarding_ai_chats ADD COLUMN messages JSONB DEFAULT '[]';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'onboarding_ai_chats' AND column_name = 'current_step') THEN
    ALTER TABLE onboarding_ai_chats ADD COLUMN current_step TEXT;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'onboarding_ai_chats' AND column_name = 'escalated') THEN
    ALTER TABLE onboarding_ai_chats ADD COLUMN escalated BOOLEAN DEFAULT false;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'onboarding_ai_chats' AND column_name = 'escalated_at') THEN
    ALTER TABLE onboarding_ai_chats ADD COLUMN escalated_at TIMESTAMPTZ;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'onboarding_ai_chats' AND column_name = 'updated_at') THEN
    ALTER TABLE onboarding_ai_chats ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END $$;

-- ============================================================================
-- Feature flag for AI Setup Assistant
-- ============================================================================
INSERT INTO feature_flags (
  feature_key,
  display_name,
  description,
  category,
  enabled,
  solo_agent_access,
  team_access,
  brokerage_access,
  multi_location_access,
  superadmin_only,
  solo_agent_limit,
  team_limit,
  brokerage_limit,
  multi_location_limit,
  beta,
  deprecated
) VALUES (
  'ai_setup_assistant',
  'AI Setup Assistant',
  'AI-powered setup assistant for agent onboarding. Provides contextual help and answers questions about platform configuration.',
  'onboarding',
  true,
  true, true, true, true,
  false,
  NULL, NULL, NULL, NULL,
  false, false
) ON CONFLICT (feature_key) DO NOTHING;

-- ============================================================================
-- Seed platform-wide help topics
-- ============================================================================
INSERT INTO help_topics_kb (brokerage_id, topic_key, title, content, category, tags) VALUES
  -- License topics
  (NULL, 'license_upload_help', 'How to Upload Your Real Estate License', 
   'To upload your real estate license: 1) Navigate to the License section in onboarding. 2) Click the upload area or drag and drop your license image/PDF. 3) Ensure the license number and expiration date are clearly visible. 4) Our system will automatically extract your license details using OCR. 5) Verify the extracted information is correct and submit for verification. The verification process typically takes 1-2 business days.',
   'license', ARRAY['license', 'upload', 'verification']),
  
  (NULL, 'license_verification_time', 'How Long Does License Verification Take?',
   'License verification typically takes 1-2 business days. We verify your license against the state regulatory database (NIPR for most states). If there are any issues, you will be notified via email with specific instructions. Common reasons for delays include: unclear license images, expired licenses, or name mismatches between your account and license.',
   'license', ARRAY['license', 'verification', 'time']),
  
  (NULL, 'eo_insurance_requirements', 'E&O Insurance Requirements',
   'Errors and Omissions (E&O) insurance is required for all agents. Minimum coverage requirements vary by brokerage but typically range from $100,000 to $1,000,000. You will need to provide: 1) Insurance certificate showing coverage dates. 2) Named insured (your name or brokerage). 3) Policy number. 4) Coverage amounts. Upload your certificate in the E&O Insurance section.',
   'license', ARRAY['insurance', 'eo', 'requirements']),

  -- Brand topics
  (NULL, 'brand_colors_help', 'Setting Up Your Brand Colors',
   'Your brand colors help maintain consistent visual identity across all marketing materials. To set up colors: 1) Enter your primary brand color as a hex code (e.g., #0066CC). 2) Optionally add a secondary/accent color. 3) Upload your logo in PNG or SVG format with a transparent background. 4) Preview how your colors look across different materials using the preview panel. Colors are applied to email signatures, marketing materials, and social media templates.',
   'brand', ARRAY['brand', 'colors', 'logo', 'design']),
  
  (NULL, 'brand_voice_setup', 'Configuring Your Brand Voice',
   'Brand voice defines how your communications sound to clients. Options include: Professional (formal, business-like), Friendly (warm, approachable), Luxury (sophisticated, premium), or Conversational (casual, relatable). You can also: 1) Add preferred words/phrases you want included. 2) List prohibited words to avoid. 3) Write custom brand messages. The AI assistant and all generated content will follow your brand voice settings.',
   'brand', ARRAY['brand', 'voice', 'tone', 'messaging']),

  -- Tech stack topics  
  (NULL, 'integration_troubleshooting', 'Integration Connection Issues',
   'If an integration fails to connect: 1) Verify your API credentials are correct (check for extra spaces). 2) Ensure your account has API access enabled. 3) For OAuth integrations, make sure you are logged into the correct account. 4) Try disconnecting and reconnecting. 5) Check if the service is experiencing downtime. Common issues: Twilio requires a verified phone number, SendGrid needs domain verification, DocuSign requires API access to be enabled in your account settings.',
   'tech_stack', ARRAY['integration', 'troubleshooting', 'api', 'connection']),
  
  (NULL, 'required_integrations', 'Which Integrations Are Required?',
   'Required integrations depend on your brokerage setup. Typically required: 1) Email provider (SendGrid or SMTP) for transactional emails. 2) Phone/SMS provider (Twilio) for communication. Optional but recommended: CRM integration (GoHighLevel), calendar sync (Google/Outlook), transaction management (DotLoop/DocuSign). Your brokerage may have specific requirements - check the integration page for indicators.',
   'tech_stack', ARRAY['integration', 'required', 'setup']),

  -- Training topics
  (NULL, 'training_completion_requirements', 'Training Video Completion Requirements',
   'Some training videos are marked as required and must be completed before you can access certain features or complete onboarding. To complete a video: 1) Watch at least 90% of the video. 2) The system tracks your progress automatically. 3) You can pause and resume - progress is saved. 4) Required videos must be completed in order. Your completion percentage is shown on the training dashboard.',
   'training', ARRAY['training', 'videos', 'requirements', 'completion']),
  
  (NULL, 'video_playback_issues', 'Video Playback Troubleshooting',
   'If videos are not playing: 1) Check your internet connection. 2) Try a different browser (Chrome or Firefox recommended). 3) Disable browser extensions that might block media. 4) Clear your browser cache. 5) If using a VPN, try disabling it. For mobile viewing, ensure you have a stable WiFi connection. Contact support if issues persist.',
   'training', ARRAY['training', 'video', 'playback', 'troubleshooting']),

  -- General topics
  (NULL, 'onboarding_overview', 'Onboarding Process Overview',
   'The onboarding process consists of several steps: 1) License Intake - Upload and verify your real estate license and E&O insurance. 2) Brand Setup - Configure your colors, logo, and brand voice. 3) Tech Stack - Connect required integrations (email, SMS, etc.). 4) Training - Complete required training videos. 5) Certification - Pass any required assessments. Each step must be completed before moving to the next. Your progress is saved automatically.',
   'general', ARRAY['onboarding', 'overview', 'process', 'steps']),
  
  (NULL, 'getting_help', 'Getting Help During Setup',
   'Multiple support options are available: 1) This AI assistant can answer most setup questions instantly. 2) Use the "Escalate to Admin" button for complex issues requiring human review. 3) Check the help documentation for detailed guides. 4) Contact your broker directly for brokerage-specific policies. Response times: AI instant, Admin escalation within 24 hours.',
   'general', ARRAY['help', 'support', 'contact', 'assistance'])

ON CONFLICT DO NOTHING;
