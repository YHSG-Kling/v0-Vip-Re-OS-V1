---
description: Regenerate TypeScript types from the Supabase/Postgres schema
argument-hint: "[optional output path]"
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

Regenerate Supabase TypeScript types. Optional output path: **$ARGUMENTS**

Steps:
1. Locate where generated DB types currently live (check `types/`, `types.ts`,
   `lib/`, and any existing `database.types.ts`). Reuse the existing location and
   export style unless an output path was given above.
2. Generate types with the Supabase CLI. Prefer the project ref form:
   `npx supabase gen types typescript --project-id "$SUPABASE_PROJECT_REF" --schema public`
   If the repo runs a local Supabase stack instead, use
   `npx supabase gen types typescript --local --schema public`.
   Requires `SUPABASE_ACCESS_TOKEN` (for the project-ref form) to be set.
3. Write the output to the existing types file. Do not hand-edit generated types.
4. Run the type checker / build if quick (e.g. `pnpm tsc --noEmit` or the repo's
   typecheck script) and report any new type errors the regeneration surfaced.
5. Summarize what tables/columns changed in the generated output.

If the CLI cannot reach the project (missing token/ref), tell me exactly which
env var is missing rather than guessing.
