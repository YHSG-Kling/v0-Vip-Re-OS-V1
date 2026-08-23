#!/usr/bin/env tsx
/**
 * scripts/fb-audience-templates-simulator.ts  (npm run test:fb-audience-templates) — pure, no DB, no mocks.
 *
 * Proves the prebuilt Facebook/Meta audience template catalog
 * (lib/ads/fb-audience-templates.ts) and its server-action accessors
 * (app/actions/fb-audience-templates.ts):
 *   • listAudienceTemplates() returns the full static catalog with valid shape
 *   • resolveAudienceTemplate(id) finds a known template and maps it to
 *     create-audience params; returns null for an unknown id
 *   • every template carries a valid category and a non-empty consent basis
 *     (consent is legally required before any audience can be created)
 */
import {
  FB_AUDIENCE_TEMPLATES,
  findAudienceTemplate,
  type AudienceTemplate,
} from "../lib/ads/fb-audience-templates"
import {
  listAudienceTemplates,
  resolveAudienceTemplate,
} from "../app/actions/fb-audience-templates"

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

  console.log("\n[resolveAudienceTemplate — find by id]")
  const knownId = "qualified_leads_remarketing"
  const knownTpl = findAudienceTemplate(knownId)
  check("catalog contains the known seed id", knownTpl !== undefined)

  const resolved = await resolveAudienceTemplate(knownId)
  check("resolves a known id to non-null params", resolved !== null)
  check("resolved audienceName matches the template name",
    resolved?.audienceName === knownTpl?.name)
  check("resolved audienceType matches the template",
    resolved?.audienceType === knownTpl?.audienceType)
  check("resolved sourceRule is the template's sourceRule (type preserved)",
    resolved?.sourceRule.type === knownTpl?.sourceRule.type)
  check("resolved consentBasis matches the template",
    resolved?.consentBasis === knownTpl?.consentBasis)

  console.log("\n[resolveAudienceTemplate — unknown id]")
  const missing = await resolveAudienceTemplate("does_not_exist_xyz")
  check("returns null for an unknown id", missing === null)
  check("findAudienceTemplate returns undefined for an unknown id",
    findAudienceTemplate("does_not_exist_xyz") === undefined)

  console.log("\n[resolve round-trips every template id]")
  let allResolve = true
  for (const t of templates) {
    const r = await resolveAudienceTemplate(t.id)
    if (!r || r.sourceRule.type !== t.sourceRule.type || r.audienceType !== t.audienceType) {
      allResolve = false
      break
    }
  }
  check("every catalog id resolves with a matching sourceRule + type", allResolve)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ FB_AUDIENCE_TEMPLATES_PASS — catalog lists + resolves; unknown ids return null")
}

main().catch((err) => { console.error(err); process.exit(1) })
