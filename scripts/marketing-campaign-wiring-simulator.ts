#!/usr/bin/env tsx
/**
 * scripts/marketing-campaign-wiring-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the MARKETING & CAMPAIGN rail's "missing middle" is closed:
 *
 *   app/actions/campaign-readiness.ts     → Marketing Studio Ad-OS + assets tab
 *   app/actions/email-campaigns.ts        → Marketing Studio newsletters tab
 *   app/actions/ai-marketing-automation.ts→ Marketing Studio (newsletter + copy)
 *
 * It also holds the line on the defects that were fixed: dead status literals,
 * phantom columns, identity-class substitution, unscoped tenant reads, and the
 * `const { data } = await supabase…` pattern that turns a REFUSED query into a
 * silently empty one.
 *
 * HOW IT PROVES ITSELF
 *   1. STATIC layer — every source file is COMMENT-STRIPPED before scanning, so
 *      no assertion can be satisfied by prose that merely describes the fix.
 *      Assertions target the CONSTRUCT (a call site, a destructured `error`, a
 *      brokerage filter), never a particular spelling of a comment.
 *   2. NEGATIVE layer — every single static assertion is deliberately broken in
 *      the real file. The mutation is verified to have ACTUALLY APPLIED (sha256
 *      of the file must change), the specific check must flip to a failure, the
 *      file is restored, and the restore is verified by sha256 against the
 *      original. An assertion that cannot be made to fail is itself a failure.
 *   3. LIVE layer — creds-gated. With NEXT_PUBLIC_SUPABASE_URL +
 *      SUPABASE_SERVICE_ROLE_KEY it verifies the columns and CHECK vocabularies
 *      the wiring depends on against the real database, round-trips a test row
 *      and re-counts to prove zero residue. Without creds — or if the database
 *      is unreachable — it SKIPS LOUDLY rather than scoring a network error as
 *      a pass.
 *
 * Run: npx tsx scripts/marketing-campaign-wiring-simulator.ts
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve, join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// ─── FILES UNDER TEST ─────────────────────────────────────────────────────────
const F = {
  readiness: "app/actions/campaign-readiness.ts",
  email: "app/actions/email-campaigns.ts",
  aiMarketing: "app/actions/ai-marketing-automation.ts",
  adOsActions: "app/dashboard/marketing/studio/components/ad-os/ad-os-actions.ts",
  prelaunchPanel: "app/dashboard/marketing/studio/components/ad-os/prelaunch-prediction-panel.tsx",
  listingCopyPanel: "app/dashboard/marketing/studio/components/ad-os/listing-copy-panel.tsx",
  studio: "app/dashboard/marketing/studio/marketing-studio-client.tsx",
} as const

// ─── SCORING ──────────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const failures: string[] = []
let skipped = 0

function record(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function skip(name: string, why: string) {
  skipped++
  console.log(`  ⊘ SKIPPED ${name} — ${why}`)
}

// ─── COMMENT STRIPPER ─────────────────────────────────────────────────────────
// Removes // line comments and /* block */ comments while preserving string,
// template and regex literals. Regex-literal detection uses the standard
// "previous significant token" heuristic so that patterns containing backticks
// or slashes are not mistaken for template literals or comments.
const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%~^<>".split(""))

export function stripComments(src: string): string {
  let out = ""
  let i = 0
  let lastSignificant = ""
  const n = src.length

  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]

    // line comment
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++
      continue
    }
    // block comment
    if (c === "/" && c2 === "*") {
      i += 2
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++
      i += 2
      out += " "
      continue
    }
    // string / template literal
    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      out += c
      i++
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "")
          i += 2
          continue
        }
        out += src[i]
        if (src[i] === quote) {
          i++
          break
        }
        i++
      }
      lastSignificant = quote
      continue
    }
    // regex literal
    if (c === "/" && (lastSignificant === "" || REGEX_PRECEDERS.has(lastSignificant))) {
      out += c
      i++
      let inClass = false
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "")
          i += 2
          continue
        }
        if (src[i] === "[") inClass = true
        else if (src[i] === "]") inClass = false
        out += src[i]
        if (src[i] === "/" && !inClass) {
          i++
          break
        }
        if (src[i] === "\n") {
          i++
          break
        }
        i++
      }
      lastSignificant = "/"
      continue
    }

    out += c
    if (!/\s/.test(c)) lastSignificant = c
    i++
  }
  return out
}

// ─── SOURCE HELPERS ───────────────────────────────────────────────────────────
function readRaw(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8")
}
function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}
function code(rel: string): string {
  return stripComments(readRaw(rel))
}

/** Body of a top-level `export async function NAME(` … up to the next top-level `\nexport ` or EOF. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) return ""
  const after = src.slice(start)
  const next = after.slice(1).search(/\nexport\s/)
  return next === -1 ? after : after.slice(0, next + 1)
}

/**
 * Body of a client-component function declared at one indent level
 * (`  async function NAME(` / `  function NAME(`), up to the next sibling
 * declaration. Prevents an assertion from being satisfied by a NEIGHBOURING
 * function that happens to contain the same construct.
 */
