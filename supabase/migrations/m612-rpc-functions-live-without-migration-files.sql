-- m612 — THIRTEEN RPC FUNCTIONS THE APP CALLS THAT NO MIGRATION FILE DEFINED
--
-- STATUS: ALREADY LIVE. Every function below exists on hrvaqgvukzxfskkcrwbt
-- (verified via pg_proc on 2026-09-08); this file was written FROM
-- pg_get_functiondef(), not the other way round. Applying it is a no-op
-- (CREATE OR REPLACE with the identical body). It exists so the schema is
-- reproducible from supabase/migrations alone — scripts/rpc-census-z1.ts
-- reported these thirteen `.rpc()` targets as "called but no migration
-- defines it" (a reader with no writer in the migration ledger), and a
-- function only the dashboard knows about is one nobody can restore.
--
-- Callers (app/lib):
--   tenant_safety_schema_check     app/api/cron/tenant-safety-scan/route.ts
--   increment_blog_view_count      app/api/blog/track-view/route.ts
--   increment_blog_share_count     app/api/blog/track-share/route.ts
--   increment_knowledge_article_view app/actions/support.ts
--   increment                      app/actions/support.ts, app/actions/listing-video.ts
--   increment_learning_module_view app/actions/academy.ts, app/actions/academy-learning.ts
--   advance_brokerage_onboarding   lib/onboarding/state-machine.ts
--   increment_rule_triggered       lib/lead-assignment/tier-routing.ts
--   match_help_topics              lib/knowledge/embedding-service.ts
--   match_knowledge_articles       lib/knowledge/embedding-service.ts
--   increment_ai_usage_monthly     lib/ai/cost-tracking.ts
--   get_current_month_usage        lib/ai/cost-tracking.ts
--   contact_memory_recall          lib/agents/contact-memory.ts
--
-- MEASURED BEFORE APPLYING (2026-09-08): all 13 present in pg_proc, bodies
-- identical to the text below. Dependencies assumed live: get_billing_subscriber,
-- jsonb_deep_merge, extension `vector` (operator <=>), tables ai_usage_monthly,
-- blog_posts, knowledge_articles, learning_modules, assignment_rules,
-- help_topics_kb, contact_memory, brokerages.onboarding_status.

