-- m563 — `client` IS NOT A CONTACT TYPE
-- =============================================================================
--
-- OWNER RULING, verbatim:
--
--   "lifetime should not get the welcome and client isn't a type"
--
-- Two rulings in one sentence. This migration is the SECOND half. The first half
-- (`lifetime_customer` gets no agent-signed welcome) is code-only and lands in
-- lib/kernel/client-welcome.ts :: resolveWelcomeManagers — it touches no schema
-- and is deliberately NOT smuggled in here.
--
-- THIS RULING REVERSES RECENT WORK, AND THE RECORD SHOULD SAY SO. m539 (2026-08-23)
-- narrowed this same CHECK from 14 values to 12 and KEPT `client` while collapsing
-- the three lifetime spellings; lib/contact-types.ts then made `client` the first
-- member of LIFETIME_CONTACT_TYPES and SPHERE_CONTACT_TYPES, which is the
-- membership four consolidated call sites still select on. The owner has now ruled
-- the value out entirely. Nothing here is a correction of a mistake — it is a
-- product call arriving after the vocabulary was built the other way.
--
-- ── WHY `client` IS A DEFECT AND NOT MERELY A SPARE VALUE (CLAUDE.md §6) ──────
--
-- `contact_type` answers ONE question: which side of a transaction is this person
-- on. Its other eleven values all answer it —
--
--   lead / prospect            not yet represented
--   buyer / seller / both      represented, and which side
--   investor                   represented, buy-side, numbers-first
--   lifetime_customer          represented once, already closed
--   sphere / referral_partner  relationship, no transaction
--   vendor                     counterparty
--   other                      declared, unclassifiable
--
-- `client` answers a DIFFERENT question — "are they represented?" — and every row
-- that could hold it can already say which side it is on. So it is a second
-- spelling of buyer / seller / both / investor with the side thrown away, which is
-- exactly the §6 defect: a scorer cannot match a writer across them, and the
-- representation fact it does carry lives on contacts.STATUS
-- ('representation' / 'active_transaction' / 'under_contract' — the vocabulary
-- lib/kernel/compliance.ts :: RESTRICTED_STATES gates outbound messaging on) and on
-- contacts.LIFECYCLE_STATE. Neither of those is touched here.
--
-- ── WHAT WAS MEASURED LIVE BEFORE WRITING THIS (2026-08-26, hrvaqgvukzxfskkcrwbt) ──
--
--   contacts_contact_type_check, BEFORE — 12 values:
--     CHECK (contact_type = ANY (ARRAY['lead','prospect','client',
--       'lifetime_customer','sphere','vendor','referral_partner','investor',
--       'buyer','seller','both','other']))
--
--   contact_type census: buyer 2, lifetime_customer 1, seller 1.
--   `client` = 0 ROWS. The removal is data-safe by census, not by hope.
--
--   BLAST RADIUS, measured before applying: contacts=4, brokerages=2, leads=0,
--   vendors=1, ai_tool_usage=23.
--
--   TWO-SIDED CONTROL, run live BEFORE applying, inside a DO block ending in RAISE
--   so nothing was left behind (the m554/m561/m562 pattern):
--
--     contacts.contact_type  client                  = ADMITTED
--     contacts.contact_type  lifetime_customer       = ADMITTED   ← the probe can see an accept
--     contacts.contact_type  not_a_real_contact_type = REFUSED(23514) ← the CHECK is really there
--
--   `not_a_real_contact_type` is the POSITIVE CONTROL (CLAUDE.md §2): after this
--   migration `client` must be REFUSED **while `lifetime_customer` is still
--   ADMITTED**, otherwise a narrowed vocabulary is indistinguishable from a CHECK
--   that refuses everything — and a dropped constraint would look identical to a
--   correct one if only the refusal probe were run.
--
--   Cardinality is read back DERIVED from pg_get_constraintdef rather than counted
--   off the literals typed below, so the 12 → 11 claim is the database's number and
--   not this file's.
--
-- ── campaign_sequences.contact_type — CHECKED, AND CORRECTLY UNTOUCHED ────────
--
-- m539's header records the trap this migration was told to re-check by name:
-- `campaign_sequences.contact_type` carries its OWN copy of this vocabulary and
-- lib/campaigns/contact-sources.ts :: contactTypeForContact maps one onto the
-- other, so collapsing only the contacts CHECK rebuilds the drift one table over.
--
-- MEASURED, NOT ASSUMED:
--
--   campaign_sequences_contact_type_check
--     CHECK ((contact_type IS NULL) OR (contact_type = ANY (ARRAY[
--       'buyer','seller','both','lifetime_customer'])))
--
--   PROBE, live, in a rolled-back DO block:
--     campaign_sequences.contact_type client            = REFUSED(23514)
--     campaign_sequences.contact_type lifetime_customer = ADMITTED
--
-- `client` IS NOT A MEMBER THERE AND NEVER WAS: that column is the COARSE axis
-- (which side is this sequence for), and m539 already gave it exactly four values.
-- So the "handle both or neither" rule is satisfied by NEITHER — there is nothing
-- to remove. Widening the migration to touch it anyway would be a no-op DDL that
-- reads like an enforced change, which is the waypoint defect §2 warns about.
--
-- `users.contact_type` also exists (information_schema, 2026-08-26). It carries NO
-- check constraint and 0 non-null rows live, so it holds no vocabulary to narrow.
--
-- `document_folders.folder_type` admits 'client' and is DELIBERATELY untouched: it
-- is a FOLDER taxonomy (transaction / client / template / marketing / compliance),
-- a different function. §6 is one vocabulary per FUNCTION, not one spelling per
-- repository — the same reasoning m539 used to leave portal_view, snapshot_type
-- and referral_sources.source_type alone.
--
-- ── THERE IS NO BACKFILL, AND THAT IS THE MEASURED DECISION ───────────────────
--
-- m539 backfilled, because it COLLAPSED three spellings onto one survivor and the
-- survivor was knowable for every row. This is not a collapse. `client` is being
-- removed because the question it answers is not this column's question, so the
-- correct replacement DEPENDS ON THE ROW — a represented buyer becomes 'buyer', a
-- represented seller 'seller', a dual-sided move 'both', a closed deal
-- 'lifetime_customer'. There is no expression over this table that decides that,
-- and writing `SET contact_type = 'other'` would make the migration succeed while
-- destroying the one fact the row still carried.
--
-- So instead of guessing, step 1 REFUSES to run where the guess would be needed,
-- naming the count. On hrvaqgvukzxfskkcrwbt that count is 0 and the guard is inert;
-- in an environment that does hold such rows a human classifies them first. A
-- migration that silently mislabels people is worse than one that stops.
--
-- APPLICATION STATUS: APPLIED 2026-08-26 to project hrvaqgvukzxfskkcrwbt, with
--   before/after two-sided controls whose fixtures ran inside DO blocks ending in
--   RAISE and were therefore rolled back — no INSERT was taken outside a DO block,
--   and the live counts were proved back to contacts=4 (census buyer 2,
--   lifetime_customer 1, seller 1), brokerages=2, leads=0, vendors=1,
--   ai_tool_usage=23, campaign_sequences=0, with 0 rows matching the probe name.
--   NO ASSERTION ANYWHERE IS PINNED TO THESE WORDS (CLAUDE.md §2): every guard asks
--   the DATABASE, or the generated vocabulary cache, whether the value is admitted.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. REFUSE RATHER THAN GUESS. Inert here (census: 0 rows); load-bearing anywhere
--    that still holds the value.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare v_client bigint;
begin
  select count(*) into v_client from public.contacts where contact_type = 'client';
  if v_client > 0 then
    raise exception
      'm563: % contacts still hold contact_type=''client''. There is no automatic '
      'survivor — a represented buyer is ''buyer'', a seller ''seller'', a dual-sided '
      'move ''both'', a closed deal ''lifetime_customer''. Classify them (the '
      'representation fact itself lives on contacts.status / contacts.lifecycle_state), '
      'then re-run.', v_client;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. contacts.contact_type — 12 spellings -> 11.
