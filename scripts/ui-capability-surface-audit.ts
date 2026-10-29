#!/usr/bin/env tsx
/**
 * scripts/ui-capability-surface-audit.ts   (npm run test:ui-capability-surface — pure, no DB, no network)
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY ROLE'S JOURNEYS, ON THEIR REAL SURFACES — DERIVED, NOT DECLARED.
 *
 * Owner ruling 18 (2026-10-29): "All capabilities at all levels. Platform, tenants and their
 * users/customers, vendors; website/landing pages/lead magnets, lead acquisition, record
 * dedup/enrichment/behavioural intent, listings, properties, forms, transactions, closings,
 * portals/dashboards/login/onboarding, vendor marketplace, education, agent referral/recruiting/
 * agreements/gamification incl. rewards/share. Validate each on its real surface." Lane 146H's brief:
 * "record BUILT / PARTIAL / UNWIRED / MISSING per journey with the screen and the action behind it".
 *
 * WHAT IT DERIVES (every population READ from the tree, never listed by hand — CLAUDE.md §2):
 *   · the ROLES' SURFACES: `NAVIGATION_BY_ROLE` (app/config/navigation-config.ts — sidebar incl.
 *     children, top nav, mobile bottom nav, command palette) for every staff and external persona;
 *     the contact's real surface is the portal's own pages (app/portal/[contactId]/** — the app shell
 *     bypasses /portal, app/components/layout/app-shell.tsx); platform prospects and the public are
 *     every page whose route `classifyProxyPath` (app/constants/auth.ts) does not protect;
 *   · each href → its page.tsx (route groups dropped, dynamic / catch-all segments matched, next.config
 *     redirects and ROUTE_ALIASES honoured);
 *   · the ACTION BEHIND each screen: a breadth-first walk of the page's local imports (app/**, ui
 *     primitives and api excluded, depth ≤ 6) collecting server actions (`app/actions/**` or a
 *     "use server" module, with the names imported), `fetch("/api/…")` literals, server-side reads
 *     (a supabase client + `.from(`) and lib data modules;
 *   · the VERDICT: BUILT (the screen reaches a data path) · PARTIAL (it reaches one but says so
 *     honestly that a part is not available / not configured) · UNWIRED (interactive controls, no data
 *     path) · STATIC (informational, no controls, no data — not a defect) · REDIRECT (follows its
 *     target) · MISSING (no page). Dead CONTROLS inside a BUILT screen are test:ui-wiring-census's
 *     (hard zero on every journey); this audit is the role × domain × surface layer above it.
 *   · the ROLE × DOMAIN matrix over the ruling-18 domains, and the EXPECTED coverage gaps — a role the
 *     ruling names with no surface in a domain it should reach. Every gap must sit in KNOWN_GAPS with
 *     the owning lane and the reason; a NEW gap fails.
 *
 * --write-doc regenerates docs/architecture/CAPABILITY-SURFACE-AUDIT.md; without it the guard fails when
 * the committed document disagrees with the derivation (the doc can never drift from the code).
 *
 * BLIND SPOTS (published beside the numbers, §2):
 *   · reachability is LEXICAL: an action reached only through a prop callback defined in another page,
 *     a registry lookup or a computed import is invisible (the screen then reads UNWIRED/STATIC — an
 *     under-claim, never an over-claim);
 *   · BUILT means "a data path exists", not "every control works" — that is test:ui-wiring-census;
 *   · role ACCESS on the page itself (a page gate that refuses a role its nav links) is
 *     test:page-role-gate-roster's; this audit does not re-read gates;
 *   · PARTIAL is detected from honest-state copy ("not available yet", "not configured", "coming
 *     soon" as a feature state) — a screen that is partial without saying so reads BUILT;
 *   · dynamic hrefs (template literals) are not navigation entries and are not audited.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { stripComments, stringLiterals } from "./strip-comments"
import { walkTs } from "./runtime-roots"
import { journeyOf, underPrefix } from "./ui-journeys"
import { NAVIGATION_BY_ROLE } from "../app/config/navigation-config"
import { classifyProxyPath } from "../app/constants/auth"
import { ROUTE_ALIASES } from "../app/routes-compatibility"

const ROOT = process.cwd()
const DOC_PATH = join(ROOT, "docs", "architecture", "CAPABILITY-SURFACE-AUDIT.md")
const WRITE_DOC = process.argv.includes("--write-doc")
let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const rel = (abs: string) => abs.slice(ROOT.length + 1).replace(/\\/g, "/")

// ── ruling-18 domains (+ the supporting domains every role's nav also reaches) ─────────────────────
/** Longest matching page-file prefix wins. The first thirteen are the owner's ruling-18 list, verbatim
 *  in order; the rest name the surrounding OS so no surface is left unclassified. */
