/**
 * scripts/canaries/publishing.ts — PUBLISHING canary (wave 144, lane 144J; owner rulings 15 + 16 + 18 display notice):
 *   the book creator serves the PLATFORM's own KDP book, tenant / agent lead magnets AND tenant KDP books — the ownership /
 *   publishing context explicit · topics chosen on evidence of demand and unmet interest (never generic) · logos, brand
 *   colours and approved taglines from the brand context · outline → manuscript → fact checks → original creative → cover →
 *   formatting → metadata → approved export · ALWAYS a humanized review after the draft · never a bestseller promise ·
 *   the TV-ad provider path stays lib/ads/ctv-campaign.ts (wave 143's lib/video/tv-spot*.ts is the creative judge) · the
 *   platform's copyright / licensing prohibition is DISPLAYED.
 * Through the survivors at 967a4866: lib/lead-magnets/book-publishing.ts (scanBookClaims, composeKdpMetadata /
 * validateKdpMetadata, buildEpub — pure), lib/lead-magnets/book-creator.ts (BOOK_STAGES, composeBookPdfData — pure),
 * lib/ads/ctv-campaign.ts + lib/providers/vibe.ts, lib/video/tv-spot.ts. Nothing is uploaded or published.
 *
 * MEASURED AT 967a4866: a book project carries no ownership / publishing context (platform KDP vs tenant magnet vs tenant
 * KDP), its research is topic-bank titles (no demand evidence), its PDF data carries no logo or brand colours, and no
 * humanized-review stage gates the export — 144H.
 */
