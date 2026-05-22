---
description: Create or run seed data for local Supabase development
argument-hint: <what to seed, e.g. "a broker with two agents and sample leads">
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

Create seed data for: **$ARGUMENTS**

Steps:
1. Check for an existing seed file (`supabase/seed.sql` or similar) and the
   schema so seeded rows satisfy NOT NULL / FK constraints.
2. Generate realistic, RLS-aware seed rows. Because access is driven by
   `users.user_type` and `brokerage_id`, set those fields coherently so seeded
   users actually see the seeded data under RLS (e.g. an agent's `agent_id` on
   their leads, a shared `brokerage_id`).
3. Write seeds to the conventional seed file. Make them idempotent where
   reasonable (e.g. `ON CONFLICT DO NOTHING`) so re-running is safe.
4. Only target a LOCAL/dev database. Never run seed inserts against a production
   project without explicit confirmation from me.
5. Tell me how to apply them (e.g. `npx supabase db reset` for local, which
   re-runs migrations + seed).

Keep the dataset small but representative of the real estate domain (brokerage,
broker, agents, contacts, leads, transactions).
