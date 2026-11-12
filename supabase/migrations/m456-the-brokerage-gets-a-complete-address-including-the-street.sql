-- m456 — OWNER RULING: "brokerage needs to have the complete address include street."
--
-- MEASURED BEFORE WRITING: brokerages holds city and state and NOTHING ELSE of an
-- address. There is no street line anywhere on the tenant row, which is why
-- lib/kernel/listings.ts:946 selected `brokerages.address` — a column that has
-- never existed. PostgREST rejects an unknown column in a nested select, the
-- catch below it turned that into { success: false }, and so
-- prefillListingFormFromRecord failed for EVERY listing while looking like an
-- ordinary empty result. The author's assumption was right; the column was
-- simply missing. This migration makes that assumption true.
--
-- ── NAMING FOLLOWS THE REPOSITORY, NOT A PREFERENCE ────────────────────────
--
-- Measured across the live schema before choosing:
--     address        7 tables      zip             7 tables
--     address_line1  1 table       address_line2   1 table
-- `address` + `city` + `state` + `zip` is what listings and six other tables
-- already use, and it is the exact spelling listings.ts reached for. Using
-- address_line1 here would have been a second convention for one table and would
-- have left that read broken. address_line2 is added for the suite/unit line
-- because a brokerage office usually has one and a required disclosure that
-- silently drops it is wrong on the printed piece.
--
-- ── WHY THIS IS A REAL COMPLIANCE FIELD, NOT DECORATION ────────────────────
--
-- lib/brand-template-registry/brand-requirements.ts:90,127 pushes
-- `brokerage_address` as a REQUIRED brand field, and lib/kernel/forms.ts:389
-- feeds it from prefillListingFormFromRecord. So the requirement was declared,
-- the plumbing was built, the form field was rendered — and the column at the
-- bottom of it did not exist. Every layer above assumed the one below had it.
--
-- No RLS change is needed and none is made: brokerages_update already reads
--   is_platform_admin() OR (is_brokerage_admin() AND id = current_user_brokerage_id())
-- in BOTH using and with check, so a brokerage admin may edit their own row and
-- no other tenant's. VERIFIED live before adding these columns rather than
-- assumed — building a settings screen on a write path that refuses is how a
-- surface ships looking finished and saving nothing.

alter table public.brokerages
  add column if not exists address       text,
  add column if not exists address_line2 text,
  add column if not exists zip           text;

comment on column public.brokerages.address is
  'Street line of the brokerage office address. Set by a brokerage admin in Settings -> Brokerage Info. Feeds the required `brokerage_address` brand field (lib/brand-template-registry/brand-requirements.ts) and listing form prefill.';
comment on column public.brokerages.address_line2 is
  'Optional suite/unit line of the brokerage office address.';
comment on column public.brokerages.zip is
  'Postal code of the brokerage office address. Spelled `zip` to match listings and the direct-mail lane.';

do $$
declare n_total int; n_with_street int;
begin
  select count(*), count(*) filter (where address is not null and btrim(address) <> '')
    into n_total, n_with_street from public.brokerages where deleted_at is null;
  raise notice 'm456: brokerages can now hold a street address. % of % brokerages have one so far — the settings screen is what fills them.', n_with_street, n_total;
end $$;
