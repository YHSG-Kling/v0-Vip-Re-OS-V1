export const migrationStatus = {
  supabaseSchema: {
    tablesCreated: 40,
    status: "complete",
    tables: [
      "users",
      "contacts",
      "leads",
      "agents",
      "listings",
      "transactions",
      "vendors",
      "copilot_plans",
      "credit_status",
      "video_engagement",
      "property_interests",
      "interaction_history",
      "journey_cards",
      "transparency_updates",
      "scripts",
      "video_assets",
      "content_marketing",
      "compliance_flags",
      "financial_records",
      "ai_tools",
      "suggestions",
      "deal_teams",
      "documents",
      "milestones",
      "listing_analytics",
    ],
  },
  supabaseService: {
    status: "complete",
    cruds: 80,
    description: "Comprehensive service with all CRUD operations for contacts, leads, listings, and more",
  },
  apiRoutes: {
    status: "complete",
    count: 25,
    description: "All API routes updated to use Supabase queries instead of Airtable",
  },
  serverActions: {
    status: "complete",
    workflows: 15,
    description: "Replaced n8n workflows with native Server Actions using Vercel AI SDK",
  },
  components: {
    status: "complete",
    updated: 37,
    description: "All pages and components migrated from airtableService to supabaseService",
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
