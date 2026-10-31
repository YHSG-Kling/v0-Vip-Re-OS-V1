-- ── APPLIED LIVE 2026-09-28 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m675 — lead_scraping_jobs: INSERT is a platform-admin act, like its SELECT/UPDATE/DELETE
-- (wave 88, lane 88F — census round 33).
--
-- LIVE BEFORE (read 2026-09-28, project hrvaqgvukzxfskkcrwbt, pg_policy):
--   lsj_select  r  is_platform_admin()                  (public)
--   lsj_update  w  is_platform_admin() / is_platform_admin()
--   lsj_delete  d  is_platform_admin()
--   lsj_insert  a  WITH CHECK (true)                    TO authenticated   ← the odd one out
--   rows: 0
--
-- The only writer was the lead-scraping cron, through two "use server" doors on the COOKIE
-- client (app/actions/lead-scraping-config.ts createScrapingJob/updateScrapingJob). A cron
-- has no session, so its inserts were refused (0 rows live); meanwhile the `true` insert
-- policy let ANY signed-in user of any tenant mint job rows through that public endpoint.
-- Lane 88F moved the writer to lib/lead-pipeline/scraping-job-ledger.ts on the cron's
-- SERVICE client (bypasses RLS) and retired both doors, so no authenticated path inserts
-- any more. This closes the table to the platform-admin class on every command.
--
-- Idempotent; data-free (no row is touched).

drop policy if exists lsj_insert on public.lead_scraping_jobs;
create policy lsj_insert on public.lead_scraping_jobs
  for insert
  to authenticated
  with check (is_platform_admin());

-- Postcondition: exactly one INSERT policy, and it is platform-admin-gated.
do $$
declare n int;
begin
  select count(*) into n
  from pg_policy
  where polrelid = 'public.lead_scraping_jobs'::regclass
    and polcmd = 'a'
    and pg_get_expr(polwithcheck, polrelid) ilike '%is_platform_admin()%';
  if n <> 1 then
    raise exception 'm675 postcondition: expected one platform-admin INSERT policy on lead_scraping_jobs, found %', n;
  end if;
end $$;
