-- m510 — voice_calls.compliance_passed must not assert a check that never ran.
--
-- THE DEFECT. The column is declared `boolean DEFAULT true`. No code in the tree
-- has ever written it (opposite-missing census class 1b, wave 13: the column is
-- READ by three surfaces and written by nobody):
--
--   app/components/dashboard/voice/VoiceCallHistoryTable.tsx:156  green ShieldCheck
--   app/dashboard/voice-intelligence/page.tsx:50                  compliance column
--   app/dashboard/superadmin/tenant-calls/page.tsx:86 + :174      tenant call log
--
-- So every row on every voice lane — inbound webhooks, warm transfers, the relay,
-- the ElevenLabs lane, the demo seeder — was stamped "compliance passed" by the
-- DATABASE, and all three surfaces drew a green shield over a call nothing had
-- checked. The red branch (`compliance_passed === false`) was unreachable, and
-- the superadmin log's whole purpose is to surface exactly that branch. This is
-- the documents-verified-passes-with-zero-documents shape, in the lane where the
-- fact being asserted is TCPA/DNC consent.
--
-- THE FIX HAS TWO HALVES AND BOTH ARE REQUIRED.
--
--   1. A REAL WRITER (already landed, this is not a schema-only change):
--      lib/voice/twilio-outbound.ts:placeOutboundAiCall now stamps
--      compliance_passed = true on the ledger row it inserts. That insert is
--      reached ONLY past runOutboundCallGates — autonomy, suppression/DNC, TCPA
--      consent + quiet hours, de-conflict, vendor budget — every one of which
--      short-circuits with a refusal before anything dials. A `true` written
--      there is a verdict, not a default.
--
--   2. THIS MIGRATION, which removes the claim from every lane that has no such
--      gate. NULL is the honest value for "not checked": all three readers
--      already branch `=== true` / `=== false` / else, and render an em dash for
--      the else. Dropping the default therefore changes a FALSE CLAIM into an
--      accurate silence without touching a single reader.
--
-- WHY THE DEFAULT IS DROPPED RATHER THAN FLIPPED TO false. `false` would be the
-- opposite lie — it says a check ran and the call FAILED it, which would light
-- the superadmin log's red flag on every inbound call the platform ever takes
-- and bury the real violations under noise. Absence of a verdict is not a
-- verdict.
--
-- LIVE STATE MEASURED BEFORE WRITING (project hrvaqgvukzxfskkcrwbt):
--   select count(*), count(compliance_passed) from voice_calls;  →  0, 0
-- The table is empty, so no historical row is being re-labelled and no backfill
-- is needed or offered. Existing deployments with rows keep whatever they have:
-- this migration does NOT rewrite data it cannot re-derive, because a stamp
-- invented after the fact is the same defect one layer down.

do $$
declare
  v_default text;
  v_rows    bigint;
begin
  select column_default into v_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'voice_calls' and column_name = 'compliance_passed';

  if not found or v_default is null then
    raise notice 'm510 BEFORE: voice_calls.compliance_passed has no default — nothing to drop (already correct, or the column is absent).';
  else
    raise notice 'm510 BEFORE: voice_calls.compliance_passed default = %', v_default;
  end if;

  execute 'select count(*) from public.voice_calls' into v_rows;
  raise notice 'm510 BEFORE: voice_calls rows = %', v_rows;
end $$;

alter table public.voice_calls
  alter column compliance_passed drop default;

comment on column public.voice_calls.compliance_passed is
  'Did this call clear the pre-dial compliance stack (autonomy, suppression/DNC, TCPA consent + quiet hours, de-conflict, budget)? Written ONLY by lib/voice/twilio-outbound.ts:placeOutboundAiCall, which is reached only past runOutboundCallGates. NULL means NO CHECK RAN on this lane and every reader renders it as "—" — it must never be defaulted to true, which is what m510 removed.';

-- ── AFTER: the default is gone, and a fresh row says nothing rather than "pass".
do $$
declare
  v_default text;
begin
  select column_default into v_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'voice_calls' and column_name = 'compliance_passed';

  if v_default is not null then
    raise exception 'm510: voice_calls.compliance_passed still carries a default (%) — the claim was not removed.', v_default;
  end if;

  raise notice 'm510 AFTER: voice_calls.compliance_passed default removed; an unchecked call now records NULL.';
end $$;
