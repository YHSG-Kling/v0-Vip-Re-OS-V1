-- m399 — the assertion half of m398, and the reason it is a separate file.
--
-- m398 rewrites `public.offer_strategy_templates."Read active templates"` from
--
--     FOR SELECT USING (is_active = true)                         -- TO PUBLIC
-- to
--     FOR SELECT TO authenticated
--       USING (is_active = true
--              AND (brokerage_id IS NULL
--                   OR brokerage_id = current_user_brokerage_id()))
--
-- taking `anon` off the table and stopping brokerage B reading brokerage A's
-- negotiation playbook, while KEEPING `is_active` as a conjunct — the owner
-- ruling is that active means published to THIS TENANT'S people, not that active
-- stops meaning anything.
--
-- That leaves a gap that must not be allowed to close quietly, so this migration
-- is the gate: **if any PERMISSIVE SELECT policy on a table carrying a
-- `brokerage_id` column decides visibility from `is_active` WITHOUT ever
-- consulting `brokerage_id`, this FAILS and names every one of them.**
--
-- WHY A SEPARATE MIGRATION rather than a `raise exception` at the end of m398:
-- a raise rolls back its whole transaction. Raising inside m398 would undo the
-- rewrite along with it, so one policy that could not be narrowed would revert
-- the one that could — and the table would stay exactly as world-readable as
-- before, with a red migration as the only difference. Split, m398's ALTER
-- COMMITs and this fails afterwards on the genuine remainder. Same reason m393
-- is split from m392, m395 from m394 and m397 from m396.
--
-- ── THIS ASSERTS THE RULING, NOT m398'S EXACT SPELLING ──────────────────────
--
-- It deliberately does NOT key on `polqual = '(is_active = true)'`, which is
-- what m398 SELECTS on. m398 must select narrowly — it rewrites expressions, and
-- a migration that rewrites what it has not read exactly is a different and
-- worse kind of migration. An ASSERTION has the opposite duty: `is_active IS
-- TRUE`, `is_active`, `(is_active = true) AND (published_at IS NOT NULL)` are
-- all the same defect in different spellings, and a gate that only recognises
-- one of them is a spelling test wearing a security label. So the predicate here
-- is the RULING: consults `is_active`, never consults `brokerage_id`, on a table
-- that has a `brokerage_id`.
--
-- ── AND IT IS NOT SCOPED TO PUBLIC, ON PURPOSE ─────────────────────────────
--
-- m395 and m397 both key on `0 = any(p.polroles)`, because the defect they hold
-- shut is specifically an `anon` grant. This one is wider, because the ruling is
-- wider. `TO authenticated USING (is_active = true)` on a tenant table has taken
-- `anon` off and left every OTHER BROKERAGE reading — which is most of the
-- defect, spelled to look like the fix. Role-blind is the only predicate that
-- catches that, and it costs nothing: a policy that consults `brokerage_id` at
-- all is out of scope whoever it is granted to.
--
-- HOW TO SATISFY IT: for each policy named in the failure, decide whose rows
-- those are and say so in DDL, in its own migration.
--   · They are the tenant's — the ordinary case, and what m398 does:
--       ALTER POLICY <name> ON public.<table> TO authenticated
--         USING (<the existing flag> AND (brokerage_id IS NULL
--                OR brokerage_id = current_user_brokerage_id()));
--     That spelling is not arbitrary: it is what `brokerage_form_library`,
--     `content_templates`, `chat_templates` and `thank_you_note_templates`
--     already use, and what `offer_strategy_templates`' own sibling policies use.
--   · They genuinely are world-readable catalogue content — then say that out
--     loud rather than inheriting it, and add the policy to m398's
--     `keep_world_readable` array WITH THE LOGGED-OUT CALL SITE that needs it,
--     established the way docs/wave22-audit.md § W22-2 establishes one: a
--     browser client on a logged-out route, or a session client on a route with
--     no auth gate. A carve-out that is not named is not a carve-out, it is the
--     same defect with a new date on it.
-- Do NOT satisfy it by deleting this file.
--
-- WHAT THIS DOES **NOT** ASSERT, and must not be read as blessing:
--   · `video_templates."Anyone can view active templates"` is the one other
--     policy on this database with the identical `(is_active = true)` shape. Its
--     table has NO `brokerage_id` column, so it is out of scope BY CONSTRUCTION,
--     exactly as the 20 non-tenant INSERT-true policies are out of m397's. That
--     is a platform video catalogue and whether it should be world-readable is a
--     separate question with a separate answer.
--   · Within the tenant, an INACTIVE template is still readable through
--     `offer_strategy_templates_tenant_select`, which carries the same tenant
--     predicate without the `is_active` conjunct. Permissive policies OR. m398's
--     header records this; narrowing that sibling is an edit to the
--     `brokerage_id IS NULL` escape family — task #156, an owner ruling — and is
--     not this file's business.
--   · The escape branch itself survives, so any AUTHENTICATED user of ANY
--     brokerage can still read UNTENANTED rows of this table. Same task #156.
--     A green m399 says the WORLD-READABLE-BY-FLAG-ALONE path is closed on
--     tenant tables, and nothing more.

