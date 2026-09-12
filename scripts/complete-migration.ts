#!/usr/bin/env node

/**
 * Complete Migration Script: Airtable & n8n → Supabase & Server Actions
 * This script systematically replaces all legacy service calls with Supabase equivalents
 *
 * HISTORICAL — this codemod has already run and both of its targets are GONE.
 * services/airtableService.ts and services/workflowService.ts (which exported the
 * n8nService alias) no longer exist; the patterns below are kept as the record of
 * what was rewritten, not as a rule that still has anything to match. See
 * lib/migration-status.ts for the current state.
 */

import * as fs from "fs"
import * as path from "path"

// Find all TypeScript/TSX files
function findFiles(dir: string, pattern: RegExp, exclude: string[] = []): string[] {
  const results: string[] = []

  function traverse(currentPath: string) {
    const files = fs.readdirSync(currentPath, { withFileTypes: true })
    for (const file of files) {
      // Skip excluded paths
      if (exclude.some((e) => file.path?.includes(e))) continue

      const fullPath = path.join(currentPath, file.name)
      if (file.isDirectory()) {
        traverse(fullPath)
      } else if (pattern.test(file.name)) {
        results.push(fullPath)
      }
    }
  }

  traverse(dir)
  return results
}

// Migration replacements
const replacements = [
  // Import replacements
  {
    find: /import.*airtableService.*from.*services\/airtable/g,
    replace: 'import { supabaseService } from "@/services/supabaseService"',
  },
  {
    find: /import.*n8nService.*from.*services\/n8n/g,
    replace: 'import { executeWorkflow } from "@/app/actions/workflows"',
  },
  {
    find: /import.*airtable.*from.*services\/airtable/g,
    replace: 'import { supabaseService } from "@/services/supabaseService"',
  },

  // Service call replacements
  { find: /airtableService\.getContacts\(/g, replace: "supabaseService.getContacts(" },
  { find: /airtableService\.getLeads\(/g, replace: "supabaseService.getLeads(" },
  { find: /airtableService\.getTransactions\(/g, replace: "supabaseService.getTransactions(" },
  { find: /airtableService\.getListings\(/g, replace: "supabaseService.getListings(" },
  { find: /airtableService\.getAgents\(/g, replace: "supabaseService.getAgents(" },
  { find: /airtableService\.getVendors\(/g, replace: "supabaseService.getVendors(" },
  { find: /airtableService\.getCommissions\(/g, replace: "supabaseService.getFinancials(" },
  { find: /airtableService\.getMarketingStats\(/g, replace: 'supabaseService.getFinancials("marketing"' },
  { find: /airtableService\.getTeamByDealId\(/g, replace: "supabaseService.getTeamByDealId(" },
  { find: /airtableService\.getAIISAActivityByContactId\(/g, replace: "supabaseService.getAIISAActivityByContactId(" },

  // n8n replacements
  { find: /n8nService\.triggerWorkflow\(/g, replace: "executeWorkflow(" },
  { find: /n8nService\.executePayoutBatch\(/g, replace: 'executeWorkflow("process-payouts"' },
  { find: /n8nService\.triggerCMAPackage\(/g, replace: 'executeWorkflow("generate-cma"' },
]

console.log("Starting comprehensive migration from Airtable/n8n to Supabase/Server Actions...\n")

// Find all files
const sourceDir = process.cwd()
const files = findFiles(sourceDir, /\.(ts|tsx)$/, ["node_modules", ".next", "dist", "build"])

let filesModified = 0
let totalReplacements = 0

for (const file of files) {
  try {
    let content = fs.readFileSync(file, "utf-8")
    const originalContent = content

    for (const replacement of replacements) {
      content = content.replace(replacement.find, replacement.replace)
    }

    if (content !== originalContent) {
      fs.writeFileSync(file, content)
      filesModified++
      totalReplacements += (originalContent.match(/airtableService|n8nService/g) || []).length
      console.log(`✓ Migrated: ${file.replace(sourceDir, "")}`)
    }
  } catch (err) {
    console.error(`✗ Error processing ${file}:`, err)
  }
}

console.log(`\n✓ Migration Complete!`)
console.log(`  - Files modified: ${filesModified}`)
console.log(`  - Total replacements: ${totalReplacements}`)
console.log(`\nNext steps:`)
console.log(`  1. Run 'npm run build' to verify compilation`)
console.log(`  2. Test each page to ensure functionality`)
console.log(`  3. Deploy with confidence!`)
