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
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
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
  // "/listings/x" — CLOSED (wave 146, lane 146Z): app/constants/auth.ts classifyProxyPath answers 'public' for
  // /listings/<uuid> (one uuid segment; /listings, /listings/new and every child stay protected).
}

/** The proxy's answer for a route pattern, each dynamic segment read as the uuid a real link carries. */
const DYNAMIC_SEGMENT_SPECIMEN = "7b1f6a52-1c1e-4d4e-9f55-0a1b2c3d4e5f"
const proxyOfRoute = (route: string) => classifyProxyPath(route.replace(/\[[^\]]+\]/g, DYNAMIC_SEGMENT_SPECIMEN))

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
/** `honestAt` (wave 147, lane 147H): the file:line of the honest-state copy that made the screen PARTIAL / MISSING, so the
 *  classification table (ruling 9) can name the class of the very sentence the verdict rests on. */
type Reach = { actions: Map<string, Set<string>>; apis: Set<string>; serverRead: boolean; dataLibs: Set<string>; interactive: boolean; honestPartial: string | null; honestAt?: string | null; redirectTo: string | null; visited: number; links: Set<string> }
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
      const lineAt = (i: number) => code.slice(0, i).split("\n").length
      if (!r.honestPartial) for (const l of stringLiterals(code)) { const m = l.text.match(HONEST_PARTIAL); if (m) { r.honestPartial = m[0]; r.honestAt = `${rel(abs)}:${lineAt(l.start)}`; break } }
      if (!r.honestPartial) { const m = HONEST_PARTIAL.exec(code); if (m) { r.honestPartial = m[0]; r.honestAt = `${rel(abs)}:${lineAt(m.index)}` } }
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

