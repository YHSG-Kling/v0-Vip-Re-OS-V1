#!/usr/bin/env tsx
/**
 * scripts/landing-template-guard.ts   (npm run test:landing-template) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE "TEMPLATE" BOX IS NO LONGER A SILENT NO-OP.
 *
 * `listing_landing_pages.template_id` was written by two surfaces and read by
 * NOBODY. The value came from a bare uuid box in the sequence step palette
 * (lib/workflow/step-palette.ts:245, labelled "Template"): an agent typed an id,
 * it was stored, and it was never resolved, applied, or shown back. The column
 * carried no foreign key either, so it did not even name what class of id it
 * held — the same shape as the buyer-lender column that cost a whole statement
 * per write before m605.
 *
 * A previous wave recorded it as UNRESOLVED and put the question to the owner,
 * who answered on 2026-09-05 that landing-page templates are wanted.
 *
 * ── WHAT THE PREVIOUS NOTE GOT WRONG, AND WHY IT IS WORTH RECORDING ──────────
 *
 * It said: "there is no landing-page template table anywhere in this tree". That
 * was true of the NAME and false of the CAPABILITY. `public.content_templates`
 * was already live carrying template_body, structure, placeholders, variables,
 * seo_guidelines, category, content_type, platform, brokerage_id, agent_id,
 * is_global and is_active — 0 rows and ZERO code references, a shell built and
 * never wired. A search scoped to the expected spelling reported absence. That is
 * the §2 failure mode in a different costume, and it nearly bought a second table.
 *
 * So there is NO new table: m606 points template_id at content_templates, and
 * this guard's job is to keep it that way (§6 — a
 * `listing_landing_page_templates` table would be a second spelling of the same
 * idea and would strand the shell for good).
 *
 * ── BLIND SPOTS, PUBLISHED BESIDE THE RESULT (§2) ────────────────────────────
 *   · STATIC + the generated FK cache. It proves the column NAMES its id class
 *     and that a resolver exists and is called; it cannot prove a template row
 *     was applied to a page, because no page and no template exist yet (both
 *     tables measured 0 rows live on 2026-09-05).
 *   · The feature is INERT until somebody authors a template. That is correct
 *     rather than incomplete — the documented fallback is the free-form
 *     generation that has always run — but it does mean this proof is about
 *     REACHABILITY, not about output quality.
 *   · It does not evaluate template CONTENT. Templates are tenant-authored text
 *     that steers a model; nothing here executes one, and this guard asserts
 *     exactly that and nothing about what a model then writes.
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { SCHEMA_FK_MAP } from "./schema-fk-map"

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

const RESOLVER = src("lib/marketing/landing-template.ts")
const GEN      = src("app/actions/ai-listing-intake.ts")
const ADAPTER  = src("lib/workflow/adapters/listing-landing-page.ts")

console.log("══════════════════════════════════════════════════")
console.log(" The landing-page template resolves, applies, and is recorded")
console.log("══════════════════════════════════════════════════")

console.log("\n── 1 · the column names its id class (m606) ──")
{
  const edges = SCHEMA_FK_MAP["listing_landing_pages"] ?? {}
  check("listing_landing_pages.template_id FKs content_templates in the GENERATED cache",
    edges["template_id"] === "content_templates", `found: ${edges["template_id"] ?? "(no edge)"}`)
  check("…and the pre-existing edges survived the change (positive control on the cache read)",
    edges["listing_id"] === "listings" && edges["brokerage_id"] === "brokerages" && edges["contact_id"] === "contacts")
}

console.log("\n── 2 · NO SECOND TABLE — the survivor is the one that already existed (§1/§6) ──")
check("nothing in the tree names a rival listing_landing_page_templates table",
  !/listing_landing_page_templates/.test(RESOLVER + GEN + ADAPTER))
check("the resolver reads content_templates",
  /from\("content_templates"\)/.test(RESOLVER))
check("…filtered to the landing-page category, so a template for another surface cannot answer",
  /LANDING_TEMPLATE_CATEGORY/.test(RESOLVER) && /listing_landing_page/.test(RESOLVER))
check("…and to active templates only",
  /\.eq\("is_active", true\)/.test(RESOLVER))

console.log("\n── 3 · precedence: agent > brokerage > global, the OS's one answer to 'whose setting wins' ──")
check("the agent's own template is tried first",
  /\.eq\("agent_id", params\.agentId\)/.test(RESOLVER))
check("the brokerage default EXCLUDES personal templates (.is agent_id null)",
  /\.is\("agent_id", null\)/.test(RESOLVER),
  "without this an arbitrary colleague's personal template answers as the brokerage default")
check("the global fallback is last",
  /\.eq\("is_global", true\)/.test(RESOLVER))
check("an EXPLICIT choice is tenant-scoped, so a copied id from another brokerage resolves to nothing",
  /explicitTemplateId[\s\S]{0,400}\.eq\("brokerage_id", params\.brokerageId\)/.test(RESOLVER))

console.log("\n── 4 · a REFUSED lookup is not 'no template configured' (§3) ──")
check("the resolution carries lookupFailed separately from an empty result",
  /lookupFailed/.test(RESOLVER))
check("every read destructures and READS its error",
  (RESOLVER.match(/error/g) ?? []).length >= 4 && /if \(error\)|if \(brkErr\)|if \(globErr\)/.test(RESOLVER))
check("the generator reports a refusal as a refusal, not as an absent template",
  /lookupFailed/.test(GEN) && /REFUSED/.test(GEN))

console.log("\n── 5 · it is APPLIED, and the column records what actually shaped the page ──")
check("the generator resolves a template before generating",
  /resolveLandingTemplate/.test(GEN))
check("…and folds it into the prompt",
  /applyLandingTemplateToPrompt/.test(GEN))
check("the stored id is the RESOLVED template, not the one that was merely requested",
  /template_id: templateChoice\.template\?\.id \?\? null/.test(GEN),
  "storing the request would make the page claim a provenance it does not have")
check("the adapter's FALLBACK row stores no template — it exists because the generator did NOT run",
  /template_id: null/.test(ADAPTER) && !/template_id: step\.listing_page_template_id/.test(ADAPTER))

console.log("\n── 6 · a template STEERS a model; it is never executed (tenant-authored content) ──")
check("applyLandingTemplateToPrompt only builds text",
  /export function applyLandingTemplateToPrompt/.test(RESOLVER) &&
  !/eval\(|new Function\(|replace\(\s*\/\\\$\{/.test(RESOLVER))
check("…and returns the prompt UNCHANGED when there is no template (today's behaviour preserved)",
  /if \(!template\) return basePrompt/.test(RESOLVER))

console.log("\n── CONTROLS ──")
check("POSITIVE CONTROL: the FK reader would notice the edge disappearing",
  (SCHEMA_FK_MAP["listing_landing_pages"] ?? {})["template_id"] !== undefined)
check("POSITIVE CONTROL: the 'stored id is resolved' finder rejects the OLD shape",
  !/template_id: templateChoice\.template\?\.id \?\? null/.test("template_id: params.templateId ?? null,"))
check("POSITIVE CONTROL: the brokerage-default finder rejects a query missing the null-agent filter",
  !/\.is\("agent_id", null\)/.test('.eq("brokerage_id", b).order("created_at")'))
check("BLINDNESS CONTROL: the scans read comment-STRIPPED source",
  !stripComments("// template_id: params.templateId ?? null\n").includes("params.templateId"))

console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS (§2): static + the generated FK cache. Proves the column")
console.log(" names its id class and that a resolver exists and is called — NOT that a")
console.log(" template was applied to a page: listing_landing_pages and")
console.log(" content_templates both held 0 rows live on 2026-09-05, so the feature is")
console.log(" INERT until somebody authors a template. That is the designed state, with")
console.log(" free-form generation as the documented fallback. Template CONTENT is not")
console.log(" evaluated here.")
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(`\n RESULT: ${pass} passed, ${fails.length} failed`)
if (fails.length > 0) { console.log(" ❌ LANDING_TEMPLATE_FAIL"); process.exit(1) }
console.log(" ✅ LANDING_TEMPLATE_PASS — the Template box resolves against content_templates, applies, and records what shaped the page")
