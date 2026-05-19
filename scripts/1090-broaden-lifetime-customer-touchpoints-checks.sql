-- ===========================================================================
-- 1090-broaden-lifetime-customer-touchpoints-checks.sql
--
-- Three CHECK constraints on lifetime_customer_touchpoints were too narrow
-- for the code that already writes into the table. Every insert from the
-- annual home-value report cron, the lifetime-customers actions, and the
-- transaction-coordinator follow-ups silently violated one or more CHECK
-- constraints and never landed.
--
-- Original  channel CHECK:        video / sms / email / call
-- Original  status CHECK:         scheduled / sent / delivered / failed / skipped
-- Original  touchpoint_type CHECK: post_close_3_day / post_close_30_day /
--                                 post_close_6_month / home_anniversary /
--                                 birthday / referral_request / custom
--
-- The codebase writes additional values (channel='in_app',
-- status='pending_review', touchpoint_type='annual_home_value_report' / etc).
-- This migration broadens all three constraints to cover the full
-- vocabulary the application uses. Backward compatible — every old value
-- is still valid.
--
-- APPLIED VIA: supabase apply_migration "broaden_lifetime_customer_touchpoints_checks"
-- ===========================================================================

ALTER TABLE public.lifetime_customer_touchpoints
  DROP CONSTRAINT IF EXISTS past_client_touchpoints_channel_check;
ALTER TABLE public.lifetime_customer_touchpoints
  ADD CONSTRAINT past_client_touchpoints_channel_check
  CHECK (channel = ANY (ARRAY['video','sms','email','call','in_app','direct_mail','push']::text[]));

ALTER TABLE public.lifetime_customer_touchpoints
  DROP CONSTRAINT IF EXISTS past_client_touchpoints_status_check;
ALTER TABLE public.lifetime_customer_touchpoints
  ADD CONSTRAINT past_client_touchpoints_status_check
  CHECK (status = ANY (ARRAY['scheduled','pending_review','sent','delivered','failed','skipped','cancelled']::text[]));

ALTER TABLE public.lifetime_customer_touchpoints
  DROP CONSTRAINT IF EXISTS past_client_touchpoints_touchpoint_type_check;
ALTER TABLE public.lifetime_customer_touchpoints
  ADD CONSTRAINT past_client_touchpoints_touchpoint_type_check
  CHECK (touchpoint_type = ANY (ARRAY[
    'post_close_3_day','post_close_30_day','post_close_6_month',
    'home_anniversary','birthday','referral_request','market_update','custom',
    'annual_home_value_report','quarterly_home_value_report','new_listing_match',
    'price_drop_alert','open_house_invite','holiday','thank_you',
    'email','sms','call','video'
  ]::text[]));
