#!/usr/bin/env tsx
/**
 * scripts/conditional-tenant-predicate-guard.ts
 *   (npm run test:conditional-tenant-predicate — pure, no DB, in the guard chain)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OPTIONAL TENANT PREDICATE — a query that runs either way, whose brokerage
 * filter is applied only when the id happens to be truthy.
 *
 *     let q = svc.from("compliance_events").select(…)
 *     if (brokerageId) q = q.eq("brokerage_id", brokerageId)   ← predicate OPTIONAL
 *     const { data } = await q                                  ← query UNCONDITIONAL
 *
 * When the id arrives null the predicate is not skipped, it is GONE, and on a
 * service-role client (RLS bypassed) the read returns every brokerage's rows.
 * CLAUDE.md §4: "A gate that cannot run must refuse, not pass. 'Nobody checked'
 * must never render as 'checked and fine'."
 *
 * The owner's ruling is what makes the shape load-bearing rather than cosmetic:
 * "brokerage id determines the tenant unique and platform only has no
 * brokerageid" — so an ABSENT brokerage_id already means PLATFORM. A function
 * that lets the value simply go missing therefore cannot tell "I am the platform"
 * from "I never found out", and answers both with every tenant's data.
 *
 * TWO SURFACES WERE REACHED EXACTLY THIS WAY, and both are now converted to the
 * explicit discriminator in lib/kernel/tenant-scope.ts:
 *   · lib/kernel/compliance-ledger.ts — its page computed
 *     `isSuperadmin ? null : (userData?.brokerage_id ?? null)`, so a NON-superadmin
 *     broker/admin with a NULL users.brokerage_id read every brokerage's Fair
 *     Housing and consent audit trail.
 *   · lib/kernel/command-center.ts — `brokerageId: isSuperadmin ? undefined :
 *     brokerageId` behind an `isAdminOrBroker(user_type)` gate that never consults
 *     brokerage_id. Same null, SEVEN queries, service client.
 * Neither was exploitable on today's data (0 of 23 live `users` rows carry a NULL
 * brokerage_id) and both were structurally reachable, because the column is nullable.
 *
 * ── TWO OWNER RULINGS CLOSED TWO ENTRIES (2026-08-24) ────────────────────────
 * Both had been recorded here as UNRESOLVED rather than guessed, and both are now
 * OUT of the population entirely — the baseline moved 58 → 55, removals only:
 *
 *  · `app/actions/listing-landing.ts :: brokerageId` (1 → 0).
 *    Ruling, verbatim: "public landing pages should not show cross brokerage
 *    comps. not sure how that got figured in?" — nothing figured it in.
 *    getSimilarListings(listingId, zip, brokerageId?) had ONE caller and it never
 *    passed the third argument, so the predicate never once fired and every public
 *    landing page listed similar homes from every brokerage in the ZIP. The
 *    parameter is now REQUIRED and the predicate goes through
 *    tenantScope()/applyTenantScope(), which is why the site left the population
 *    rather than merely being reclassified.
 *
 *  · `app/api/webhooks/inbound-suppression/route.ts :: payload.brokerageId` (2 → 0).
 *    Ruling, verbatim: "inbound suppression could come from an external feeds like
 *    emails/dms etc." — so the path is live, and a BODY-SUPPLIED brokerageId on a
 *    service client (CLAUDE.md §4) was the tenant. Both sites are gone: the field
 *    is removed from the payload, the tenant is DERIVED from the row the inbound
 *    identity resolves to, and the fuzzy phone/email match now takes limit(2) plus
 *    the one-distinct-tenant rule — REFUSING on ambiguity instead of the old
 *    limit(1), which picked whichever brokerage sorted first.
 *    The rule itself is no longer re-spelled per webhook: it is
 *    lib/kernel/unambiguous-tenant.ts:resolveUnambiguousTenant, the merge of the
 *    sendgrid-events and inbound-mail copies (§6).
 *
 * NO `unresolved` ENTRY REMAINS. The third and last one —
 * `lib/kernel/lender-linkage.ts :: brokerageId` — was closed in the same wave by
 * the owner's shared-vendor ruling; see its CLASSIFICATION entry below. The
 * `unresolved` verdict itself is DELIBERATELY KEPT in the type: it is how the next
 * lane records a site whose caller set it could not establish, and deleting a
 * verdict because it currently has no members would take the option away.
 *
 * ── WHAT THIS GUARD FREEZES ──────────────────────────────────────────────────
 * The population can only SHRINK. Every site that survives is in the baseline
 * WITH A REASON in CLASSIFICATION below — the list is the argument, not a rubber
 * stamp. A NEW conditional tenant predicate fails the build with its location.
 *
 * ── WHAT IT IS BLIND TO (published beside the number, CLAUDE.md §2) ──────────
 *  1. `scripts/**` is not scanned. This file's own positive controls are string
 *     literals, and blankComments deliberately preserves string contents, so a
 *     self-scan would count its own controls as findings.
 *  2. Only `.eq("brokerage_id", <identifier>)` is recognised. `.match({…})`,
 *     `.or("brokerage_id.eq.…")`, `.filter("brokerage_id", "eq", …)` and a
 *     predicate built from a computed expression are NOT seen.
 *  3. Only `brokerage_id` is treated as the tenant column. A child table scoped
 *     through a parent id (open_house_analytics → open_house_events) is the
 *     LIVE-database guard's job: npm run test:child-tenant-scope.
 *  4. The truthiness guard must be within 320 characters before the predicate.
 *     A conditional separated by more than that reads as unconditional here.
 *  5. It does not decide whether a site is SAFE. A conditional predicate whose
 *     chain also carries a primary key or an entity id (`.eq("id", listingId)`,
 *     `.eq("lead_id", leadId)`) cannot cross a tenant boundary in practice — the
 *     row is already named. Those are counted, classified `anchored`, and kept in
 *     the baseline so they stay visible rather than blessed.
 *  6. `.eq(...)` on a *shared* builder is the shape sought. A query CREATED inside
 *     the guarded branch (`if (b) { await svc.from(T)…eq(…) }`) is fail-CLOSED —
 *     the falsy path yields nothing — and is deliberately NOT reported. Control 4
 *     pins that so the exclusion cannot silently widen.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { blankComments } from "./strip-comments"

const root = process.cwd()
const baselinePath = join(root, "scripts", "conditional-tenant-predicate-baseline.json")

/** Roots scanned. `scripts/` is excluded — see blind spot 1. */
const SCAN_DIRS = ["app", "lib", "services", "components", "hooks", "contexts", "workflows", "tools"]

