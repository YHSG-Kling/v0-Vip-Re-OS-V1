---
description: Verify Supabase env, clients, and MCP server are correctly configured
allowed-tools: Read, Bash, Grep, Glob
---

Run a Supabase setup health check for this repo. Do not modify code — report only.

Check and report on:
1. **Env vars** — are these present (in the environment or an env file)?
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (secret, server only)
   - `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` (for the MCP server)
   Report which are set vs. missing. NEVER print secret values — only whether
   each is present.
2. **Clients** — confirm `lib/supabase/client.ts`, `server.ts`, and `service.ts`
   exist and are imported correctly across the app. Flag any client component
   importing the service client (a security problem).
3. **RLS** — confirm `supabase/rls-governance/` policies exist and note whether
   the apply script (`011-apply-all-policies.sql`) is present.
4. **MCP server** — confirm the bundled Supabase MCP server can run
   (`npx -y @supabase/mcp-server-supabase@latest --help` succeeds) and that its
   required env vars are set.
5. **CLI** — report whether the Supabase CLI is available
   (`npx supabase --version`).

End with a short checklist of what's ready and what needs attention.
