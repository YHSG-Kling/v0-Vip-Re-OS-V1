-- supabase/migrations/m606-a-landing-page-template-id-that-points-at-nothing.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- APPLIED 2026-09-05 by the integrator (MCP apply_migration).
--    (CLAUDE.md §3: lanes write migrations, the integrator applies them.)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─── THE DEFECT: A UUID COLUMN WITH NO DECLARED ID CLASS ────────────────────
--
-- `listing_landing_pages.template_id` is a bare nullable uuid with NO FOREIGN
-- KEY. Two writers put a value in it:
--
--   app/actions/ai-listing-intake.ts          (the upsert, `params.templateId`)
--   lib/workflow/adapters/listing-landing-page.ts:49  (`step.listing_page_template_id`)
--
-- and NOTHING READS IT — four selects across the tree touch this table and not
-- one names the column. The value originates in a bare uuid box in the sequence
-- step palette (lib/workflow/step-palette.ts:245, labelled "Template"), so an
-- agent typing an id into that field produced a silent no-op: stored, never
-- resolved, never applied, never shown back.
--
-- A previous wave recorded this as UNRESOLVED and asked the owner whether
-- landing-page templates were wanted (the note is in ai-listing-intake.ts). The
-- owner said yes on 2026-09-05. What that note ALSO said was that "there is no
-- landing-page template table anywhere in this tree" — and that turned out to be
-- true of the NAME and false of the CAPABILITY, which is worth recording because
-- it is the same shape as several defects this repo has already paid for: a
-- search scoped to the expected spelling reporting absence.
--
-- ─── THE SURVIVOR ALREADY EXISTS, EMPTY AND UNWIRED (§1, §6) ────────────────
--
-- `public.content_templates` is live and carries exactly the shape a landing-page
-- template needs:
--
--   template_name, template_body, structure, placeholders, variables,
--   example_output, seo_guidelines, category, content_type, platform,
--   brokerage_id, agent_id, is_global, is_active, usage_count
--
-- Measured live 2026-09-05: 0 rows, and ZERO code references anywhere in the
-- tree. It is a shell somebody built and never wired — which makes it the right
-- home for this, not a reason to avoid it. Creating a second
-- `listing_landing_page_templates` table beside it would be a second spelling of
-- "content template", the §6 defect, and would leave the shell orphaned forever.
--
-- So this migration does not create a table. It DECLARES THE ID CLASS the column
-- always meant, which is the m605 lesson applied before the fact rather than
-- after: a uuid column whose target is unstated is a column two surfaces will
-- eventually disagree about.
--
-- ON DELETE SET NULL, deliberately. A landing page must SURVIVE the deletion of
-- the template that shaped it — the page is published content with its own URL
-- and its own lead history, and CASCADE would delete a live public page because
-- somebody tidied up a template. Losing the provenance link is the correct,
-- recoverable loss; losing the page is not.
--
-- NOT VALIDATED AGAINST EXISTING ROWS BY ACCIDENT — measured first:
-- listing_landing_pages holds 0 rows with a non-null template_id (2026-09-05),
-- so there is no orphaned id to strand and the constraint can be added without a
-- backfill or a cleanup pass.

begin;

ALTER TABLE public.listing_landing_pages
  ADD CONSTRAINT listing_landing_pages_template_id_fkey
  FOREIGN KEY (template_id) REFERENCES public.content_templates(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.listing_landing_pages.template_id IS
  'The content_templates row that shaped this page, or NULL when the page was generated free-form. Resolved agent > brokerage > global by lib/marketing/landing-template.ts#resolveLandingTemplate, which filters is_active and category=''listing_landing_page''. ON DELETE SET NULL because a published page with its own URL and lead history must outlive the template that shaped it — the provenance link is the recoverable loss, the page is not. Before m606 this column had NO foreign key at all and no reader: two writers stored a uuid that pointed at nothing and was never resolved, so the "Template" box in the sequence step palette was a silent no-op.';

CREATE INDEX IF NOT EXISTS idx_listing_landing_pages_template
  ON public.listing_landing_pages (template_id)
  WHERE template_id IS NOT NULL;

-- ─── VERIFY, RATHER THAN HOPE (CLAUDE.md §7) ───────────────────────────────
DO $$
DECLARE
  v_target text;
  v_rule   text;
  v_control text;
BEGIN
  SELECT ccu.table_name, rc.delete_rule INTO v_target, v_rule
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name   = 'listing_landing_pages'
    AND kcu.column_name = 'template_id'
  LIMIT 1;

  IF v_target IS DISTINCT FROM 'content_templates' THEN
    RAISE EXCEPTION 'template_id must FK content_templates, found %', coalesce(v_target, '(no FK at all)');
  END IF;
  IF v_rule IS DISTINCT FROM 'SET NULL' THEN
    RAISE EXCEPTION 'template_id must be ON DELETE SET NULL — a published page must outlive its template, found %', v_rule;
  END IF;

  -- POSITIVE CONTROL for the probe above: it must be able to see a DIFFERENT
  -- target on the same table, otherwise it is a query that returns whatever it
  -- is asked about rather than evidence.
  SELECT ccu.table_name INTO v_control
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name   = 'listing_landing_pages'
    AND kcu.column_name = 'listing_id'
  LIMIT 1;
  IF v_control IS DISTINCT FROM 'listings' THEN
    RAISE EXCEPTION 'POSITIVE CONTROL FAILED — listing_id should still FK listings, found %', coalesce(v_control, '(none)');
  END IF;

  RAISE NOTICE 'listing_landing_pages.template_id now names its id class: content_templates, ON DELETE SET NULL';
END $$;

commit;
