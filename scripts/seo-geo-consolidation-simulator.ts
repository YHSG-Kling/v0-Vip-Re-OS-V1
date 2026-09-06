#!/usr/bin/env tsx
/**
 * scripts/seo-geo-consolidation-simulator.ts  (npm run test:seo-geo-consolidation)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE SEO / GEO SECTION, NOT THREE NAV ENTRIES. The owner wants competitors +
 * popular keywords to live in the SEO section, and the SEO section to also cover
 * GEO (AI-search visibility). The standalone "Competitors" and "Market
 * Intelligence" marketing nav entries overlapped and are now TABS under a single
 * /dashboard/marketing/seo surface: Keywords · Competitors · Market Trends ·
 * GEO / AI Visibility. This proves (1) the four tabs exist and each renders the
 * kept surface; (2) the two folded routes redirect (no dead links); (3) the
 * duplicate nav entries are gone and SEO is relabeled "SEO / GEO"; (4) the
 * separate Intelligence Center was left untouched.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the SEO page is a tabbed SEO / GEO surface with all four tabs ──")
{
  const page = src("app/dashboard/marketing/seo/page.tsx")
  check("declares the four tabs (keywords, competitors, trends, geo)",
    /"keywords"/.test(page) && /"competitors"/.test(page) && /"trends"/.test(page) && /"geo"/.test(page))
  check("Keywords tab renders SeoKeywordsDashboardClient", page.includes("SeoKeywordsDashboardClient"))
  check("Competitors tab reuses the CompetitorsClient (kept, unchanged)",
    page.includes("CompetitorsClient") && page.includes("../competitors/competitors-client"))
  check("Market Trends tab renders the extracted MarketTrendsPanel", page.includes("MarketTrendsPanel"))
  check("Trends tab is fed by the real intelligence actions",
    page.includes("getTrendingKeywords") && page.includes("getCompetitorHighPerformers"))
  check("GEO tab reuses AiCitationVisibilityCard (the AI-search visibility signal)",
    page.includes("AiCitationVisibilityCard") && page.includes("ai_search_citation_observations"))
  check("tab switching is driven by the ?tab= search param",
    /searchParams/.test(page) && /\?tab=\$\{t\.key\}/.test(page))
  // The empty state MOVED rather than disappeared (m335): it is now per-scope,
  // because "you have published nothing citable yet" is a different fact from
  // "the company has no data". Retargeted at the delegation plus the sentence's
  // new home — not weakened to "some empty state exists somewhere".
  check("GEO tab has an explicit empty state (per-scope, from citation-scope)",
    /emptyScopeMessage\(active\.scope/.test(page) &&
    /No AI-search citation data yet/.test(src("lib/geo/citation-scope.ts")))
  check("...and the scope switcher is wired to the same resolver",
    /allowedScopes\(/.test(page) && /resolveScope\(/.test(page))
}

console.log("\n── the MarketTrendsPanel keeps the trending-keyword + competitor-post view ──")
{
  const panel = src("app/dashboard/marketing/seo/components/market-trends-panel.tsx")
  check("renders Trending Keywords", panel.includes("Trending Keywords"))
  check("renders Competitor High-Performers", panel.includes("Competitor High-Performers"))
  check("typed on the real action return shapes",
    panel.includes("TrendingKeyword") && panel.includes("CompetitorPost"))
}

console.log("\n── the two folded routes redirect into the SEO tabs (no dead links) ──")
{
  const comp = src("app/dashboard/marketing/competitors/page.tsx")
  check("competitors page redirects to ?tab=competitors",
    comp.includes("redirect") && comp.includes("/dashboard/marketing/seo?tab=competitors"))
  const intel = src("app/dashboard/marketing/intelligence/page.tsx")
  check("intelligence page redirects to ?tab=trends",
    intel.includes("redirect") && intel.includes("/dashboard/marketing/seo?tab=trends"))
}

console.log("\n── nav: SEO relabeled, duplicate entries removed across every role tree ──")
{
  const nav = src("app/config/navigation-config.ts")
  check("no standalone Competitors nav entry remains", !nav.includes("/dashboard/marketing/competitors"))
  check("no standalone Market Intelligence nav entry remains", !nav.includes("/dashboard/marketing/intelligence"))
  check("the SEO entry is relabeled 'SEO / GEO'",
    nav.includes("'SEO / GEO'") && !nav.includes("SEO Dashboard"))
  check("the SEO route itself is still present", nav.includes("/dashboard/marketing/seo"))
}

console.log("\n── the SEPARATE Intelligence Center is left untouched ──")
{
  const intelCenter = src("app/dashboard/intelligence/page.tsx")
  check("the Intelligence Center keeps its own AiCitationVisibilityCard mount",
    intelCenter.includes("AiCitationVisibilityCard") && intelCenter.includes("IntelligenceOSClient"))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ SEO_GEO_CONSOLIDATION_FAIL"); process.exit(1) }
console.log(" ✅ SEO_GEO_CONSOLIDATION_PASS — one SEO / GEO surface (keywords · competitors · trends · GEO); folded routes redirect; nav de-duplicated")
