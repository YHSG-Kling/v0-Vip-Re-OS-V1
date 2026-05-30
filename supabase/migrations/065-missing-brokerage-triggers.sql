-- =====================================================
-- MIGRATION 065: add 4 missing brokerage_id auto-denormalize triggers
-- =====================================================
-- Audit (round 7) found 4 tables shipped with brokerage_id nullable +
-- RLS scoped on brokerage_id, but no BEFORE INSERT trigger to fill it
-- from the parent FK. Result: rows inserted via .insert({ agent_id: X })
-- without explicit brokerage_id end up with brokerage_id=NULL, which
-- their SELECT policies reject (silent invisibility to brokerage users).
--
-- Tables: photo_enhancement_jobs (m053), chat_templates (m057),
--         ai_suggestions (m057), generated_documents (m057).
--
-- A FALSE POSITIVE the audit flagged is NOT in this migration:
-- automation_logs_set_brokerage() queries public.users (not auth.users),
-- which is correct — public.users is the real shadow table with
-- brokerage_id (see m037). Leaving that trigger alone.
-- =====================================================

-- ─── photo_enhancement_jobs ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.photo_enhancement_jobs_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.agent_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
    ELSIF NEW.photo_id IS NOT NULL THEN
      -- listing_photos has listing_id; listings has brokerage_id.
      SELECT l.brokerage_id INTO NEW.brokerage_id
        FROM public.listing_photos lp
        JOIN public.listings l ON l.id = lp.listing_id
       WHERE lp.id = NEW.photo_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS photo_enhancement_jobs_set_brokerage_trg ON public.photo_enhancement_jobs;
CREATE TRIGGER photo_enhancement_jobs_set_brokerage_trg BEFORE INSERT ON public.photo_enhancement_jobs
  FOR EACH ROW EXECUTE FUNCTION public.photo_enhancement_jobs_set_brokerage();

-- ─── chat_templates ──────────────────────────────────────────────────────────
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

-- ─── ai_suggestions ──────────────────────────────────────────────────────────
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

-- ─── generated_documents ────────────────────────────────────────────────────
-- Multi-parent precedence: agent_id → contact_id → listing_id → transaction_id.
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
