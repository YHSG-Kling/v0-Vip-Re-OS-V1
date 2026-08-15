-- ============================================================================
-- Migration 1069 — Extend documents.status for combined-packet e-sign dispatch
-- ============================================================================
--
-- WHY:
--   Voice-cockpit combined dispatch (Commit X) sends BBA + offer as ONE e-sign
--   envelope. The dispatch path updates documents.status from
--   'needs_agent_input' → 'pending_signature' to mirror the BBA's lifecycle
--   vocabulary. The pre-existing CHECK only allowed up to 'complete', blocking
--   this transition.
--
-- WHAT:
--   Extends the CHECK to include 'pending_signature' / 'signed' / 'declined' /
--   'cancelled' so the offer document tracks the same lifecycle as the BBA
--   that ships with it in the envelope.
-- ============================================================================

ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_status_check
  CHECK (status = ANY (ARRAY[
    'draft','draft_ready','generating','review','complete','archived',
    'needs_agent_input',
    'pending_signature',
    'signed',
    'declined',
    'cancelled'
  ]));
