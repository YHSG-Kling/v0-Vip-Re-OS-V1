/**
 * lib/migration-status.ts — the AIRTABLE → SUPABASE / n8n → SERVER-ACTIONS record.
 *
 * WHAT THIS IS, and what it stopped being (2026-08-29, lane K4)
 * ────────────────────────────────────────────────────────────
 * Two files point a reader here in prose —
 *   app/dashboard/superadmin/engagement/page.tsx:37  "… deleted — see lib/migration-status.ts."
 *   scripts/complete-migration.ts:11                 "… for the current state."
 * — and what they want is the narrative half below: which service was removed,
 * what its named survivor is, and the one capability that was NOT ported.
 * `verifyVendorInsurance` in particular is an OPEN PRODUCT GAP recorded nowhere
 * else, so this module is documentation with real readers, not an orphan.
 *
 * WHAT WAS DELETED FROM IT: every COUNT and every frozen list.
 *   · `supabaseSchema.tablesCreated: 40`, `status: "complete"`, and a 25-name
 *     table list. The live schema exposes 757 relations (scripts/live-tables.ts,
 *     generated 2026-08-28 from public.live_schema_json()). The claim was wrong
 *     by nearly twenty times and had been wrong for as long as nobody read it.
 *   · `supabaseService.cruds: 80`, `apiRoutes.count: 25`,
 *     `serverActions.workflows: 15`, `components.updated: 37`.
 *
 * All six are WAYPOINTS — true for one afternoon of a multi-step migration and
 * permanently false afterwards — which is the exact shape CLAUDE.md §2 forbids
 * pinning anything to, and §3's "files are not the database" besides. A
 * hand-kept count of live tables cannot be right twice.
 *
 * SURVIVOR for every schema fact: scripts/live-tables.ts `LIVE_TABLES` (and
 * scripts/schema-snapshot.ts for the queried subset) — MACHINE-WRITTEN caches of
 * the live database, regenerated with `npm run schema:regen` and held honest by
 * scripts/schema-cache-drift-guard.ts. Ask them what exists; they can answer,
 * and this file never could.
 */

export const migrationStatus = {
  /** Schema facts live in the generated cache — see the header. */
  supabaseSchema: {
    status: "complete",
    source: "scripts/live-tables.ts (LIVE_TABLES) — machine-written, npm run schema:regen",
  },
  supabaseService: {
    status: "complete",
    description: "services/supabaseService.ts carries the CRUD surface for contacts, leads, listings and the rest.",
  },
  apiRoutes: {
    status: "complete",
    description: "API routes query Supabase directly; no route reads Airtable.",
  },
  serverActions: {
    status: "complete",
    description: "n8n workflows replaced by native Server Actions on the Vercel AI SDK.",
  },
  components: {
    status: "complete",
    description: "Pages and components read supabaseService; airtableService is gone.",
  },
  airtableService: {
    status: "removed",
    action:
      "services/airtableService.ts no longer exists. All reads/writes go through services/supabaseService.ts. The only surviving mentions are in scripts/complete-migration.ts, the codemod that performed the rewrite.",
  },
  n8nService: {
    status: "removed",
    action:
      "services/workflowService.ts (which also exported the n8nService alias) has been DELETED. The named survivor is app/actions/workflows.ts — every non-stub method on the shim was a lossy 1:1 pass-through to the same-named export there (triggerCMAPackage dropped beds/baths/sqft/upgrades; several hardcoded the actor as \"system\"), and the remainder returned fabricated constants.",
    knownGap:
      "verifyVendorInsurance was the one capability with no real implementation anywhere — the shim returned complianceScore 100 / isCompliant true unconditionally. Nothing was ported because a function returning constants has no implementation to preserve. Vendor insurance verification is an open product gap.",
  },
} as const
