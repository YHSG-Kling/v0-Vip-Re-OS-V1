-- m478 — A CLIENT SEAT DOES NOT WRITE THE TENANT'S LEDGERS (#180, INSERT stratum).
--
-- #180 measured 191 INSERT policies that pin a tenant (brokerage_id) and test NO
-- identity or role: any authenticated seat in the brokerage — including the
-- contact / lender / vendor client seats that exist only to see their own deals —
-- may insert rows into staff-operated ledgers. m475 closed the 5-table credential
-- stratum and introduced public.is_tenant_staff_seat() (staff user_types minus
-- contact/lender/vendor/system). This migration closes the next stratum: the 119
-- tables where a repo-wide writer census found NO client-side flow that inserts
-- with the user's own authenticated (RLS-bound) client.
--
-- HOW THE 119 WERE CHOSEN (grep census of app/, lib/, components/):
--   * STAFF-ONLY  — every authenticated-client .insert()/.upsert() writer is a
--     staff surface (dashboard pages/actions/routes); no portal (app/portal,
--     app/lender, app/vendor, app/(external-portal)), widget/embed, or public
--     token surface writes the table with the caller's own client.
--   * SERVICE-ONLY / NO WRITER — the table is written only through
--     createServiceClient() (service role bypasses RLS) or has no app writer at
--     all; its bare-tenant INSERT policy is dead permissiveness, so the seat
--     test costs nothing and closes the open door.
-- EXCLUDED from this migration (left untouched, on purpose):
--   * portal/client-written tables (client_portal_messages, offers, showings,
--     collaborative_search*, client_documents, home-value/open-house intake,
--     support tickets, ...) — a contact inserting there is the product working;
--     they need a compound (staff-seat OR own-row) policy, not this blanket.
--   * tables whose INSERT policy already carries an identity/role-bearing test
--     (closing_disclosure_agreement, transactions, subscriber_service_areas,
--     open_house_analytics, ...) — never rewrite someone else's rule blind.
--   * chat_sessions and vendor_usage_tracking — each carries a SECOND permissive
--     INSERT policy WITH CHECK (true), so tightening the tenant policy alone
--     would claim a closure it does not deliver.
-- UPDATE/DELETE policies are out of scope here: this is the INSERT stratum only.
-- is_tenant_staff_seat() is NOT redefined here — m475 owns it.

do $$
declare
  v_tables constant text[] := array[
        'agent_assistant_sessions','agent_avatar_assets','agent_ce_completions',
        'agent_relationships','ai_comp_scores','ai_daily_briefings',
        'ai_insights','ai_isa_activities','ai_isa_calls',
        'ai_isa_campaigns','ai_isa_engagement_tracking','ai_isa_qualifications',
        'ai_subscription_tier','approval_items','assignment_log',
        'assignment_rules','auto_response_settings','brokerage_cda_templates',
        'brokerage_form_library','business_card_scans','buyer_intake_tokens',
        'buyer_tours','calendar_sync_conflicts','calendar_sync_mappings',
        'call_analyses','call_coaching_insights','call_transcriptions',
        'campaign_sequences','client_engagement_scores','collaborative_searches',
        'competitor_content','competitor_profiles','competitors',
        'compliance_tasks','contact_vendors','cron_execution_logs',
        'documents','embed_sessions','embed_widgets',
        'farm_territories','form_submissions','gamification_badges',
        'health_check_history','health_metrics','inbound_call_classifications',
        'isa_outreach_log','journey_stage_progress','keyword_intelligence',
        'lead_capture_forms','lead_enrichment_queue','lead_imports',
        'lead_magnet_submissions','lead_magnets','lead_score_history',
        'lead_sla_tracking','leaderboard_rankings','lifetime_customer_touchpoints',
        'listing_landing_pages','listing_marketing_content','listing_packet_jobs',
        'listing_presentations','listing_price_changes','listing_task_templates',
        'local_news_sources','message_threads','neighbor_notification_campaigns',
        'neighbor_notification_recipients','neighborhood_data_sources','newsletter_brokers_templates',
        'newsletter_templates','newsletters','notification_rules',
        'objection_training_sessions','offer_strategy_templates','onboarding_ai_chats',
        'open_houses','organization_members','outside_agent_contact_links',
        'outside_agents','phone_number_events','plan_tasks',
        'platform_lead_distributions','predictive_listing_actions','predictive_listing_scores',
        'price_predictions','price_trend_alerts','pricing_history',
        'property_alert_delivery_log','property_matches','property_smart_insights',
        'property_views','qr_scan_events','quickbooks_sync_log',
        'referral_sources','scraper_executions','showing_analytics',
        'showing_feedback','signal_reactivations','social_intelligence',
        'sync_errors','system_health_checks','team_heatmap_snapshots',
        'team_performance','tenant_phone_numbers','territory_metrics',
        'tour_stops','unified_lead_profile','usage_events',
        'user_profiles','vendor_access_logs','vendors',
        'voice_assistant_config','voice_assistant_sessions','voice_commands',
        'wealth_advisor_recommendations','website_visitors','workflow_intake_sessions',
        'workflow_runs','workflow_webhook_events'
  ];
  r record;
  n int := 0;