CREATE OR REPLACE FUNCTION public.advance_brokerage_onboarding(p_brokerage_id uuid, p_target_status text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  current_status text;
BEGIN
  IF p_target_status NOT IN ('pending','in_progress','completed','abandoned') THEN
    RAISE EXCEPTION 'invalid target status: %', p_target_status;
  END IF;

  SELECT onboarding_status INTO current_status
  FROM public.brokerages WHERE id = p_brokerage_id;

  IF current_status IS NULL THEN
    RETURN 'brokerage_not_found';
  END IF;

  IF (current_status = 'pending'      AND p_target_status IN ('in_progress','completed','abandoned'))
  OR (current_status = 'in_progress'  AND p_target_status IN ('completed','abandoned'))
  OR (current_status = p_target_status) THEN
    UPDATE public.brokerages
      SET onboarding_status = p_target_status, updated_at = now()
      WHERE id = p_brokerage_id;
    RETURN p_target_status;
  END IF;

  RETURN current_status;
END$function$;

CREATE OR REPLACE FUNCTION public.contact_memory_recall(p_brokerage_id uuid, p_entity_type text, p_entity_id uuid, p_query_embedding vector, p_k integer, p_memory_kinds text[])
 RETURNS TABLE(id uuid, memory_kind text, content text, created_at timestamp with time zone, similarity double precision, metadata jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT
    m.id,
    m.memory_kind,
    m.content,
    m.created_at,
    1 - (m.embedding OPERATOR(extensions.<=>) p_query_embedding) AS similarity,
    m.metadata
  FROM public.contact_memory m
  WHERE m.brokerage_id = p_brokerage_id
    AND m.entity_type  = p_entity_type
    AND m.entity_id    = p_entity_id
    AND m.archived_at IS NULL
    AND m.embedding IS NOT NULL
    AND (p_memory_kinds IS NULL OR m.memory_kind = ANY(p_memory_kinds))
  ORDER BY m.embedding OPERATOR(extensions.<=>) p_query_embedding
  LIMIT GREATEST(1, LEAST(20, p_k));
$function$;

CREATE OR REPLACE FUNCTION public.get_current_month_usage(p_brokerage_id uuid DEFAULT NULL::uuid, p_team_id uuid DEFAULT NULL::uuid, p_agent_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(total_tokens bigint, total_cost_cents integer, usage_by_model jsonb, usage_by_feature jsonb)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    m.total_tokens,
    m.total_cost_cents,
    m.usage_by_model,
    m.usage_by_feature
  FROM public.ai_usage_monthly m
  WHERE m.month = date_trunc('month', CURRENT_DATE)::date
    AND (
      (p_brokerage_id IS NOT NULL AND m.brokerage_id = p_brokerage_id) OR
      (p_team_id IS NOT NULL AND m.team_id = p_team_id) OR
      (p_agent_id IS NOT NULL AND m.agent_id = p_agent_id)
    )
  LIMIT 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.increment(table_name text, row_id uuid, column_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF (table_name, column_name) NOT IN (
    ('ai_video_projects','view_count'),
    ('knowledge_articles','view_count'),
    ('knowledge_articles','helpful_count'),
    ('knowledge_articles','not_helpful_count')
  ) THEN
    RAISE EXCEPTION 'increment: (%, %) is not an allowed counter', table_name, column_name;
  END IF;
  EXECUTE format('UPDATE public.%I SET %I = COALESCE(%I,0) + 1 WHERE id = $1', table_name, column_name, column_name)
  USING row_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.increment_ai_usage_monthly(p_brokerage_id uuid, p_month date, p_tokens_input bigint, p_tokens_output bigint, p_cost_cents integer, p_model text, p_feature text, p_team_id uuid DEFAULT NULL::uuid, p_agent_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_subscriber_type text;
  v_subscriber_id uuid;
  v_usage_by_model jsonb;
  v_usage_by_feature jsonb;
  v_brokerage_id uuid;
  v_team_id uuid;
  v_agent_id uuid;
BEGIN
  -- Determine who pays for this usage
  SELECT subscriber_type, subscriber_id
  INTO v_subscriber_type, v_subscriber_id
  FROM get_billing_subscriber(p_brokerage_id, p_team_id, p_agent_id);

  -- Set the appropriate ID based on subscriber type
  IF v_subscriber_type = 'agent' THEN
    v_brokerage_id := NULL;
    v_team_id := NULL;
    v_agent_id := v_subscriber_id;
  ELSIF v_subscriber_type = 'team' THEN
    v_brokerage_id := NULL;
    v_team_id := v_subscriber_id;
    v_agent_id := NULL;
  ELSE -- brokerage
    v_brokerage_id := v_subscriber_id;
    v_team_id := NULL;
    v_agent_id := NULL;
  END IF;

  -- Build JSONB objects for model and feature tracking
  v_usage_by_model := jsonb_build_object(
    p_model,
    jsonb_build_object(
      'tokens', p_tokens_input + p_tokens_output,
      'cost_cents', p_cost_cents
    )
  );

  v_usage_by_feature := jsonb_build_object(
    p_feature,
    jsonb_build_object(
      'tokens', p_tokens_input + p_tokens_output,
      'cost_cents', p_cost_cents
    )
  );

  -- Perform SINGLE insert based on subscriber type (no wasted queries)
  IF v_subscriber_type = 'brokerage' THEN
    INSERT INTO public.ai_usage_monthly (
      brokerage_id, team_id, agent_id, month,
      total_tokens_input, total_tokens_output, total_tokens,
      total_cost_cents, usage_by_model, usage_by_feature
    ) VALUES (
      v_brokerage_id, NULL, NULL, p_month,
      p_tokens_input, p_tokens_output, p_tokens_input + p_tokens_output,
      p_cost_cents, v_usage_by_model, v_usage_by_feature
    )
    ON CONFLICT (brokerage_id, month) WHERE brokerage_id IS NOT NULL
    DO UPDATE SET
      total_tokens_input = ai_usage_monthly.total_tokens_input + EXCLUDED.total_tokens_input,
      total_tokens_output = ai_usage_monthly.total_tokens_output + EXCLUDED.total_tokens_output,
      total_tokens = ai_usage_monthly.total_tokens + EXCLUDED.total_tokens,
      total_cost_cents = ai_usage_monthly.total_cost_cents + EXCLUDED.total_cost_cents,
      usage_by_model = jsonb_deep_merge(ai_usage_monthly.usage_by_model, EXCLUDED.usage_by_model),
      usage_by_feature = jsonb_deep_merge(ai_usage_monthly.usage_by_feature, EXCLUDED.usage_by_feature),
      updated_at = now();

  ELSIF v_subscriber_type = 'team' THEN
    INSERT INTO public.ai_usage_monthly (
      brokerage_id, team_id, agent_id, month,
      total_tokens_input, total_tokens_output, total_tokens,
      total_cost_cents, usage_by_model, usage_by_feature
    ) VALUES (
      NULL, v_team_id, NULL, p_month,
      p_tokens_input, p_tokens_output, p_tokens_input + p_tokens_output,
      p_cost_cents, v_usage_by_model, v_usage_by_feature
    )
    ON CONFLICT (team_id, month) WHERE team_id IS NOT NULL
    DO UPDATE SET
      total_tokens_input = ai_usage_monthly.total_tokens_input + EXCLUDED.total_tokens_input,
      total_tokens_output = ai_usage_monthly.total_tokens_output + EXCLUDED.total_tokens_output,
      total_tokens = ai_usage_monthly.total_tokens + EXCLUDED.total_tokens,
      total_cost_cents = ai_usage_monthly.total_cost_cents + EXCLUDED.total_cost_cents,
      usage_by_model = jsonb_deep_merge(ai_usage_monthly.usage_by_model, EXCLUDED.usage_by_model),
      usage_by_feature = jsonb_deep_merge(ai_usage_monthly.usage_by_feature, EXCLUDED.usage_by_feature),
      updated_at = now();

  ELSE -- agent
    INSERT INTO public.ai_usage_monthly (
      brokerage_id, team_id, agent_id, month,
      total_tokens_input, total_tokens_output, total_tokens,
      total_cost_cents, usage_by_model, usage_by_feature
    ) VALUES (
      NULL, NULL, v_agent_id, p_month,
      p_tokens_input, p_tokens_output, p_tokens_input + p_tokens_output,
      p_cost_cents, v_usage_by_model, v_usage_by_feature
    )
    ON CONFLICT (agent_id, month) WHERE agent_id IS NOT NULL
    DO UPDATE SET
      total_tokens_input = ai_usage_monthly.total_tokens_input + EXCLUDED.total_tokens_input,
      total_tokens_output = ai_usage_monthly.total_tokens_output + EXCLUDED.total_tokens_output,
      total_tokens = ai_usage_monthly.total_tokens + EXCLUDED.total_tokens,
      total_cost_cents = ai_usage_monthly.total_cost_cents + EXCLUDED.total_cost_cents,
      usage_by_model = jsonb_deep_merge(ai_usage_monthly.usage_by_model, EXCLUDED.usage_by_model),
      usage_by_feature = jsonb_deep_merge(ai_usage_monthly.usage_by_feature, EXCLUDED.usage_by_feature),
      updated_at = now();
  END IF;

EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail transaction
    RAISE WARNING 'Failed to increment monthly usage: %', SQLERRM;
END;
$function$;

CREATE OR REPLACE FUNCTION public.increment_blog_share_count(p_blog_post_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  update public.blog_posts set share_count_total = coalesce(share_count_total, 0) + 1
  where id = p_blog_post_id;
$function$;

CREATE OR REPLACE FUNCTION public.increment_blog_view_count(p_blog_post_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  update public.blog_posts set view_count_total = coalesce(view_count_total, 0) + 1
  where id = p_blog_post_id;
$function$;

CREATE OR REPLACE FUNCTION public.increment_knowledge_article_view(article_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.knowledge_articles SET view_count = COALESCE(view_count, 0) + 1 WHERE id = article_id;
$function$;

CREATE OR REPLACE FUNCTION public.increment_learning_module_view(p_module_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE learning_modules
     SET view_count = view_count + 1,
         updated_at = now()
   WHERE id = p_module_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.increment_rule_triggered(rule_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.assignment_rules SET times_triggered = COALESCE(times_triggered,0) + 1 WHERE id = rule_id;
$function$;

CREATE OR REPLACE FUNCTION public.match_help_topics(query_embedding vector, match_threshold double precision DEFAULT 0.7, match_count integer DEFAULT 5, p_brokerage_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, topic_key text, title text, content text, category text, tags text[], similarity double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    h.id,
    h.topic_key,
    h.title,
    h.content,
    h.category,
    h.tags,
    1 - (h.content_embedding <=> query_embedding) AS similarity
  FROM help_topics_kb h
  WHERE h.is_active = TRUE
    AND h.content_embedding IS NOT NULL
    AND (h.brokerage_id IS NULL OR h.brokerage_id = p_brokerage_id)
    AND 1 - (h.content_embedding <=> query_embedding) > match_threshold
  ORDER BY h.content_embedding <=> query_embedding
  LIMIT match_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_knowledge_articles(query_embedding vector, match_threshold double precision DEFAULT 0.7, match_count integer DEFAULT 5, p_brokerage_id uuid DEFAULT NULL::uuid, p_category text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, title text, slug text, content text, excerpt text, category text, tags text[], similarity double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    ka.id,
    ka.title,
    ka.slug,
    ka.content,
    ka.excerpt,
    ka.category,
    ka.tags,
    1 - (ka.content_embedding <=> query_embedding) AS similarity
  FROM knowledge_articles ka
  WHERE ka.status = 'published'
    AND ka.content_embedding IS NOT NULL
    AND (ka.brokerage_id IS NULL OR ka.brokerage_id = p_brokerage_id)
    AND (p_category IS NULL OR ka.category = p_category)
    AND 1 - (ka.content_embedding <=> query_embedding) > match_threshold
  ORDER BY ka.content_embedding <=> query_embedding
  LIMIT match_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_safety_schema_check()
 RETURNS TABLE(table_name text, missing_col text, missing_policy text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH tenant_signal AS (
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tbl
      ON tbl.table_schema = c.table_schema AND tbl.table_name = c.table_name
    WHERE c.table_schema='public'
      AND tbl.table_type='BASE TABLE'
      AND c.column_name IN ('agent_id','contact_id','listing_id','transaction_id','user_id','agent_user_id')
  ),
  has_brokerage AS (
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.column_name='brokerage_id'
  ),
  policed AS (
    SELECT DISTINCT p.tablename AS table_name
    FROM pg_policies p
    WHERE p.schemaname='public'
      AND (p.qual ILIKE '%brokerage_id%' OR p.with_check ILIKE '%brokerage_id%')
  )
  SELECT
    ts.table_name::text,
    (CASE WHEN hb.table_name IS NULL THEN 'missing_brokerage_id' ELSE NULL END)::text,
    (CASE WHEN hb.table_name IS NOT NULL AND p.table_name IS NULL THEN 'missing_policy' ELSE NULL END)::text
  FROM tenant_signal ts
  LEFT JOIN has_brokerage hb ON hb.table_name = ts.table_name
  LEFT JOIN policed       p  ON p.table_name  = ts.table_name
  WHERE hb.table_name IS NULL OR p.table_name IS NULL;
$function$;