export const DOMAINS: Array<{ name: string; ruling18: boolean; prefixes: string[] }> = [
  { name: "website · landing pages · lead magnets", ruling18: true, prefixes: ["app/site", "app/team", "app/p", "app/lm", "app/blog", "app/embed", "app/widget", "app/v", "app/page.tsx", "app/pricing", "app/trust", "app/privacy", "app/legal", "app/demo", "app/dashboard/marketing/lead-magnets", "app/dashboard/marketing/video-pages", "app/dashboard/marketing/seo", "app/dashboard/settings/branding", "app/dashboard/settings/embeds", "app/dashboard/settings/widget", "app/settings/branding", "app/components/features/lead-magnets"] },
  { name: "lead acquisition", ruling18: true, prefixes: ["app/leads", "app/dashboard/acquisition", "app/dashboard/admin/lead-intake", "app/qr", "app/home-value", "app/buyer-intake", "app/dashboard/tools/home-value", "app/dashboard/agent/qr-codes", "app/dashboard/agent/business-cards", "app/open-house", "app/dashboard/admin/visitor-tracking", "app/dashboard/admin/farm-intelligence", "app/dashboard/admin/scrape-diagnostics", "app/dashboard/isa", "app/dashboard/ai-isa"] },
  { name: "dedup · enrichment · behavioural intent", ruling18: true, prefixes: ["app/dashboard/admin/data-health", "app/dashboard/admin/lead-lineage", "app/dashboard/admin/import", "app/dashboard/patterns", "app/dashboard/sphere", "app/sphere", "app/intelligence", "app/dashboard/intelligence", "app/dashboard/admin/transaction-propensity", "app/dashboard/stale", "app/dashboard/wealth", "app/dashboard/admin/intelligence-mesh"] },
  { name: "listings", ruling18: true, prefixes: ["app/dashboard/listings", "app/listings", "app/listing", "app/dashboard/listing-appointments", "app/dashboard/open-house", "app/dashboard/open-houses"] },
  { name: "properties", ruling18: true, prefixes: ["app/properties", "app/search", "app/dashboard/cma", "app/dashboard/market-insights", "app/portal/[contactId]/search", "app/portal/[contactId]/properties"] },
  { name: "forms", ruling18: true, prefixes: ["app/forms", "app/dashboard/forms", "app/dashboard/admin/forms", "app/dashboard/admin/transaction-forms", "app/dashboard/documents", "app/documents", "app/portal/[contactId]/documents", "app/vendor/documents", "app/lender/documents", "app/title/documents"] },
  { name: "transactions", ruling18: true, prefixes: ["app/transactions", "app/dashboard/transactions", "app/transaction", "app/offers", "app/dashboard/offers", "app/dashboard/coordinator", "app/portal/[contactId]/transaction", "app/portal/[contactId]/offers", "app/portal/[contactId]/my-offer", "app/lender/pipeline", "app/lender/transactions", "app/lender/approvals", "app/lender/underwriting", "app/title/orders", "app/title/status", "app/vendor/jobs"] },
  { name: "closings", ruling18: true, prefixes: ["app/dashboard/transactions/closing-concierge", "app/dashboard/transactions/[id]/cda", "app/title/closing", "app/dashboard/financials/cda", "app/dashboard/financials/commissions", "app/dashboard/financials/payouts"] },
  { name: "portals · dashboards · login · onboarding", ruling18: true, prefixes: ["app/portal", "app/(external-portal)", "app/login", "app/signup", "app/get-started", "app/onboarding", "app/auth", "app/vendor-invite", "app/dashboard/page.tsx", "app/dashboard/onboarding", "app/dashboard/getting-started", "app/dashboard/agent/page.tsx", "app/dashboard/brokerage", "app/dashboard/briefing", "app/vendor/dashboard", "app/lender/dashboard", "app/title/dashboard", "app/dashboard/superadmin/platform", "app/dashboard/whats-new", "app/notifications"] },
  { name: "vendor marketplace", ruling18: true, prefixes: ["app/dashboard/vendors", "app/vendor", "app/dashboard/admin/vendor-approvals", "app/dashboard/superadmin/vendors", "app/dashboard/partners", "app/referral-partners", "app/portal/[contactId]/vendors", "app/transaction/vendors"] },
  { name: "education", ruling18: true, prefixes: ["app/academy", "app/dashboard/education", "app/dashboard/coaching", "app/dashboard/admin/education", "app/dashboard/admin/learning-modules", "app/dashboard/onboarding/training", "app/dashboard/onboarding/mentorship", "app/portal/[contactId]/learn", "app/portal/[contactId]/resources"] },
  { name: "agent referral · recruiting · agreements · gamification", ruling18: true, prefixes: ["app/dashboard/agent/refer", "app/dashboard/agent/referral-network", "app/recruiting", "app/dashboard/recruiting-roi", "app/referrals", "app/dashboard/referrals", "app/dashboard/financials/agreements", "app/dashboard/challenges", "app/dashboard/leaderboard", "app/dashboard/motivation", "app/dashboard/goals", "app/dashboard/agent/first-deal", "app/gifts", "app/dashboard/gifts", "app/portal/[contactId]/referrals", "app/dashboard/superadmin/affiliates", "app/dashboard/agent/roi"] },
  { name: "CRM · contacts · lifetime", ruling18: false, prefixes: ["app/crm", "app/dashboard/buyers", "app/lifetime-customers", "app/past-clients", "app/dashboard/showings", "app/showings", "app/tasks", "app/dashboard/tasks", "app/calendar", "app/dashboard/calendar", "app/dashboard/buyer-broker-agreements", "app/credit-pipeline", "app/dashboard/credit-pipeline"] },
  { name: "marketing · media · communications · AI", ruling18: false, prefixes: ["app/dashboard/marketing", "app/dashboard/campaigns", "app/dashboard/social", "app/social-planner", "app/dashboard/content", "app/content-studio", "app/dashboard/video", "app/dashboard/videos", "app/newsletters", "app/dashboard/communications", "app/dashboard/inbox", "app/dashboard/chat", "app/dashboard/voice", "app/dashboard/voice-intelligence", "app/dashboard/ai-tools", "app/dashboard/ai-quality", "app/video-assistant", "app/mobile", "app/dashboard/admin/marketing-approvals", "app/dashboard/admin/marketing-campaigns", "app/dashboard/admin/content-studio", "app/dashboard/admin/campaign-center", "app/dashboard/reputation", "app/reviews"] },
  { name: "compliance · approvals", ruling18: false, prefixes: ["app/compliance", "app/dashboard/compliance", "app/approvals", "app/dashboard/admin/compliance", "app/dashboard/admin/compliance-ledger", "app/dashboard/admin/compliance-eval", "app/dashboard/admin/approvals", "app/dashboard/admin/ai-audit", "app/dashboard/admin/privacy"] },
  { name: "financials · billing", ruling18: false, prefixes: ["app/dashboard/financials", "app/financials", "app/dashboard/income-truth", "app/dashboard/admin/fees", "app/dashboard/admin/billing", "app/settings/billing", "app/dashboard/admin/usage", "app/dashboard/superadmin/subscriptions", "app/dashboard/superadmin/contracts", "app/dashboard/superadmin/plans", "app/dashboard/superadmin/coupons", "app/dashboard/superadmin/usage-reports", "app/vendor/earnings", "app/vendor/invoices", "app/vendor/billing", "app/vendor/plans", "app/portal/[contactId]/invoices"] },
  { name: "operations · managers · reports", ruling18: false, prefixes: ["app/dashboard/operations", "app/dashboard/coordination", "app/dashboard/system", "app/dashboard/diagnosis", "app/dashboard/jobs", "app/workflows", "app/dashboard/admin", "app/dashboard/superadmin", "app/dashboard/reports", "app/dashboard/reporting", "app/dashboard/analytics", "app/analytics", "app/dashboard/insights", "app/dashboard/intelligence-report", "app/dashboard/team-heatmap", "app/dashboard/overdue", "app/dashboard/meetings", "app/admin"] },
  { name: "settings · people · support", ruling18: false, prefixes: ["app/settings", "app/dashboard/settings", "app/dashboard/profile", "app/dashboard/team", "app/dashboard/teams", "app/dashboard/admin/users", "app/dashboard/help", "app/support", "app/dashboard/support", "app/vendor/settings", "app/lender/settings", "app/title/settings", "app/portal/[contactId]/settings", "app/portal/[contactId]/help", "app/dashboard/calculators", "app/dashboard/tools"] },
]
export function domainOf(pageFile: string): string {
  let best: { name: string; len: number } | null = null
  for (const d of DOMAINS) for (const p of d.prefixes) if ((pageFile === p || underPrefix(pageFile, p)) && (!best || p.length > best.len)) best = { name: d.name, len: p.length }
  if (best) return best.name
  const j = journeyOf(pageFile)
  return j ? `(journey) ${j}` : "(unclassified)"
}

