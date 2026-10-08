-- ── APPLIED LIVE 2026-10-05 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
-- m711 — competency tags on the EXISTING learning-module catalog (wave 104, lane 104E)
-- Owner answer 2 (2026-10-05): "TAG the existing learning-module catalog with the five competency tags."
--
-- WHAT THIS IS: DML only, idempotent, re-runnable. No DDL. It appends the wave-103 competency gap tags
-- (lib/education/skill-freshness.ts COMPETENCY_GAP_TAG) to public.learning_modules.gap_tags so the ONE
-- learning router (lib/learning-router/composer.ts scoreLearningModule — `r.gap_tags ∩ ctx.gapTags`)
-- can match a module to a SCORED competency gap (lib/learning-router/resolve-agent-learning-context.ts
-- folds scoreCompetency's gapTags into ctx.gapTags). Until this runs, the five tags match nothing.
--
-- LIVE COLUMN SHAPE (scripts/schema-snapshot.ts `learning_modules`, confirmed against
-- information_schema 2026-10-05): there is NO category / skill column. The catalog carries
--   title text NOT NULL · summary text · body · gap_tags text[] NOT NULL DEFAULT '{}' ·
--   stage_tags text[] NOT NULL DEFAULT '{}' · milestone_key text · required (bool) · status text
--   NOT NULL DEFAULT 'draft' · audience_roles / audience_personas / … · brokerage_id · updated_at.
-- So the mapping is by TITLE / SUMMARY wording, the `required` flag, and the tags a module already
-- carries — conservative word-boundary matches, never a wildcard over everything.
--
-- LIVE CATALOG AT WRITE TIME: 2 rows, both proof fixtures ("ZZ_M422_FIXTURE platform course",
-- "ZZ_M422_FIXTURE tenant course", gap_tags '{}'). Fixtures are excluded below, so TODAY this updates
-- 0 rows — the mapping fires on every real module in the catalog when the integrator applies it, and
-- on re-application after modules are authored (idempotent: a tag already present is never appended).
--
-- THE MAPPING (tag ← rule). A module can earn several tags.
--   objection_handling    ← already tagged 'objection:<scenario>' by the curriculum author
--                           (lib/education/curriculum-author.ts), or title/summary names objection handling
--   product_knowledge     ← title/summary names product / market / inventory / neighborhood knowledge
--                           or a listing presentation
--   coursework_incomplete ← required = true (the coursework an agent must finish; the gap IS the
--                           unfinished required curriculum) or title/summary names coursework
--   call_quality          ← title/summary names call quality / call scripts / phone skills / cold calling
--   compliance_ce         ← title/summary names compliance, fair housing, ethics, continuing education,
--                           license renewal, TCPA or RESPA
-- NOT mapped here (already the router's own tags with their own emitters): slow_lead_response,
-- low_close_rate — the curriculum author tags those directly.
--
-- Safe to apply in one part (DML only). Each statement is its own idempotent UPDATE.

update public.learning_modules
   set gap_tags = array_append(gap_tags, 'objection_handling'), updated_at = now()
 where not (gap_tags @> array['objection_handling'])
   and title not like 'ZZ\_%FIXTURE%'
   and (
         exists (select 1 from unnest(gap_tags) t where t like 'objection:%')
      or title ~* '\mobjection'
      or coalesce(summary, '') ~* '\mobjection handling'
   );

update public.learning_modules
   set gap_tags = array_append(gap_tags, 'product_knowledge'), updated_at = now()
 where not (gap_tags @> array['product_knowledge'])
   and title not like 'ZZ\_%FIXTURE%'
   and (
         title ~* '(product|market|inventory|neighbou?rhood) knowledge|listing presentation'
      or coalesce(summary, '') ~* '(product|market|inventory|neighbou?rhood) knowledge'
   );

update public.learning_modules
   set gap_tags = array_append(gap_tags, 'coursework_incomplete'), updated_at = now()
 where not (gap_tags @> array['coursework_incomplete'])
   and title not like 'ZZ\_%FIXTURE%'
   and (
         required = true
      or title ~* '\mcoursework'
      or coalesce(summary, '') ~* '\mcoursework'
   );

update public.learning_modules
   set gap_tags = array_append(gap_tags, 'call_quality'), updated_at = now()
 where not (gap_tags @> array['call_quality'])
   and title not like 'ZZ\_%FIXTURE%'
   and (
         title ~* 'call (quality|scripts?|coaching|skills)|phone (skills|scripts?)|cold[ -]?call'
      or coalesce(summary, '') ~* 'call (quality|scripts?|coaching|skills)|phone (skills|scripts?)|cold[ -]?call'
   );

update public.learning_modules
   set gap_tags = array_append(gap_tags, 'compliance_ce'), updated_at = now()
 where not (gap_tags @> array['compliance_ce'])
   and title not like 'ZZ\_%FIXTURE%'
   and (
         title ~* '\mcompliance\M|fair housing|\methics\M|continuing education|\mCE\M|license renewal|\mTCPA\M|\mRESPA\M'
      or coalesce(summary, '') ~* '\mcompliance\M|fair housing|\methics\M|continuing education|license renewal|\mTCPA\M|\mRESPA\M'
   );

-- VERIFY (read-only, after apply):
--   select title, gap_tags from public.learning_modules
--    where gap_tags && array['objection_handling','product_knowledge','coursework_incomplete','call_quality','compliance_ce']
--    order by title;
