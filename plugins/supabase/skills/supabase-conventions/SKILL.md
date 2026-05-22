---
name: supabase-conventions
description: >-
  Conventions for working with Supabase in the VIP Real Estate OS codebase —
  which client to use (browser/server/service), how RLS governance works, env
  vars, migrations, and type generation. Use when reading or writing code that
  imports from lib/supabase, touches supabase/ SQL, queries the database, or
  configures Supabase auth/env.
---

# Supabase conventions (VIP Real Estate OS)

## 1. Choosing a client

| Need | Import | RLS |
|------|--------|-----|
| Client component / browser | `import { supabase } from "@/lib/supabase/client"` | Enforced (anon key + user session) |
| Server component / route handler / user-scoped server action | `import { createClient } from "@/lib/supabase/server"` then `await createClient()` | Enforced (cookie-bound session) |
| Trusted server-only privileged work | `import { createServiceClient } from "@/lib/supabase/service"` | **Bypassed** (service role) |

Rules of thumb:
- Always `await` the server `createClient()` — it reads `cookies()`.
- The browser client is a singleton; do not create new browser clients.
- Use the service client only in code never reachable by the browser. It bypasses
  RLS, so you own access control. Document why each call needs it.
- Default to the cookie-bound server client so RLS does the enforcement for you.

## 2. Environment variables

- `NEXT_PUBLIC_SUPABASE_URL` — project URL (public).
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — anon key (public).
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (**secret**, server only).

For the Supabase MCP server bundled with this plugin:
- `SUPABASE_ACCESS_TOKEN` — a personal access token from the Supabase dashboard.
- `SUPABASE_PROJECT_REF` — the project ref (the subdomain in your project URL).

Never expose the service role key or access token to client code or commit them.

## 3. RLS governance (the security model)

Authoritative permission field is `users.user_type`. `contact_persona` is UX-only.

Data is isolated by `brokerage_id`. Only `admin` bypasses isolation; `broker`
sees their whole brokerage; agents see their own/assigned rows; `contact` users
get read-only self-visibility; vendors/lenders/title agents are transaction-scoped.

Use the SQL helpers, never reinvent them:
`auth.user_type()`, `auth.user_brokerage_id()`, `auth.is_admin()`,
`auth.is_broker()`, `auth.is_agent()`, `auth.is_contact()`,
`auth.owns_record(table, id)`.

Policy naming: `[user_type]_[operation]_[table]_[condition]`.

Authoritative policies live in `supabase/rls-governance/`, applied via
`011-apply-all-policies.sql`. See that folder's README for the full model. When
adding a table that holds business data: add `brokerage_id`, enable RLS, and
write a policy for every user type that should have access (RLS-enabled +
no-policy = deny all).

## 4. Querying patterns

```ts
// RLS filters automatically — no need to add brokerage_id by hand
const { data } = await supabase.from("contacts").select("*")

// Extra filters narrow within the RLS-allowed set
const { data } = await supabase.from("contacts").select("*").eq("agent_id", userId)
```

You cannot bypass RLS from the anon/session client. To intentionally bypass it,
switch to `createServiceClient()` server-side.

## 5. Migrations & types

- Schema changes belong in migration files, not ad-hoc SQL.
- After any schema change, regenerate TypeScript types so `types.ts` /
  generated types stay in sync.
- Never run destructive SQL against a live project without explicit confirmation.

When in doubt about access control, delegate to the `supabase-expert` agent.
