-- m583 — eleven clocks the database already sets, and the repo never recorded.
--
-- WRITTEN, NOT APPLIED. Every statement below is a NO-OP against the live
-- database: each column ALREADY carries exactly the default this file states.
-- MEASURED LIVE on 2026-08-28 against hrvaqgvukzxfskkcrwbt from
-- information_schema.columns (table_schema='public', column_default IS NOT NULL);
-- the eleven rows are reproduced verbatim beside each statement. The integrator
-- should re-read those defaults before applying, and applying changes nothing
-- but the migration ledger.
--
-- WHY IT EXISTS. The opposite-missing census reports category 1b — "column read
-- by code, written by NOBODY" — and it correctly EXEMPTS a column whose writer
-- is an expression DEFAULT, because there is nothing for app code to write. It
-- derives that exemption OFFLINE, from the DDL in supabase/migrations and
-- scripts/*.sql, so that CI (which holds no database credentials) sees the same
-- evidence a developer does. Its coverage block publishes the resulting blind
-- spot in as many words:
--
--     "≥13 live EXPRESSION defaults are NOT visible to this scan
--      (their DDL is not in the repo)"
--
-- This file MEASURES that blind spot instead of leaving it as an inequality. Of
-- the 122 category-1b findings standing on 2026-08-28, ELEVEN are these columns:
-- their writer is `now()` or `CURRENT_DATE`, they are filled on every insert,
-- and every one of them was being reported as read-by-code-written-by-nobody.
-- That is the accusing direction of CLAUDE.md §2 — a finding list that names
-- eleven live, correct database defaults teaches its readers to stop reading it,
-- and invites the next lane to BUILD an app-side writer for a value the database
-- already computes (a second opinion about a timestamp, and in one case about a
-- billing event).
--
-- CLAUDE.md §3 records the trap in its trigger form; m582 recorded a trigger for
-- exactly this reason. This is the same move for the DEFAULT form, and it is the
-- same remedy the doctrine prescribes: teach the finder to see the writer, never
-- exempt the column by hand.
--
-- NOT INCLUDED, deliberately. A CONSTANT default is NOT a writer — it writes an
-- initial value, not information — and the census is right to keep those
-- findings. Sitting in the same live result set and left out on purpose:
-- thank_you_note_templates.is_active DEFAULT true, ai_autopilot_actions.status
-- DEFAULT 'pending', email_campaigns.open_rate/click_rate DEFAULT 0,
-- neighbor_notification_campaigns.recipients_sent/responses_received DEFAULT 0,
-- market_data.median_list_price DEFAULT 0, property_views.view_count DEFAULT 1,
-- ai_isa_campaigns.max_touches DEFAULT 5, conversation_insights.interruption_count
-- and .silence_duration_seconds DEFAULT 0, newsletter_brokers_templates.version_number
-- DEFAULT 1, service_status.is_critical DEFAULT false,
-- neighborhood_data_sources.is_active DEFAULT true, collaborative_searches.status
-- DEFAULT 'active', call_whisper_logs.agent_heard DEFAULT true,
-- ai_isa_engagement_tracking.metadata and social_posts.engagement_data DEFAULT
-- '{}'::jsonb. Those are counters, flags and statuses with a reader, a floor and
-- no writer — real findings, and they stay.

BEGIN;

-- live: agent_outcome_evaluations.evaluated_at  timestamptz  DEFAULT now()  NOT NULL
ALTER TABLE public.agent_outcome_evaluations   ALTER COLUMN evaluated_at    SET DEFAULT now();

-- live: approval_items.submitted_at            timestamptz  DEFAULT now()  NULLABLE
ALTER TABLE public.approval_items              ALTER COLUMN submitted_at    SET DEFAULT now();

-- live: call_whisper_logs.delivered_at         timestamptz  DEFAULT now()  NULLABLE
ALTER TABLE public.call_whisper_logs           ALTER COLUMN delivered_at    SET DEFAULT now();

-- live: collaborative_search_properties.added_at  timestamptz  DEFAULT now()  NULLABLE
ALTER TABLE public.collaborative_search_properties ALTER COLUMN added_at    SET DEFAULT now();

-- live: home_value_estimates.generated_at      timestamptz  DEFAULT now()  NULLABLE
ALTER TABLE public.home_value_estimates        ALTER COLUMN generated_at    SET DEFAULT now();

-- live: market_insights.generated_at           timestamptz  DEFAULT now()  NOT NULL
ALTER TABLE public.market_insights             ALTER COLUMN generated_at    SET DEFAULT now();

-- live: platform_coupon_redemptions.redeemed_at  timestamptz  DEFAULT now()  NOT NULL
-- This one is a BILLING event stamp: app/actions/superadmin/coupons.ts:93 folds
-- it into `last_redeemed_at` per coupon on the platform coupon list. All three
-- redemption writers (billing.ts:153, superadmin/coupons.ts:245,
-- auth/signup-brokerage.ts:373) omit it on purpose — the database clock is the
-- one that should stamp when a discount was taken, not whichever of three code
-- paths got there.
ALTER TABLE public.platform_coupon_redemptions ALTER COLUMN redeemed_at     SET DEFAULT now();

-- live: prediction_accuracy_log.logged_at      timestamptz  DEFAULT now()  NULLABLE
ALTER TABLE public.prediction_accuracy_log     ALTER COLUMN logged_at       SET DEFAULT now();

-- live: price_predictions.prediction_date      date         DEFAULT CURRENT_DATE  NOT NULL
ALTER TABLE public.price_predictions           ALTER COLUMN prediction_date SET DEFAULT CURRENT_DATE;

-- live: pricing_history.recorded_at            timestamptz  DEFAULT now()  NULLABLE
ALTER TABLE public.pricing_history             ALTER COLUMN recorded_at     SET DEFAULT now();

-- live: transaction_assignments.assigned_at    timestamptz  DEFAULT now()  NULLABLE
ALTER TABLE public.transaction_assignments     ALTER COLUMN assigned_at     SET DEFAULT now();

COMMIT;

-- AFTER APPLYING: nothing to regenerate. No CHECK is added, no column is added
-- or dropped, and the schema caches (schema-snapshot / schema-fk-map /
-- check-vocabularies / live-tables) carry no default information, so none of
-- them changes. The one thing that changes is what the offline scanners can
-- see: `npm run test:opposite-missing` should drop these eleven entries from
-- category 1b and count them in its "column read(s) computed by a DB expression
-- DEFAULT" coverage line instead — the count moving DOWN because the
-- accusations were false, which is the direction CLAUDE.md §2 asks to be stated.
