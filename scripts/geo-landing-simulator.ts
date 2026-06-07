#!/usr/bin/env tsx
/**
 * scripts/geo-landing-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 GEO — public video landing-page builder harness.
 *
 * Exercises the REAL pure layer (lib/geo/video-landing.ts) that the public
 * /v/[slug] page, llms.txt, robots, and sitemap routes consume: SEO slug
 * generation, schema.org VideoObject + RealEstateListing + BreadcrumbList
 * JSON-LD, XSS-safe serialization, llms.txt body, duration math, and the
 * AI-crawler allowlist. Proves the AI-search-discoverability contract
 * without a browser or DB.
 *
 * Run:  npx tsx scripts/geo-landing-simulator.ts
 * Exit: 0 = all pass, 1 = any failure (CI gate).
 */
import {
  slugifyTitle,
  isPublishableRender,
  buildVideoObjectJsonLd,
  buildRealEstateListingJsonLd,
  buildBreadcrumbJsonLd,
  serializeJsonLd,
  buildLlmsTxt,
  secondsToIso8601,
  framesToSeconds,
  AI_CRAWLER_BOTS,
} from "../lib/geo/video-landing"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const RID = "f2c58b0e-fdfd-48c6-af8c-18990dac272e"

function testSlug() {
  console.log("\n[SEO slug generation]")
  const s = slugifyTitle("Just Listed — 123 Main Street, Brickell FL!", "JustListedReel", RID)
  check("kebab-cased + special chars stripped", /^[a-z0-9-]+$/.test(s), s)
  check("no leading/trailing/double dashes", !/^-|--|-$/.test(s), s)
  check("ends with 8-char render id suffix", s.endsWith("-f2c58b0e"), s)
  check("deterministic for same inputs", slugifyTitle("Just Listed — 123 Main Street, Brickell FL!", "JustListedReel", RID) === s)
  check("falls back to display_name when no title", slugifyTitle(null, "MarketUpdateReel", RID).startsWith("marketupdatereel-"))
  check("falls back to 'video' when title + fallback empty", slugifyTitle("", "", RID).startsWith("video-"))
  const long = slugifyTitle("x".repeat(200), "f", RID)
  check("kebab body capped (<= 60 + suffix)", long.length <= 60 + 1 + 8, String(long.length))
  check("unicode normalized (accents folded to ascii-ish)", /^[a-z0-9-]+$/.test(slugifyTitle("Café Münster Über", "f", RID)))
}

function testPublishable() {
  console.log("\n[Publishability gate]")
  check("succeeded + url + video category → publishable", isPublishableRender({ renderStatus: "succeeded", outputUrl: "https://x/v.mp4", category: "listing" }))
  check("failed → NOT publishable", !isPublishableRender({ renderStatus: "failed", outputUrl: "https://x/v.mp4", category: "listing" }))
  check("no output_url → NOT publishable", !isPublishableRender({ renderStatus: "succeeded", outputUrl: null, category: "listing" }))
  check("postcard (print-only) → NOT publishable", !isPublishableRender({ renderStatus: "succeeded", outputUrl: "https://x/p.png", category: "postcard" }))
  check("thumbnail/still IS publishable (e.g. lead_magnet)", isPublishableRender({ renderStatus: "succeeded", outputUrl: "https://x/c.png", category: "lead_magnet" }))
}

function testVideoLd() {
  console.log("\n[schema.org VideoObject]")
  const ld = buildVideoObjectJsonLd({
    name: "Just Listed — 123 Main", description: "A 3 bed in Brickell.",
    thumbnailUrl: "https://x/thumb.png", contentUrl: "https://x/v.mp4",
    uploadDate: "2026-06-07T00:00:00Z", durationSec: 25, publisherName: "VIP Realty",
    pageUrl: "https://app/v/abc",
  })
  check("@type VideoObject", ld["@type"] === "VideoObject")
  check("@context schema.org", ld["@context"] === "https://schema.org")
  check("required: name/description/contentUrl/uploadDate", !!ld.name && !!ld.description && !!ld.contentUrl && !!ld.uploadDate)
  check("thumbnailUrl is an array", Array.isArray(ld.thumbnailUrl) && (ld.thumbnailUrl as string[])[0] === "https://x/thumb.png")
  check("duration → ISO-8601 PT#M#S", ld.duration === "PT25S")
  check("publisher Organization", (ld.publisher as any)?.["@type"] === "Organization" && (ld.publisher as any)?.name === "VIP Realty")
  const noThumb = buildVideoObjectJsonLd({ name: "x", description: "y", thumbnailUrl: null, contentUrl: "https://x/v.mp4", uploadDate: "2026-06-07T00:00:00Z", pageUrl: "https://app/v/abc" })
  check("no thumbnail → key omitted (no null pollution)", !("thumbnailUrl" in noThumb))
  check("zero duration → key omitted", !("duration" in noThumb))
}

