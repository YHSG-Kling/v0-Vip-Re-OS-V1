-- 1099: Retire the marketing-trigger-engine cron (fold step 2 — System B enrollment retired).
-- campaign_sequences (System A) is now the SOLE enrollment spine; the reactor's marketing-trigger
-- branch + lib/marketing/trigger-engine.ts + the cron route are removed in the same change. Drop
-- the dead cron's health-registry row so the cron-health dashboard doesn't alarm on a retired cron.
-- The marketing-campaign-scheduler + marketing-attribution-engine crons (the send/attribution layer)
-- remain — they are orthogonal to enrollment and are now fed by System A via the touch-ledger bridge.
-- Applied live via Supabase MCP.

DELETE FROM cron_health_snapshot WHERE cron_name = 'marketing-trigger-engine';