// ═════════════════════════════════════════════════════════════════════════════
// CLASSIFICATION (wave 147, lane 147H — owner ruling 9: "build the missing capabilities and also ones that say 'not
// available yet' … every exposed function works, gives an honest configuration message, or leaves the advertised
// launch surface"). EVERY honest-state sentence in the tree — the copy that makes a screen PARTIAL / MISSING above,
// plus every server refusal of the same family a screen relays — is placed in EXACTLY ONE of the five classes the
// lane brief names. The class is DERIVED FROM CODE where the code says it (an env var the repo reads, a fail-closed
// tenant guard, a tenant connection / provider probe, an unapplied migration); otherwise it comes from the published
// allow-list below, with the reason and the action taken. A sentence with neither FAILS (C1); an allow-list row that
// contradicts the derivation fails (C2); a row that outlives its sentence fails (C3).
//
// BLIND SPOTS (§2): the population is the HONEST_PARTIAL phrase family on STRIPPED source (app/** every line, lib/**
// the "not available yet" family only) — a dishonest screen that claims nothing is test:ui-wiring-census's; console
// logs and thrown server errors in app/** are classified with the rest (a relayed error is still copy a person reads);
// derivation reads a ±3-line window, so an env var checked in a different function reads as allow-listed, never as
// derived (an under-claim, never an over-claim).
// ═════════════════════════════════════════════════════════════════════════════
export const SURFACE_CLASSES = ["implemented-missing-owner-config", "present-but-unwired", "incomplete-code", "missing-reader/writer/evidence", "unsupported/deferred"] as const
export type SurfaceClass = (typeof SURFACE_CLASSES)[number]
/** The "not available yet" family — scanned in lib/** too, and never allowed unclassified anywhere (brief, proof). */
export const NOT_AVAILABLE = /not available yet|isn['’]t available yet|not yet available/i
export interface HonestSite { file: string; line: number; phrase: string; text: string; scope: "ui" | "server" }
export interface ClassifiedSite extends HonestSite { cls: SurfaceClass | null; derivedFrom: "code" | "allow-list" | null; basis: string; action: string }

/**
 * THE ALLOW-LIST — sentences whose class the code cannot state by itself. Keyed by file (+ an optional substring of the
 * line when one file holds sentences of different classes). `action` says what lane 147H did; every row is re-checked
 * against the tree (C3: a row whose sentence is gone fails, so the list can never outlive the copy it explains).
 */
export const CLASSIFIED_SURFACES: ReadonlyArray<{ file: string; match?: string; cls: SurfaceClass; why: string; action: string }> = [
  { file: "app/components/settings/BenefitOfferingsCard.tsx", cls: "implemented-missing-owner-config", why: "the brokerage has not described its benefit distribution — a tenant-owner setting on the same card", action: "kept: honest owner-setting copy (the toggle pays nothing until the distribution is described)" },
  { file: "app/components/portal/DocumentUploadDialog.tsx", cls: "implemented-missing-owner-config", why: "the storage upload refused for a missing bucket configuration — a platform storage setting, not code", action: "kept: honest refusal, the client is told to contact support" },
  { file: "app/dashboard/admin/onboarding/components/os/setup-blockers-panel.tsx", cls: "implemented-missing-owner-config", why: "the tenant setup board lists each setup item the owner has not configured yet", action: "kept: the setup board IS the configuration surface" },
  { file: "app/dashboard/admin/phone-settings/phone-settings-client.tsx", match: "Voice cloning", cls: "implemented-missing-owner-config", why: "the platform voice provider key (ELEVENLABS_API_KEY) is unset; the 503 says so — a TENANT is told the capability status and who switches it on, never the variable (readiness V6: platform configuration never reaches a tenant screen)", action: "copy corrected (was \"isn't available yet\")" },
  { file: "app/dashboard/admin/phone-settings/page.tsx", cls: "implemented-missing-owner-config", why: "phone number / A2P registration not configured for the tenant — a tenant connection (Twilio) set on this page", action: "kept: status label on the page that configures it" },
  { file: "app/dashboard/superadmin/env-providers/providers-client.tsx", cls: "implemented-missing-owner-config", why: "the platform provider console lists each provider whose env is unset", action: "kept: the console IS the configuration surface" },
  { file: "app/dashboard/superadmin/ai-ops/rotation-risks-panel.tsx", cls: "implemented-missing-owner-config", why: "a credential-refresh sweep reports providers it skipped because they are not configured", action: "kept: honest sweep summary" },
  { file: "app/dashboard/superadmin/connectors/go-live-card.tsx", cls: "implemented-missing-owner-config", why: "the go-live board's per-connector state vocabulary (not_configured)", action: "kept: the board IS the readiness surface" },
  { file: "app/dashboard/superadmin/sentinel/sentinel-action-queue.tsx", cls: "implemented-missing-owner-config", why: "email sending needs the platform SendGrid key (SENDGRID_API_KEY); the draft is kept for copying", action: "kept: honest fallback naming the provider" },
  { file: "app/dashboard/marketing/podcast/components/distribution-channels-tab.tsx", cls: "implemented-missing-owner-config", why: "a podcast distribution channel the tenant has not connected", action: "kept: status label on the connection tab" },
  { file: "app/dashboard/settings/podcast-channels/podcast-channels-client.tsx", cls: "implemented-missing-owner-config", why: "a podcast channel the tenant has not connected", action: "kept: status label on the settings page that connects it" },
  { file: "app/dashboard/onboarding/tech-stack/tech-stack-client.tsx", cls: "implemented-missing-owner-config", why: "a tech-stack integration the tenant has not connected", action: "kept: status label on the page that connects it" },
  { file: "app/dashboard/team-heatmap/page.tsx", cls: "implemented-missing-owner-config", why: "the platform map provider (Mapbox token) is not configured; the activity list still renders", action: "kept: honest degraded state (WAITING_EXTERNAL Mapbox, readiness B6)" },
  { file: "app/dashboard/marketing/podcast/components/create-episode-dialog.tsx", cls: "implemented-missing-owner-config", why: "the agent has not set up an ElevenLabs voice clone (an agent-level connection on /dashboard/videos/voice)", action: "kept: honest refusal naming where to set it up" },
  { file: "app/mobile/voice/page.tsx", cls: "implemented-missing-owner-config", why: "the voice assistant is not set up for this agent (voice settings)", action: "kept: honest empty state" },
  { file: "app/mobile/voice/voice-session-button.tsx", cls: "implemented-missing-owner-config", why: "the voice assistant session refused because voice is not set up in settings", action: "kept: honest refusal naming settings" },
  { file: "app/actions/admin/run-scrape-test.ts", cls: "implemented-missing-owner-config", why: "CRON_SECRET (platform env) is unset, so the self-call cannot authenticate", action: "kept: names the variable" },
  { file: "app/actions/crm-connect.ts", cls: "implemented-missing-owner-config", why: "secret storage (SECRETS_ENCRYPTION_KEY) is not configured, so an API secret cannot be stored safely", action: "kept: honest refusal" },
  { file: "app/actions/vendor-billing.ts", cls: "implemented-missing-owner-config", why: "the vendor tier price is a brokerage setting; a refused read is logged as unpriced", action: "kept: server log" },
  { file: "app/actions/superadmin/platform-staff.ts", cls: "implemented-missing-owner-config", why: "email delivery (SendGrid) is not configured, so a staff invite cannot be sent", action: "kept: honest refusal" },
  { file: "app/actions/video-generation.ts", cls: "implemented-missing-owner-config", why: "the agent has no avatar / voice id set in the Agent Roster, or the D-ID provider is not configured", action: "kept: names where to set it" },
  { file: "app/actions/superadmin/brokerage-management.ts", cls: "implemented-missing-owner-config", why: "a refund needs Stripe (STRIPE_SECRET_KEY); the skipped path says so", action: "kept: honest refusal" },
  { file: "app/actions/billing.ts", match: "Payments are not configured", cls: "implemented-missing-owner-config", why: "Stripe (STRIPE_SECRET_KEY) is not configured in this environment — the code could not be applied", action: "kept: honest refusal (owner ruling: no live billing)" },
  { file: "app/actions/billing.ts", match: "Stripe is not configured", cls: "implemented-missing-owner-config", why: "Stripe (STRIPE_SECRET_KEY) is not configured — seats cannot be sold from this environment", action: "kept: honest refusal (owner ruling: no live billing)" },
  { file: "app/actions/ai-listing-intake.ts", cls: "implemented-missing-owner-config", why: "Dotloop is a brokerage connection (Settings › Integrations)", action: "kept: names where to connect it" },
  { file: "app/actions/ai-offer-creation.ts", cls: "implemented-missing-owner-config", why: "Dotloop is a brokerage connection (Settings › Integrations)", action: "kept: names where to connect it" },
  { file: "app/actions/seller-showings.ts", cls: "implemented-missing-owner-config", why: "ShowingTime credentials are a brokerage connection", action: "kept: honest refusal" },
  { file: "app/actions/lead-intelligence.ts", cls: "implemented-missing-owner-config", why: "ZenRows / BatchData keys (ZENROWS_API_KEY, BATCHDATA_API_KEY) are platform env; the run says it is dark", action: "kept: names the variable where the line can" },
  { file: "app/actions/investor-buybox-preview.ts", cls: "implemented-missing-owner-config", why: "the BatchData MCP connector is platform configuration", action: "kept: honest refusal (the card relays it)" },
  { file: "app/actions/podcast-generation.ts", cls: "implemented-missing-owner-config", why: "the agent's ElevenLabs voice clone (agent connection) or ELEVENLABS_API_KEY (platform env)", action: "kept: names where to set it" },
  { file: "app/dashboard/campaigns/mail/mail-dashboard.tsx", cls: "implemented-missing-owner-config", why: "fail-closed tenant guard rendered as a heading — the seat has no brokerage (users.brokerage_id)", action: "kept: honest refusal" },
  { file: "app/api/cron/health-check/route.ts", cls: "implemented-missing-owner-config", why: "a provider with no credentials row reads 'unknown — Not configured' in the health sweep (never 'healthy')", action: "kept: fail-closed health status" },
  { file: "app/api/integrations/oauth/[provider]/route.ts", cls: "implemented-missing-owner-config", why: "secret storage (SECRETS_ENCRYPTION_KEY) or the provider's OAuth client id/secret (platform env per catalog entry) is unset", action: "kept: the redirect says nothing was stored" },
  { file: "app/api/social/oauth/[platform]/route.ts", cls: "implemented-missing-owner-config", why: "secret storage or the platform's OAuth client (config.clientIdEnv / clientSecretEnv — the line names them for platform staff) is unset", action: "kept: names the variables on the platform-scope path" },
  { file: "app/api/sms/inbound-optout/route.ts", cls: "implemented-missing-owner-config", why: "no Twilio auth token resolves for the receiving number (tenant / platform Twilio connection), so the signature cannot be verified — refused 503, fail closed", action: "kept: fail-closed webhook" },
  { file: "app/api/voice/recording/[callId]/route.ts", cls: "implemented-missing-owner-config", why: "the brokerage's Twilio connection is absent, so a recording cannot be fetched", action: "kept: honest refusal" },
  { file: "app/api/voice/twilio/inbound/route.ts", cls: "implemented-missing-owner-config", why: "the dialled number is not mapped to a tenant (phone settings) — the caller hears a polite hang-up", action: "kept: fail-closed" },
  { file: "app/components/ai-image/generate-image-button.tsx", cls: "implemented-missing-owner-config", why: "the image-generation provider returns 503 when its platform key is unset", action: "kept: honest refusal" },
  { file: "app/dashboard/superadmin/coupons/coupons-manager.tsx", cls: "implemented-missing-owner-config", why: "Stripe (STRIPE_SECRET_KEY) unset — publish records an honest MOCK ledger entry (owner ruling: no Stripe objects)", action: "kept: honest mock label" },
  { file: "app/dashboard/videos/create/teammate-explainer-card.tsx", cls: "implemented-missing-owner-config", why: "the D-ID avatar provider (DID_API_KEY) / ElevenLabs (ELEVENLABS_API_KEY) are platform env; the video queues and renders when they are set", action: "kept: honest readiness labels" },
  { file: "app/settings/services/services-content.tsx", cls: "implemented-missing-owner-config", why: "a tenant service connection that is not connected — this page connects it", action: "kept: status label on the configuring page" },
  { file: "lib/integrations/providers/provider-resolver.ts", cls: "unsupported/deferred", why: "a legal-forms / e-sign provider listed in the catalog with implemented:false — the refusal names the providers that work", action: "kept: honest refusal; the catalog marks it unimplemented (no adapter is claimed)" },
  // WAVE 147 (lane 147Z — convergence of lane 147E's producer with this audit): the market report's honest data label. Owner
  // ruling 6 REQUIRES it ("unavailable data labelled honestly"): a datum the licensed sources (RentCast / the tenant's MLS feed /
  // public records) do not return for the territory is printed as "not available for <territory> as of <date>", never estimated.
  { file: "lib/market-reports/producer.ts", match: "Not available yet", cls: "implemented-missing-owner-config", why: "a market datum the licensed data sources (RentCast — RENTCAST_API_KEY, the tenant's MLS / IDX feed connection) did not return for this territory; the report labels it instead of estimating it (owner ruling 6)", action: "kept: the honest section heading the producer's validator requires" },
  { file: "lib/market-reports/prompts.ts", match: "not available yet", cls: "implemented-missing-owner-config", why: "the writing prompt's rule that a fact the data sources did not return is said to be not available, never estimated (owner ruling 6; the producer validator refuses an invented figure)", action: "kept: an instruction to the model, not user copy" },
  { file: "lib/kernel/video.ts", cls: "unsupported/deferred", why: "video repurposing (shorts / clips / thumbnails) has no processing backend; the old code fabricated artifact URLs", action: "kept: honest refusal relayed by the video studio dialog; a processor (worker) is an owner decision — Still open" },
]

const STAMP_APPLIED = /^--\s*──\s*APPLIED LIVE\b/
/** The line-1 stamp of supabase/migrations/m<NNN>-*.sql — applied / written / absent (the RULE, both stamps accepted). */
export function migrationStampOf(n: number): "applied" | "written" | "absent" {
  const dir = join(ROOT, "supabase", "migrations")
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => new RegExp(`^m${n}(?:[a-z])?-`).test(f)) : []
  if (!files.length) return "absent"
  return files.some((f) => STAMP_APPLIED.test(readFileSync(join(dir, f), "utf8").split("\n")[0] ?? "")) ? "applied" : "written"
}