function testListingLd() {
  console.log("\n[schema.org RealEstateListing]")
  const ld = buildRealEstateListingJsonLd({
    name: "Just Listed", description: "d", url: "https://app/v/abc", imageUrl: "https://x/t.png",
    streetAddress: "123 Main St", city: "Tampa", state: "FL", price: 625000, bedrooms: 3, bathrooms: 2,
  })!
  check("@type RealEstateListing", ld["@type"] === "RealEstateListing")
  check("about SingleFamilyResidence", (ld.about as any)?.["@type"] === "SingleFamilyResidence")
  check("PostalAddress shape", (ld.about as any)?.address?.["@type"] === "PostalAddress" && (ld.about as any)?.address?.streetAddress === "123 Main St" && (ld.about as any)?.address?.addressRegion === "FL")
  check("beds/baths mapped", (ld.about as any)?.numberOfBedrooms === 3 && (ld.about as any)?.numberOfBathroomsTotal === 2)
  check("Offer with USD price", (ld.offers as any)?.["@type"] === "Offer" && (ld.offers as any)?.price === 625000 && (ld.offers as any)?.priceCurrency === "USD")
  check("no facts → null (no misleading empty schema)", buildRealEstateListingJsonLd({ name: "x", description: "d", url: "u", imageUrl: null, streetAddress: null, city: null, state: null, price: null, bedrooms: null, bathrooms: null }) === null)
  check("price 0 → no Offer emitted", !("offers" in (buildRealEstateListingJsonLd({ name: "x", description: "d", url: "u", imageUrl: null, streetAddress: "1 A St", city: null, state: null, price: 0, bedrooms: null, bathrooms: null })!)))
}

function testBreadcrumbAndSerialize() {
  console.log("\n[Breadcrumb + XSS-safe serialize]")
  const bc = buildBreadcrumbJsonLd({ siteName: "VIP", siteUrl: "https://app", agentName: "Jane Doe", pageUrl: "https://app/v/abc", pageName: "Just Listed" })
  check("@type BreadcrumbList", bc["@type"] === "BreadcrumbList")
  check("positions sequential 1..3 with agent", (bc.itemListElement as any[]).map((i) => i.position).join(",") === "1,2,3")
  const bcNoAgent = buildBreadcrumbJsonLd({ siteName: "VIP", siteUrl: "https://app", agentName: null, pageUrl: "https://app/v/abc", pageName: "x" })
  check("agent omitted → 2 items", (bcNoAgent.itemListElement as any[]).length === 2)
  const evil = serializeJsonLd({ name: "</script><script>alert(1)</script>", note: "<!--x" })
  check("escapes </script (no tag break-out)", !evil.includes("</script>") && evil.includes("<\\/script"))
  check("escapes <!-- comment open", !evil.includes("<!--"))
  check("still valid JSON after escaping", (() => { try { JSON.parse(evil.replace(/<\\\//g, "</").replace(/<\\!--/g, "<!--")); return true } catch { return false } })())
}

function testLlmsAndDuration() {
  console.log("\n[llms.txt + duration math + crawler allowlist]")
  const body = buildLlmsTxt({ siteName: "VIP Real Estate OS", siteSummary: "AI real-estate videos.", pages: [
    { title: "Just Listed — 123 Main", url: "https://app/v/abc", summary: "3bd Brickell" },
  ]})
  check("llms.txt has H1 site name", body.startsWith("# VIP Real Estate OS"))
  check("llms.txt has blockquote summary", body.includes("> AI real-estate videos."))
  check("llms.txt lists page as markdown link", body.includes("- [Just Listed — 123 Main](https://app/v/abc): 3bd Brickell"))
  check("llms.txt empty pages → placeholder", buildLlmsTxt({ siteName: "S", siteSummary: "x", pages: [] }).includes("(no published videos yet)"))
  check("secondsToIso8601 25s → PT25S", secondsToIso8601(25) === "PT25S")
  check("secondsToIso8601 90s → PT1M30S", secondsToIso8601(90) === "PT1M30S")
  check("framesToSeconds 750f@30 → 25s", framesToSeconds(750, 30) === 25)
  check("framesToSeconds fps 0 guard → 0", framesToSeconds(750, 0) === 0)

  for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot"]) {
    check(`crawler allowlist welcomes ${bot}`, (AI_CRAWLER_BOTS as readonly string[]).includes(bot))
  }
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" GEO video landing-page simulator (m173)")
  console.log("══════════════════════════════════════════════════")
  testSlug()
  testPublishable()
  testVideoLd()
  testListingLd()
  testBreadcrumbAndSerialize()
  testLlmsAndDuration()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ All GEO landing-page checks passed")
}
main()