/**
 * WHY EACH SURVIVING SITE IS STILL HERE. Keyed by the same `path :: identifier`
 * the baseline uses. Three verdicts, and the distinction is the whole point:
 *
 *  · platform  — the null genuinely means "every tenant", and ONLY a caller with
 *                proven platform authority can produce it. The reason names the proof.
 *  · anchored  — the same chain carries a primary key or an entity id, so the row
 *                is already named and the missing brokerage predicate cannot widen
 *                the result across tenants.
 *  · unresolved— the caller set could not be established. Recorded as unresolved
 *                rather than guessed (CLAUDE.md §1).
 */
type Verdict = "platform" | "anchored" | "unresolved"
export const CLASSIFICATION: Record<string, { verdict: Verdict; why: string }> = {
  // ── platform: only a platform-authorised caller can produce the null ────────
  "lib/analytics/prediction-accuracy.ts :: brokerageId": {
    verdict: "platform",
    why: "Every adapter is reached only through getPredictionAccuracyReport. Two callers: app/dashboard/superadmin/platform/page.tsx behind requireSuperadmin() passes no brokerageId (platform); app/dashboard/analytics/page.tsx calls it only inside `if (profile?.brokerage_id)`, so the tenant path can never pass a null.",
  },
  "lib/analytics/assignment-outcomes.ts :: brokerageId": {
    verdict: "platform",
    why: "loadPolicyOutcomeInputs is reached through assignmentPolicyAdapter, which getPredictionAccuracyReport calls with the same id as every other rail — same two gated callers as prediction-accuracy above.",
  },
  "lib/kernel/write-sentinel.ts :: brokerageId": {
    verdict: "platform",
    why: "loadSentinelLosses callers are app/dashboard/superadmin/continuity/page.tsx (superadmin board) and lib/kernel/repair-digest.ts (the platform weekly digest). Both omit the id deliberately: the surface is the platform's own write-loss ledger.",
  },
  "lib/kernel/self-heal-ledger.ts :: brokerageId": {
    verdict: "platform",
    why: "loadSelfHealRollup's action caller refuses first — app/actions/self-heal-rollup.ts returns 'No brokerage on user' before calling — and lib/kernel/week-in-review.ts passes the agent row's own brokerage_id. The null lane is the platform digest.",
  },
  "lib/property-alerts/alert-engine.ts :: brokerageId": {
    verdict: "platform",
    why: "runAllActiveAlerts' only caller is app/api/property-alerts/run/route.ts, a CRON_SECRET-gated sweep. Omitting the id is the platform-wide run. THAT GATE WAS ITSELF FAIL-OPEN and was fixed in the same lane: it read `if (cronSecret && authHeader !== …)`, so an UNSET CRON_SECRET skipped the check entirely and an anonymous POST could sweep every tenant (or name one in the body). It now returns 404 on an unset secret, the rule already in force at app/api/webhooks/sendgrid-events/route.ts.",
  },
  "lib/fatigue/fatigue-calculator.ts :: brokerageId": {
    verdict: "platform",
    why: "calculateAllBuyerFatigue's only caller is app/api/fatigue/calculate/route.ts, which refuses on a wrong x-cron-secret before reading the body. Omitting brokerageId is the platform sweep.",
  },
  "lib/video/living-video-sweep.ts :: opts.brokerageId": {
    verdict: "platform",
    why: "refreshLivingVideos is called only from app/api/cron/composition-render-queue/route.ts with { limit: 200 } — a cron sweep across every tenant's living videos, by design.",
  },
  "lib/remotion/render-cache.ts :: opts.brokerageId": {
    verdict: "platform",
    why: "sweepDeterminismLeaks is called only from app/api/cron/composition-render-queue/route.ts with { limit: 200 } — the platform's determinism sweep.",
  },
  "lib/workflow/intelligence/proactive-checks.ts :: input.brokerageId": {
    verdict: "platform",
    why: "scanContingenciesNearingDeadline is called only from app/api/cron/contingency-scan/route.ts with { withinDays: 3 } — a cron sweep over every tenant's open contracts.",
  },
  "lib/kernel/scraping.ts :: params.brokerageId": {
    verdict: "platform",
    why: "runScrapeSourcesChronologically is the lead-scrape cron entry point; the unscoped run is the platform sweep. NOT TOUCHED BY THIS LANE — lead-acquisition code is explicitly out of scope ('any lead scrapping needs to be left alone').",
  },
  "app/api/cron/health-check/route.ts :: targetBrokerageId": {
    verdict: "platform",
    why: "The route refuses any request without a matching x-cron-secret before reading targetBrokerageId. Omitting it checks every tenant's service_status, which is the health check's purpose.",
  },
  "app/api/leads/raw/route.ts :: brokerageId": {
    verdict: "platform",
    why: "requirePlatformStaffAuth(supabase) runs before the query and returns its own 403 response on failure. Only platform staff reach the unscoped read.",
  },
  "app/api/webhooks/sendgrid-events/route.ts :: eventBrokerageId": {
    verdict: "platform",
    why: "SECRET-gated webhook with an unresolvable tenant, MITIGATED IN PLACE: both sites take limit(2)/limit(5) and require a single distinct brokerage_id across the candidates before using the match. Ambiguity yields nothing. This is the precedent the four social webhooks were converted onto in this lane.",
  },
  "app/api/webhooks/linkedin/route.ts :: brokerageId": {
    verdict: "platform",
    why: "Secret/signature-gated webhook whose tenant is unresolvable when the receiving account is not mapped. Converted in this lane to the sendgrid rule: limit(2) + one distinct tenant or nothing; unresolved falls through to the staging insert with a null tenant.",
  },
  "app/api/webhooks/meta/route.ts :: brokerageId": {
    verdict: "platform",
    why: "Same conversion as linkedin — limit(2) + one distinct tenant or nothing.",
  },
  "app/api/webhooks/twitter/route.ts :: brokerageId": {
    verdict: "platform",
    why: "Same conversion as linkedin — limit(2) + one distinct tenant or nothing.",
  },
  "app/api/webhooks/whatsapp/route.ts :: brokerageId": {
    verdict: "platform",
    why: "Same conversion as linkedin, on BOTH the metadata match and the last-10-digit phone ilike — the fuzzy one matters more, since an ilike is not an identity.",
  },
  // RESOLVED AND REMOVED (owner ruling 2, 2026-08-24) —
  // "app/api/webhooks/inbound-suppression/route.ts :: payload.brokerageId" (2 → 0).
  // See the ruling block in this file's header. The body-supplied tenant is gone and
  // the fuzzy match now refuses on ambiguity, so there is no predicate left to classify.
  "lib/kernel/command-center.ts :: brokerageId": {
    verdict: "platform",
    why: "CONVERTED IN THIS LANE. loadCommandCenter now resolves a TenantScope up front (resolveTenantScope) and applies it with applyTenantScope; the platform lane requires an explicit `platform: { reason }`. The residual matches here are the applyTenantScope call sites, which carry no truthiness test — see the count move in the lane report.",
  },
  "app/actions/open-house.ts :: ctx.brokerageId": {
    verdict: "platform",
    why: "Both sites are the middle arm of an if/else-if chain whose FINAL else refuses ('deny rather than expose all events/listings via service client'). The falsy path never reaches an unscoped query. The finder cannot see a refusing else; the reason is recorded here instead.",
  },
  "lib/kernel/0.1-feature-access.ts :: brokerageId": {
    verdict: "platform",
    why: "disableFeatureFor returns early unless at least one of userId/brokerageId/teamId is set, and the three predicates are an if/else-if chain — so the DELETE always carries exactly one scope, and user_id/team_id are globally unique.",
  },
  "services/supabaseService.ts :: brokerageId": {
    verdict: "platform",
    why: "CONVERTED IN THIS LANE. getContacts/getTransactions now THROW without a scope, matching getCommissions/getBusinessExpenses in the same file; getAllContacts() (a no-argument call into the service-role reader, zero callers) is deleted with a tombstone naming getContacts as the survivor.",
  },
  "services/supabaseService.ts :: filters.brokerageId": {
    verdict: "platform",
    why: "CONVERTED IN THIS LANE. getVideoPerformanceTracking now throws unless one of brokerageId/videoAssetId/videoProjectId is supplied.",
  },
  "services/supabaseService.ts :: scope.brokerageId": {
    verdict: "platform",
    why: "getCommissions/getBusinessExpenses already threw without a scope — this is the survivor pattern the three above were converted onto.",
  },

  // ── anchored: the chain already names the row ───────────────────────────────
  "app/actions/ai-isa/handle-inbound-email.ts :: callerBrokerageId": {
    verdict: "anchored",
    why: "Both chains carry .eq('id', params.leadId) — a primary key. The brokerage predicate narrows an already-named row; dropping it cannot widen the result set beyond that one lead.",
  },
  "app/actions/buyer-offer-tools.ts :: expectBrokerageId": {
    verdict: "anchored",
    why: "The chain carries .eq('id', contactId) — contacts PRIMARY key. Dropping the tenant predicate returns at most that one contact, and the function's own header says the gate's brokerage_id is applied 'too'.",
  },
  "app/actions/listing-lifecycle-core.ts :: brokerageId": {
    verdict: "anchored",
    why: ".eq('id', listingId) is in the chain, and the file's own comment states the RLS client already scopes this — the explicit filter is defence for a future service-role client.",
  },
  "lib/contact-promotion/history-carry.ts :: brokerageId": {
    verdict: "anchored",
    why: "Both UPDATEs carry .eq('lead_id', leadId) plus .is('contact_id', null). A lead id names rows belonging to exactly one brokerage, so the re-point/move cannot cross a tenant boundary even with the predicate absent.",
  },
  "lib/buyer-broker/gate.ts :: params.brokerageId": {
    verdict: "anchored",
    why: "The chain carries .eq('agent_id', params.agentId) — an agents.id the caller established — so the BBA lookup is already inside one agent's book.",
  },
  "lib/lifetime-customer-npv/current.ts :: q.brokerageId": {
    verdict: "anchored",
    why: "The chain carries .eq('agent_id', q.agentId) (a users.id, per the module header). The file's own comment already states an agent id alone is not a tenant boundary; kept visible rather than blessed.",
  },
  "lib/application/transactions.ts :: brokerageId": {
    verdict: "anchored",
    why: "getTransactionStats reads through `await createClient()` — the SESSION (RLS) client, not the service client — so the tenant boundary is enforced by RLS even when the predicate is dropped. Defence-in-depth only; not a cross-tenant read.",
  },
  "app/actions/predictive-listing.ts :: params.brokerageId": {
    verdict: "anchored",
    why: "getTopPredictiveSellers reads through `await createClient()` (session/RLS client). Its one caller, app/dashboard/agent/page.tsx, passes the viewer's own ids.",
  },
  "app/portal/vendor/page.tsx :: userRow.brokerage_id": {
    verdict: "anchored",
    why: "The chain carries .eq('email', userRow.email) where userRow is the AUTHENTICATED viewer's own users row — the vendor matched is the viewer.",
  },
  // RESOLVED AND REMOVED (owner ruling 3, 2026-08-24) —
  // "app/actions/listing-landing.ts :: brokerageId" (1 → 0). The owner's answer to
  // "not sure how that got figured in?" is that nothing did: an optional parameter
  // went unpassed. It is required now and the predicate is unconditional, so there
  // is no conditional predicate left to classify. Header block has the detail.
  // RESOLVED (owner ruling on shared vendors, 2026-08-24). The earlier entry read
  // "unresolved — whether marketplace vendors are genuinely multi-tenant is a
  // product question this lane could not settle from the tree." The owner settled
  // it: "vendors whcih include title companies and lenders can be used by other
  // brokerages". They ARE multi-tenant — which made the SERVICE-client caller a
  // real cross-tenant read rather than a theoretical one, so it was PINNED rather
  // than blessed: app/api/internal/ai-chat/route.ts now passes
  // lenderVendor.brokerageId, taken from the vendor's own row (never the request),
  // exactly as app/lender/documents/page.tsx and the TC/lender brief already did.
  "lib/kernel/lender-linkage.ts :: brokerageId": {
    verdict: "anchored",
    why: "lenderVendorTransactionIds(client, vendorId, brokerageId?) — the optional argument is CORRECT now that the owner has ruled vendors are shared across brokerages: 'every deal this lender vendor is on' is a legitimate question for a company that spans tenants. Every SERVICE-client caller pins it. The one remaining caller that omits it, app/(external-portal)/lender/transactions/page.tsx, reads through the SESSION (RLS) client, so vendor_assignments RLS is the tenant boundary there and the predicate is defence-in-depth. See lib/vendors/vendor-platform-identity.ts for the shared-vendor model and the boundary it must not cross.",
  },
  "lib/kernel/approval-sources.ts :: params.brokerageId": {
    verdict: "platform",
    why: "CONVERTED IN THIS LANE to take a TenantScope; its only caller is loadCommandCenter, which now resolves one.",
  },
}