do $$
declare
  publishes_on_flag_alone text[];
  -- Kept in step with m398's `keep_world_readable`. Empty, and it should stay
  -- empty: the one policy m398 rewrote had no logged-out reader of any kind —
  -- its sole reader (`app/actions/buyer-offers.ts:411`) runs on
  -- `createServiceClient()`, which BYPASSes RLS, and the table has no runtime
  -- writer at all (`scripts/writerless-read-sweep.ts:33` lists it as seeded
  -- reference data).
  keep_world_readable     text[] := '{}';
begin
  select coalesce(array_agg(c.relname || '.' || p.polname order by c.relname, p.polname), '{}')
  into   publishes_on_flag_alone
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  p.polpermissive                                         -- PERMISSIVE: it ORs
    and  p.polcmd in ('r', '*')                                  -- FOR SELECT, or FOR ALL
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), 'is_active')    > 0
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), 'brokerage_id') = 0
    and  not ((c.relname || '.' || p.polname) = any(keep_world_readable))
    and  exists (                                                -- …on a TENANT table
           select 1
           from   pg_attribute a
           where  a.attrelid = p.polrelid
             and  a.attname  = 'brokerage_id'
             and  a.attnum   > 0
             and  not a.attisdropped
         );

  if array_length(publishes_on_flag_alone, 1) is not null then
    raise exception
      'm399: % SELECT polic(ies) on tables carrying `brokerage_id` decide visibility from an `is_active` flag and never consult `brokerage_id`: %. A row admitted by such a policy is admitted to EVERY caller the policy is granted to — and where that grant is PUBLIC (no TO clause) it includes `anon`, the key shipped in the browser bundle, which holds Supabase''s default GRANT ALL on these tables with RLS as the only thing in the way. These are tenant tables: one of them is a brokerage''s negotiation playbook — price guidance, earnest-money guidance, contingency recommendations and win rates per market condition. Marking a row active must publish it to THAT TENANT''S people, not to the world. AND the every-other-brokerage half survives a role narrowing, so `TO authenticated` is NOT a fix here: conjoin the tenant predicate the rest of this schema uses (ALTER POLICY <name> ON public.<table> TO authenticated USING (<flag> AND (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()))), or name it as a deliberate world-readable catalogue in m398''s keep_world_readable array with the logged-out call site that needs it.',
      array_length(publishes_on_flag_alone, 1),
      array_to_string(publishes_on_flag_alone, ', ');
  end if;

  raise notice 'm399: no PERMISSIVE SELECT policy on a `brokerage_id` table publishes rows on an `is_active` flag alone. Marking a template active publishes it to the tenant, not to the internet. Verified, not assumed.';
end $$;
