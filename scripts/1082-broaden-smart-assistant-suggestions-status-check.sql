-- ===========================================================================
-- 1082-broaden-smart-assistant-suggestions-status-check.sql
--
-- Application code writes 'accepted', 'actioned', 'dismissed' to
-- smart_assistant_suggestions.status — but the existing CHECK only allowed
-- {pending, executed, ignored}, so every action-button update was silently
-- failing. Broadens the constraint to cover the full semantic vocabulary
-- the suggestion lifecycle uses end-to-end:
--   pending   — newly created, awaiting agent decision
--   accepted  — agent agreed but hasn't completed the action yet
--   actioned  — agent took the action (synonym used in older code)
--   executed  — outcome recorded as successfully done (synonym for actioned)
--   dismissed — agent explicitly passed on the suggestion
--   ignored   — auto-aged or programmatically skipped (legacy synonym)
--
-- APPLIED VIA: supabase apply_migration "broaden_smart_assistant_suggestions_status_check"
-- ===========================================================================

ALTER TABLE public.smart_assistant_suggestions
  DROP CONSTRAINT IF EXISTS smart_assistant_suggestions_status_check;

ALTER TABLE public.smart_assistant_suggestions
  ADD CONSTRAINT smart_assistant_suggestions_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'accepted'::text,
    'actioned'::text,
    'executed'::text,
    'dismissed'::text,
    'ignored'::text
  ]));