// ── roles ─────────────────────────────────────────────────────────────────────
/** The ruling-18 levels, each with the nav roles that carry it. */
export const ROLE_GROUPS: Array<{ name: string; navRoles: string[]; derived?: "public" | "portal" }> = [
  { name: "platform staff", navRoles: ["superadmin"] },
  { name: "platform prospects · public", navRoles: [], derived: "public" },
  { name: "tenant admins", navRoles: ["broker", "admin"] },
  { name: "teams · team leads", navRoles: ["team_lead"] },
  { name: "agents", navRoles: ["agent"] },
  { name: "ISA", navRoles: ["isa"] },
  { name: "transaction coordinators", navRoles: ["tc"] },
  { name: "compliance officers", navRoles: ["compliance_officer"] },
  { name: "buyers · sellers · lifetime contacts", navRoles: ["contact"], derived: "portal" },
  { name: "vendors · partners", navRoles: ["vendor", "lender", "title_agent"] },
]

/** Where ruling 18 expects each level to reach. A level/domain pair here with no surface is a GAP. */
export const EXPECTED: Record<string, string[]> = {
  "platform staff": ["portals · dashboards · login · onboarding", "vendor marketplace", "education", "lead acquisition", "dedup · enrichment · behavioural intent", "agent referral · recruiting · agreements · gamification"],
  "platform prospects · public": ["website · landing pages · lead magnets", "portals · dashboards · login · onboarding", "lead acquisition", "listings", "properties", "forms"],
  "tenant admins": DOMAINS.filter((d) => d.ruling18).map((d) => d.name),
  "teams · team leads": ["listings", "transactions", "closings", "education", "agent referral · recruiting · agreements · gamification", "portals · dashboards · login · onboarding", "lead acquisition"],
  "agents": ["website · landing pages · lead magnets", "lead acquisition", "listings", "properties", "forms", "transactions", "closings", "portals · dashboards · login · onboarding", "vendor marketplace", "education", "agent referral · recruiting · agreements · gamification"],
  "buyers · sellers · lifetime contacts": ["portals · dashboards · login · onboarding", "properties", "forms", "transactions", "education", "vendor marketplace", "agent referral · recruiting · agreements · gamification"],
  "vendors · partners": ["portals · dashboards · login · onboarding", "transactions", "forms", "vendor marketplace"],
}

/**
 * Expected pairs with no surface at HEAD, each with its owner and reason. A gap NOT listed here fails;
 * an entry whose gap has closed fails too (it can never outlive the gap it names).
 */
export const KNOWN_GAPS: Record<string, { owner: string; why: string }> = {}

/**
 * Public pages that link an ANONYMOUS visitor into a page the proxy protects (the visitor meets /login),
 * keyed by the linked href. MEASURED 2026-10-29 (lane 146H): the public listing page app/listings/
 * [listingId]/page.tsx — the target of every QR "View the listing" / "Book a time" code
 * (lib/marketing/qr-contract.ts listing_detail) and of the public agent profile's listing cards — sits
 * under PROTECTED_ROUTES '/listings' (app/constants/auth.ts), which lane 88E protected for the agent
 * listings BOARD. An entry here can never outlive its block (P2).
 */
export const KNOWN_PUBLIC_BLOCKS: Record<string, { owner: string; fix: string }> = {
  "/listings/x": { owner: "Outside-lane (lane 146H notes) — app/constants/auth.ts is security config, not presentation", fix: "classifyProxyPath: answer 'public' for /listings/<uuid> (a UUID-shaped single segment, so /listings and /listings/new stay protected) before the PROTECTED check; the page already gates on the row (public status) and reads through the service client (lane 146H)" },
}

