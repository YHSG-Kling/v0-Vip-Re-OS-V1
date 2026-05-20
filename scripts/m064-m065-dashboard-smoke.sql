-- =====================================================
-- m064 + m065 — apply + smoke-test bundle for the Supabase Dashboard SQL Editor
-- =====================================================
-- The Supabase MCP execute_sql/apply_migration path is timing out for this
-- project (schema-introspection > MCP connection timeout). The Dashboard SQL
-- Editor runs SQL directly with no introspection wrapper, so use it here.
--
-- RUN ORDER:
--   BLOCK 1 — applies the m065 triggers (COMMITS — run once).
--   BLOCK 2 — smoke-tests the 4 m065 triggers      (BEGIN…ROLLBACK — nothing persists).
--   BLOCK 3 — smoke-tests the m064 code-fix shapes  (BEGIN…ROLLBACK — nothing persists).
--
-- For BLOCK 2 & 3: success = the SELECTs return rows with the expected
-- non-null values and NO error is raised. The ROLLBACK at the end discards
-- everything, so you can re-run them freely. Paste the output back to me.
-- =====================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ BLOCK 1 — APPLY m065 (commits). Idempotent; safe to re-run.               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION public.photo_enhancement_jobs_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.agent_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
    ELSIF NEW.photo_id IS NOT NULL THEN
      SELECT l.brokerage_id INTO NEW.brokerage_id
        FROM public.listing_photos lp JOIN public.listings l ON l.id = lp.listing_id
       WHERE lp.id = NEW.photo_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS photo_enhancement_jobs_set_brokerage_trg ON public.photo_enhancement_jobs;
CREATE TRIGGER photo_enhancement_jobs_set_brokerage_trg BEFORE INSERT ON public.photo_enhancement_jobs
  FOR EACH ROW EXECUTE FUNCTION public.photo_enhancement_jobs_set_brokerage();

CREATE OR REPLACE FUNCTION public.chat_templates_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL AND NEW.agent_id IS NOT NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS chat_templates_set_brokerage_trg ON public.chat_templates;
CREATE TRIGGER chat_templates_set_brokerage_trg BEFORE INSERT ON public.chat_templates
  FOR EACH ROW EXECUTE FUNCTION public.chat_templates_set_brokerage();

CREATE OR REPLACE FUNCTION public.ai_suggestions_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL AND NEW.agent_id IS NOT NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ai_suggestions_set_brokerage_trg ON public.ai_suggestions;
CREATE TRIGGER ai_suggestions_set_brokerage_trg BEFORE INSERT ON public.ai_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.ai_suggestions_set_brokerage();

CREATE OR REPLACE FUNCTION public.generated_documents_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.agent_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
    ELSIF NEW.contact_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id;
    ELSIF NEW.listing_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.listings WHERE id = NEW.listing_id;
    ELSIF NEW.transaction_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.transactions WHERE id = NEW.transaction_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS generated_documents_set_brokerage_trg ON public.generated_documents;
CREATE TRIGGER generated_documents_set_brokerage_trg BEFORE INSERT ON public.generated_documents
  FOR EACH ROW EXECUTE FUNCTION public.generated_documents_set_brokerage();


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ BLOCK 2 — m065 trigger smoke test (BEGIN…ROLLBACK — nothing persists).     ║
-- ║ EXPECT: each inserted row comes back with filled_brokerage_id NOT NULL     ║
-- ║ even though we never set brokerage_id on insert.                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
BEGIN;
DO $$
DECLARE
  v_agent   UUID;
  v_brok    UUID;
  v_filled  UUID;
BEGIN
  SELECT id, brokerage_id INTO v_agent, v_brok
    FROM public.agents WHERE brokerage_id IS NOT NULL LIMIT 1;
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'No agent with a brokerage_id found — cannot smoke-test';
  END IF;

  -- chat_templates
  INSERT INTO public.chat_templates (agent_id, template_name, template_body)
  VALUES (v_agent, 'm065_smoke', 'body')
  RETURNING brokerage_id INTO v_filled;
  RAISE NOTICE 'chat_templates: expected=% got=% %', v_brok, v_filled,
    CASE WHEN v_filled = v_brok THEN 'PASS' ELSE 'FAIL' END;

  -- ai_suggestions
  INSERT INTO public.ai_suggestions (agent_id, suggestion_type)
  VALUES (v_agent, 'm065_smoke')
  RETURNING brokerage_id INTO v_filled;
  RAISE NOTICE 'ai_suggestions: expected=% got=% %', v_brok, v_filled,
    CASE WHEN v_filled = v_brok THEN 'PASS' ELSE 'FAIL' END;

  -- generated_documents
  INSERT INTO public.generated_documents (agent_id, document_type)
  VALUES (v_agent, 'm065_smoke')
  RETURNING brokerage_id INTO v_filled;
  RAISE NOTICE 'generated_documents: expected=% got=% %', v_brok, v_filled,
    CASE WHEN v_filled = v_brok THEN 'PASS' ELSE 'FAIL' END;

  -- photo_enhancement_jobs (photo_id is NOT NULL — needs a real listing_photos row)
  IF EXISTS (SELECT 1 FROM public.listing_photos LIMIT 1) THEN
    INSERT INTO public.photo_enhancement_jobs (photo_id, agent_id, status)
    VALUES ((SELECT id FROM public.listing_photos LIMIT 1), v_agent, 'queued')
    RETURNING brokerage_id INTO v_filled;
    RAISE NOTICE 'photo_enhancement_jobs: expected=% got=% %', v_brok, v_filled,
      CASE WHEN v_filled = v_brok THEN 'PASS' ELSE 'FAIL' END;
  ELSE
    RAISE NOTICE 'photo_enhancement_jobs: SKIPPED (no listing_photos rows)';
  END IF;