/** Every env var name the runtime reads (`process.env.NAME`) — the vocabulary an ENV derivation may name. */
let ENV_NAMES: Set<string> | null = null
function envNames(): Set<string> {
  if (ENV_NAMES) return ENV_NAMES
  ENV_NAMES = new Set<string>()
  for (const root of ["app", "lib"]) for (const abs of walkTs(join(ROOT, root))) for (const m of readCode(abs).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) ENV_NAMES.add(m[1])
  return ENV_NAMES
}

/** PURE over a window: the class the CODE states for one honest-state line, or null (→ the allow-list). */
export function deriveSurfaceClass(lines: string[], idx: number, envVocabulary: Set<string>, fileCode: string): { cls: SurfaceClass; basis: string } | null {
  const text = lines[idx] ?? ""
  const win = lines.slice(Math.max(0, idx - 3), idx + 4).join("\n")
  // 1. MIGRATION-GATED: the sentence names a migration. Unapplied → the reader/writer/evidence is missing until the
  //    integrator applies it. APPLIED → the sentence is the fallback for a database missing it: dormant on the live
  //    database, and a deployment step (apply the migration) wherever it fires — configuration, not missing code.
  const mig = /\bm(\d{3,4})\b/.exec(text)
  if (mig && /migration|pending|not applied/i.test(text)) {
    const stamp = migrationStampOf(Number(mig[1]))
    return stamp === "applied"
      ? { cls: "implemented-missing-owner-config", basis: `fallback for a database missing APPLIED migration m${mig[1]} (dormant live; the deployment applies it)` }
      : { cls: "missing-reader/writer/evidence", basis: `migration m${mig[1]} is ${stamp === "absent" ? "not in the tree" : "written, not applied"}` }
  }
  // 2. ENV: the window names a variable the runtime reads, or tests an identifier assigned from process.env in the file.
  const vars = new Set<string>()
  for (const m of win.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)) if (envVocabulary.has(m[1])) vars.add(m[1])
  for (const m of fileCode.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.([A-Z][A-Z0-9_]+)/g)) if (new RegExp(`\\b${m[1].replace(/\$/g, "\\$")}\\b`).test(win)) vars.add(m[2])
  if (vars.size) return { cls: "implemented-missing-owner-config", basis: `platform env ${[...vars].sort().join(", ")}` }
  // 3. FAIL-CLOSED TENANT GUARD: "Brokerage not configured" behind a falsy brokerage id — the seat has no
  //    users.brokerage_id; the tenant admin attaches it. The page is built; the identity is not configured.
  if (/brokerage not configured/i.test(text) && /!\s*[\w?.]*[bB]rokerage_?[iI]d\b|[bB]rokerage_?[iI]d\s*\)\s*return/.test(win)) return { cls: "implemented-missing-owner-config", basis: "fail-closed tenant guard — the signed-in seat has no users.brokerage_id (the tenant admin attaches the seat)" }
  // 4. CONNECTION / PROVIDER PROBE: the sentence is the else-branch of a configured-probe the code evaluates.
  const probe = /\b(is_configured|isConfigured|stripeConfigured|isStripeConfigured|didConfigured|unconfigured|tenantConnections|missingEnv|envPart|skipped|connected(?=\s*\?))/.exec(win)
  if (probe) return { cls: "implemented-missing-owner-config", basis: `tenant / provider connection probe (${probe[1]})` }
  return null
}

