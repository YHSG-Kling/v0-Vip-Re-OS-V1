-- ── APPLIED LIVE 2026-10-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
-- m720 — ONE competency vocabulary (wave 106, lane 106D). DML only, idempotent, re-runnable. No DDL.
--
-- Owner 2026-10-06: the competency model per agent is Listing Presentation, Buyer Consultation,
-- Negotiation, Pricing, Lead Conversion, Follow-Up, Transaction Management, Compliance, Marketing,
-- Recruiting, Technology. lib/education/skill-freshness.ts COMPETENCY_SKILLS is that list (eleven
-- keys); the wave-103 rail spellings (objection_handling, product_knowledge, coursework, lead_response,
-- closing, call_quality, compliance_ce) were merged onto it and tombstoned there (§6: one vocabulary).
--
-- WHY A MIGRATION AT ALL: competency has no table (m715 — the key IS the identity: the graph node id
-- is entityIdForKey("competency", <key>), a deterministic v5-shaped uuid). Two things live in the
-- database under the OLD keys and must follow the vocabulary:
--   PART A  relationship_edges has_competency rows whose to_entity_id is a RETIRED key's node. They are
--           EXPIRED (effective_to = now()), never deleted — the graph carries valid_to for exactly this
--           (an edge that was true under the old spelling stays as history). The next development
--           cycle / learning-router load re-plants the edges under the new keys (deriveCompetencyEdges).
--   PART B  learning_modules.gap_tags for the FOUR competencies that had no rail before wave 106
--           (listing_presentation, pricing, marketing, recruiting): tagged by title/summary the way m711
--           tagged the first five, so the loop's recommendation step (and the learning router) can match
--           a module to the gap. Same idempotency guard shape (NOT gap_tags @> array[tag]); fixtures
--           excluded. The seven tags m711 stamped are UNCHANGED (the model kept their values).
--
-- RETIRED node ids (computed by lib/kernel/relationship-graph.ts entityIdForKey("competency", key)):
--   objection_handling 185f2934-fdaa-5622-ac92-c92900d49d1d   product_knowledge 210377a2-f544-5ef1-b307-d6986e8f0af2
--   coursework         2ff07cd6-4064-5148-8fdd-84d32a112cd9   lead_response     659e8dbc-de02-5b21-b2bf-eb9cf7984bc3
--   closing            e945a62c-1b27-5841-8240-671bcc48ff5b   call_quality      e590adc1-9d74-59f0-965d-5e2ce540b67c
--   compliance_ce      845a0a9a-5dc3-53d7-b582-58e3ef045e48
--   (lead_conversion 899acff8-890e-59c6-b775-aa03a6947ff5 is in BOTH vocabularies — untouched.)
--
-- Apply as two parts (part A, then part B); each is a single statement and re-runnable.

-- ══════════════════════════════ PART A — expire has_competency edges on retired nodes ══════════════════════════════
update public.relationship_edges
   set effective_to = now()
 where relationship_type = 'has_competency'
   and to_entity_type = 'competency'
   and effective_to is null
   and to_entity_id in (
     '185f2934-fdaa-5622-ac92-c92900d49d1d', '210377a2-f544-5ef1-b307-d6986e8f0af2', '2ff07cd6-4064-5148-8fdd-84d32a112cd9',
     '659e8dbc-de02-5b21-b2bf-eb9cf7984bc3', 'e945a62c-1b27-5841-8240-671bcc48ff5b', 'e590adc1-9d74-59f0-965d-5e2ce540b67c',
     '845a0a9a-5dc3-53d7-b582-58e3ef045e48'
   );

-- ══════════════════════════════ PART B — catalog tags for the four new competencies ══════════════════════════════
update public.learning_modules
   set gap_tags = array_append(gap_tags, 'listing_presentation'), updated_at = now()
 where not (gap_tags @> array['listing_presentation'])
   and title not like 'ZZ\_%FIXTURE%'
   and (title ~* 'listing (presentation|appointment|consultation)|pre-?listing|win(ning)? the listing|listing agreement'
     or coalesce(summary, '') ~* 'listing (presentation|appointment|consultation)|pre-?listing|win(ning)? the listing');

update public.learning_modules
   set gap_tags = array_append(gap_tags, 'pricing'), updated_at = now()
 where not (gap_tags @> array['pricing'])
   and title not like 'ZZ\_%FIXTURE%'
   and (title ~* '\mpricing\M|\mCMA\M|comparative market|price (reduction|strategy)|list[ -]to[ -]sale'
     or coalesce(summary, '') ~* '\mpricing\M|\mCMA\M|comparative market|price (reduction|strategy)');

update public.learning_modules
   set gap_tags = array_append(gap_tags, 'marketing'), updated_at = now()
 where not (gap_tags @> array['marketing'])
   and title not like 'ZZ\_%FIXTURE%'
   and (title ~* '\mmarketing\M|social (media|post)|\mbranding\M|content (plan|calendar)|listing (video|photos)'
     or coalesce(summary, '') ~* '\mmarketing\M|social (media|post)|\mbranding\M');

update public.learning_modules
   set gap_tags = array_append(gap_tags, 'recruiting'), updated_at = now()
 where not (gap_tags @> array['recruiting'])
   and title not like 'ZZ\_%FIXTURE%'
   and (title ~* '\mrecruit(ing|ment)?\M|attract(ing)? agents|sponsor(ing)? agents|revenue share'
     or coalesce(summary, '') ~* '\mrecruit(ing|ment)?\M|attract(ing)? agents|sponsor(ing)? agents');

-- VERIFY (read-only, after apply):
--   select count(*) from public.relationship_edges where relationship_type = 'has_competency' and effective_to is not null;
--   select title, gap_tags from public.learning_modules
--    where gap_tags && array['listing_presentation','pricing','marketing','recruiting'] order by title;
