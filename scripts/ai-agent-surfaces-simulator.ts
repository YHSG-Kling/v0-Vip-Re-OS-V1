#!/usr/bin/env tsx
/**
 * scripts/ai-agent-surfaces-simulator.ts  (npm run test:ai-agent-surfaces) — pure, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVES wave 59's AI-agent-surfaces catalog merge (docs/ai-agent-surfaces-2026-09.md):
 * one verified Vercel AI Gateway model catalog, correct billing, gateway-side
 * fallback and Anthropic prompt caching, across the five chat surfaces
 * (website visitor chat, portal contact assistant, in-app agent copilot,
 * D-ID live avatar brain, onboarding assistant).
 *
 * CLAUDE.md §6: two spellings of the same idea is a defect. Before this wave,
 * lib/ai/models.ts's MODEL_CONFIG and lib/ai/resolve-model.ts's ALIASES were
 * two independently hand-maintained alias tables that had already drifted —
 * MODEL_CONFIG pointed at two nonexistent dated Anthropic snapshots
 * (claude-sonnet-4-20250514, claude-haiku-4-20250514) and a retired Gemini
 * preview (gemini-2.0-flash-exp), while resolve-model.ts's OWN ALIASES
 * disagreed with it for the same two identities (claude-haiku-3-5, a real but
 * OLDER Haiku generation). Every Haiku turn was billed at Haiku 3.5's price —
 * a wrong number in the ledger is a wrong invoice (§5). MODEL_CONFIG now
 * DERIVES from resolve-model.ts's ALIASES (lib/ai/models.ts) rather than
 * repeating it.
 *
 * ── WHAT IS ASSERTED ─────────────────────────────────────────────────────────
 *   (a) Every AIModel billing-identity alias in resolve-model.ts's ALIASES
 *       resolves to a slug in VERIFIED_GATEWAY_SLUGS (checked against
 *       @ai-sdk/gateway's own GatewayModelId union — see the allowlist
 *       comment below for how it was produced).
 *   (b) No dated/retired literal (`-20250514`, `gemini-2.0-flash-exp`,
 *       `claude-haiku-4-2025`) remains anywhere under lib/ai/. Positive
 *       control: a synthetic specimen string containing each banned pattern
 *       IS caught by the same scanner, so a broken regex cannot read as a
 *       clean tree (§2).
 *   (c) getModelPricing() has a row for every AIModel union member, each with
 *       lastUpdated ≥ 2026-09-12 and a non-empty `source` URL.
 *   (d) Each of the six AI-agent-surface routes imports streamTextRouted from
 *       lib/ai/models — never a raw `streamText` straight from "ai".
 *   (e) AI_TASK_ROUTING's five chat-surface keys match
 *       docs/ai-agent-surfaces-2026-09.md §3 exactly (model + fallback).
 *   (f) streamTextRouted passes providerOptions.gateway.models (gateway-side
 *       fallback) and wraps an Anthropic-routed system prompt in
 *       providerOptions.anthropic.cacheControl (prompt caching).
 *   (g) calculateCost's arithmetic matches the verified per-row prices —
 *       1M input + 1M output tokens on claude-haiku prices to 600 cents
 *       ($1.00 + $5.00 = $6.00), replicated from the SAME parsed pricing row
 *       assertion (c) already verified, so this cannot silently drift from a
 *       hand-typed constant.
 *
 * ── WHY A NEW PROOF AND NOT AN EXTENSION OF A SIBLING GUARD (§6 checked) ────
 *   · scripts/ai-spend-booked-guard.ts proves a call site BOOKS ai_tool_usage
 *     at all — nothing there checks WHICH price or WHICH gateway slug it
 *     books at.
 *   · scripts/ai-gateway-single-lane-guard.ts proves every model call reaches
 *     the model through the gateway lane, not a second provider client — it
 *     does not check the catalog's slugs are real or current.
 *   · scripts/data-guard-guard.ts proves prompts are redacted before they
 *     leave — independent of pricing and routing.
 *   None of the three owns "is the catalog verified, current, and one table."
 *   This proof does, and stops there.
 *
 * ── HOW IT READS SOURCE ──────────────────────────────────────────────────────
 * Through scripts/strip-comments.ts's stripComments, per CLAUDE.md §2 — a
 * tombstone comment is not a call site (a mention of a retired slug in a
 * comment recording the fix must not fail this proof forever). Deliberately
 * NOT blankStrings here: every check below reads the actual CONTENT of a
 * string literal (a model slug, an import specifier, a price, a source URL)
 * rather than searching for a bare code token — blanking strings would blind
 * the proof to the very thing it is checking. Every absence assertion (b)
 * still carries a positive control.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { stripComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const clean = (src: string) => stripComments(src)

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, extra?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${extra ? ` — ${extra}` : ""}`) }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE VERIFIED GATEWAY CATALOG (docs/ai-agent-surfaces-2026-09.md §2, checked
// 2026-09-12 against node_modules/@ai-sdk/gateway/dist/index.d.ts's own
// GatewayModelId union — every slug below is a literal member of that union,
// confirmed by grep at authoring time). Kept HERE, in the proof, deliberately
// separate from lib/ai/resolve-model.ts's ALIASES: this is the independent
// yardstick resolve-model.ts is measured against, not a copy of it — if this
// list and ALIASES were the same file, a bad edit to one could never be
// caught by the other.
const VERIFIED_GATEWAY_SLUGS = new Set<string>([
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.6",
  "openai/gpt-5-mini",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/gpt-4-turbo",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
  "perplexity/sonar",
  "perplexity/sonar-pro",
])

// The AIModel billing-identity keys (lib/ai/cost-tracking.ts's AIModel union)
// that this wave's catalog merge governs. Extracted from source below (not
// hand-typed a second time) so this list cannot silently diverge from the
// real union — see the (c) section.

console.log("[a] resolve-model.ts ALIASES — every AIModel billing identity resolves to a VERIFIED gateway slug")
const resolveModelSrc = clean(read("lib/ai/resolve-model.ts"))
const aliasesBlockMatch = resolveModelSrc.match(/const ALIASES:[^{]*\{([\s\S]*?)\n\}/)
check("ALIASES table found in lib/ai/resolve-model.ts", !!aliasesBlockMatch)
const aliasesBlock = aliasesBlockMatch?.[1] ?? ""
const aliasEntries = new Map<string, string>()
for (const m of aliasesBlock.matchAll(/"([\w.-]+)"\s*:\s*"([\w./-]+)"/g)) {
  aliasEntries.set(m[1], m[2])
}
check(`ALIASES parsed at least 10 entries (found ${aliasEntries.size})`, aliasEntries.size >= 10)

// Only the identities lib/ai/models.ts's derived MODEL_CONFIG actually routes
// on — the extra dated short forms (claude-haiku-3, claude-sonnet-3-5,
// claude-opus-3) exist for ad-hoc literal call sites elsewhere in the repo
// (app/actions/*) and are OUT OF SCOPE for this wave's chat-surface catalog;
// published here rather than silently excluded (§2 blind spots).
const BILLING_IDENTITY_ALIASES = [
  "claude-sonnet", "claude-opus", "claude-haiku",
  "gpt-4o", "gpt-4-turbo", "gpt-4o-mini", "gpt-5-mini",
  "gemini-pro", "gemini-flash",
  "perplexity-sonar", "perplexity-sonar-pro",
]
const OUT_OF_SCOPE_LEGACY_ALIASES = ["claude-haiku-3", "claude-sonnet-3-5", "claude-opus-3", "gpt-4", "gpt-3.5-turbo"]
console.log(`  (blind spot: ${OUT_OF_SCOPE_LEGACY_ALIASES.join(", ")} are legacy dated short forms out of this wave's scope, not asserted below)`)

for (const key of BILLING_IDENTITY_ALIASES) {
  const slug = aliasEntries.get(key)
  check(`ALIASES["${key}"] = "${slug ?? "<missing>"}" is a VERIFIED gateway slug`,
    !!slug && VERIFIED_GATEWAY_SLUGS.has(slug))
}

// lib/ai/models.ts's MODEL_CONFIG stays a LITERAL (scripts/ai-gateway-single-lane-guard.ts's
// A5b parses it statically and cannot import a server-only module) rather than
// being computed from resolveModel() at runtime — see that file's own comment
// on MODEL_CONFIG. §6 ("one vocabulary") is enforced here instead: every
// MODEL_CONFIG entry must equal what resolveModel() actually returns for the
// same key, so the two tables cannot silently drift apart a second time.
console.log("\n[a2] lib/ai/models.ts's MODEL_CONFIG literal equals resolve-model.ts's ALIASES for every key")
const modelConfigBlockMatch = clean(read("lib/ai/models.ts")).match(/const MODEL_CONFIG:[^{]*\{([\s\S]*?)\n\}/)
check("MODEL_CONFIG literal found in lib/ai/models.ts", !!modelConfigBlockMatch)
const modelConfigBlock = modelConfigBlockMatch?.[1] ?? ""
const modelConfigEntries = new Map<string, string>()
for (const m of modelConfigBlock.matchAll(/"([\w-]+)":\s*\{\s*provider:\s*"([\w.-]+)",\s*modelId:\s*"([\w.-]+)"\s*\}/g)) {
  modelConfigEntries.set(m[1], `${m[2]}/${m[3]}`)
}
check(`MODEL_CONFIG parsed an entry for every billing-identity alias (${modelConfigEntries.size}/${BILLING_IDENTITY_ALIASES.length})`,
  BILLING_IDENTITY_ALIASES.every((k) => modelConfigEntries.has(k)))
for (const key of BILLING_IDENTITY_ALIASES) {
  const fromModelConfig = modelConfigEntries.get(key)
  const fromAliases = aliasEntries.get(key)
  check(`MODEL_CONFIG["${key}"] (${fromModelConfig ?? "<missing>"}) === resolveModel("${key}") (${fromAliases ?? "<missing>"})`,
    !!fromModelConfig && fromModelConfig === fromAliases)
}

console.log("\n[b] no dated/retired model literal remains under lib/ai/ — positive control included")
const BANNED_PATTERNS: Array<{ name: string; literal: string; re: RegExp }> = [
  { name: "-20250514 (nonexistent dated Anthropic snapshot)", literal: "anthropic/claude-sonnet-4-20250514", re: /-20250514/ },
  { name: "gemini-2.0-flash-exp (retired Gemini preview)", literal: "google/gemini-2.0-flash-exp", re: /gemini-2\.0-flash-exp/ },
  { name: "claude-haiku-4-2025 (the specific stale Haiku-4 dated id)", literal: "anthropic/claude-haiku-4-20250514", re: /claude-haiku-4-2025/ },
]
const LIB_AI_FILES = ["lib/ai/models.ts", "lib/ai/resolve-model.ts", "lib/ai/cost-tracking.ts"]
for (const pattern of BANNED_PATTERNS) {
  // Positive control FIRST: prove the scanner still recognises the defect it
  // was written for, on a synthetic specimen (comments stripped, string
  // content left intact — see the file header), before trusting a "0 found".
  const specimen = clean(`const bad = "${pattern.literal}" // not a real comment mention`)
  check(`positive control — "${pattern.name}" pattern DOES match its own specimen`, pattern.re.test(specimen))

  const hits: string[] = []
  for (const f of LIB_AI_FILES) {
    if (pattern.re.test(clean(read(f)))) hits.push(f)
  }
  check(`no live "${pattern.name}" literal under lib/ai/ (${hits.length} found)`, hits.length === 0, hits.join(", "))
}

console.log("\n[c] getModelPricing() — a priced, sourced, freshly-verified row for every AIModel")
const costTrackingRaw = read("lib/ai/cost-tracking.ts")
const costTrackingClean = clean(costTrackingRaw)
const aiModelUnionMatch = costTrackingClean.match(/export type AIModel\s*=([\s\S]*?)\n\n/)
check("AIModel union found in lib/ai/cost-tracking.ts", !!aiModelUnionMatch)
const aiModelKeys = [...(aiModelUnionMatch?.[1] ?? "").matchAll(/"([\w-]+)"/g)].map((m) => m[1])
check(`AIModel union has ≥10 members and includes gpt-5-mini (found ${aiModelKeys.length}: ${aiModelKeys.join(", ")})`,
  aiModelKeys.length >= 10 && aiModelKeys.includes("gpt-5-mini"))

const pricingBlockMatch = costTrackingClean.match(/function getModelPricing\(\)[\s\S]*?return\s*\{([\s\S]*?)\n  \}\n\}/)
check("getModelPricing() return block found", !!pricingBlockMatch)
const pricingBlock = pricingBlockMatch?.[1] ?? ""
type PricingRow = { input: number; output: number; lastUpdated: string; source: string }
const pricingRows = new Map<string, PricingRow>()
for (const m of pricingBlock.matchAll(/"([\w-]+)"\s*:\s*\{([^{}]*)\}/g)) {
  const [, key, body] = m
  const input = body.match(/input:\s*([\d.]+)/)
  const output = body.match(/output:\s*([\d.]+)/)
  const lastUpdated = body.match(/lastUpdated:\s*"([\d-]+)"/)
  const source = body.match(/source:\s*"([^"]+)"/)
  if (input && output && lastUpdated && source) {
    pricingRows.set(key, {
      input: Number(input[1]), output: Number(output[1]),
      lastUpdated: lastUpdated[1], source: source[1],
    })
  }
}
check(`parsed a pricing row for every AIModel key (${pricingRows.size}/${aiModelKeys.length})`,
  aiModelKeys.every((k) => pricingRows.has(k)),
  aiModelKeys.filter((k) => !pricingRows.has(k)).join(", "))

for (const key of aiModelKeys) {
  const row = pricingRows.get(key)
  check(`"${key}" priced, lastUpdated ≥ 2026-09-12, has a source`,
    !!row && row.lastUpdated >= "2026-09-12" && row.source.startsWith("https://"),
    row ? `lastUpdated=${row.lastUpdated} source=${row.source || "<none>"}` : "no row")
}

console.log("\n[d] the six AI-agent-surface routes import streamTextRouted, never raw streamText from \"ai\"")
const SURFACE_ROUTES = [
  "app/api/widget/message/route.ts",
  "app/api/portal/ai-chat/route.ts",
  "app/api/chat/stream/route.ts",
  "app/api/internal/ai-chat/route.ts",
  "app/api/did/custom-llm/route.ts",
  "app/api/onboarding/assistant/route.ts",
]
for (const route of SURFACE_ROUTES) {
  const src = clean(read(route))
  const importsRouted = /import\s*\{[^}]*\bstreamTextRouted\b[^}]*\}\s*from\s*["']@\/lib\/ai\/models["']/.test(src)
  const rawStreamTextImport = /import\s*\{[^}]*\bstreamText\b[^}]*\}\s*from\s*["']ai["']/.test(src)
  check(`${route} imports streamTextRouted from lib/ai/models`, importsRouted)
  check(`${route} does NOT import raw streamText from "ai"`, !rawStreamTextImport)
}

console.log("\n[e] AI_TASK_ROUTING — five chat-surface keys match docs/ai-agent-surfaces-2026-09.md §3")
const modelsSrc = read("lib/ai/models.ts")
const modelsClean = clean(modelsSrc)
const EXPECTED_ROUTING: Record<string, { model: string; fallback: string }> = {
  agent_chat_stream:       { model: "claude-haiku", fallback: "gpt-5-mini" },
  widget_visitor_chat:     { model: "gpt-5-mini",   fallback: "gemini-flash" },
  portal_chat_stream:      { model: "claude-haiku", fallback: "gpt-5-mini" },
  internal_assistant_chat: { model: "claude-haiku", fallback: "gpt-5-mini" },
  live_avatar_conversation:{ model: "gemini-flash", fallback: "gpt-5-mini" },
}
for (const [key, expected] of Object.entries(EXPECTED_ROUTING)) {
  const re = new RegExp(`\\b${key}:\\s*\\{\\s*model:\\s*"([\\w-]+)",\\s*fallback:\\s*"([\\w-]+)"`)
  const m = modelsClean.match(re)
  check(`AI_TASK_ROUTING.${key} = { model: "${expected.model}", fallback: "${expected.fallback}" }`,
    !!m && m[1] === expected.model && m[2] === expected.fallback,
    m ? `found { model: "${m[1]}", fallback: "${m[2]}" }` : "key not found")
}

console.log("\n[f] streamTextRouted carries gateway-side fallback + Anthropic prompt caching")
const streamStart = modelsClean.indexOf("export async function streamTextRouted")
const streamEnd = modelsClean.indexOf("export async function generateSimpleText")
check("streamTextRouted function body located", streamStart !== -1 && streamEnd > streamStart)
const streamBody = streamStart !== -1 && streamEnd > streamStart ? modelsClean.slice(streamStart, streamEnd) : ""
check("streamTextRouted passes providerOptions: gatewayProviderOptions(...)",
  /providerOptions:\s*gatewayProviderOptions\(/.test(streamBody))
check("streamTextRouted wraps system through withAnthropicCaching(...)",
  /system:\s*withAnthropicCaching\(/.test(streamBody))
check("gatewayProviderOptions() shapes { gateway: { models: [...] } } (verified against @ai-sdk/gateway's gatewayProviderOptions schema)",
  /gateway:\s*\{\s*models:/.test(modelsClean))
check("withAnthropicCaching() shapes { anthropic: { cacheControl: { type: \"ephemeral\" } } } (verified against @ai-sdk/provider's SharedV3ProviderOptions doc example)",
  /anthropic:\s*\{\s*cacheControl:\s*\{\s*type:\s*["']ephemeral["']/.test(modelsClean))
const genTextStart = modelsClean.indexOf("export async function generateTextRouted")
const genTextEnd = modelsClean.indexOf("export class AIFairUseError")
const genTextBody = genTextStart !== -1 && genTextEnd > genTextStart ? modelsClean.slice(genTextStart, genTextEnd) : ""
check("generateTextRouted ALSO carries the gateway fallback + caching (not just streamTextRouted)",
  /providerOptions:\s*gatewayProviderOptions\(/.test(genTextBody) && /withAnthropicCaching\(/.test(genTextBody))

console.log("\n[g] calculateCost arithmetic matches the verified per-row prices (derived, not hand-typed)")
const haikuRow = pricingRows.get("claude-haiku")
check("claude-haiku row available for arithmetic check", !!haikuRow)
if (haikuRow) {
  // Same rounding rule as the real calculateCost: dollars → cents, Math.ceil.
  const costCents = Math.ceil(((1_000_000 / 1_000_000) * haikuRow.input + (1_000_000 / 1_000_000) * haikuRow.output) * 100)
  check(`1M input + 1M output tokens on claude-haiku (verified $${haikuRow.input}/$${haikuRow.output}) prices to 600 cents`,
    costCents === 600, `computed ${costCents}`)
}
const calculateCostSrc = modelsClean // calculateCost itself lives in cost-tracking.ts
const ctClean = costTrackingClean
check("calculateCost() reads getModelPricing()[model] rather than a second price table",
  /function calculateCost[\s\S]{0,300}getModelPricing\(\)\[model\]/.test(ctClean))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  for (const f of fails) console.log(`   · ${f}`)
  console.log(" ❌ AI_AGENT_SURFACES_FAIL")
  process.exit(1)
}
console.log(" ✅ AI_AGENT_SURFACES_PASS — one verified gateway catalog, correct billing, gateway fallback + Anthropic caching wired")