--
--    Order is otherwise preserved: scripts/check-vocabularies.ts is GENERATED from
--    pg_get_constraintdef, and a reordering would rewrite that cache's diff for no
--    behavioural reason (the m562 note).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.contacts drop constraint if exists contacts_contact_type_check;

alter table public.contacts
  add constraint contacts_contact_type_check
  check (contact_type = any (array[
    'lead'::text,
    'prospect'::text,
    -- 'client' REMOVED by m563 on the owner ruling "client isn't a type".
    'lifetime_customer'::text,   -- survivor of lifetime / lifetime_customer / past_client (m539)
    'sphere'::text,
    'vendor'::text,
    'referral_partner'::text,
    'investor'::text,
    'buyer'::text,
    'seller'::text,
    'both'::text,
    'other'::text
  ]));

comment on column public.contacts.contact_type is
  'WHICH SIDE OF A TRANSACTION THIS PERSON IS ON. m539 narrowed this from 14 values '
  'to 12 by collapsing lifetime / lifetime_customer / past_client onto '
  '''lifetime_customer''; m563 narrowed it to 11 by removing ''client'' on the owner '
  'ruling "client isn''t a type". ''client'' answered a DIFFERENT question — are they '
  'represented — which every row can already answer more precisely as buyer / seller '
  '/ both / investor, so it was a second spelling with the side thrown away '
  '(CLAUDE.md §6). THE REPRESENTATION FACT DID NOT MOVE INTO THIS COLUMN AND IS NOT '
  'LOST: it lives on contacts.status (''representation'', ''active_transaction'', '
  '''under_contract'' — what lib/kernel/compliance.ts :: RESTRICTED_STATES gates '
  'outbound messaging on) and on contacts.lifecycle_state. CODE-SIDE SURVIVOR OF THE '
  'VOCABULARY: lib/contact-types.ts :: CONTACT_TYPES, with '
  'canonicalContactType() the one tolerant reader for retired spellings and '
  'scripts/contact-vocabulary-guard.ts holding code and database in agreement. '
  'READERS STAY TOLERANT, WRITERS MUST NAME A SURVIVOR: the database refuses a '
  'retired spelling on write (23514) and matches nothing on read, and supabase-js '
  'RESOLVES both — the row is lost, or the query is empty, in silence. NOT the same '
  'vocabulary as campaign_sequences.contact_type (the four-value COARSE axis: buyer '
  '/ seller / both / lifetime_customer, which never admitted ''client''), nor as '
  'contacts.contact_persona (a SITUATION — m531a settled that axis), nor as '
  'document_folders.folder_type (a folder taxonomy that still admits ''client'' '
  'because it is a different function).';

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run after apply; the lane report quotes the output)
--
--   -- THE CONSTRAINT, AFTER, with cardinality DERIVED and not typed:
--   with defs as (
--     select conname,
--            (select array_agg(m[1] order by ord)
--               from regexp_matches(pg_get_constraintdef(oid), '''([a-z0-9_]+)''::text', 'g')
--                 with ordinality as t(m, ord)) as vocab
--       from pg_constraint
--      where conname in ('contacts_contact_type_check',
--                        'campaign_sequences_contact_type_check'))
--   select conname, cardinality(vocab),          -- expected 11, 4
--          'client'            = any(vocab),     -- expected false, false
--          'lifetime_customer' = any(vocab)      -- expected true,  true
--     from defs;
--
--   -- NO ROW LEFT ON THE RETIRED SPELLING (must be 0):
--   select count(*) from public.contacts where contact_type = 'client';
--
--   -- TWO-SIDED POSITIVE CONTROL (CLAUDE.md §2) — a CHECK that refuses EVERYTHING
--   -- and a CHECK that refuses exactly 'client' both make the REFUSAL probe pass.
--   -- The ACCEPT probe is what tells them apart, so all three run together inside
--   -- one DO block that ends in RAISE and is therefore rolled back:
--   --
--   --   contacts.contact_type 'client'                  → EXPECT 23514 (was ADMITTED)
--   --   contacts.contact_type 'lifetime_customer'       → EXPECT ADMITTED (the control)
--   --   contacts.contact_type 'not_a_real_contact_type' → EXPECT 23514 (the CHECK is real)
--
--   SCHEMA CACHES (CLAUDE.md §3): this narrows a CHECK, so
--   scripts/check-vocabularies.ts drifted the moment it was applied and was
--   REGENERATED by `npm run schema:regen:vocabularies` — piped from the live
--   database, never hand-edited. No table is added or dropped, so
--   scripts/live-tables.ts, scripts/schema-snapshot.ts and scripts/schema-fk-map.ts
--   are untouched by design.
--
--   No assertion anywhere is pinned to the words of this file (CLAUDE.md §2 — do
--   not pin an assertion to a waypoint): every guard asks the DATABASE, or the
--   generated vocabulary cache, whether the value is admitted.
-- ─────────────────────────────────────────────────────────────────────────────