// ─────────────────────────────────────────────────────────────────────────────

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(entry)) yield p
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const lineOf = (s: string, i: number) => s.slice(0, i).split("\n").length

/** `.eq("brokerage_id", <identifier or dotted path>)`. Blind spot 2 lives here. */
const EQ = /\.eq\(\s*(["'`])brokerage_id\1\s*,\s*([A-Za-z_$][\w$]*(?:\??\.[\w$]+)*)\s*\)/g

/**
 * Walk the postfix method chain LEFTWARDS from the `.` at `dotIdx` and report the
 * link names plus the chain's root identifier.
 *
 * WHY A WALK AND NOT "THE STATEMENT SO FAR". The discriminator this guard needs is
 * whether the `.eq()` continues a builder held in a VARIABLE (query runs either way)
 * or continues a FRESH `.from()` created inside the guarded branch (falsy path yields
 * nothing). Deciding that by slicing back to the previous `;`/`{`/`}` fails on this
 * codebase's semicolon-free style: with no statement terminator the slice runs back
 * to the enclosing brace and swallows an earlier `.from(`, so an in-place mutation
 * like `if (userId) deleteQuery.eq(…)` reads as a fresh query and goes UNSEEN.
 * Measured, not theorised — lib/kernel/0.1-feature-access.ts:443 disappeared from
 * the population exactly that way. The chain walk is terminator-independent.
 */
function chainBack(code: string, dotIdx: number): { links: string[]; root: string } {
  const links: string[] = []
  let i = dotIdx
  for (let guard = 0; guard < 400; guard++) {
    let j = i - 1
    while (j >= 0 && /\s/.test(code[j])) j--
    if (j < 0) return { links, root: "" }
    if (code[j] === ")" || code[j] === "]") {
      const open = code[j] === ")" ? "(" : "["
      const close = code[j]
      let depth = 0
      while (j >= 0) {
        if (code[j] === close) depth++
        else if (code[j] === open) { depth--; if (depth === 0) break }
        j--
      }
      j--
      while (j >= 0 && /\s/.test(code[j])) j--
    }
    const end = j
    while (j >= 0 && /[\w$]/.test(code[j])) j--
    if (end === j) return { links, root: "" }
    const name = code.slice(j + 1, end + 1)
    let k = j
    while (k >= 0 && /\s/.test(code[k])) k--
    if (code[k] === "." && code[k - 1] !== ".") { links.push(name); i = k; continue }
    return { links, root: name }
  }
  return { links, root: "" }
}

export interface Finding {
  /** The identifier whose truthiness gates the predicate. */
  ident: string
  line: number
  /** Which shape gated it — for the failure message. */
  shape: "if" | "ternary" | "&&"
}

/**
 * THE ONE PLACE THE VERDICT IS MADE, so the positive controls below judge the SAME
 * code that judges the repo. `raw` is a file's text exactly as read from disk.
 *
 * ── COMMENTS ARE BLANKED, NOT DELETED, AND THAT CHOICE IS DELIBERATE ─────────
 * Every position this function reports is computed from a match INDEX — the
 * truthiness window is `code.slice(idx - 320, idx)` and the chain walk steps
 * backwards through `code` character by character. stripComments() would delete
 * characters and shift every one of those offsets against the text they were
 * matched in; blankComments() replaces a comment with spaces, so line numbers AND
 * character offsets both survive (CLAUDE.md §2, and the note at the top of
 * scripts/strip-comments.ts). The cost is that a long comment sitting between the
 * `if` and the predicate spends the 320-character window on whitespace — blind
 * spot 4, and control 6 pins the comment case that matters: prose can never
 * MANUFACTURE a finding.
 */
export function conditionalPredicatesIn(raw: string): Finding[] {
  const out: Finding[] = []
  if (!raw.includes("brokerage_id")) return out
  const code = blankComments(raw)
  let m: RegExpExecArray | null
  EQ.lastIndex = 0
  while ((m = EQ.exec(code))) {
    const val = m[2]
    const leaf = val.split(/[.?]/).filter(Boolean).pop()!
    const T = `(?:${esc(val)}|${esc(leaf)})`
    const win = code.slice(Math.max(0, m.index - 320), m.index)

    let shape: Finding["shape"] | null = null
    if (
      new RegExp(`\\bif\\s*\\(\\s*${T}\\s*\\)\\s*\\{?[\\s\\S]{0,200}$`).test(win) ||
      new RegExp(`\\bif\\s*\\(\\s*${T}\\s*(?:!==|!=)\\s*(?:null|undefined)\\s*\\)\\s*\\{?[\\s\\S]{0,200}$`).test(win)
    ) shape = "if"
    else if (new RegExp(`${T}\\s*&&[^&;]{0,200}$`).test(win)) shape = "&&"
    else if (new RegExp(`${T}\\s*\\?[^?;]{0,200}$`).test(win)) shape = "ternary"
    if (!shape) continue

    // A query CREATED inside the guarded branch is fail-CLOSED — the falsy path
    // yields no rows at all — so only a SHARED builder counts. Blind spot 6.
    const { links } = chainBack(code, m.index)
    if (links.includes("from")) continue

    out.push({ ident: val, line: lineOf(code, m.index), shape })
  }
  return out
}

// ── POSITIVE CONTROLS ────────────────────────────────────────────────────────
// Two-sided on purpose. A finder that has stopped recognising the defect and a
// clean tree both report zero (CLAUDE.md §2), and a finder that flags everything
// is equally useless because the baseline stops meaning anything. Each control
// says what a failure would MEAN, not just that it failed.
{
  const controls: Array<{ name: string; src: string; expect: number; why: string }> = [
    {
      name: "the compliance-ledger shape IS flagged",
      expect: 1,
      why: "the finder no longer recognises the exact defect it was written for — its zero is meaningless",
      src: [
        'let q = svc.from("compliance_events").select("id, created_at")',
        '  .eq("gate_name", PREFLIGHT_GATE).gte("created_at", since)',
        '  .order("created_at", { ascending: false }).limit(1000)',
        'if (brokerageId) q = q.eq("brokerage_id", brokerageId)',
        "const { data } = await q",
      ].join("\n"),
    },
    {
      name: "an IN-PLACE mutation under the same guard IS flagged (no reassignment)",
      expect: 1,
      why: "postgrest builders mutate, so `q.eq(...)` with no `q =` applies the filter just the same — missing this hid lib/kernel/command-center.ts's seven queries",
      src: [
        'const sessionsQuery = supabase.from("managed_agent_sessions").select("id").limit(50)',
        'if (brokerageId) sessionsQuery.eq("brokerage_id", brokerageId)',
        "const { data } = await sessionsQuery",
      ].join("\n"),
    },
    {
      name: "an UNCONDITIONAL tenant predicate is NOT flagged",
      expect: 0,
      why: "the finder is accusing correctly-scoped code — every honest query in the repo would land in the baseline and the baseline would stop meaning anything",
      src: [
        'const { data } = await svc.from("contacts").select("id")',
        '  .eq("brokerage_id", brokerageId)',
        '  .eq("status", "active")',
      ].join("\n"),
    },
    {
      name: "a query CREATED inside the guarded branch is NOT flagged (fail-closed)",
      expect: 0,
      why: "the fail-closed shape is being reported as the fail-open one; the falsy path here yields no rows at all, which is the correct behaviour",
      src: [
        "if (brokerageId) {",
        '  const { data } = await supabase.from("calendar_events").select("id")',
        '    .eq("brokerage_id", brokerageId).limit(5)',
        "  upcoming = data ?? []",
        "}",
      ].join("\n"),
    },
    {
      name: "a ternary whose false arm yields an EMPTY result is NOT flagged",
      expect: 0,
      why: "same fail-closed shape in ternary form — `b ? query : Promise.resolve({data: []})` runs no query at all when b is falsy",
      src: [
        "const res = brokerageId",
        '  ? supabase.from("leads").select("id").eq("brokerage_id", brokerageId).limit(20)',
        "  : Promise.resolve({ data: [] })",
      ].join("\n"),
    },
    {
      name: "the shape written ONLY IN A COMMENT is NOT flagged",
      expect: 0,
      why: "prose is manufacturing findings — a guard that a comment can talk INTO reporting is as broken as one a comment can talk out of it",
      src: [
        "// The old body read:",
        '//   if (brokerageId) q = q.eq("brokerage_id", brokerageId)',
        "// and that is exactly what this rewrite removes.",
        'const { data } = await q.eq("brokerage_id", scope.brokerageId)',
      ].join("\n"),
    },
    {
      name: "the FIXED form — applyTenantScope(q, scope) — is NOT flagged",
      expect: 0,
      why: "the repair does not read as repaired, so converting a site would leave it in the population and nobody could tell fixed from unfixed",
      src: [
        'const q = svc.from("compliance_events").select("id").limit(1000)',
        "const { data } = await applyTenantScope(q, scope)",
      ].join("\n"),
    },
  ]

  let bad = false
  console.log("── CONDITIONAL-TENANT-PREDICATE · controls ──")
  for (const c of controls) {
    const got = conditionalPredicatesIn(c.src).length
    if (got === c.expect) console.log(`  ✓ control · ${c.name}`)
    else {
      bad = true
      console.log(`  ✗ CONTROL FAILED · ${c.name} — expected ${c.expect}, got ${got}`)
      console.log(`      ${c.why}`)
    }
  }
  if (bad) {
    console.log(" ❌ CONDITIONAL_TENANT_PREDICATE_CONTROL_FAIL — the finder cannot prove it still works, so its count means nothing")
    process.exit(1)
  }
}

// ── THE SCAN ─────────────────────────────────────────────────────────────────
const found = new Map<string, number>()
const locations = new Map<string, string[]>()
let scanned = 0
for (const dir of SCAN_DIRS) {
  for (const abs of walk(join(root, dir))) {
    scanned++
    const rel = relative(root, abs)
    for (const f of conditionalPredicatesIn(readFileSync(abs, "utf8"))) {
      const key = `${rel} :: ${f.ident}`
      found.set(key, (found.get(key) ?? 0) + 1)
      const list = locations.get(key) ?? []
      list.push(`${rel}:${f.line} (${f.shape})`)
      locations.set(key, list)
    }
  }
}

const baseline: Record<string, number> = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : {}

if (process.env.CONDITIONAL_TENANT_PREDICATE_BASELINE === "1") {
  const next: Record<string, number> = {}
  for (const k of [...found.keys()].sort()) next[k] = found.get(k)!
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n")
  console.log(`\n  ↻ baseline rewritten — ${Object.keys(next).length} site group(s), ${[...found.values()].reduce((a, b) => a + b, 0)} predicate(s)`)
  process.exit(0)
}

const total = [...found.values()].reduce((a, b) => a + b, 0)
const baseTotal = Object.values(baseline).reduce((a, b) => a + b, 0)

const failures: string[] = []
let added = 0
for (const [key, count] of found) {
  const allowed = baseline[key] ?? 0
  if (count > allowed) {
    added += count - allowed
    failures.push(`${key} — ${count} conditional tenant predicate(s), baseline ${allowed}\n         at ${(locations.get(key) ?? []).join(", ")}`)
  }
}
let shrunk = 0
const gone: string[] = []
for (const [key, allowed] of Object.entries(baseline)) {
  const now = found.get(key) ?? 0
  if (now < allowed) { shrunk += allowed - now; gone.push(`${key} (${allowed} → ${now})`) }
}

// The classification is part of the MEASUREMENT, not commentary: a baselined site
// with no recorded reason is an unexamined site, and the guard says so.
const unexplained = [...found.keys()].filter((k) => !CLASSIFICATION[k])

console.log(`\n── CONDITIONAL-TENANT-PREDICATE GUARD ──`)
console.log(`  ${scanned} files scanned across ${SCAN_DIRS.join(", ")} (scripts/ excluded — see blind spot 1)`)
console.log(`  ${total} conditional tenant predicate(s) in ${found.size} site group(s) · baseline ${baseTotal}`)
{
  const counts = { platform: 0, anchored: 0, unresolved: 0 } as Record<Verdict, number>
  for (const [k, n] of found) { const c = CLASSIFICATION[k]; if (c) counts[c.verdict] += n }
  console.log(`  classified: ${counts.platform} platform-authorised · ${counts.anchored} anchored by a co-predicate · ${counts.unresolved} UNRESOLVED`)
}
if (shrunk > 0) {
  console.log(`  ↓ ${shrunk} predicate(s) fixed — run CONDITIONAL_TENANT_PREDICATE_BASELINE=1 to tighten:`)
  for (const g of gone) console.log(`     - ${g}`)
}
if (unexplained.length > 0) {
  console.log(`  ✗ ${unexplained.length} site group(s) carry NO entry in CLASSIFICATION — an unexamined conditional tenant predicate:`)
  for (const u of unexplained) console.log(`     - ${u}`)
}
if (added > 0) {
  console.log(`  ✗ ${added} NEW conditional tenant predicate(s):`)
  for (const f of failures) console.log(`     - ${f}`)
  console.log("     Use lib/kernel/tenant-scope.ts: tenantScope(id, where) refuses a null,")
  console.log("     platformScope(reason) makes the cross-tenant read something you WROTE DOWN.")
}
if (added > 0 || unexplained.length > 0) {
  console.log(" ❌ CONDITIONAL_TENANT_PREDICATE_FAIL — a missing tenant id must not decay into 'every tenant'")
  process.exit(1)
}
console.log(" ✅ CONDITIONAL_TENANT_PREDICATE_PASS — the optional-tenant-predicate surface can only shrink")
