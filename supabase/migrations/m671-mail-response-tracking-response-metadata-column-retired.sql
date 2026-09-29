-- ── WRITTEN, NOT APPLIED — the integrator applies it (CLAUDE.md §3: files are not the database) ──
--
-- m671 — mail_response_tracking.response_metadata is RETIRED (lane 90A, wave 90
-- orphan census burn-down; owner: "especially burning down left open, orphan
-- census, readerless writes … any orphaned wire/absent that needs a wire and/or
-- build needs to get it done").
--
-- THE AUDIT (orphan doctrine §1, all three options weighed before choosing):
--
--   · DUPLICATE? YES. The column was a byte-for-byte twin of
--     direct_mail_responses.response_metadata, written from the SAME
--     `params.responseMetadata` by the same writer (app/actions/direct-mail.ts
--     logResponse) and by the QR scan route. The SURVIVOR is
--     direct_mail_responses.response_metadata — genuinely read: the Responses
--     tab renders it (app/dashboard/campaigns/mail/components/responses-tab.tsx
--     metadataSummary) through app/actions/ai-direct-mail.ts's
--     `responses:direct_mail_responses(*)` embed.
--   · The app-side writers of THIS copy were deleted on 2026-09-07 with the
--     tombstone at app/actions/direct-mail.ts ("response_metadata is NO LONGER
--     WRITTEN HERE … SURVIVOR: direct_mail_responses.response_metadata") and
--     app/api/qr/scan/route.ts ("deliberately NOT copied onto the ROI ledger").
--   · READERS of this copy: NONE, ever. mail_response_tracking's consumers take a
--     COUNT (app/api/cron/bundle-attribution-rollup/route.ts) or id / type /
--     contact / lead columns (lib/campaigns/roi-calculator.ts) — never metadata.
--   · BUILD the missing half instead? NO — the reader exists and reads the
--     survivor. A second reader of a second copy is the §6 defect, not a wire.
--   · Since 2026-09-07 the ONLY writer has been m491's own self-verifying probe
--     (inserted, asserted, deleted inside that migration's transaction) — which
--     is why scripts/readerless-write-census.ts carries the column under
--     MIGRATION_ONLY_WRITE_EXEMPTIONS. An exemption is a recorded debt, not a
--     closed loop; this migration closes it.
--
-- WHAT THIS DOES: drops the column. Nothing in the tree names it in an INSERT /
-- UPDATE / SELECT of mail_response_tracking (verified 2026-09-29: the only
-- code mentions are the two tombstones above, the census exemption, and the
-- generated schema snapshot). PGRST204 cannot fire: no statement names it.
--
-- AFTER APPLYING (integrator):
--   1. regenerate scripts/schema-snapshot.ts (the column leaves the snapshot);
--   2. delete the "mail_response_tracking.response_metadata" entry from
--      MIGRATION_ONLY_WRITE_EXEMPTIONS in scripts/readerless-write-census.ts —
--      the census self-reports a stale exemption key, so leaving it is red;
--   3. test:readerless-writes: "columns written ONLY by a migration
--      self-verifying probe" 1 → 0.
--
-- SAFE TO RE-RUN: `drop column if exists`.

alter table public.mail_response_tracking
  drop column if exists response_metadata;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'mail_response_tracking'
      and column_name = 'response_metadata'
  ) then
    raise exception 'm671: mail_response_tracking.response_metadata still exists after the drop';
  end if;
  -- The survivor must still be there — this migration retires the COPY, never the original.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'direct_mail_responses'
      and column_name = 'response_metadata'
  ) then
    raise exception 'm671: the survivor direct_mail_responses.response_metadata is missing — refusing to leave the tenant with neither copy';
  end if;
end $$;
