-- m389 — the tours policy compared two disjoint id spaces, so it never matched.
--
-- `tours_agent_own` read `(agent_id = auth.uid())`. `tours.agent_id` is a FOREIGN
-- KEY TO public.agents; `auth.uid()` is a users.id. The two spaces never overlap,
-- so the clause was constant-false and the only policy granting anything on this
-- table was `tours_broker_admin` — an ordinary agent could not read their OWN
-- tours at all.
--
-- This is the class m350 was written for ("THE NAME WAS THE BUG"): 195 columns
-- are called agent_id, 175 FK agents and 20 FK users, and reading one as the
-- other never errors — it silently matches nothing. m350 fixed the COLUMNS whose
-- name lied. Here the column is right and the POLICY is wrong, which is why the
-- rename batches did not catch it.
--
-- The fix RESOLVES rather than coalesces, through the helper the rest of the
-- schema already uses (033-auth-helper-functions.sql):
--   current_user_agent_id() = SELECT id FROM agents WHERE user_id = auth.uid()
-- SECURITY DEFINER STABLE and already granted to `authenticated`. Using it keeps
-- one definition of "which agent am I" instead of minting a second inline
-- subquery that can drift from the ~40 policies already built on it.
--
-- Pre-rollout the table is empty, so this widens no existing row's visibility —
-- it restores an access path that has never once worked.
drop policy if exists tours_agent_own on public.tours;

create policy tours_agent_own on public.tours
  for all
  using      (agent_id = public.current_user_agent_id())
  with check (agent_id = public.current_user_agent_id());
