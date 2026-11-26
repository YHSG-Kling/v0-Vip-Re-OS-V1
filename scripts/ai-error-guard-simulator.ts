#!/usr/bin/env tsx
/**
 * scripts/ai-error-guard-simulator.ts   (npm run test:ai-error-guard)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RAW AI-GATEWAY BILLING ERROR MUST NEVER LEAK TO A USER. AI generation
 * routes through the Vercel AI Gateway; when that account is out of credits it
 * throws a raw billing error ("-1 … free plan") that used to surface verbatim in
 * a toast. friendlyAiError() maps known infra/billing/config failures to an
 * honest, actionable line while passing genuine content errors through. Proves
 * the classifier (imported, no drift) + that the social generators use it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { friendlyAiError, isAiBillingError, isAiConfigError } from "../lib/ai/ai-error"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the classifier maps infra failures + passes content errors through ──")
{
  check("negative/-1 credit balance → billing", isAiBillingError(new Error("your balance is -1 on the free plan")))
  check("'insufficient credits' → billing", isAiBillingError(new Error("Insufficient credits")))
  check("402 Payment Required → billing", isAiBillingError(new Error("402 Payment Required")))
  check("missing API key → config", isAiConfigError(new Error("Missing AI_GATEWAY_API_KEY")))
  check("401 unauthorized → config", isAiConfigError(new Error("401 unauthorized")))
  check("a real content error is NOT misclassified", !isAiBillingError(new Error("invalid JSON for schema")) && !isAiConfigError(new Error("invalid JSON for schema")))

  const billing = friendlyAiError(new Error("credits -1 free plan"))
  check("billing errors get a clean, non-leaky message (no raw '-1'/'free plan')",
    !billing.includes("-1") && !billing.toLowerCase().includes("free plan") && billing.includes("gateway"))
  check("content errors pass through unchanged", friendlyAiError(new Error("invalid JSON")) === "invalid JSON")
  check("empty/unknown error falls back safely", friendlyAiError(null, "fallback") === "fallback")
}

console.log("\n── the social generators route errors through the helper (no raw leak) ──")
{
  const s = src("app/actions/social/generate-social-post.ts")
  check("imports friendlyAiError", s.includes('from "@/lib/ai/ai-error"'))
  check("the weekly-plan + post + draft catches use friendlyAiError, not raw error.message",
    (s.match(/friendlyAiError\(error/g) ?? []).length >= 3 &&
    !/error:\s*error\?\.message\s*\?\?/.test(s))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ AI_ERROR_GUARD_FAIL"); process.exit(1) }
console.log(" ✅ AI_ERROR_GUARD_PASS — raw gateway billing errors are mapped to honest messages, content errors preserved")