// ── route index ───────────────────────────────────────────────────────────────
type Page = { file: string; segs: string[] }
const PAGES: Page[] = walkTs(join(ROOT, "app")).filter((f) => f.endsWith("/page.tsx")).map((abs) => {
  const f = rel(abs)
  // app/page.tsx (the root) has no inner path: slice(4, 3) is "" and its segments are [].
  const inner = f === "app/page.tsx" ? "" : f.slice("app/".length, f.length - "/page.tsx".length)
  const segs = inner.split("/").filter((s) => s && !(s.startsWith("(") && s.endsWith(")")))
  return { file: f, segs }
})
const routeOf = (p: Page) => "/" + p.segs.join("/")

/** next.config.ts redirect sources (literal prefixes; `:path*` tails accepted). */
const NEXT_REDIRECTS: Array<{ source: string; destination: string }> = (() => {
  const p = join(ROOT, "next.config.ts")
  if (!existsSync(p)) return []
  const code = stripComments(readFileSync(p, "utf8"))
  const out: Array<{ source: string; destination: string }> = []
  for (const m of code.matchAll(/source:\s*['"]([^'"]+)['"][\s\S]{0,200}?destination:\s*['"]([^'"]+)['"]/g)) out.push({ source: m[1], destination: m[2] })
  return out
})()

