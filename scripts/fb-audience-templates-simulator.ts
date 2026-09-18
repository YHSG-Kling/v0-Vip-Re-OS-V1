#!/usr/bin/env tsx
/**
 * scripts/fb-audience-templates-simulator.ts  (npm run test:fb-audience-templates) — pure, no DB, no mocks.
 *
 * Proves the prebuilt Facebook/Meta audience template catalog
 * (lib/ads/fb-audience-templates.ts) and its server-action accessors
 * (app/actions/fb-audience-templates.ts):
 *   • listAudienceTemplates() returns the full static catalog with valid shape
 *   • findAudienceTemplate(id) finds a known template (the pure lookup the
 *     Ads dashboard's "Use template" path maps into createAudience params —
 *     ads-dashboard-client.tsx handleUseTemplate); returns undefined for an
 *     unknown id. (The server action resolveAudienceTemplate that wrapped it
 *     was deleted 2026-09-03 onto that client mapping — lane L6 tombstone in
 *     app/actions/fb-audience-templates.ts.)
 *   • every template carries a valid category and a non-empty consent basis
 *     (consent is legally required before any audience can be created)
 */
import {
  FB_AUDIENCE_TEMPLATES,
  findAudienceTemplate,
  type AudienceTemplate,
} from "../lib/ads/fb-audience-templates"
import { listAudienceTemplates } from "../app/actions/fb-audience-templates"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`) }
}

// "exclusion" WAS A MEMBER. It is gone with the union member it mirrored —
// SURVIVOR: `templateAudienceUse(t)` (lib/ads/fb-audience-templates.ts), derived
// from the source rule. The category was a second spelling of exclusion intent
// and it had already drifted: `exclude_lifetime_customers` claimed the category
// while its rule type said inclusion. A stale member here would keep passing
// forever, since this list only ever ADMITS.
const VALID_CATEGORIES: AudienceTemplate["category"][] = [
  "remarketing", "lookalike", "geo", "lifecycle",
  // The owner's persona basis ("audience should be segmented on persona"). The
  // catalog now DERIVES one template per ads-eligible persona; without this member
  // every one of them would fail the valid-category check above.
  "persona",
]

async function main() {
  console.log("\n[listAudienceTemplates — full catalog]")
  const templates = await listAudienceTemplates()
  check("returns a non-empty array", Array.isArray(templates) && templates.length > 0)
  check("returns exactly the catalog constant length",
    templates.length === FB_AUDIENCE_TEMPLATES.length)
  check("template ids are unique",
    new Set(templates.map((t) => t.id)).size === templates.length)
  check("every template has a non-empty name + description",
    templates.every((t) => t.name.trim().length > 0 && t.description.trim().length > 0))
  check("every template has a valid category",
    templates.every((t) => VALID_CATEGORIES.includes(t.category)))
  check("every template carries a non-empty consent basis (legally required)",
    templates.every((t) => t.consentBasis.trim().length > 0))
  check("every template has a sourceRule with a type + filters object",
    templates.every((t) => typeof t.sourceRule.type === "string" && typeof t.sourceRule.filters === "object"))
  check("every template has an estimatedSizeLabel",
    templates.every((t) => t.estimatedSizeLabel.trim().length > 0))

  console.log("\n[findAudienceTemplate — find by id (the lookup the Use-template path maps into createAudience)]")
  const knownId = "qualified_leads_remarketing"
  const knownTpl = findAudienceTemplate(knownId)
  check("catalog contains the known seed id", knownTpl !== undefined)
  check("the found template carries every field the client mapping sends to createAudience",
    !!knownTpl && typeof knownTpl.name === "string" && knownTpl.name.trim().length > 0
    && typeof knownTpl.audienceType === "string"
    && typeof knownTpl.sourceRule?.type === "string"
    && typeof knownTpl.consentBasis === "string" && knownTpl.consentBasis.trim().length > 0)
  check("the found template is the catalog's own object (identity, not a copy that could drift)",
    !!knownTpl && templates.includes(knownTpl))

  console.log("\n[findAudienceTemplate — unknown id]")
  check("findAudienceTemplate returns undefined for an unknown id",
    findAudienceTemplate("does_not_exist_xyz") === undefined)

  console.log("\n[lookup round-trips every template id]")
  const allResolve = templates.every((t) => {
    const r = findAudienceTemplate(t.id)
    return !!r && r.sourceRule.type === t.sourceRule.type && r.audienceType === t.audienceType
  })
  check("every catalog id is found with a matching sourceRule + type", allResolve)

  console.log("\n[wiring — the Ads dashboard maps a template into createAudience itself (the survivor)]")
  {
    const { readFileSync } = await import("node:fs")
    const client = readFileSync("app/dashboard/campaigns/ads/ads-dashboard-client.tsx", "utf8")
    const action = readFileSync("app/actions/fb-audience-templates.ts", "utf8")
    check("handleUseTemplate carries sourceRule + audienceType + name + consentBasis off the template",
      /handleUseTemplate\s*=\s*\(template: AudienceTemplate\)/.test(client)
      && /sourceRule:\s*template\.sourceRule/.test(client)
      && /audienceType:\s*template\.audienceType/.test(client)
      && /audienceName:\s*template\.name/.test(client)
      && /consentBasis:\s*template\.consentBasis/.test(client))
    check("the deleted server-action duplicate did not come back",
      !/export\s+async\s+function\s+resolveAudienceTemplate\b/.test(action))
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ FB_AUDIENCE_TEMPLATES_PASS — catalog lists + resolves; unknown ids return null")
}

main().catch((err) => { console.error(err); process.exit(1) })