/** Every honest-state sentence in the tree, one per line. */
export function honestSites(): HonestSite[] {
  const out: HonestSite[] = []
  for (const root of ["app", "lib"]) for (const abs of walkTs(join(ROOT, root))) {
    const file = rel(abs)
    const re = root === "app" ? HONEST_PARTIAL : NOT_AVAILABLE
    readCode(abs).split("\n").forEach((l, i) => { const m = l.match(re); if (m) out.push({ file, line: i + 1, phrase: m[0], text: l.trim().slice(0, 220), scope: file.endsWith(".tsx") ? "ui" : "server" }) })
  }
  return out
}

/** Every site with its ONE class (derived first, the allow-list otherwise). */
export function classifySites(sites: HonestSite[] = honestSites()): ClassifiedSite[] {
  const env = envNames()
  const linesOf = new Map<string, string[]>()
  return sites.map((s) => {
    let lines = linesOf.get(s.file)
    if (!lines) { lines = readCode(join(ROOT, s.file)).split("\n"); linesOf.set(s.file, lines) }
    const d = deriveSurfaceClass(lines, s.line - 1, env, readCode(join(ROOT, s.file)))
    const listed = CLASSIFIED_SURFACES.find((r) => r.file === s.file && (!r.match || s.text.includes(r.match)))
    if (d) return { ...s, cls: d.cls, derivedFrom: "code" as const, basis: d.basis, action: listed?.action ?? "kept: honest configuration copy (derived)" }
    if (listed) return { ...s, cls: listed.cls, derivedFrom: "allow-list" as const, basis: listed.why, action: listed.action }
    return { ...s, cls: null, derivedFrom: null, basis: "UNCLASSIFIED", action: "—" }
  })
}

