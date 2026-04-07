-- Add AI call handling preferences to ai_identity_profiles
-- These fields control whether the AI answers inbound/outbound calls
-- and where to forward calls after the AI interaction.

ALTER TABLE ai_identity_profiles
  ADD COLUMN IF NOT EXISTS ai_answer_calls          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_call_handle_inbound   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_call_handle_outbound  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_call_forward_number   text;

COMMENT ON COLUMN ai_identity_profiles.ai_answer_calls         IS 'Master toggle: AI will handle phone calls for this scope';
COMMENT ON COLUMN ai_identity_profiles.ai_call_handle_inbound  IS 'AI answers inbound calls to the brokerage/agent phone number';
COMMENT ON COLUMN ai_identity_profiles.ai_call_handle_outbound IS 'AI makes outbound ISA calls on behalf of the agent';
COMMENT ON COLUMN ai_identity_profiles.ai_call_forward_number  IS 'E.164 phone number to forward the caller to after AI interaction (e.g. +15551234567)';
