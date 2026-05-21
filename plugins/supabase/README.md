# Supabase plugin for Claude Code

A Supabase development toolkit for the **VIP Real Estate OS** project. Bundles
slash commands, a specialized agent, a conventions skill, and the official
Supabase MCP server.

## What's included

### Slash commands (`/supabase:*`)
- `/supabase:migration <change>` — author/review a migration following repo conventions.
- `/supabase:rls <table or goal>` — author or audit RLS policies per the governance model.
- `/supabase:types [output path]` — regenerate TypeScript types from the schema.
- `/supabase:seed <what to seed>` — create RLS-aware seed data for local dev.
- `/supabase:setup` — health-check env vars, clients, RLS, and the MCP server.

### Agent
- `supabase-expert` — security-first expert in this repo's clients, RLS
  governance, migrations, and types. Claude delegates database/access-control
  work to it automatically.

### Skill
- `supabase-conventions` — which client to use (browser/server/service), the RLS
  model, env vars, query patterns, migrations, and type generation.

### MCP server
- The official `@supabase/mcp-server-supabase` (read-only by default), letting
  Claude inspect your project directly.

## Required environment variables

App (already used by the repo):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (secret — server only)

MCP server (set these to enable it):
- `SUPABASE_ACCESS_TOKEN` — personal access token from the Supabase dashboard.
- `SUPABASE_PROJECT_REF` — your project ref (the subdomain of the project URL).

The MCP server runs with `--read-only`. Remove that flag in `.mcp.json` only if
you intentionally want Claude to be able to write to the project.

## Installing

This repo ships a marketplace at `.claude-plugin/marketplace.json`. Add it and
install the plugin:

```
/plugin marketplace add ./
/plugin install supabase@vip-re-os-marketplace
```

(Or point the marketplace command at this repo's path/URL from another project.)