function matchSegs(pat: string[], path: string[]): number {
  // returns a specificity score (> 0) or -1
  let score = 0
  for (let i = 0; i < pat.length; i++) {
    const s = pat[i]
    if (/^\[\[\.\.\..+\]\]$/.test(s)) return score + 1
    if (/^\[\.\.\..+\]$/.test(s)) return path.length > i ? score + 1 : -1
    if (i >= path.length) return -1
    if (/^\[.+\]$/.test(s)) { score += 1; continue }
    if (s !== path[i]) return -1
    score += 10
  }
  return pat.length === path.length ? score + 5 : -1
}
export function resolveHref(href: string, depth = 0): { page: Page | null; via?: string } {
  const path = href.split(/[?#]/)[0].replace(/\/+$/, "") || "/"
  const segs = path.split("/").filter(Boolean)
  let best: { page: Page; score: number } | null = null
  for (const p of PAGES) { const s = matchSegs(p.segs, segs); if (s >= 0 && (!best || s > best.score)) best = { page: p, score: s } }
  if (best) return { page: best.page }
  if (depth < 3) {
    const alias = ROUTE_ALIASES[path]
    if (alias) { const r = resolveHref(alias, depth + 1); if (r.page) return { page: r.page, via: `alias → ${alias}` } }
    for (const r of NEXT_REDIRECTS) {
      const src = r.source.replace(/\/:path\*$/, "")
      if (path === src || (r.source.endsWith(":path*") && path.startsWith(src + "/"))) {
        const dest = r.destination.replace(/\/:path\*$/, path.slice(src.length))
        const t = resolveHref(dest, depth + 1)
        if (t.page) return { page: t.page, via: `next.config redirect → ${r.destination}` }
      }
    }
  }
  return { page: null }
}

// ── reach: the action behind a screen ─────────────────────────────────────────
type Reach = { actions: Map<string, Set<string>>; apis: Set<string>; serverRead: boolean; dataLibs: Set<string>; interactive: boolean; honestPartial: string | null; redirectTo: string | null; visited: number; links: Set<string> }
const fileCache = new Map<string, string>()
function readCode(abs: string): string {
  let c = fileCache.get(abs)
  if (c == null) { c = existsSync(abs) ? stripComments(readFileSync(abs, "utf8")) : ""; fileCache.set(abs, c) }
  return c
}
function resolveImport(fromAbs: string, spec: string): string | null {
  let base: string
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2))
  else if (spec.startsWith(".")) base = join(dirname(fromAbs), spec)
  else return null
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) { const p = base + ext; if (existsSync(p) && !p.endsWith("/")) { try { if (readFileSync(p)) return p } catch { /* a directory */ } } }
  return null
}
const isUseServer = (code: string) => /^\s*(?:["']use server["'])/.test(code)
const HONEST_PARTIAL = /not available yet|isn['’]t available yet|not yet available|not configured|isn['’]t configured|awaiting (?:configuration|credentials)|waiting on (?:the )?(?:provider|credentials)|coming soon to your/i
export function reachOf(pageAbs: string, maxDepth = 6): Reach {
  const r: Reach = { actions: new Map(), apis: new Set(), serverRead: false, dataLibs: new Set(), interactive: false, honestPartial: null, redirectTo: null, visited: 0, links: new Set() }
  const seen = new Set<string>([pageAbs])
  let frontier = [pageAbs]
  for (let d = 0; d <= maxDepth && frontier.length; d++) {
    const next: string[] = []
    for (const abs of frontier) {
      const code = readCode(abs)
      r.visited++
      if (d === 0) {
        const m = code.match(/\bredirect\(\s*["'`]([^"'`$]+)["'`]/)
        const hasJsx = /return\s*\(?\s*</.test(code) || /=>\s*\(?\s*</.test(code)
        if (m && !hasJsx) r.redirectTo = m[1]
      }
      if (/\bonClick=|\bonSubmit=|<form\b|onValueChange=|onCheckedChange=/.test(code)) r.interactive = true
      if (!r.honestPartial) for (const l of stringLiterals(code)) { const m = l.text.match(HONEST_PARTIAL); if (m) { r.honestPartial = m[0]; break } }
      if (!r.honestPartial) { const m = code.match(HONEST_PARTIAL); if (m) r.honestPartial = m[0] }
      // A supabase client used for a read, an auth call, storage or an RPC is a data path (server OR client — RLS governs the client).
      if (/\bcreate(?:Service|Server|Admin|Browser)?Client\(|\buseSupabase\(|\bsupabase\b/.test(code) && /\.(?:from|rpc)\(\s*["'`]|\.auth\.(?:updateUser|signIn\w*|signUp|resetPasswordForEmail|exchangeCodeForSession|verifyOtp)\(|\.storage\.from\(/.test(code)) r.serverRead = true
      for (const m of code.matchAll(/fetch\(\s*["'`](\/api\/[^"'`?$]+)/g)) r.apis.add(m[1])
      for (const m of code.matchAll(/(?:\bhref\s*[=:]\s*\{?\s*|router\.(?:push|replace)\(\s*)["'](\/[a-z][^"'#?\s]*)["']/g)) if (!m[1].startsWith("/api/")) r.links.add(m[1])
      // A template href with interpolated SEGMENTS (`/listings/${l.id}`) still names its route; each `${…}` is
      // read as one dynamic segment. A template whose FIRST segment is interpolated names no route and is skipped.
      for (const m of code.matchAll(/\bhref\s*=\s*\{\s*`(\/[a-z][^`]*)`\s*\}/g)) {
        const path = m[1].split(/[?#]/)[0].replace(/\$\{[^}]*\}/g, "x")
        if (!path.startsWith("/api/") && /^\/[a-z]/.test(path)) r.links.add(path)
      }
      const specs: Array<{ spec: string; names: string[] }> = []
      for (const m of code.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
        if (/^type\s/.test(m[0].replace(/^import\s+/, ""))) continue
        const names = (m[1].match(/\{([\s\S]*)\}/)?.[1] ?? "").split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean)
        specs.push({ spec: m[2], names })
      }
      for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.push({ spec: m[1], names: [] })
      for (const { spec, names } of specs) {
        const target = resolveImport(abs, spec)
        if (!target) continue
        const t = rel(target)
        if (t.startsWith("app/actions/") || (t.startsWith("app/") && isUseServer(readCode(target)))) {
          const set = r.actions.get(t) ?? new Set<string>()
          names.forEach((n) => set.add(n))
          r.actions.set(t, set)
          continue
        }
        if (t.startsWith("lib/")) {
          const lc = readCode(target)
          if (isUseServer(lc) || /\.from\(\s*["'`]/.test(lc)) r.dataLibs.add(t)
          continue
        }
        if (!t.startsWith("app/") || t.startsWith("app/components/ui/") || t.startsWith("app/api/")) continue
        if (!seen.has(target)) { seen.add(target); next.push(target) }
      }
    }
    frontier = next
  }
  return r
}
export type Verdict = "BUILT" | "PARTIAL" | "UNWIRED" | "STATIC" | "REDIRECT" | "MISSING"
/** MISSING has two kinds: no page serves the href (a dead link — A1 holds it at zero), or a page that says
 *  HONESTLY that the capability is not available yet and reaches no data (the ruling-16 honest state; the
 *  capability is missing and routed, the surface is not lying). */
export function verdictOf(r: Reach | null): Verdict {
  if (!r) return "MISSING"
  if (r.redirectTo) return "REDIRECT"
  const data = r.actions.size > 0 || r.apis.size > 0 || r.serverRead || r.dataLibs.size > 0
  if (data) return r.honestPartial ? "PARTIAL" : "BUILT"
  if (r.honestPartial) return "MISSING"
  return r.interactive ? "UNWIRED" : "STATIC"
}
const reachCache = new Map<string, Reach>()
function reachForPage(file: string): Reach {
  let r = reachCache.get(file)
  if (!r) { r = reachOf(join(ROOT, file)); reachCache.set(file, r) }
  return r
}
function behind(r: Reach): string {
  const parts: string[] = []
  const acts = [...r.actions.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 2)
  for (const [m, names] of acts) parts.push(`${m}${names.size ? ` (${[...names].slice(0, 3).join(", ")}${names.size > 3 ? ", …" : ""})` : ""}`)
  if (parts.length < 2) for (const a of [...r.apis].slice(0, 2 - parts.length)) parts.push(`fetch ${a}`)
  if (parts.length < 2) for (const l of [...r.dataLibs].slice(0, 2 - parts.length)) parts.push(l)
  if (!parts.length && r.serverRead) parts.push("server-side read in the page tree")
  return parts.join(" · ") || "—"
}

// ── the derivation ────────────────────────────────────────────────────────────
type Row = { role: string; domain: string; label: string; href: string; page: string | null; via?: string; verdict: Verdict; behind: string; partial?: string; hop: 0 | 1 }
function navItems(role: string): Array<{ label: string; href: string }> {
  const cfg = (NAVIGATION_BY_ROLE as Record<string, { sidebarItems?: any[]; topNavItems?: any[]; mobileBottomNav?: any[]; commandPaletteItems?: any[] }>)[role]
  if (!cfg) return []
  const out: Array<{ label: string; href: string }> = []
  const walk = (items: any[] | undefined) => { for (const it of items ?? []) { if (it?.href && typeof it.href === "string") out.push({ label: it.label ?? it.id, href: it.href }); walk(it?.children) } }
  walk(cfg.sidebarItems); walk(cfg.topNavItems); walk(cfg.mobileBottomNav); walk(cfg.commandPaletteItems)
  return out
}
export function derive(): { rows: Row[]; publicPages: string[]; portalPages: string[] } {
  const rows: Row[] = []
  const rowFor = (role: string, label: string, href: string, pageHint?: Page): Row => {
    const res = pageHint ? { page: pageHint } as { page: Page; via?: string } : resolveHref(href)
    if (!res.page) return { role, domain: "(unresolved)", label, href, page: null, verdict: "MISSING", behind: "—", hop: 0 }
    let r = reachForPage(res.page.file)
    let verdict = verdictOf(r)
    let via = res.via
    if (verdict === "REDIRECT" && r.redirectTo) {
      const t = resolveHref(r.redirectTo)
      if (t.page && t.page.file !== res.page.file) { const tr = reachForPage(t.page.file); const tv = verdictOf(tr); if (tv !== "REDIRECT") { verdict = tv; r = tr; via = `redirects → ${r === tr ? t.page.file : r.redirectTo}` } }
    }
    return { role, domain: domainOf(res.page.file), label, href, page: res.page.file, via, verdict, behind: behind(r), partial: r.honestPartial ?? undefined, hop: 0 }
  }
  for (const g of ROLE_GROUPS) {
    const seen = new Set<string>()
    for (const navRole of g.navRoles) for (const it of navItems(navRole)) {
      const key = it.href.split(/[?#]/)[0]
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(rowFor(g.name, it.label, it.href))
    }
  }
  // ONE HOP: a surface a nav screen links to with a literal href is reachable by that level too
  // (the platform console's page links its vendor / affiliate / growth consoles; a deal's CDA is a tab).
  // Hop rows count for coverage and verdicts; the journey table lists them under the screen that links them.
  const navRows = rows.slice()
  for (const g of ROLE_GROUPS) {
    const have = new Set(navRows.filter((r) => r.role === g.name && r.page).map((r) => r.page as string))
    for (const r of navRows.filter((x) => x.role === g.name && x.page)) {
      for (const link of reachForPage(r.page as string).links) {
        const res = resolveHref(link)
        if (!res.page || have.has(res.page.file)) continue
        have.add(res.page.file)
        const row = rowFor(g.name, `↳ from ${r.label}`, link)
        row.hop = 1
        rows.push(row)
      }
    }
  }
  const publicPages = PAGES.filter((p) => {
    const route = routeOf(p)
    if (route.startsWith("/dashboard") || route.startsWith("/api")) return false
    if (/^\/(portal|vendor|lender|title|transaction|transactions|crm|leads|settings|admin|compliance|approvals|notifications|offers|workflows|tasks|calendar|analytics|financials|intelligence|lifetime-customers|past-clients|referrals|sphere|showings|content-studio|social-planner|newsletters|credit-pipeline|recruiting|gifts|mobile|video-assistant|academy|support|documents|properties\/compare|seed)(\/|$)/.test(route)) return false
    return classifyProxyPath(route.replace(/\[[^\]]+\]/g, "x")) !== "protected"
  })
  for (const p of publicPages) rows.push(rowFor("platform prospects · public", routeOf(p), routeOf(p), p))
  const portalPages = PAGES.filter((p) => p.file.startsWith("app/portal/[contactId]/"))
  for (const p of portalPages) rows.push(rowFor("buyers · sellers · lifetime contacts", routeOf(p).replace("/portal/[contactId]", "portal ·") || "portal", routeOf(p), p))
  return { rows, publicPages: publicPages.map((p) => p.file), portalPages: portalPages.map((p) => p.file) }
}

function gapsOf(rows: Row[]): string[] {
  const out: string[] = []
  for (const [role, domains] of Object.entries(EXPECTED)) for (const d of domains) {
    const has = rows.some((r) => r.role === role && r.domain === d && r.verdict !== "MISSING")
    if (!has) out.push(`${role} × ${d}`)
  }
  return out
}

function renderDoc(rows: Row[], gaps: string[], meta: { publicPages: number; portalPages: number }): string {
  const verdicts: Verdict[] = ["BUILT", "PARTIAL", "UNWIRED", "STATIC", "REDIRECT", "MISSING"]
  const roles = ROLE_GROUPS.map((g) => g.name)
  const domains = [...DOMAINS.map((d) => d.name), ...[...new Set(rows.map((r) => r.domain))].filter((d) => !DOMAINS.some((x) => x.name === d)).sort()]
  const cell = (role: string, d: string) => {
    const rs = rows.filter((r) => r.role === role && r.domain === d)
    if (!rs.length) return (EXPECTED[role] ?? []).includes(d) ? "**GAP**" : "·"
    const c = (v: Verdict) => rs.filter((r) => r.verdict === v).length
    return verdicts.filter((v) => c(v) > 0).map((v) => `${v[0]}${c(v)}`).join(" ")
  }
  const total = (v: Verdict) => rows.filter((r) => r.verdict === v).length
  const lines: string[] = []
  lines.push("# Capability surface audit — every role's journeys on their real surfaces")
  lines.push("")
  lines.push("<!-- GENERATED by `npx tsx scripts/ui-capability-surface-audit.ts --write-doc` (wave 146, lane 146H). Do not hand-edit: the guard fails when this file disagrees with the derivation. -->")
  lines.push("")
  lines.push("Owner ruling 18 (2026-10-29): *\"All capabilities at all levels … Validate each on its real surface.\"* Every row below is DERIVED from the tree: the role's navigation (`app/config/navigation-config.ts` `NAVIGATION_BY_ROLE`), the contact portal's own pages (`app/portal/[contactId]/**`), and every page the proxy does not protect (`app/constants/auth.ts` `classifyProxyPath`) → the page that serves the href → a walk of that page's imports to the server action / API / server read behind it.")
  lines.push("")
  lines.push("**Verdicts.** BUILT — the screen reaches a data path. PARTIAL — it reaches one and says honestly that a part is not available / not configured. UNWIRED — interactive controls, no data path. STATIC — informational, no controls, no data (not a defect). REDIRECT — an alias that lands elsewhere. MISSING — no page serves the href. Dead CONTROLS inside a BUILT screen are `test:ui-wiring-census`'s (hard zero on every journey); page role gates are `test:page-role-gate-roster`'s; colour contrast is `test:ui-palette-contrast`'s.")
  lines.push("")
  lines.push(`**Totals:** ${rows.length} role-surfaces — ${verdicts.map((v) => `${v} ${total(v)}`).join(" · ")}. Public pages: ${meta.publicPages}; contact-portal pages: ${meta.portalPages}. Expected-coverage gaps: ${gaps.length}.`)
  lines.push("")
  lines.push("## Role × domain (B = BUILT, P = PARTIAL, U = UNWIRED, S = STATIC, R = REDIRECT, M = MISSING; **GAP** = ruling 18 expects this level here and no surface exists; · = not expected, none)")
  lines.push("")
  lines.push(`| domain | ${roles.join(" | ")} |`)
  lines.push(`|---|${roles.map(() => "---").join("|")}|`)
  for (const d of domains) lines.push(`| ${DOMAINS.find((x) => x.name === d)?.ruling18 ? `**${d}**` : d} | ${roles.map((r) => cell(r, d)).join(" | ")} |`)
  lines.push("")
  lines.push("## Expected-coverage gaps (ruling 18) and their owners")
  lines.push("")
  if (!gaps.length) lines.push("None — every level the ruling names reaches every domain it should, on a real surface.")
  for (const g of gaps) lines.push(`- **${g}** — ${KNOWN_GAPS[g] ? `${KNOWN_GAPS[g].why} (owner: ${KNOWN_GAPS[g].owner})` : "UNROUTED"}`)
  lines.push("")
  lines.push("## Not BUILT — every UNWIRED / PARTIAL / MISSING surface")
  lines.push("")
  const notBuilt = rows.filter((r) => r.verdict === "UNWIRED" || r.verdict === "PARTIAL" || r.verdict === "MISSING")
  if (!notBuilt.length) lines.push("None.")
  else { lines.push("| role | domain | surface | page | verdict | why |"); lines.push("|---|---|---|---|---|---|") }
  for (const r of notBuilt) lines.push(`| ${r.role} | ${r.domain} | ${r.label} \`${r.href}\` | ${r.page ? `\`${r.page}\`` : "—"} | ${r.verdict} | ${r.verdict === "PARTIAL" ? `says "${r.partial}"` : r.verdict === "MISSING" ? (r.page ? `honest state — says "${r.partial}"; capability routed in lane 146H notes` : "no page serves the href") : "controls without a data path"} |`)
  lines.push("")
  lines.push("## Journey table — role × domain × surface × the action behind it × verdict")
  lines.push("")
  for (const role of roles) {
    const rs = rows.filter((r) => r.role === role).sort((a, b) => a.domain.localeCompare(b.domain) || a.href.localeCompare(b.href))
    lines.push(`### ${role} (${rs.length})`)
    lines.push("")
    lines.push("| domain | surface | page | action behind it | verdict |")
    lines.push("|---|---|---|---|---|")
    for (const r of rs) lines.push(`| ${r.domain} | ${r.label} \`${r.href}\` | ${r.page ? `\`${r.page}\`` : "—"}${r.via ? ` (${r.via})` : ""} | ${r.behind.replace(/\|/g, "\\|")} | ${r.verdict} |`)
    lines.push("")
  }
  return lines.join("\n") + "\n"
}

async function main() {
  console.log("\n━━ CAPABILITY SURFACE AUDIT — every role's journeys on their real surfaces (ruling 18) ━━\n")

  // ── X · positive controls ───────────────────────────────────────────────────
  console.log("[X · positive controls]")
  check("X1 a href to no page resolves MISSING", resolveHref("/dashboard/__no_such_surface__").page === null && verdictOf(null) === "MISSING")
  check("X2 a dynamic segment resolves (a listing detail href hits app/dashboard/listings/[id]/page.tsx)", resolveHref("/dashboard/listings/abc-123").page?.file === "app/dashboard/listings/[id]/page.tsx", resolveHref("/dashboard/listings/abc-123").page?.file)
  check("X3 a route group vanishes from the URL and a query string is ignored", PAGES.some((p) => p.file.includes("/(") ) ? PAGES.filter((p) => p.file.includes("/(")).every((p) => !routeOf(p).includes("(")) : true)
  const fakeAction: Reach = { actions: new Map([["app/actions/x.ts", new Set(["doX"])]]), apis: new Set(), serverRead: false, dataLibs: new Set(), interactive: true, honestPartial: null, redirectTo: null, visited: 1, links: new Set() }
  check("X4 a screen reaching a server action is BUILT; the same screen with honest 'not configured' copy is PARTIAL", verdictOf(fakeAction) === "BUILT" && verdictOf({ ...fakeAction, honestPartial: "not configured" }) === "PARTIAL")
  check("X5 controls with no data path are UNWIRED; no controls and no data is STATIC (informational, not a defect)", verdictOf({ ...fakeAction, actions: new Map() }) === "UNWIRED" && verdictOf({ ...fakeAction, actions: new Map(), interactive: false }) === "STATIC")
  const known = reachForPage("app/dashboard/transactions/[id]/page.tsx")
  check("X6 the walk finds the action behind a known BUILT screen (the deal page reaches app/actions/**)", known.actions.size > 0, behind(known))
  check("X7 the redirect-only /portal entry reads REDIRECT-or-BUILT (it resolves a contact first), never MISSING", ["REDIRECT", "BUILT"].includes(verdictOf(reachForPage("app/portal/page.tsx"))))

  // ── A · the derivation ──────────────────────────────────────────────────────
  console.log("\n[A · roles → surfaces → actions]")
  const { rows, publicPages, portalPages } = derive()
  const by = (v: Verdict) => rows.filter((r) => r.verdict === v)
  console.log(`    denominator: ${rows.length} role-surfaces over ${ROLE_GROUPS.length} levels · ${PAGES.length} pages in app/ · ${publicPages.length} public · ${portalPages.length} contact-portal`)
  console.log(`    verdicts: ${(["BUILT", "PARTIAL", "UNWIRED", "STATIC", "REDIRECT", "MISSING"] as Verdict[]).map((v) => `${v} ${by(v).length}`).join(" · ")}`)
  for (const g of ROLE_GROUPS) {
    const rs = rows.filter((r) => r.role === g.name)
    console.log(`      ${g.name}: ${rs.length} surfaces — ${(["BUILT", "PARTIAL", "UNWIRED", "STATIC", "REDIRECT", "MISSING"] as Verdict[]).map((v) => `${v[0]}${rs.filter((r) => r.verdict === v).length}`).join(" ")}`)
  }
  const noPage = rows.filter((r) => r.page === null)
  check("A1 every navigation href of every level resolves to a page (no-page MISSING = 0 — a nav entry that 404s is a dead control)", noPage.length === 0, noPage.map((r) => `${r.role}: ${r.label} ${r.href}`).join("; "))
  for (const r of rows.filter((x) => x.verdict === "MISSING" && x.page)) console.log(`    MISSING (honest state) ${r.role} · ${r.label} ${r.href} → ${r.page} ("${r.partial}")`)
  const unwired = by("UNWIRED")
  for (const r of unwired) console.log(`    UNWIRED ${r.role} · ${r.label} ${r.href} → ${r.page}`)
  for (const r of by("PARTIAL")) console.log(`    PARTIAL ${r.role} · ${r.label} ${r.href} → ${r.page} ("${r.partial}")`)
  check("A2 no navigation entry lands on an UNWIRED screen (controls that reach no data are dead controls one level up)", unwired.filter((r) => r.role !== "platform prospects · public").length === 0, unwired.map((r) => `${r.role}: ${r.href}`).join("; "))

  // ── P · a public journey never walks into the login wall ────────────────────
  console.log("\n[P · public pages never link into a page the proxy protects]")
  const blocked: string[] = []
  for (const f of publicPages) for (const link of reachForPage(f).links) {
    const res = resolveHref(link)
    if (!res.page) continue
    const route = "/" + res.page.segs.join("/")
    if (classifyProxyPath(route.replace(/\[[^\]]+\]/g, "x")) === "protected" && !/^\/(?:login|signup|dashboard|portal|vendor|lender|title)(?:\/|$)/.test(route)) blocked.push(`${f} → ${link} (${res.page.file})`)
  }
  const uniqueBlocked = [...new Set(blocked)]
  for (const b of uniqueBlocked) console.log(`    PUBLIC → PROTECTED ${b} — ${KNOWN_PUBLIC_BLOCKS[b.split(" → ")[1].split(" ")[0]] ? `routed: ${KNOWN_PUBLIC_BLOCKS[b.split(" → ")[1].split(" ")[0]].owner}` : "UNROUTED"}`)
  const unroutedBlocks = uniqueBlocked.filter((b) => !KNOWN_PUBLIC_BLOCKS[b.split(" → ")[1].split(" ")[0]])
  check("P1 every public page that links an anonymous visitor into a PROTECTED page is routed to its owner (a NEW one fails) — the visitor would meet /login", unroutedBlocks.length === 0, unroutedBlocks.join("; "))
  const staleBlocks = Object.keys(KNOWN_PUBLIC_BLOCKS).filter((k) => !uniqueBlocked.some((b) => b.split(" → ")[1].split(" ")[0] === k))
  check("P2 no KNOWN_PUBLIC_BLOCKS entry outlives its block", staleBlocks.length === 0, staleBlocks.join("; "))
  const ctlBlocked = classifyProxyPath("/listings/x") === "protected" && resolveHref("/listings/x").page?.file === "app/listings/[listingId]/page.tsx"
  check("P3 positive control — the finder sees the measured block (the public listing page sits under the protected /listings prefix)", ctlBlocked || !uniqueBlocked.length)

  // ── G · expected coverage (ruling 18) ───────────────────────────────────────
  console.log("\n[G · ruling-18 coverage — every level reaches every domain it should]")
  const gaps = gapsOf(rows)
  for (const g of gaps) console.log(`    GAP ${g} — ${KNOWN_GAPS[g] ? `${KNOWN_GAPS[g].why} (owner ${KNOWN_GAPS[g].owner})` : "UNROUTED"}`)
  const unrouted = gaps.filter((g) => !KNOWN_GAPS[g])
  const stale = Object.keys(KNOWN_GAPS).filter((g) => !gaps.includes(g))
  check("G1 every expected-coverage gap is routed to its owner (a NEW gap fails)", unrouted.length === 0, unrouted.join("; "))
  check("G2 no KNOWN_GAPS entry outlives its gap (a closed gap is deleted, never kept as decoration)", stale.length === 0, stale.join("; "))

  // ── D · the document ────────────────────────────────────────────────────────
  console.log("\n[D · docs/architecture/CAPABILITY-SURFACE-AUDIT.md]")
  const doc = renderDoc(rows, gaps, { publicPages: publicPages.length, portalPages: portalPages.length })
  if (WRITE_DOC) { writeFileSync(DOC_PATH, doc); console.log(`    written: ${rel(DOC_PATH)} (${doc.split("\n").length} lines)`) }
  const onDisk = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, "utf8") : ""
  check("D1 the committed audit document agrees with the derivation (regenerate with --write-doc)", onDisk === doc, onDisk ? "drifted — run with --write-doc" : "missing")

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
  console.log("✅ UI_CAPABILITY_SURFACE_PASS — every level's surfaces resolve, reach their actions, and cover the ruling-18 domains or name the owner of the gap")
}
// Run only when invoked as the guard, so a canary can import derive / resolveHref / verdictOf / the tables.
if (/ui-capability-surface-audit\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1) })