function clientFnBody(src: string, name: string): string {
  const m = new RegExp(`\\n  (?:async )?function ${name}\\(`).exec(src)
  if (!m) return ""
  const after = src.slice(m.index + 1)
  const next = after.slice(1).search(/\n  (?:async )?function |\n  useEffect\(/)
  return next === -1 ? after : after.slice(0, next + 1)
}

/** True when `ident(` appears as a CALL (not merely as an imported name). */
function callsFunction(src: string, ident: string): boolean {
  const re = new RegExp(`(?<![\\w$.])${ident}\\s*\\(`)
  return re.test(src)
}

/** True when a `.eq(<any quote>col<any quote>` filter exists in the slice. */
function hasEqFilter(src: string, column: string): boolean {
  const re = new RegExp(`\\.eq\\(\\s*["'\`]${column}["'\`]`)
  return re.test(src)
}

/**
 * Counts supabase awaits whose destructuring pattern omits `error`.
 * Construct-level: matches `const { … } = await supabase` regardless of naming.
 */
function undestructuredSupabaseReads(src: string): number {
  let count = 0
  const re = /const\s*\{([^}]*)\}\s*=\s*await\s+supabase/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (!/\berror\b/.test(m[1]) && !/\bcount\b/.test(m[1])) count++
  }
  return count
}

// ─── CHECK REGISTRY ───────────────────────────────────────────────────────────
// Each check owns: the assertion (on comment-stripped source) AND the mutation
// that must break it. `mutate` returns the new RAW file content, or null when
// the anchor is missing (which is itself reported as a harness failure).
interface Check {
  id: string
  file: keyof typeof F
  name: string
  assert: (stripped: string, all: Record<string, string>) => boolean
  mutate: (raw: string) => string | null
}

function replaceOnce(raw: string, needle: string, repl: string): string | null {
  const idx = raw.indexOf(needle)
  if (idx === -1) return null
  return raw.slice(0, idx) + repl + raw.slice(idx + needle.length)
}

