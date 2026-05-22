---
description: Create or review a Supabase/Postgres migration following repo conventions
argument-hint: <describe the schema change>
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

Create a Supabase migration for the following change: **$ARGUMENTS**

Steps:
1. Inspect existing schema and migrations to match naming, column, and style
   conventions. Check `supabase/` and any `migrations` directory.
2. Write the migration as a forward SQL file. Use `IF NOT EXISTS` / `IF EXISTS`
   guards where reasonable and idempotent-friendly patterns.
3. If the new/changed table holds business data, ensure it has a `brokerage_id`
   column and `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`, then note that RLS
   policies are required (see `/supabase:rls`). A table with RLS enabled and no
   policy denies all access.
4. Do NOT run destructive SQL (DROP/TRUNCATE/DELETE without WHERE) against any
   live project without explicit confirmation from me.
5. After writing, summarize what changed and remind me to run `/supabase:types`
   to regenerate TypeScript types.

If the change touches access control, delegate the policy work to the
`supabase-expert` agent.
