-- m425 — close the write half that migration 063 left unconditionally open.
--
-- FOUND WHILE SWEEPING #156's ZERO STRATUM, not while looking for it. Asking the
-- catalogue for "any INSERT or UPDATE policy whose predicate is unconditionally
-- true" returned exactly three tables with an open UPDATE:
--
--   long_form_videos.lfv_upd      FOR UPDATE USING (TRUE) WITH CHECK (TRUE) TO PUBLIC
--   marketing_stats.mstats_upd    FOR UPDATE USING (TRUE) WITH CHECK (TRUE) TO PUBLIC
--   transparency_videos.tvids_upd FOR UPDATE USING (TRUE) WITH CHECK (TRUE) TO PUBLIC
--
-- All three were created by migration 063 and have never been narrowed. m413
-- took `anon` off these tables' SELECT and m414 asserted they are off the open
-- internet — but BOTH ONLY TOUCHED SELECT. This is the same read-side-only sweep
-- miss as commission_splits (m419): the read half gets fixed, the write half is
-- not looked at, and the table is recorded as "handled".
--
-- MEASURED, NOT ASSUMED. `anon` is in fact refused, but not by these policies —
-- it is refused because m413 left it matching NO SELECT policy, and Postgres
-- evaluates the SELECT policy to locate the row for an UPDATE carrying a WHERE.
-- So the open UPDATE is inert for `anon` and live for `authenticated`. Proven by
-- running the update as each role against fixture rows inside a transaction that
-- was then rolled back:
--
--   as anon           → description unchanged, impressions unchanged  (refused)
--   as authenticated  → description rewritten, impressions rewritten  (ALLOWED)
--
-- So the true exposure is: ANY SIGNED-IN USER OF ANY TENANT COULD REWRITE EVERY
-- ROW of all three tables. Not anonymous — the first reading of the policy said
-- anonymous, and the empirical check is what corrected it.
--
-- WHY THIS IS SAFE TO CLOSE NOW, AND WHY `is_platform_admin()` IS THE RIGHT GATE:
-- these are not tenant tables and there is nothing to migrate. m288 already
-- recorded that none of the three carries a brokerage_id/agent_id/user_id;
-- m413 recorded 0 readers and 0 rows; a fresh grep of app/ lib/ services/ hooks/
-- finds ZERO code references to any of the three; and all three are still empty.
-- Each table ALREADY gates DELETE on is_platform_admin(). So this does not invent
-- a new opinion about who owns these tables — it makes INSERT and UPDATE agree
-- with the decision the table itself already records on DELETE.
--
-- NOT A DELETION. The tables stay. Nothing here rules on whether the long-form
-- video / transparency-video / marketing-stat features should be built; it only
-- stops an unbuilt feature's storage from being a cross-tenant write surface in
-- the meantime.

-- long_form_videos ----------------------------------------------------------
drop policy if exists lfv_upd on public.long_form_videos;
create policy lfv_upd on public.long_form_videos
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists lfv_ins on public.long_form_videos;
create policy lfv_ins on public.long_form_videos
  for insert to authenticated
  with check (public.is_platform_admin());

-- marketing_stats -----------------------------------------------------------
drop policy if exists mstats_upd on public.marketing_stats;
create policy mstats_upd on public.marketing_stats
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists mstats_ins on public.marketing_stats;
create policy mstats_ins on public.marketing_stats
  for insert to authenticated
  with check (public.is_platform_admin());

-- transparency_videos -------------------------------------------------------
drop policy if exists tvids_upd on public.transparency_videos;
create policy tvids_upd on public.transparency_videos
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists tvids_ins on public.transparency_videos;
create policy tvids_ins on public.transparency_videos
  for insert to authenticated
  with check (public.is_platform_admin());