const CHECKS: Check[] = [
  // ══ A. campaign-readiness.ts — readiness verdicts are recorded, and scoped ══
  {
    id: "readiness/identity-helper",
    file: "readiness",
    name: "readiness logging identity comes from the session (getAgentContext), not the caller",
    assert: (s) => {
      const body = fnBody(s, "resolveLoggingIdentity")
      return body.length > 0 && callsFunction(body, "getAgentContext") && /ctx\.agentId/.test(body)
    },
    mutate: (raw) => replaceOnce(raw, "const ctx = await getAgentContext()\n  if (!ctx.isAuthenticated) return { ok: false, error: \"Unauthorized\" }", "const ctx = { isAuthenticated: true, brokerageId: null, agentId: null, userId: \"\" } as any"),
  },
  {
    id: "readiness/no-identity-substitution",
    file: "readiness",
    name: "agents id is never substituted with a users id (`agent_id: … user…`)",
    assert: (s) => !/agent_id\s*:\s*[A-Za-z0-9_.]*[uU]ser/.test(s),
    mutate: (raw) => replaceOnce(raw, "agent_id: identity.agentId,", "agent_id: identity.userId,"),
  },
  {
    id: "readiness/evaluate-logs-context",
    file: "readiness",
    name: "evaluateContentReadiness supplies the NOT NULL activities columns when logging",
    assert: (s) => {
      const body = fnBody(s, "evaluateContentReadiness")
      const call = body.slice(body.indexOf("logReadinessEvaluation("))
      return /brokerage_id\s*:/.test(call.slice(0, 500)) && /agent_id\s*:/.test(call.slice(0, 500))
    },
    mutate: (raw) =>
      replaceOnce(
        raw,
        `            brokerage_id: identity.brokerageId,
            agent_id: identity.agentId,
          })
          if (logResult.success) {`,
        `          })
          if (logResult.success) {`
      ),
  },
  {
    id: "readiness/evaluate-surfaces-log-failure",
    file: "readiness",
    name: "evaluateContentReadiness returns log_error instead of swallowing a failed record",
    assert: (s) => {
      const body = fnBody(s, "evaluateContentReadiness")
      return /log_error\s*=\s*/.test(body) && /return\s*\{[^{}]*log_error[^{}]*\}/.test(body)
    },
    mutate: (raw) =>
      replaceOnce(
        raw,
        `      readiness_output: readinessOutput,
      activity_id,
      log_error,
    }`,
        `      readiness_output: readinessOutput,
      activity_id,
    }`
      ),
  },
  {
    id: "readiness/batch-logs-context",
    file: "readiness",
    name: "batchEvaluateContentReadiness attaches additional_context so rows can be written",
    assert: (s) => {
      const body = fnBody(s, "batchEvaluateContentReadiness")
      return /additional_context\s*:\s*\{/.test(body) && /brokerage_id\s*:/.test(body) && /agent_id\s*:/.test(body)
    },
    mutate: (raw) =>
      replaceOnce(
        raw,
        `            additional_context: {
              brokerage_id: identity.brokerageId,
              agent_id: identity.agentId,
            },`,
        ``
      ),
  },
  {
    id: "readiness/channel-resolves-identity",
    file: "readiness",
    name: "checkSpecificChannelReadiness resolves identity itself (no caller-supplied tenant, no silent skip)",
    assert: (s) => {
      const body = fnBody(s, "checkSpecificChannelReadiness")
      return callsFunction(body, "resolveLoggingIdentity") && !/brokerage_id\?\s*:\s*string/.test(body)
    },
    mutate: (raw) =>
      replaceOnce(
        raw,
        `        const identity = await resolveLoggingIdentity()
        if (!identity.ok) {
          log_error = identity.error
        } else {
          const logResult = await logChannelReadinessCheck(`,
        `        const identity = { ok: true as const, brokerageId: "", agentId: "" }
        if (!identity.ok) {
          log_error = "unreachable"
        } else {
          const logResult = await logChannelReadinessCheck(`
      ),
  },
  {
    id: "readiness/history-brokerage-gate",
    file: "readiness",
    name: "fetchReadinessHistory gates the service-role read with an explicit brokerage filter",
    assert: (s) => {
      const body = fnBody(s, "fetchReadinessHistory")
      return hasEqFilter(body, "brokerage_id") && callsFunction(body, "getAgentContext")
    },
    mutate: (raw) => replaceOnce(raw, `      .eq("brokerage_id", ctx.brokerageId)\n      .eq("entity_type", "content")`, `      .eq("entity_type", "content")`),
  },
  {
    id: "readiness/history-surfaces-scope-error",
    file: "readiness",
    name: "fetchReadinessHistory destructures the scope probe's error",
    assert: (s) => {
      const body = fnBody(s, "fetchReadinessHistory")
      return /const\s*\{[^}]*error\s*:\s*scopeError[^}]*\}\s*=\s*await\s+supabase/.test(body) && /if\s*\(scopeError\)/.test(body)
    },
    mutate: (raw) => replaceOnce(raw, "const { count, error: scopeError } = await supabase", "const { count } = await supabase\n    const scopeError = null"),
  },

  // ══ B. email-campaigns.ts ══════════════════════════════════════════════════
  {
    id: "email/preview-text-column",
    file: "email",
    name: "updateEmailCampaign maps previewText onto the live preview_text column",
    assert: (s) => /payload\.preview_text\s*=\s*updates\.previewText/.test(s) && /previewText\?\s*:\s*string/.test(s),
    mutate: (raw) => replaceOnce(raw, "if (updates.previewText !== undefined) payload.preview_text = updates.previewText", ""),
  },
  {
    id: "email/no-silent-supabase-reads",
    file: "email",
    name: "no `const { data } = await supabase…` in email-campaigns (every query destructures error)",
    assert: (s) => undestructuredSupabaseReads(s) === 0,
    mutate: (raw) => replaceOnce(raw, "const { data: existing, error: existingError } = await supabase\n      .from(\"email_campaigns\")\n      .select(\"status, brokerage_id\")", "const { data: existing } = await supabase\n      .from(\"email_campaigns\")\n      .select(\"status, brokerage_id\")\n    const existingError = null"),
  },
  {
    id: "email/stats-checks-errors",
    file: "email",
    name: "getEmailCampaignStats fails loudly instead of reporting zero on a refused read",
    assert: (s) => {
      const body = fnBody(s, "getEmailCampaignStats")
      return /if\s*\(campaignsResult\.error\)/.test(body) && /if\s*\(subscribersResult\.error\)/.test(body)
    },
    mutate: (raw) => replaceOnce(raw, "if (campaignsResult.error) throw campaignsResult.error", ""),
  },
  {
    id: "email/update-refuses-in-flight",
    file: "email",
    name: "updateEmailCampaign refuses to race the sender (status 'sending' rejected)",
    assert: (s) => {
      const body = fnBody(s, "updateEmailCampaign")
      return /existing\.status\s*===\s*["'`]sending["'`]/.test(body)
    },
    mutate: (raw) => replaceOnce(raw, `    if (existing.status === "sending") {`, `    if (false) {`),
  },
  {
    id: "email/update-reports-refusal",
    file: "email",
    name: "updateEmailCampaign reports a no-op update rather than claiming success",
    assert: (s) => {
      const body = fnBody(s, "updateEmailCampaign")
      return /if\s*\(!data\)\s*return\s*\{\s*success:\s*false/.test(body)
    },
    mutate: (raw) => replaceOnce(raw, `    if (!data) return { success: false, error: "Update was refused — campaign not found in your brokerage" }`, ""),
  },

  // ══ C. ai-marketing-automation.ts ═════════════════════════════════════════
  {
    id: "ai/newsletter-single-writer",
    file: "aiMarketing",
    name: "generateAINewsletter does NOT insert newsletter_campaigns directly (one writer)",
    assert: (s) => {
      const body = fnBody(s, "generateAINewsletter")
      const directInsert = /\.from\(\s*["'`]newsletter_campaigns["'`]\s*\)[\s\S]{0,120}\.insert\(/.test(body)
      return !directInsert && callsFunction(body, "createNewsletterCampaign")
    },
    mutate: (raw) =>
      replaceOnce(
        raw,
        `    const { createNewsletterCampaign } = await import("@/app/actions/ai-newsletter")
    const saveResult = await createNewsletterCampaign({`,
        `    const saveResult = await supabase.from("newsletter_campaigns").insert({`
      ),
  },
  {
    id: "ai/no-phantom-tone-attributes",
    file: "aiMarketing",
    name: "brand_voice_profile.tone_attributes (phantom column) is gone",
    assert: (s) => !/tone_attributes/.test(s),
    mutate: (raw) => replaceOnce(raw, "BRAND VOICE: ${brandVoice?.tone ||", "BRAND VOICE: ${brandVoice?.tone_attributes?.join(\", \") ||"),
  },
  {
    id: "ai/no-phantom-listing-description-cols",
    file: "aiMarketing",
    name: "listings.mls_description / marketing_description (phantom columns) are gone",
    assert: (s) => !/\bmls_description\b/.test(s) && !/\bmarketing_description\b/.test(s),
    mutate: (raw) => replaceOnce(raw, "Original: ${original}", "Original: ${listing.mls_description || listing.marketing_description}"),
  },
  {
    id: "ai/enhance-reads-public-remarks-scoped",
    file: "aiMarketing",
    name: "enhanceListingDescription reads public_remarks and is brokerage-scoped",
    assert: (s) => {
      const body = fnBody(s, "enhanceListingDescription")
      return /public_remarks/.test(body) && hasEqFilter(body, "brokerage_id")
    },
    mutate: (raw) =>
      replaceOnce(
        raw,
        `      .eq("id", listingId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle()

    if (listingError) throw listingError`,
        `      .eq("id", listingId)
      .maybeSingle()

    if (listingError) throw listingError`
      ),
  },
  {
    id: "ai/enhance-is-read-only",
    file: "aiMarketing",
    name: "enhanceListingDescription never writes back to listings (no second writer)",
    assert: (s) => {
      const body = fnBody(s, "enhanceListingDescription")
      return !/\.update\(/.test(body) && !/\.insert\(/.test(body)
    },
    mutate: (raw) =>
      replaceOnce(
        raw,
        `    return { success: true, enhanced: text }
  } catch (error) {
    return handleError(error, "enhanceListingDescription") as any`,
        `    await supabase.from("listings").update({ public_remarks: text }).eq("id", listingId)
    return { success: true, enhanced: text }
  } catch (error) {
    return handleError(error, "enhanceListingDescription") as any`
      ),
  },
  {
    id: "ai/agents-not-users-identity",
    file: "aiMarketing",
    name: "agent ids resolve through the agents table, never a users lookup keyed by agentId",
    assert: (s) => {
      const bad = /\.from\(\s*["'`]users["'`]\s*\)[\s\S]{0,160}\.eq\(\s*["'`]id["'`]\s*,\s*[A-Za-z0-9_.]*agentId/i
      return !bad.test(s) && /\.from\(\s*["'`]agents["'`]\s*\)/.test(s)
    },
    mutate: (raw) =>
      replaceOnce(
        raw,
        `    const auth = await requireAgentInCallerBrokerage(params.agentId)
    if (!auth.ok) return { success: false, error: auth.error }
    const brokerageId = auth.brokerageId`,
        `    const { data: agentRow } = await supabase.from("users").select("brokerage_id").eq("id", params.agentId).maybeSingle()
    const brokerageId = (agentRow as { brokerage_id: string | null } | null)?.brokerage_id ?? null
    if (!brokerageId) return { success: false, error: "Could not resolve brokerage for the agent" }`
      ),
  },
  {
    id: "ai/tenant-guard-on-every-action",
    file: "aiMarketing",
    name: "every AI marketing action verifies the agent is inside the caller's brokerage",
    assert: (s) =>
      [
        "generateAINewsletter",
        "generateNewsletterSubjectVariants",
        "enhanceListingDescription",
        "createAIListing",
        "createAIOffer",
        "generateCounterOfferStrategy",
        "compareOffers",
      ].every((fn) => callsFunction(fnBody(s, fn), "requireAgentInCallerBrokerage")),
    mutate: (raw) =>
      replaceOnce(
        raw,
        `    const auth = await requireAgentInCallerBrokerage(agentId)
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    const { data: offers, error: offersError } = await supabase`,
        `    const auth = { ok: true as const, brokerageId: "" }
    if (!auth.ok) return { success: false, error: "x" }

    const supabase = await createClient()

    const { data: offers, error: offersError } = await supabase`
      ),
  },
  {
    id: "ai/offer-escalation-clause-type",
    file: "aiMarketing",
    name: "createAIOffer writes a boolean into the boolean column offers.escalation_clause",
    assert: (s) => {
      const body = fnBody(s, "createAIOffer")
      return /escalation_clause\s*:\s*Boolean\(/.test(body)
    },
    mutate: (raw) => replaceOnce(raw, "escalation_clause: Boolean(params.escalationClause),", "escalation_clause: params.escalationClause,"),
  },
  {
    id: "ai/offer-columns-are-real",
    file: "aiMarketing",
    name: "offer reads use offer_price / closing_date, not the phantom offer_amount / close_date",
    assert: (s) => !/\boffer_amount\b/.test(s) && !/\bclose_date\b/.test(s),
    mutate: (raw) => replaceOnce(raw, "- Offer: $${offer.offer_price?.toLocaleString() ?? \"N/A\"}", "- Offer: $${offer.offer_amount.toLocaleString()}"),
  },
  {
    id: "ai/listing-price-column-is-real",
    file: "aiMarketing",
    name: "compareOffers uses listings.list_price, not the phantom listings.price",
    assert: (s) => {
      const body = fnBody(s, "compareOffers")
      return !/listing\??\.price\b/.test(body) && /list_price/.test(body)
    },
    mutate: (raw) => replaceOnce(raw, "- List Price: $${listing?.list_price?.toLocaleString() ?? \"N/A\"}", "- List Price: $${listing?.price.toLocaleString()}"),
  },
  {
    id: "ai/json-parse-is-guarded",
    file: "aiMarketing",
    name: "AI JSON responses are fence-stripped and parse failures are reported, not thrown",
    assert: (s) => {
      // 1 declaration + one guarded call site per AI-JSON consumer.
      const uses = (s.match(/stripCodeFences\s*\(/g) ?? []).length
      const guardedParses = (s.match(/try\s*\{\s*[^}]{0,200}JSON\.parse\(/g) ?? []).length
      return uses >= 4 && guardedParses >= 3
    },
    mutate: (raw) => replaceOnce(raw, "parsed = JSON.parse(stripCodeFences(text))", "parsed = JSON.parse(text || \"\")"),
  },

  // ══ D. SURFACES — the capability is reachable and reports the server ═══════
  {
    id: "surface/email-actions-called",
    file: "studio",
    name: "Studio calls getEmailCampaigns / getEmailCampaign / updateEmailCampaign / aiComposeEmail / getEmailCampaignStats",
    assert: (s) =>
      ["getEmailCampaigns", "getEmailCampaign", "updateEmailCampaign", "aiComposeEmail", "getEmailCampaignStats"].every(
        (fn) => callsFunction(s, fn)
      ),
    mutate: (raw) =>
      replaceOnce(
        raw,
        `const { getEmailCampaigns, getEmailCampaignStats } = await import("@/app/actions/email-campaigns")
    const [listRes, statsRes] = await Promise.all([getEmailCampaigns(), getEmailCampaignStats()])`,
        `const { getEmailCampaigns } = await import("@/app/actions/email-campaigns")
    const [listRes, statsRes] = await Promise.all([getEmailCampaigns(), Promise.resolve({ success: true, stats: null } as any)])`
      ),
  },
  {
    id: "surface/email-list-rendered",
    file: "studio",
    name: "the email_campaigns the create dialog writes are rendered back on the same tab",
    assert: (s) => /emailCampaigns\.map\(/.test(s) && /setEmailCampaigns\(/.test(s),
    // Anchor follows the row body: it became a block (`=> {`) rather than an
    // expression (`=> (`) when each row gained its Schedule + Delete controls.
    mutate: (raw) => replaceOnce(raw, "{emailCampaigns.map((c) => {", "{[].map((c: any) => {"),
  },
  {
    id: "surface/email-save-reports-server-verdict",
    file: "studio",
    name: "saving an email campaign surfaces the SERVER's refusal (no optimistic success)",
    assert: (s) => {
      const body = clientFnBody(s, "saveEmailCampaign")
      return body.length > 0 && /if\s*\(!res\.success\)/.test(body) && /setEmailEditorError\(/.test(body)
    },
    mutate: (raw) =>
      replaceOnce(
        raw,
        `      if (!res.success) {
        // Report the SERVER's refusal — never an optimistic "Saved!".
        setEmailEditorError((res as any).error ?? "Save was refused")
        return
      }`,
        ``
      ),
  },
  {
    id: "surface/email-editor-opens-via-action",
    file: "studio",
    name: "the campaign editor loads its row through getEmailCampaign (not a raw client read)",
    assert: (s) => {
      const body = clientFnBody(s, "openEmailCampaignEditor")
      return body.length > 0 && callsFunction(body, "getEmailCampaign") && !/\.from\(\s*["'`]email_campaigns["'`]/.test(body)
    },
    mutate: (raw) => replaceOnce(raw, "const res = await getEmailCampaign(campaignId)", "const res = await supabaseUnused.from(\"email_campaigns\").select(\"*\").eq(\"id\", campaignId).maybeSingle() as any"),
  },
  {
    id: "surface/ai-newsletter-wired",
    file: "studio",
    name: "Studio calls generateAINewsletter and generateNewsletterSubjectVariants",
    assert: (s) => callsFunction(s, "generateAINewsletter") && callsFunction(s, "generateNewsletterSubjectVariants"),
    mutate: (raw) => replaceOnce(raw, "const res = await generateAINewsletter({", "const res = await Promise.resolve({ success: false, error: \"x\" } as any) as any; void ({"),
  },
  {
    id: "surface/batch-readiness-wired",
    file: "studio",
    name: "Studio runs a bulk readiness sweep over marketing assets",
    assert: (s) => callsFunction(s, "runBatchReadinessCheck") && /readinessSweep/.test(s),
    mutate: (raw) => replaceOnce(raw, "const res = await runBatchReadinessCheck(", "const res = await Promise.resolve({ success: true } as any); void ("),
  },
  {
    id: "surface/no-newsletter-silent-reads",
    file: "studio",
    name: "the newsletter tab's client reads destructure error (a refusal is not an empty tab)",
    assert: (s) => {
      const body = clientFnBody(s, "loadNewsletterData")
      return body.length > 0 && undestructuredSupabaseReads(body) === 0 && /setNewsletterError\(/.test(body)
    },
    mutate: (raw) => replaceOnce(raw, "const { data: templates, error: templatesError } = await supabase", "const { data: templates } = await supabase\n      const templatesError = null"),
  },
  {
    id: "surface/studio-does-not-send",
    file: "studio",
    name: "the Studio never sends directly — egress stays on the consent-gated path",
    assert: (s) => !callsFunction(s, "sendEmailCampaign") && !callsFunction(s, "dispatchEmail") && !callsFunction(s, "sendCampaignNow"),
    mutate: (raw) => replaceOnce(raw, "const { updateEmailCampaign } = await import(\"@/app/actions/email-campaigns\")", "const { updateEmailCampaign, sendEmailCampaign } = await import(\"@/app/actions/email-campaigns\")\n      await sendEmailCampaign(editingEmailCampaign.id)"),
  },

  // ══ E. Ad-OS actions — the 4.2 → 4.3 → 4.5 chain is real ══════════════════
  {
    id: "adOs/no-dead-approval-literal",
    file: "adOsActions",
    name: "the dead approval literal 'auto_approved' is gone (ApprovalStatus is approved|pending|rejected)",
    assert: (s) => !/auto_approved["'`]/.test(s),
    mutate: (raw) => replaceOnce(raw, "  const approval = determineApprovalDecision(", "  const approval = { approval_status: \"auto_approved\" } as any || determineApprovalDecision("),
  },
  {
    id: "adOs/real-compliance-verdict",
    file: "adOsActions",
    name: "readiness is fed a REAL compliance verdict + approval decision, not a hardcoded pass",
    assert: (s) => {
      const body = s.slice(s.indexOf("async function buildReadinessInput"))
      return (
        callsFunction(body, "evaluateContentCompliance") &&
        callsFunction(body, "determineApprovalDecision") &&
        !/compliance_status\s*:\s*["'`]pass["'`]/.test(body)
      )
    },
    mutate: (raw) => replaceOnce(raw, "  const compliance = await evaluateContentCompliance({", "  const compliance = { compliance_status: \"pass\" } as any; void ({"),
  },
  {
    id: "adOs/compliance-is-brokerage-scoped",
    file: "adOsActions",
    name: "the compliance evaluation carries the caller's brokerage (state rules load per tenant)",
    assert: (s) => {
      const body = s.slice(s.indexOf("async function buildReadinessInput"))
      return /brokerage_id\s*:\s*params\.brokerageId/.test(body)
    },
    mutate: (raw) => replaceOnce(raw, "    brokerage_id: params.brokerageId,\n    intended_audience:", "    intended_audience:"),
  },
  {
    id: "adOs/readiness-capabilities-called",
    file: "adOsActions",
    name: "validate / quick / channel / format / batch / history readiness actions are all reachable",
    assert: (s) =>
      [
        "validateReadinessInput",
        "quickCheckReadiness",
        "checkSpecificChannelReadiness",
        "formatReadinessResult",
        "batchEvaluateContentReadiness",
        "fetchReadinessHistory",
        "evaluateContentReadiness",
      ].every((fn) => callsFunction(s, fn)),
    mutate: (raw) =>
      replaceOnce(
        raw,
        "  const validation = await validateReadinessInput(readinessInput)",
        "  const validation = { success: true, is_valid: true, missing_fields: [] } as any"
      ),
  },
  {
    id: "adOs/readiness-is-recorded",
    file: "adOsActions",
    name: "prelaunch + batch checks request log_to_activities so the ops pass-rate has data",
    assert: (s) => (s.match(/log_to_activities\s*:/g) ?? []).length >= 2,
    mutate: (raw) => replaceOnce(raw, "evaluateContentReadiness(readinessInput, { log_to_activities: Boolean(contentId) })", "evaluateContentReadiness(readinessInput)"),
  },
  {
    id: "adOs/channel-vocabulary-validated",
    file: "adOsActions",
    name: "platform strings are mapped to the ExecutionChannel vocabulary, not cast blindly",
    assert: (s) => {
      const body = s.slice(s.indexOf("async function buildReadinessInput"))
      return (
        /EXECUTION_CHANNELS/.test(s) &&
        callsFunction(body, "toExecutionChannel") &&
        callsFunction(body, "toReadinessContentType") &&
        !/as any\]/.test(body)
      )
    },
    mutate: (raw) => replaceOnce(raw, "  const channel = toExecutionChannel(params.platform)", "  const channel = params.platform as any"),
  },

  // ══ F. Panels render the server's answer ══════════════════════════════════
  {
    id: "panel/prelaunch-renders-server-verdicts",
    file: "prelaunchPanel",
    name: "pre-launch panel renders the server's compliance, channel and formatted readiness verdicts",
    assert: (s) =>
      /result\.compliance\.violations\.map\(/.test(s) &&
      /result\.channelVerdict\.isReady/.test(s) &&
      /\{\s*result\.readinessReport\s*\}/.test(s) &&
      /\{result\.readinessLogError\}/.test(s),
    mutate: (raw) => replaceOnce(raw, "                  {result.readinessReport}", "                  {\"\"}"),
  },
  {
    id: "panel/prelaunch-history-wired",
    file: "prelaunchPanel",
    name: "pre-launch panel can read back the recorded readiness trail",
    assert: (s) => callsFunction(s, "loadReadinessHistory") && /setHistory\(/.test(s),
    mutate: (raw) => replaceOnce(raw, "const res = await loadReadinessHistory(id)", "const res = { success: true, entries: [] } as any"),
  },
  {
    id: "panel/listing-copy-wired",
    file: "listingCopyPanel",
    name: "listing copy panel calls enhanceListingDescription and surfaces its refusal",
    assert: (s) =>
      callsFunction(s, "enhanceListingDescription") && /if\s*\(!res\.success\)\s*setError\(/.test(s) && !/\.update\(/.test(s),
    mutate: (raw) => replaceOnce(raw, "      if (!res.success) setError(res.error ?? \"Could not enhance the description\")", ""),
  },
]

// ─── STATIC LAYER ─────────────────────────────────────────────────────────────
function runStatic(): Map<string, boolean> {
  console.log("\n[static — comment-stripped source, construct assertions]")
  const stripped: Record<string, string> = {}
  for (const [k, rel] of Object.entries(F)) stripped[k] = code(rel)

  const results = new Map<string, boolean>()
  for (const c of CHECKS) {
    const ok = c.assert(stripped[c.file], stripped)
    results.set(c.id, ok)
    record(c.name, ok, ok ? undefined : `[${c.id}] in ${F[c.file]}`)
  }
  return results
}

// ─── NEGATIVE LAYER ───────────────────────────────────────────────────────────
// Break each assertion in the real file; prove the mutation applied (sha256
// changed), prove the check flips to failure, restore, prove the restore by
// sha256. Any assertion that cannot be made to fail is reported as a failure.
function runNegative() {
  console.log("\n[negative — every assertion is broken in-source and must flip]")

  for (const c of CHECKS) {
    const rel = F[c.file]
    const abs = join(ROOT, rel)
    const original = readFileSync(abs, "utf8")
    const originalSha = sha(original)

    const mutated = c.mutate(original)
    if (mutated === null) {
      record(`negative: ${c.name}`, false, `[${c.id}] mutation anchor not found in ${rel}`)
      continue
    }
    if (sha(mutated) === originalSha) {
      record(`negative: ${c.name}`, false, `[${c.id}] mutation was a NO-OP — the test would be theatre`)
      continue
    }

    let flipped = false
    let detail = ""
    try {
      writeFileSync(abs, mutated, "utf8")
      const onDisk = readFileSync(abs, "utf8")
      if (sha(onDisk) !== sha(mutated)) {
        detail = "mutation did not reach disk"
      } else {
        const stripped: Record<string, string> = {}
        for (const [k, r] of Object.entries(F)) stripped[k] = code(r)
        flipped = c.assert(stripped[c.file], stripped) === false
        if (!flipped) detail = "assertion still passed with the fix removed — TIGHTEN IT"
      }
    } finally {
      writeFileSync(abs, original, "utf8")
    }

    const restoredSha = sha(readFileSync(abs, "utf8"))
    if (restoredSha !== originalSha) {
      record(`negative: ${c.name}`, false, `[${c.id}] RESTORE FAILED — file left mutated`)
      continue
    }

    record(`negative: ${c.name}`, flipped, flipped ? undefined : `[${c.id}] ${detail}`)
  }
}

// ─── LIVE LAYER ───────────────────────────────────────────────────────────────
async function runLive() {
  console.log("\n[live — schema + constraint verification against the real database]")

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    skip(
      "live schema layer",
      "no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env — NOT counted as a pass"
    )
    return
  }

  let db: any
  try {
    const { createClient } = await import("@supabase/supabase-js")
    db = createClient(url, key, { auth: { persistSession: false } })
    const probe = await db.from("email_campaigns").select("id").limit(1)
    if (probe.error) {
      skip("live schema layer", `database unreachable / refused: ${probe.error.message} — NOT counted as a pass`)
      return
    }
  } catch (err) {
    skip("live schema layer", `could not connect: ${err instanceof Error ? err.message : String(err)} — NOT counted as a pass`)
    return
  }

  // 1. Columns the wiring writes/reads must EXIST.
  const mustExist: Array<[string, string]> = [
    ["email_campaigns", "preview_text"],
    ["email_campaigns", "approval_status"],
    ["activities", "brokerage_id"],
    ["activities", "entity_type"],
    ["listings", "public_remarks"],
    ["offers", "escalation_cap"],
    ["brand_voice_profile", "tone"],
    ["market_data", "brokerage_id"],
  ]
  for (const [table, column] of mustExist) {
    const { error } = await db.from(table).select(column).limit(1)
    record(`live: ${table}.${column} exists`, !error, error?.message)
  }

  // 2. Columns the wiring must NOT reference (the phantoms that were removed).
  const mustNotExist: Array<[string, string]> = [
    ["listings", "mls_description"],
    ["listings", "marketing_description"],
    ["brand_voice_profile", "tone_attributes"],
    ["offers", "offer_amount"],
    ["offers", "close_date"],
  ]
  for (const [table, column] of mustNotExist) {
    const { error } = await db.from(table).select(column).limit(1)
    record(`live: ${table}.${column} is a PHANTOM (correctly unreferenced)`, !!error, error ? undefined : "column exists — re-check the audit")
  }

  // 3. Status literals the code writes must satisfy the live CHECK vocabularies.
  const brokerage = await db.from("brokerages").select("id").limit(1).maybeSingle()
  if (brokerage.error || !brokerage.data?.id) {
    skip("live round-trip", "no brokerage row available to scope a test insert — NOT counted as a pass")
    return
  }
  const brokerageId = brokerage.data.id as string
  const marker = `__wiring-sim-${Date.now()}__`

  // 3a. A bogus status must be REFUSED — proves the vocabulary is enforced live.
  const bogus = await db
    .from("email_campaigns")
    .insert({ brokerage_id: brokerageId, campaign_name: marker, subject_line: marker, status: "not_a_real_status" })
    .select("id")
  record("live: email_campaigns rejects a status outside its CHECK vocabulary", !!bogus.error, bogus.error ? undefined : "insert was ACCEPTED")
  if (!bogus.error && bogus.data?.[0]?.id) {
    await db.from("email_campaigns").delete().eq("id", bogus.data[0].id)
  }

  // 3b. Round-trip the columns the editor actually writes, then clean up.
  const created = await db
    .from("email_campaigns")
    .insert({
      brokerage_id: brokerageId,
      campaign_name: marker,
      subject_line: marker,
      content: "body",
      preview_text: "preheader",
      status: "draft",
      approval_status: "pending",
    })
    .select("id, preview_text")
    .maybeSingle()

  record("live: email_campaigns accepts the editor's payload (incl. preview_text)", !created.error && !!created.data?.id, created.error?.message)

  if (created.data?.id) {
    const id = created.data.id as string
    const updated = await db
      .from("email_campaigns")
      .update({ preview_text: "updated preheader", subject_line: `${marker}-v2` })
      .eq("id", id)
      .eq("brokerage_id", brokerageId)
      .select("preview_text")
      .maybeSingle()
    record(
      "live: updateEmailCampaign's column set round-trips",
      !updated.error && updated.data?.preview_text === "updated preheader",
      updated.error?.message
    )

    const del = await db.from("email_campaigns").delete().eq("id", id).eq("brokerage_id", brokerageId)
    record("live: test row deleted", !del.error, del.error?.message)
  }

  // 4. Residue must be ZERO — re-count everything this run could have created.
  const residue = await db.from("email_campaigns").select("id", { count: "exact", head: true }).ilike("campaign_name", `${marker}%`)
  record(
    "live: zero test-data residue after cleanup",
    !residue.error && (residue.count ?? 0) === 0,
    residue.error?.message ?? `residue count = ${residue.count}`
  )
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" Marketing & Campaign wiring simulator")
  console.log(" campaign-readiness · email-campaigns · ai-marketing-automation")
  console.log("══════════════════════════════════════════════════════════════")

  // Sanity: the stripper must actually remove comments, or every assertion
  // below could be satisfied by prose.
  const stripperProbe = stripComments(
    'const a = 1 // brokerage_id\n/* .eq("brokerage_id", x) */\nconst s = "// not a comment"\nconst r = /a\\/b/g'
  )
  record(
    "harness: comment stripper removes comments and keeps string/regex literals",
    !/brokerage_id/.test(stripperProbe) && /\/\/ not a comment/.test(stripperProbe) && /a\\\/b/.test(stripperProbe)
  )

  runStatic()
  runNegative()
  await runLive()

  console.log("\n──────────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed, ${skipped} skipped`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ Marketing & campaign capabilities are reachable, tenant-scoped,")
  console.log("    report the server's verdict, and record where the next reader looks.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