import { LIVE, canary, landedModule } from "./_harness"
import { findLanded, listFiles, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Publishing: platform / tenant book contexts · demand-evidenced topics · branding · humanized review · usable outputs · no bestseller promise · TV-ad provider retained · copyright notice displayed")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const pub = await import("../../lib/lead-magnets/book-publishing")
  const creator = await import("../../lib/lead-magnets/book-creator")

  // ── 1 · never a bestseller promise (green — preserve) ──
  const dirty = pub.scanBookClaims({ description: "The Amazon #1 bestseller every Pensacola seller needs.", subtitle: "Guaranteed to become a best-seller" })
  const clean = pub.scanBookClaims({ description: "A plain-language guide to selling a home in Pensacola, step by step." })
  c.rule("144H", "NEVER PROMISE BESTSELLER STATUS (green — preserve): rank / bestseller / '#1' / guarantee-of-rank language in the public fields is found and named; plain descriptive copy passes", dirty.length >= 2 && clean.length === 0, dirty.map((f) => `${f.where}: ${f.rule}`).join("; "))

  // ── 2 · usable outputs: metadata + EPUB (green — preserve) ──
  const chapters = Array.from({ length: 4 }, (_, i) => ({ heading: `Chapter ${i + 1}: Pricing your home`, body: "A clear walk through the steps a seller takes. ".repeat(60) }))
  const book = { title: "Selling in Pensacola", subtitle: "A plain-language guide", tagline: "Know every step before you list", introduction: "Why this guide exists.", closing: "What to do next.", chapters, audience: "seller" as const, area: "Pensacola, FL", concept: "selling a home in Pensacola", authorName: "Casey Agent", brokerageName: "Canary Realty", landingUrl: null, year: 2026 }
  const meta = pub.composeKdpMetadata(book)
  const problems = pub.validateKdpMetadata(meta)
  const epub = pub.buildEpub({ ...book, identifier: "00000000-0000-4000-8000-000000000144", description: meta.descriptionText, now: new Date("2026-10-25T00:00:00Z") })
  c.rule("144H", "USABLE OUTPUTS (green — preserve): the KDP metadata composed from the manuscript validates with no problem, and the EPUB is a real ZIP container (PK header) carrying the chapters — formatting → metadata → export are deterministic", problems.length === 0 && Buffer.isBuffer(epub) && epub.subarray(0, 2).toString("latin1") === "PK" && epub.length > 1000, `${problems.map((p) => `${p.field}: ${p.problem}`).join("; ") || "metadata ok"}; epub ${epub.length} bytes`)

  // ── 3/4/6 · lane 144H's PURE book rules, driven when its file exists (lib/lead-magnets/book-editorial.ts); the WORKFLOW half is
  // read on stripped source — a book-pipeline module (not the rules file) must CALL each rule, so a rule nobody calls stays red.
  const ed = await landedModule("../../lib/lead-magnets/book-editorial.ts")
  const pipeline = [...listFiles("lib/lead-magnets", (f) => /\.ts$/.test(f) && !/book-editorial\.ts$/.test(f)), "lib/kernel/lead-magnets.ts"].map((f) => strippedRepo(f) ?? "").join("\n")
  const calls = (fn: string) => new RegExp(`\\b${fn}\\s*\\(`).test(pipeline)
  const house = { isHouseTenant: true }, tenantB = { isHouseTenant: false }
  const contexts = ed ? {
    three: [...ed.BOOK_PUBLICATION_CONTEXTS].sort().join() === "lead_magnet,platform_kdp,tenant_kdp",
    platformOnlyInHouse: !ed.bookContextAllowed("platform_kdp", tenantB).ok && ed.bookContextAllowed("platform_kdp", house).ok && !ed.bookContextAllowed("tenant_kdp", house).ok,
    ownerAndBrand: (() => { const p = ed.publicationRecord({ context: "platform_kdp", agentId: null, isHouseTenant: true, by: "u", at: "2026-10-25T00:00:00Z", why: "canary" }); const a = ed.publicationRecord({ context: "lead_magnet", agentId: "ag", isHouseTenant: false, by: "u", at: "2026-10-25T00:00:00Z", why: "canary" }); return p.owner === "platform" && p.brand_source === "platform" && a.owner === "agent" && a.brand_source === "tenant" })(),
    kdpMovesTheMagnet: ed.kdpContextFor("lead_magnet", tenantB) === "tenant_kdp" && ed.kdpContextFor("lead_magnet", house) === "platform_kdp",
    workflowReadsIt: calls("bookContextAllowed") && calls("kdpContextFor"),
  } : null
  const now = "2026-10-25T00:00:00Z"
  const evidence = ed ? {
    genericRefused: ed.scoreBookTopicEvidence({ concept: "The Ultimate Home Buying Guide", demand: [{ topic: "how to buy a home", score: 5 }], bank: [], positioning: null, conversion: null, now }).verdict === "generic",
    noDemandRefused: ed.scoreBookTopicEvidence({ concept: "Downsizing from a Pensacola Beach condo after retirement", demand: [], bank: [], positioning: null, conversion: null, now }).verdict === "no_demand",
    evidencedRecordsWhy: (() => { const e = ed.scoreBookTopicEvidence({ concept: "Downsizing from a Pensacola Beach condo after retirement", demand: [{ topic: "where do retirees downsize near Pensacola Beach", score: 9 }, { topic: "condo HOA rules for retirees", score: 4 }], bank: ["55+ communities near Pensacola"], positioning: { titles: ["Retire to Florida"], snippets: [] }, conversion: null, now }); return e.verdict === "evidenced" && !!e.audience_problem && e.gaps.length > 0 && e.positioning.researched })(),
    outlineRefusesWithout: calls("scoreBookTopicEvidence") && /verdict\s*!==\s*["']evidenced["']/.test(pipeline),
  } : null
  const review = ed ? {
    aiDraftNotReady: !ed.humanizedReviewState([{ body: "In today's fast-paced real estate market, it's important to note that buyers delve into listings.", edited: null }]).ready,
    humanRevisedReady: ed.humanizedReviewState([{ body: "In today's fast-paced real estate market…", edited: { human_revised_at: now } }]).ready,
    exportRefusesUnreviewed: calls("humanizedReviewState") && calls("humanizedReviewRefusal"),
  } : null
  const allTrue = (o: Record<string, boolean> | null) => !!o && Object.values(o).every(Boolean)

  // ── 3 · the ownership / publishing context is explicit ──
  const ctx = findLanded(["lib/lead-magnets", "lib/kernel/lead-magnets.ts", "lib/education/book-authority-program.ts", "supabase/migrations"], /\b(publishing_context|publishingContext|BOOK_CONTEXTS?|BookContext|book_context|platform_kdp|tenant_kdp|BOOK_OWNERSHIP\w*|bookOwnership\w*)\b/)
  c.rule("144H", "THREE PUBLISHING CONTEXTS, EXPLICIT (ruling 15: 'the PLATFORM's Amazon (KDP) book AND tenant/agent lead magnets AND tenant KDP books'): every book project names its context and owner — platform KDP (platform brand, platform rights), tenant / agent lead magnet (the tenant's brand, gated capture), tenant KDP (the tenant's rights and KDP account) — and the export / publication workflow reads it", allTrue(contexts), contexts ? `landed rules: ${JSON.stringify(contexts)}` : ctx ? `landed at ${ctx}, but lib/lead-magnets/book-editorial.ts is absent` : `HEAD: BookProject = { ${Object.keys(creator.composeBookPdfData({ stage: "research", concept: "x", audience: "seller", area: null, brand: null, title: "t", subtitle: null, tagline: null, introduction: null, closing: null, research: null, outline: null, chapters: [], fact_check: null, pdf_url: null, document_id: null, page_count: null, cost: { tokens: 0, model_calls: 0 }, needs_human_review: [], started_by: "u", started_at: "", updated_at: "", log: [] })).join(", ")} } — no context / owner field; the magnet is always a tenant lead_capture_forms row`)

  // ── 4 · topics with DEMAND evidence, never generic ──
  // The BOOK pipeline's own files (lib/lead-magnets/suggestions.ts already carries a search_demand reading for lead-magnet IDEAS —
  // a survivor the book research should READ, not the book's own evidence record).
  const bookFiles = [...listFiles("lib/lead-magnets", (f) => /\/book[\w-]*\.ts$/.test(f)), "lib/education/book-authority-program.ts"]
  const demand = findLanded(bookFiles, /\b(demand_evidence|demandEvidence|topic_demand|topicDemand|search_demand|searchDemand|unmet_interest|unmetInterest|competitor_positioning|competitorPositioning)\b/)
  c.rule("144H", "TOPICS CHOSEN ON EVIDENCE OF DEMAND (ruling 15: 'search/topic intelligence, audience problem, competitor positioning, gaps, originality, conversion … never generic'): the research stage records the demand evidence a topic was chosen on (search / topic intelligence, the audience problem, competitor positioning and the gap) and a concept with no evidence is not advanced as a book", allTrue(evidence), evidence ? `landed rules: ${JSON.stringify(evidence)}` : demand ? `landed at ${demand}, but lib/lead-magnets/book-editorial.ts is absent` : "HEAD: research = { topics, bank_topics, fetched_at } — titles, no demand measure")

  // ── 5 · branding: logo + brand colours + approved tagline ──
  // RE-ASSERTED (lane 144Z): this step pinned a SHAPE — "composeBookPdfData's keys name a logo and a colour". The integrator (lane
  // 144X item H4) carried the brand where the PDF engine takes it: the ClientPdfBrand argument (lib/documents/client-pdf.ts —
  // accentColor, tagline and the logo as BYTES, the engine staying network-free), filled by book-creator.ts's brand resolver from
  // the ONE brand context (resolveBrandContext) through the ONE vetting (book-publishing-produce.ts approvedBookBrandAssets). The
  // RULE is the rendered book's: it carries the brand context's logo, colour palette and approved tagline. Asserted on the RENDER
  // (the book's own data through bookPdfSpec → renderClientPdf): with the brand's logo the PDF embeds an image; POSITIVE CONTROL —
  // the same book without one embeds none; and the resolver merges the brand context's logo / colours / approved tagline.
  const bookData = creator.composeBookPdfData({ stage: "layout", concept: "x", audience: "seller", area: "Pensacola", brand: "Canary Realty", title: "Selling in Pensacola", subtitle: null, tagline: "Know every step", introduction: null, closing: null, research: null, outline: null, chapters: [{ heading: "One", body: "Plain words." }], fact_check: null, pdf_url: null, document_id: null, page_count: null, cost: { tokens: 0, model_calls: 0 }, needs_human_review: [], started_by: "u", started_at: "", updated_at: "", log: [] } as never)
  const { bookPdfSpec, renderClientPdf } = await import("../../lib/documents/client-pdf")
  const sharp = (await import("sharp")).default
  const logoPng = await sharp({ create: { width: 300, height: 90, channels: 3, background: { r: 20, g: 60, b: 160 } } }).png().toBuffer()
  const baseBrand = { brokerageName: "Canary Realty", agentName: "Casey Agent", primaryColor: "#14532D" }
  const branded = bookPdfSpec(bookData, { ...baseBrand, accentColor: "#F59E0B", tagline: "Calm advice, local roots", logo: new Uint8Array(logoPng) }, "October 2026")
  const withLogo = Buffer.from(await renderClientPdf(branded)).toString("latin1")
  const noLogo = Buffer.from(await renderClientPdf(bookPdfSpec(bookData, baseBrand, "October 2026"))).toString("latin1")
  const creatorSrc = strippedRepo("lib/lead-magnets/book-creator.ts") ?? ""
  const resolverAt = creatorSrc.indexOf("const defaultBrandResolver")
  const resolverBody = resolverAt < 0 ? "" : creatorSrc.slice(resolverAt, (() => { const n = creatorSrc.slice(resolverAt + 1).search(/\n(?:export\s+)?(?:const|function|async function)\s/); return n < 0 ? undefined : resolverAt + 1 + n })())
  const resolverMerges = /resolveBrandContext\s*\(/.test(resolverBody) && /approvedBookBrandAssets\s*\(/.test(resolverBody) && /accentColor/.test(resolverBody) && /\blogo\b/.test(resolverBody) && /tagline/.test(resolverBody)
  const brandKeys = Object.keys(branded.brand ?? {})
  c.rule("144H", "LOGOS, BRAND COLOURS AND APPROVED TAGLINES (ruling 15): the book's rendered data carries the brand context's logo and colour palette beside the approved tagline (lib/branding/resolve-brand-context.ts is the survivor) — the rendered book embeds the brand's logo (positive control: none without it), the PDF brand carries the accent colour and the approved tagline, and the book's brand resolver merges the brand context's logo / colours / approved tagline through the one vetting", /\/Subtype\s*\/Image/.test(withLogo) && !/\/Subtype\s*\/Image/.test(noLogo) && ["accentColor", "tagline", "logo", "primaryColor"].every((k) => brandKeys.includes(k)) && resolverMerges && bookData.tagline === "Know every step", `logo embedded ${/\/Subtype\s*\/Image/.test(withLogo)} (control without: ${/\/Subtype\s*\/Image/.test(noLogo)}); pdf brand keys ${brandKeys.join(", ")}; resolver merges brand context ${resolverMerges}; book data keys ${Object.keys(bookData).join(", ")}`)

  // ── 6 · a HUMANIZED review after the draft, before export ──
  const humanized = (creator.BOOK_STAGES as readonly string[]).some((s) => /humaniz/.test(s)) || findLanded(["lib/lead-magnets"], /\bhumaniz\w*\b/) !== null
  c.rule("144H", "ALWAYS A HUMANIZED REVIEW AFTER THE DRAFT (ruling 15): the manuscript passes a humanized review (a person reads and revises the AI draft) recorded as its own step, and the approved export / publication refuses a book that has not passed it", allTrue(review), review ? `landed rules: ${JSON.stringify(review)}${humanized ? "" : " (no humaniz* stage name)"}` : `HEAD BOOK_STAGES: ${creator.BOOK_STAGES.join(" → ")} — 'ready_for_review' is a parking state, no humanized-review step gates the export`)

  // ── 7 · the TV-ad provider path is retained, never duplicated (green — preserve) ──
  const ctv = strippedRepo("lib/ads/ctv-campaign.ts") ?? ""
  const spotFiles = listFiles("lib/video", (f) => /tv-spot[\w-]*\.ts$/.test(f))
  const spotDispatch = spotFiles.filter((f) => /@\/lib\/providers\/vibe|dispatchCtvCampaign|vibe\.co/.test(strippedRepo(f) ?? ""))
  const otherDispatchers = [...listFiles("lib", (f) => /\.ts$/.test(f)), ...listFiles("app", (f) => /\.tsx?$/.test(f))].filter((f) => f !== "lib/ads/ctv-campaign.ts" && f !== "lib/providers/vibe.ts" && /\bdispatchCtvCampaign\s*\(/.test(strippedRepo(f) ?? ""))
  c.rule("144H", "THE TV-AD PROVIDER IS RETAINED, NOT DUPLICATED (ruling 16, green — preserve): streaming-TV campaigns stage and dispatch through lib/ads/ctv-campaign.ts → lib/providers/vibe.ts only; wave 143's lib/video/tv-spot*.ts judge / master the creative and never call a CTV provider", /dispatchCtvCampaign/.test(ctv) && spotFiles.length > 0 && spotDispatch.length === 0 && otherDispatchers.every((f) => /lib\/ads\//.test(f)), `tv-spot files ${spotFiles.length}; tv-spot → provider ${spotDispatch.join(",") || "none"}; other dispatchers ${otherDispatchers.join(",") || "none"}`)

  // ── 8 · the copyright / licensing prohibition is DISPLAYED (ruling 18) ──
  const surfaces = [...new Set([...listFiles("app/legal", (f) => /\.tsx?$/.test(f)), ...listFiles("app/(marketing)", (f) => /\.tsx?$/.test(f)), ...listFiles("app/privacy", (f) => /\.tsx?$/.test(f)), ...listFiles("app/trust", (f) => /\.tsx?$/.test(f)), "app/page.tsx", "app/layout.tsx", ...listFiles("app", (f) => /footer/i.test(f) && /\.tsx$/.test(f))])].filter((f) => strippedRepo(f) !== null)
  // A surface carries the notice when its own source, or a module it imports by the @/ alias (ONE hop — the page that renders a
  // shared notice text), states the rights reserved AND the prohibition, in either word order.
  const resolveAlias = (spec: string): string | null => { for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) { const p = `${spec.slice(2)}${ext}`; if (strippedRepo(p) !== null) return p } return null }
  const surfaceText = (f: string) => { const own = strippedRepo(f) ?? ""; const hops = [...own.matchAll(/from\s+["'](@\/[^"']+)["']/g)].map((m) => resolveAlias(m[1])).filter((x): x is string => !!x); return [own, ...hops.map((h) => strippedRepo(h) ?? "")].join("\n") }
  const PROHIBITION = /(may not|must not|prohibit\w*|without (?:the )?(?:prior )?written permission|unauthori[sz]ed)[^<]{0,160}?(cop|reproduc|distribut|modif|reverse)|(cop\w*|reproduc\w*|distribut\w*|reverse[\s-]engineer\w*)[^<]{0,160}?(without (?:the )?(?:prior )?written permission|is prohibited|are prohibited)/i
  const carries = (text: string) => /all rights reserved/i.test(text) && PROHIBITION.test(text)
  const detectorControl = carries("© 2026 X. All rights reserved. Copying any part of this platform without written permission is prohibited.") && !carries("© 2026 X. All rights reserved.")
  const notice = detectorControl ? surfaces.filter((f) => carries(surfaceText(f))) : []
  c.rule("144H", "THE PLATFORM'S COPYRIGHT / LICENSING PROHIBITION IS DISPLAYED (ruling 18: 'must be DISPLAYED (notice/terms) so no one can copy it'): a public legal / footer surface states the rights reserved AND the prohibition on copying, reproducing, distributing or reverse-engineering the platform without written permission — standard rights language, no invented legal claim", notice.length > 0, `surfaces scanned ${surfaces.length}; carrying the prohibition: ${notice.join(", ") || "none"}`)

  c.blind("Pure / source-level: the book pipeline's model lanes (outline, chapters, fact check, edit) are not run — test:book-publishing drives them with injected models. The notice check reads rendered JSX text in app/legal, app/(marketing), app/privacy, app/trust, the root page / layout and every footer component under app/; a notice rendered from a CMS string or another directory reads as absent (published, not hidden).")
  return c.report([], 0)
}