END $$;
ROLLBACK;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ BLOCK 3 — m064 code-fix shape smoke test (BEGIN…ROLLBACK — nothing persists)║
-- ║ EXPECT: no error raised. Each insert exercises a column/enum shape that    ║
-- ║ m064 fixed. A raised error = that shape is still wrong.                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
BEGIN;
DO $$
DECLARE
  v_agent   UUID;
  v_brok    UUID;
  v_contact UUID;
  v_tx      UUID;
  v_conv    UUID;
BEGIN
  SELECT id, brokerage_id INTO v_agent, v_brok
    FROM public.agents WHERE brokerage_id IS NOT NULL LIMIT 1;
  SELECT id INTO v_contact FROM public.contacts WHERE brokerage_id = v_brok LIMIT 1;
  SELECT id INTO v_tx FROM public.transactions WHERE brokerage_id = v_brok LIMIT 1;

  -- 1. tasks: assigned_to_agent_id (not assigned_to) + required brokerage_id
  INSERT INTO public.tasks (brokerage_id, title, assigned_to_agent_id, priority, status)
  VALUES (v_brok, 'm064_smoke', v_agent, 'medium', 'pending');
  RAISE NOTICE 'tasks insert: PASS';

  -- 2. agent_handoffs: from_agent_type='isa_agent' (CHECK enum)
  INSERT INTO public.agent_handoffs (brokerage_id, entity_type, entity_id, from_agent_type, to_agent_type, handoff_reason, handoff_status)
  VALUES (v_brok, 'lead', gen_random_uuid(), 'isa_agent', 'human', 'm064_smoke', 'pending');
  RAISE NOTICE 'agent_handoffs isa_agent: PASS';

  -- 3. ai_isa_qualifications: qualification_result='needs_follow_up' (CHECK enum)
  INSERT INTO public.ai_isa_qualifications (brokerage_id, qualification_result, qualification_signals, stage)
  VALUES (v_brok, 'needs_follow_up', '{}'::jsonb, 'initial');
  RAISE NOTICE 'ai_isa_qualifications needs_follow_up: PASS';

  -- 4. messages: ai-auto-response shape (body/type/direction/status/compliance_checked)
  IF v_contact IS NOT NULL THEN
    INSERT INTO public.conversations (brokerage_id, contact_id, agent_id, type, status)
    VALUES (v_brok, v_contact, v_agent, 'ai_auto', 'active') RETURNING id INTO v_conv;
    INSERT INTO public.messages (conversation_id, contact_id, agent_id, type, direction, body, status, compliance_checked)
    VALUES (v_conv, v_contact, v_agent, 'ai_auto_response', 'outbound', 'm064 body', 'queued', FALSE);
    RAISE NOTICE 'messages ai-auto shape: PASS';
  ELSE
    RAISE NOTICE 'messages: SKIPPED (no contact in brokerage)';
  END IF;

  -- 5. cron_execution_logs: contact-enrichment cron logger shape
  INSERT INTO public.cron_execution_logs (cron_path, cron_name, status, duration_ms, records_processed, metadata, completed_at)
  VALUES ('m064-smoke', 'm064', 'completed', 1, 0, '{}'::jsonb, NOW());
  RAISE NOTICE 'cron_execution_logs shape: PASS';

  -- 6. compliance_flags: compliance-monitoring cron shape (real cols, no dead keys)
  INSERT INTO public.compliance_flags (brokerage_id, contact_id, content_type, violation_type, flagged_content, severity, status, detected_at)
  VALUES (v_brok, v_contact, 'sms', 'm064_smoke', 'm064 smoke', 'high', 'open', NOW());
  RAISE NOTICE 'compliance_flags shape: PASS';

  -- 7. contact_suppression_list: contact_id FK now → contacts(id) (m063), suppression_reason col
  IF v_contact IS NOT NULL THEN
    INSERT INTO public.contact_suppression_list (brokerage_id, contact_id, channel, suppression_reason, source)
    VALUES (v_brok, v_contact, 'sms', 'm064_smoke', 'STOP');
    RAISE NOTICE 'contact_suppression_list shape: PASS';
  ELSE
    RAISE NOTICE 'contact_suppression_list: SKIPPED (no contact)';
  END IF;

  RAISE NOTICE 'ALL m064 SHAPES OK';
END $$;
ROLLBACK;