begin
  for r in
    select tablename, policyname, with_check
    from pg_policies
    where schemaname = 'public'
      and cmd = 'INSERT'
      and tablename = any(v_tables)
  loop
    -- Precondition per policy: bare-tenant as measured (a tenant pin and no
    -- identity/role test). If a policy already carries one, FAIL LOUDLY rather
    -- than silently rewriting a rule someone else authored.
    if r.with_check is null or r.with_check !~ 'brokerage_id' then
      raise exception 'm478: %.% has no brokerage_id pin in with_check — not the measured stratum, refusing', r.tablename, r.policyname;
    end if;
    if r.with_check ~ 'user_type|is_brokerage|is_platform|is_tenant_staff_seat|is_team_lead|auth\.uid|jwt' then
      raise exception 'm478: %.% already carries an identity test — refusing to rewrite blind', r.tablename, r.policyname;
    end if;
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    execute format(
      'create policy %I on public.%I for insert with check ((%s) and public.is_tenant_staff_seat())',
      r.policyname, r.tablename, r.with_check);
    n := n + 1;
  end loop;
  raise notice 'm478: tightened % INSERT policies', n;
  -- Exactly one bare-tenant INSERT policy per listed table, verified against
  -- pg_policies before authoring: 119 tables, 119 policies. Any other number
  -- means the ground shifted under this migration — stop and re-measure.
  if n <> 119 then
    raise exception 'm478: expected exactly 119 INSERT policies across 119 tables, rewrote %', n;
  end if;
end $$;

-- Postcondition: no INSERT policy on the listed tables is bare-tenant any more.
do $$
declare
  v_tables constant text[] := array[
        'agent_assistant_sessions','agent_avatar_assets','agent_ce_completions',
        'agent_relationships','ai_comp_scores','ai_daily_briefings',
        'ai_insights','ai_isa_activities','ai_isa_calls',
        'ai_isa_campaigns','ai_isa_engagement_tracking','ai_isa_qualifications',
        'ai_subscription_tier','approval_items','assignment_log',
        'assignment_rules','auto_response_settings','brokerage_cda_templates',
        'brokerage_form_library','business_card_scans','buyer_intake_tokens',
        'buyer_tours','calendar_sync_conflicts','calendar_sync_mappings',
        'call_analyses','call_coaching_insights','call_transcriptions',
        'campaign_sequences','client_engagement_scores','collaborative_searches',
        'competitor_content','competitor_profiles','competitors',
        'compliance_tasks','contact_vendors','cron_execution_logs',
        'documents','embed_sessions','embed_widgets',
        'farm_territories','form_submissions','gamification_badges',
        'health_check_history','health_metrics','inbound_call_classifications',
        'isa_outreach_log','journey_stage_progress','keyword_intelligence',
        'lead_capture_forms','lead_enrichment_queue','lead_imports',
        'lead_magnet_submissions','lead_magnets','lead_score_history',
        'lead_sla_tracking','leaderboard_rankings','lifetime_customer_touchpoints',
        'listing_landing_pages','listing_marketing_content','listing_packet_jobs',
        'listing_presentations','listing_price_changes','listing_task_templates',
        'local_news_sources','message_threads','neighbor_notification_campaigns',
        'neighbor_notification_recipients','neighborhood_data_sources','newsletter_brokers_templates',
        'newsletter_templates','newsletters','notification_rules',
        'objection_training_sessions','offer_strategy_templates','onboarding_ai_chats',
        'open_houses','organization_members','outside_agent_contact_links',
        'outside_agents','phone_number_events','plan_tasks',
        'platform_lead_distributions','predictive_listing_actions','predictive_listing_scores',
        'price_predictions','price_trend_alerts','pricing_history',
        'property_alert_delivery_log','property_matches','property_smart_insights',
        'property_views','qr_scan_events','quickbooks_sync_log',
        'referral_sources','scraper_executions','showing_analytics',
        'showing_feedback','signal_reactivations','social_intelligence',
        'sync_errors','system_health_checks','team_heatmap_snapshots',
        'team_performance','tenant_phone_numbers','territory_metrics',
        'tour_stops','unified_lead_profile','usage_events',
        'user_profiles','vendor_access_logs','vendors',
        'voice_assistant_config','voice_assistant_sessions','voice_commands',
        'wealth_advisor_recommendations','website_visitors','workflow_intake_sessions',
        'workflow_runs','workflow_webhook_events'
  ];
  v_bad int;
begin
  select count(*) into v_bad
  from pg_policies
  where schemaname = 'public'
    and cmd = 'INSERT'
    and tablename = any(v_tables)
    and coalesce(with_check, qual) !~ 'is_tenant_staff_seat';
  if v_bad <> 0 then
    raise exception 'm478: % INSERT policies remain without the seat test', v_bad;
  end if;
end $$;