/** Copy that names a migration, with its stamp — an APPLIED migration must never be called pending (C4). */
export function migrationNamingCopy(): Array<{ at: string; migration: string; stamp: "applied" | "written" | "absent"; claimsPending: boolean }> {
  const out: Array<{ at: string; migration: string; stamp: "applied" | "written" | "absent"; claimsPending: boolean }> = []
  for (const abs of walkTs(join(ROOT, "app"))) {
    const code = readCode(abs)
    for (const l of stringLiterals(code)) for (const m of l.text.matchAll(/\bmigration\s+m(\d{3,4})\b|\bm(\d{3,4})\b(?=[^"'`]*(?:migration|not applied|pending))/gi)) {
      const n = Number(m[1] ?? m[2])
      out.push({ at: `${rel(abs)}:${code.slice(0, l.start).split("\n").length}`, migration: `m${n}`, stamp: migrationStampOf(n), claimsPending: /pending|not applied|not available yet/i.test(l.text) })
    }
    // JSX text is not a string literal — read the stripped lines too.
    code.split("\n").forEach((line, i) => { if (/>[^<{]*\bmigration\s+m\d{3,4}/i.test(line)) { const n = Number(/m(\d{3,4})/.exec(line.slice(line.search(/migration\s+m/i)))![1]); out.push({ at: `${rel(abs)}:${i + 1}`, migration: `m${n}`, stamp: migrationStampOf(n), claimsPending: /pending|not applied|not available yet/i.test(line) }) } })
  }
  const seen = new Set<string>()
  return out.filter((r) => { const k = `${r.at}|${r.migration}`; if (seen.has(k)) return false; seen.add(k); return true })
}

/**
 * WHAT LANE 147H CLOSED — the surfaces that sat in the OTHER four classes at 4d527cc3 and were finished, wired, or taken
 * off the launch surface. Each row is re-proved against the tree (C5): the old sentence is gone from `file` and the
 * survivor exists (a row can never claim a fix the tree does not carry).
 */
/** `oldCopy` empty = a surface that had no copy of its own (a reader added where none existed). */
export const CLOSED_THIS_WAVE: ReadonlyArray<{ surface: string; file: string; was: SurfaceClass; oldCopy: string; action: string; survivor: string }> = [
  { surface: "vendor portfolio (list)", file: "app/vendor/portfolio/page.tsx", was: "missing-reader/writer/evidence", oldCopy: "Portfolio uploads are not available yet", action: "BUILT — m906 store + writer + both readers", survivor: "app/actions/vendor-portfolio.ts" },
  { surface: "vendor portfolio (upload)", file: "app/vendor/portfolio/upload/page.tsx", was: "missing-reader/writer/evidence", oldCopy: "Portfolio uploads are not available yet", action: "BUILT — the form posts to addVendorPortfolioItem (ledgered vendor.portfolio_item.add)", survivor: "app/vendor/portfolio/upload/portfolio-upload-form.tsx" },
  { surface: "vendor portfolio (agents' view)", file: "app/dashboard/vendors/vendor-directory-client.tsx", was: "missing-reader/writer/evidence", oldCopy: "", action: "BUILT — work samples in the directory's Reviews dialog", survivor: "app/components/vendors/vendor-portfolio-strip.tsx" },
  { surface: "title closing appointment", file: "app/title/closing/new/page.tsx", was: "missing-reader/writer/evidence", oldCopy: "place from here is not available yet", action: "BUILT — proposeClosingAppointment lands the deal agent's task (ledgered transaction.closing_appointment.propose); a different day is refused as an amendment", survivor: "app/actions/title/closing-appointment.ts" },
  { surface: "portal: family search visibility", file: "app/components/portal/PortalSettingsPage.tsx", was: "present-but-unwired", oldCopy: "Family search visibility (not available yet)", action: "WIRED — a link to the shared-search member control that already existed", survivor: "app/components/portal/CollaborativeSearchDashboard.tsx" },
  { surface: "portal: share activity with agent", file: "app/components/portal/PortalSettingsPage.tsx", was: "unsupported/deferred", oldCopy: "Share activity with agent (not available yet)", action: "REMOVED from the launch surface with a tombstone — agents see portal activity by design; the rule is stated and the data-subject exits remain", survivor: "app/actions/portal-settings.ts" },
  { surface: "manager trust: improvement proposals", file: "app/dashboard/admin/manager-trust/improvement-proposals-panel.tsx", was: "implemented-missing-owner-config", oldCopy: "not available yet (pending migration m709)", action: "COPY CORRECTED — m709 is applied live; the fallback now says the store is missing from this database", survivor: "app/actions/admin/improvement-proposals.ts" },
  { surface: "manager trust: tenant constitution history", file: "app/dashboard/admin/manager-trust/tenant-constitution-panel.tsx", was: "implemented-missing-owner-config", oldCopy: "not available yet (pending migration m696)", action: "COPY CORRECTED — m696 is applied live", survivor: "lib/kernel/tenant-policy.ts" },
  { surface: "manager trust: workforce thresholds", file: "app/dashboard/admin/manager-trust/workforce-thresholds-editor.tsx", was: "implemented-missing-owner-config", oldCopy: "The proposal store is not available yet", action: "COPY CORRECTED — m709 is applied live", survivor: "app/actions/admin/improvement-proposals.ts" },
  { surface: "command center: resource allocation", file: "app/dashboard/admin/command-center/allocation-card.tsx", was: "implemented-missing-owner-config", oldCopy: "The proposal store is not available yet", action: "COPY CORRECTED — m709 is applied live", survivor: "lib/kernel/resource-allocation.ts" },
  { surface: "commission agreements history", file: "app/dashboard/financials/agreements/page.tsx", was: "implemented-missing-owner-config", oldCopy: "The terms history is not available yet", action: "COPY CORRECTED — m812 is applied live", survivor: "app/actions/commission-agreement-history.ts" },
  { surface: "phone settings: voice cloning", file: "app/dashboard/admin/phone-settings/phone-settings-client.tsx", was: "implemented-missing-owner-config", oldCopy: "Voice cloning isn't available yet", action: "CONFIGURATION MESSAGE — capability status for the tenant; ELEVENLABS_API_KEY named here and in the notes (never on a tenant screen — readiness V6)", survivor: "app/dashboard/admin/phone-settings/phone-settings-client.tsx" },
  { surface: "collaborative search refusals", file: "app/actions/collaborative-search.ts", was: "implemented-missing-owner-config", oldCopy: "Collaborative search is not yet available.", action: "CONFIGURATION MESSAGE — says the platform switched it off; the kill switch COLLABORATIVE_SEARCH_ENABLED is derived from the code and named here for platform staff, never to a portal contact", survivor: "app/actions/collaborative-search.ts" },
  { surface: "required-docs: state citations", file: "app/actions/compliance/manage-required-docs.ts", was: "implemented-missing-owner-config", oldCopy: "citations are not available yet", action: "COPY CORRECTED — m847 is applied live", survivor: "app/actions/compliance/manage-required-docs.ts" },
  { surface: "CRM tours gate", file: "app/crm/contacts/[contactId]/tours/page.tsx", was: "missing-reader/writer/evidence", oldCopy: "Tour Planning Not Yet Available", action: "COPY CORRECTED — a buyer-stage gate, not a missing capability (tour planning is built)", survivor: "app/actions/tour-planner.ts" },
  { surface: "market trend (3 cards)", file: "app/home-value/result/[requestId]/page.tsx", was: "missing-reader/writer/evidence", oldCopy: "\"Not yet available\"", action: "COPY CORRECTED — a data-coverage state (no market_data row for the area), said as such", survivor: "app/actions/home-value.ts" },
  { surface: "call transcript", file: "app/components/voice/TranscriptViewer.tsx", was: "missing-reader/writer/evidence", oldCopy: "Transcript not yet available", action: "COPY CORRECTED — an asynchronous processing state, said as such", survivor: "app/components/voice/TranscriptViewer.tsx" },
]

function renderClassification(lines: string[], sites: ClassifiedSite[]): void {
  const count = (c: SurfaceClass) => sites.filter((s) => s.cls === c).length
  const derived = sites.filter((s) => s.derivedFrom === "code").length
  lines.push("## Classification — every unfinished / not-configured / not-available sentence (ruling 9, lane 147H)")
  lines.push("")
  lines.push(`Owner ruling 9 (2026-10-31): *"Build the missing capabilities and the ones that say 'not available yet'. Every exposed function works, gives an honest configuration message, or leaves the advertised launch surface."* Population: every line of STRIPPED source in \`app/**\` carrying the honest-state phrase family (and every "not available yet" line in \`lib/**\`) — ${sites.length} sentences (${sites.filter((s) => s.scope === "ui").length} on screens, ${sites.filter((s) => s.scope === "server").length} server refusals a screen relays). Each sits in exactly one class, **derived from code** for ${derived} (an env var the runtime reads, a fail-closed tenant guard, a connection / provider probe, a migration stamp) and from the published allow-list (\`CLASSIFIED_SURFACES\`) for ${sites.length - derived}. A missing credential is configuration, never an engineering failure.`)
  lines.push("")
  lines.push(`| class | sentences |`)
  lines.push(`|---|---|`)
  for (const c of SURFACE_CLASSES) lines.push(`| ${c} | ${count(c)} |`)
  lines.push(`| UNCLASSIFIED (must be 0) | ${sites.filter((s) => !s.cls).length} |`)
  lines.push("")
  lines.push("### Closed this wave (were in another class at 4d527cc3)")
  lines.push("")
  lines.push("| surface | file | class at 4d527cc3 | action taken | survivor |")
  lines.push("|---|---|---|---|---|")
  for (const c of CLOSED_THIS_WAVE) lines.push(`| ${c.surface} | \`${c.file}\` | ${c.was} | ${c.action} | \`${c.survivor}\` |`)
  lines.push("")
  lines.push("### Every remaining sentence")
  lines.push("")
  lines.push("| file | line(s) | scope | phrase | class | derived from | basis (variable / evidence) | action |")
  lines.push("|---|---|---|---|---|---|---|---|")
  const groups = new Map<string, ClassifiedSite[]>()
  for (const s of sites) { const k = `${s.file}|${s.cls}|${s.derivedFrom}|${s.basis}`; const g = groups.get(k) ?? []; g.push(s); groups.set(k, g) }
  for (const g of [...groups.values()].sort((a, b) => a[0].file.localeCompare(b[0].file) || a[0].line - b[0].line)) {
    const s = g[0]
    lines.push(`| \`${s.file}\` | ${g.map((x) => x.line).join(", ")} | ${s.scope} | ${[...new Set(g.map((x) => x.phrase.toLowerCase()))].join(" / ")} | ${s.cls ?? "**UNCLASSIFIED**"} | ${s.derivedFrom ?? "—"} | ${s.basis.replace(/\|/g, "\\|")} | ${s.action.replace(/\|/g, "\\|")} |`)
  }
  lines.push("")
  const mig = migrationNamingCopy()
  lines.push("### Migration-gated fallbacks (copy that names a migration, with its stamp)")
  lines.push("")
  lines.push("A fallback naming an APPLIED migration fires only on a database missing it — dormant live, a deployment step wherever it fires. One naming a WRITTEN migration is waiting on the integrator.")
  lines.push("")
  lines.push("| at | migration | stamp |")
  lines.push("|---|---|---|")
  for (const m of mig) lines.push(`| \`${m.at}\` | ${m.migration} | ${m.stamp} |`)
  lines.push("")
}

// ── the derivation ────────────────────────────────────────────────────────────
type Row = { role: string; domain: string; label: string; href: string; page: string | null; via?: string; verdict: Verdict; behind: string; partial?: string; honestAt?: string; hop: 0 | 1 }
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
    return { role, domain: domainOf(res.page.file), label, href, page: res.page.file, via, verdict, behind: behind(r), partial: r.honestPartial ?? undefined, honestAt: r.honestAt ?? undefined, hop: 0 }
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

function renderDoc(rows: Row[], gaps: string[], meta: { publicPages: number; portalPages: number }, sites: ClassifiedSite[] = classifySites()): string {
  const classAt = (at?: string) => { if (!at) return null; const s = sites.find((x) => `${x.file}:${x.line}` === at); return s?.cls ?? null }
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
  lines.push("<!-- GENERATED by `npx tsx scripts/ui-capability-surface-audit.ts --write-doc` (wave 146, lane 146H; classification wave 147, lane 147H). Do not hand-edit: the guard fails when this file disagrees with the derivation. -->")
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
  for (const r of notBuilt) lines.push(`| ${r.role} | ${r.domain} | ${r.label} \`${r.href}\` | ${r.page ? `\`${r.page}\`` : "—"} | ${r.verdict} | ${r.verdict === "PARTIAL" ? `says "${r.partial}"${r.honestAt ? ` (\`${r.honestAt}\` — ${classAt(r.honestAt) ?? "UNCLASSIFIED"})` : ""}` : r.verdict === "MISSING" ? (r.page ? `honest state — says "${r.partial}"${r.honestAt ? ` (\`${r.honestAt}\` — ${classAt(r.honestAt) ?? "UNCLASSIFIED"})` : ""}` : "no page serves the href") : "controls without a data path"} |`)
  lines.push("")
  renderClassification(lines, sites)
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
  // A dynamic segment is classified as the id a real link carries (uuid-shaped), not as a literal "x": the proxy
  // answers per path SHAPE (wave 146, 146Z — /listings/<uuid> is public, /listings/new is not), and an "x" placeholder
  // would read a fixed route as still blocked forever.
  for (const f of publicPages) for (const link of reachForPage(f).links) {
    const res = resolveHref(link)
    if (!res.page) continue
    const route = "/" + res.page.segs.join("/")
    if (proxyOfRoute(route) === "protected" && !/^\/(?:login|signup|dashboard|portal|vendor|lender|title)(?:\/|$)/.test(route)) blocked.push(`${f} → ${link} (${res.page.file})`)
  }
  const uniqueBlocked = [...new Set(blocked)]
  for (const b of uniqueBlocked) console.log(`    PUBLIC → PROTECTED ${b} — ${KNOWN_PUBLIC_BLOCKS[b.split(" → ")[1].split(" ")[0]] ? `routed: ${KNOWN_PUBLIC_BLOCKS[b.split(" → ")[1].split(" ")[0]].owner}` : "UNROUTED"}`)
  const unroutedBlocks = uniqueBlocked.filter((b) => !KNOWN_PUBLIC_BLOCKS[b.split(" → ")[1].split(" ")[0]])
  check("P1 every public page that links an anonymous visitor into a PROTECTED page is routed to its owner (a NEW one fails) — the visitor would meet /login", unroutedBlocks.length === 0, unroutedBlocks.join("; "))
  const staleBlocks = Object.keys(KNOWN_PUBLIC_BLOCKS).filter((k) => !uniqueBlocked.some((b) => b.split(" → ")[1].split(" ")[0] === k))
  check("P2 no KNOWN_PUBLIC_BLOCKS entry outlives its block", staleBlocks.length === 0, staleBlocks.join("; "))
  // RE-ASSERTED (wave 146, 146Z): the control used to require the MEASURED block itself ("/listings/x" protected) —
  // a waypoint the fix retires. The rule it guarded is that the finder can SEE a public→protected link: a protected
  // dynamic destination must still classify protected through the same placeholder, and the fixed page public.
  const ctlBlocked = proxyOfRoute("/listings/[listingId]/edit") === "protected" && proxyOfRoute("/transactions/[id]") === "protected" && resolveHref("/listings/x").page?.file === "app/listings/[listingId]/page.tsx"
  check("P3 positive control — the finder's route classifier still flags a PROTECTED dynamic destination (/listings/<id>/<child>, /transactions/<id>), and the public listing page /listings/<uuid> reads public", ctlBlocked && proxyOfRoute("/listings/[listingId]") === "public")

  // ── G · expected coverage (ruling 18) ───────────────────────────────────────
  console.log("\n[G · ruling-18 coverage — every level reaches every domain it should]")
  const gaps = gapsOf(rows)
  for (const g of gaps) console.log(`    GAP ${g} — ${KNOWN_GAPS[g] ? `${KNOWN_GAPS[g].why} (owner ${KNOWN_GAPS[g].owner})` : "UNROUTED"}`)
  const unrouted = gaps.filter((g) => !KNOWN_GAPS[g])
  const stale = Object.keys(KNOWN_GAPS).filter((g) => !gaps.includes(g))
  check("G1 every expected-coverage gap is routed to its owner (a NEW gap fails)", unrouted.length === 0, unrouted.join("; "))
  check("G2 no KNOWN_GAPS entry outlives its gap (a closed gap is deleted, never kept as decoration)", stale.length === 0, stale.join("; "))

  // ── D · the document ────────────────────────────────────────────────────────
  // ── C · classification (wave 147, lane 147H — ruling 9) ────────────────────
  console.log("\n[C · classification — every unfinished / not-configured / not-available sentence in exactly one class]")
  const sites = classifySites()
  const byClass = SURFACE_CLASSES.map((c) => `${c} ${sites.filter((s) => s.cls === c).length}`).join(" · ")
  console.log(`    denominator: ${sites.length} sentences (${sites.filter((s) => s.scope === "ui").length} ui, ${sites.filter((s) => s.scope === "server").length} server) — ${byClass}; derived from code ${sites.filter((s) => s.derivedFrom === "code").length}, allow-list ${sites.filter((s) => s.derivedFrom === "allow-list").length}`)
  const unclassified = sites.filter((s) => !s.cls)
  for (const s of unclassified) console.log(`    UNCLASSIFIED ${s.file}:${s.line} ${s.text.slice(0, 120)}`)
  check("C1 every honest-state sentence sits in exactly one of the five classes (derived from code, else the published allow-list)", unclassified.length === 0, unclassified.map((s) => `${s.file}:${s.line}`).join("; "))
  const naYet = sites.filter((s) => NOT_AVAILABLE.test(s.text))
  check(`C1b no "not available yet" sentence exists without a classification row (${naYet.length} in the tree, app/** + lib/**)`, naYet.every((s) => !!s.cls), naYet.filter((s) => !s.cls).map((s) => `${s.file}:${s.line}`).join("; "))
  const env = envNames()
  const contradictions = sites.filter((s) => {
    const listed = CLASSIFIED_SURFACES.find((r) => r.file === s.file && (!r.match || s.text.includes(r.match)))
    if (!listed) return false
    const d = deriveSurfaceClass(readCode(join(ROOT, s.file)).split("\n"), s.line - 1, env, readCode(join(ROOT, s.file)))
    return !!d && d.cls !== listed.cls
  })
  check("C2 no allow-list row contradicts what the code derives for the same sentence", contradictions.length === 0, contradictions.map((s) => `${s.file}:${s.line}`).join("; "))
  const staleRows = CLASSIFIED_SURFACES.filter((r) => !sites.some((s) => s.file === r.file && (!r.match || s.text.includes(r.match))))
  check("C3 no allow-list row outlives its sentence (a row whose copy is gone is deleted, never kept as decoration)", staleRows.length === 0, staleRows.map((r) => `${r.file}${r.match ? ` "${r.match}"` : ""}`).join("; "))
  const mig = migrationNamingCopy()
  check(`C4 every copy that names a migration names one in the tree (${mig.length} sentences; ${mig.filter((m) => m.stamp === "applied").length} dormant fallbacks of applied migrations, ${mig.filter((m) => m.stamp === "written").length} waiting on the integrator)`, mig.every((m) => m.stamp !== "absent"), mig.filter((m) => m.stamp === "absent").map((m) => `${m.at} ${m.migration}`).join("; "))
  const closedBad = CLOSED_THIS_WAVE.filter((c) => !existsSync(join(ROOT, c.file)) || !existsSync(join(ROOT, c.survivor)) || (!!c.oldCopy && readCode(join(ROOT, c.file)).includes(c.oldCopy)))
  check(`C5 every surface closed this wave carries its fix in the tree (${CLOSED_THIS_WAVE.length}: the old sentence is gone from the file and the survivor exists)`, closedBad.length === 0, closedBad.map((c) => c.surface).join("; "))
  const partialRows = rows.filter((r) => (r.verdict === "PARTIAL" || (r.verdict === "MISSING" && r.page)) && r.honestAt)
  const rowUnclassified = partialRows.filter((r) => !sites.some((s) => `${s.file}:${s.line}` === r.honestAt && s.cls))
  check(`C6 the sentence behind every PARTIAL / honest-MISSING screen is classified (${partialRows.length} screens)`, rowUnclassified.length === 0, [...new Set(rowUnclassified.map((r) => `${r.page} @ ${r.honestAt}`))].join("; "))
  {
    const L = (t: string[]) => t
    const envCtl = deriveSurfaceClass(L(["const x = 1", "if (!key) return { error: \"FOO_API_KEY not configured\" }"]), 1, new Set(["FOO_API_KEY"]), "")
    const identCtl = deriveSurfaceClass(L(["if (!ON) return { error: \"Feature is not yet available.\" }"]), 0, new Set(), `const ON = ${"process"}.env.FOO_ENABLED !== 'false'`)
    const guardCtl = deriveSurfaceClass(L(["if (!profile?.brokerage_id) return <div>Brokerage not configured</div>"]), 0, new Set(), "")
    const migCtl = deriveSurfaceClass(L(["return \"History is not available yet (pending migration m9998)\""]), 0, new Set(), "")
    const noneCtl = deriveSurfaceClass(L(["<p>This part is not available yet.</p>"]), 0, new Set(), "")
    const fakeUnclassified = classifySites([{ file: "app/__no_such_file__.tsx", line: 1, phrase: "not available yet", text: "<p>not available yet</p>", scope: "ui" }])[0]
    check("CX POSITIVE CONTROLS — an env-named refusal and an env-assigned kill switch derive owner-config; a falsy-brokerage guard derives owner-config; an unapplied migration derives missing-reader/writer/evidence; a bare claim derives nothing and an unlisted sentence reads UNCLASSIFIED",
      envCtl?.cls === "implemented-missing-owner-config" && /FOO_API_KEY/.test(envCtl.basis) && identCtl?.cls === "implemented-missing-owner-config" && /FOO_ENABLED/.test(identCtl.basis)
      && guardCtl?.cls === "implemented-missing-owner-config" && migCtl?.cls === "missing-reader/writer/evidence" && noneCtl === null && fakeUnclassified.cls === null,
      JSON.stringify({ envCtl, identCtl, guardCtl, migCtl, noneCtl, fake: fakeUnclassified.cls }))
  }

  console.log("\n[D · docs/architecture/CAPABILITY-SURFACE-AUDIT.md]")
  const doc = renderDoc(rows, gaps, { publicPages: publicPages.length, portalPages: portalPages.length }, sites)
  if (WRITE_DOC) { writeFileSync(DOC_PATH, doc); console.log(`    written: ${rel(DOC_PATH)} (${doc.split("\n").length} lines)`) }
  const onDisk = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, "utf8") : ""
  check("D1 the committed audit document agrees with the derivation (regenerate with --write-doc)", onDisk === doc, onDisk ? "drifted — run with --write-doc" : "missing")

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
  console.log("✅ UI_CAPABILITY_SURFACE_PASS — every level's surfaces resolve, reach their actions, and cover the ruling-18 domains or name the owner of the gap")
}
// Run only when invoked as the guard, so a canary can import derive / resolveHref / verdictOf / the tables.
if (/ui-capability-surface-audit\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1) })
