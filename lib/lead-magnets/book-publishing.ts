// lib/lead-magnets/book-publishing.ts
//
// THE BOOK → KDP PACKAGE, PURE HALF (wave 143, lane 143F; owner: "book creation is also for publishing — Amazon
// best-seller ambition; never guarantee rank"). lib/lead-magnets/book-creator.ts finishes a manuscript (research →
// outline → chapters → fact check → fair-housing edit → a branded Letter PDF that rides the lead magnet). That PDF is a
// lead-capture asset, not a retail book. This module is what a KDP upload actually needs and the creator did not make:
//
//   · an EPUB 3 manuscript (buildEpub — a real zip: `mimetype` first and STORED, container.xml, OPF, nav + NCX, one
//     XHTML per chapter, a cover item) — KDP's eBook path (Kindle) takes EPUB;
//   · KDP METADATA as the retail page will carry it (composeKdpMetadata: title + subtitle under KDP's 200-character
//     rule, a description under 4,000 characters counting tags, ≤ 7 keywords, suggested browse categories) and the
//     CLAIM GUARD (scanBookClaims): sales rank / "bestseller" / "#1" language is refused in the title, description,
//     keywords and cover text — KDP prohibits sales rank as a keyword and misleading descriptive content, and the owner
//     ruled the platform never guarantees or implies rank;
//   · the RIGHTS + AI-DISCLOSURE RECORD (composeRightsRecord): KDP requires telling it about AI-GENERATED text and
//     images (even when substantially edited afterwards) and puts the responsibility for the content guidelines and
//     intellectual-property rights on the author — so the record names what was generated, by which lane, and what the
//     human must attest before uploading;
//   · the PAPERBACK PLAN (kdpPaperbackPlan): trim, the inside-margin chart by page count, outside margin and the page
//     range — and the blocker that stays open (see below).
//
// WHAT THIS DOES NOT DO, STATED, NOT HIDDEN:
//   · It does not publish. KDP has no publishing API: a person uploads the package in their own KDP account and answers
//     KDP's own questions (rights, AI content, pricing, territories). Everything here is prepared + evidenced; the human
//     approval (lib/lead-magnets/book-publishing-produce.ts approveKdpPackage) records WHO attested WHAT.
//   · It does not make a PAPERBACK interior PDF. KDP requires embedded fonts; this repo ships no font file and no font
//     embedder (pdf-lib's standard fonts are not embedded; @pdf-lib/fontkit is not a dependency). The paperback plan
//     reports that as an open blocker (WAITING_EXTERNAL: a licensed / OFL font file + the fontkit dependency).
//   · It never promises a sales rank. There is no "bestseller" template, keyword or cover line.
//
// KDP FACTS (read 2026-10-23 from kdp.amazon.com help pages): content guidelines + AI disclosure (G200672390); trim size
// 4"–8.5" wide × 6"–11.69" tall and page ranges (G201834180); eBook cover TIFF/JPEG, ideal 2,560 × 1,600 px, ≥ 1.6:1,
// min 1,000 × 625, max 10,000, RGB, < 50 MB (G200645690); inside margin 0.375" (24–150 pp), 0.5" (151–300), 0.625"
// (301–500), 0.75" (501–700), 0.875" (701–828), outside ≥ 0.25" (0.375" with bleed); ≤ 7 keywords; description ≤ 4,000
// characters including HTML; title + subtitle < 200 characters. The pages are older than a year in places — KDP's own
// screens at upload time govern.
//
// PURE: no server-only, no I/O (the zip writer, lib/lead-magnets/zip-writer.ts, uses node:zlib for the deflate).

import { zipEntries, type ZipEntry } from "./zip-writer"
import { KDP_PAPERBACK_SPEC, kdpInsideMarginInches, estimateTrimPages } from "./kdp-print-math"

// ── KDP numbers ─────────────────────────────────────────────────────────────────────────────────

export const KDP_SPEC = {
  readOn: "2026-10-23",
  titleSubtitleMaxChars: 199,
  descriptionMaxChars: 4000,
  maxKeywords: 7,
  ebookCover: { idealWidth: 1600, idealHeight: 2560, minWidth: 625, minHeight: 1000, maxSide: 10000, minRatio: 1.6, maxBytes: 50 * 1024 * 1024 },
  paperback: KDP_PAPERBACK_SPEC,
} as const

// (The paperback trim / margin chart and kdpInsideMarginInches, kdpTrimAllowed, estimateTrimPages live in lib/lead-magnets/kdp-print-math.ts:1 —
// extracted so each has a caller in another file. No behaviour changed.)

export interface PaperbackPlan {
  trimIn: { width: number; height: number }
  estimatedPages: number
  insideMarginIn: number | null
  outsideMarginIn: number
  pagesOk: boolean
  /** What stays open, by name — an honest plan carries its blockers. */
  blockers: string[]
}

/** PURE. The paperback plan for a manuscript of `words` words. */
export function kdpPaperbackPlan(words: number): PaperbackPlan {
  const t = KDP_SPEC.paperback
  const estimatedPages = estimateTrimPages(words)
  const blockers = [
    "EMBEDDED FONTS: KDP requires every font in a paperback interior PDF to be embedded. This repo ships no font file and no font embedder (pdf-lib's standard fonts are not embedded; @pdf-lib/fontkit is not a dependency) — WAITING_EXTERNAL: choose a licensed / open-license (OFL) text font, add its file and the fontkit dependency, then the interior PDF can be produced at this plan's trim and margins.",
  ]
  if (estimatedPages < t.pages.min) blockers.push(`PAGE COUNT: about ${estimatedPages} pages is under KDP's ${t.pages.min}-page paperback minimum — a longer manuscript, or publish as an eBook only.`)
  return {
    trimIn: { ...t.defaultTrimIn }, estimatedPages, insideMarginIn: kdpInsideMarginInches(estimatedPages),
    outsideMarginIn: t.outsideMarginIn, pagesOk: estimatedPages >= t.pages.min && estimatedPages <= t.pages.maxBlackWhite, blockers,
  }
}

// ── The claim guard (never imply or guarantee rank) ──────────────────────────────────────────────

export interface BookClaimFinding { phrase: string; where: string; rule: string }

const RANK_PATTERNS: ReadonlyArray<{ re: RegExp; rule: string }> = [
  { re: /\bbest[\s-]?sell(?:er|ers|ing)\b/i, rule: "sales-rank / bestseller language" },
  { re: /(?<![\w#])#\s?1\b|\bnumber[\s-]?(?:one|1)\b|\bno\.?\s?1\b/i, rule: "'#1' / 'number one' ranking claim" },
  { re: /\btop[\s-]?(?:selling|rated|ranked)\b/i, rule: "top-selling / top-rated ranking claim" },
  { re: /\b(?:amazon(?:'s)?|kindle)\s+(?:choice|best\s*sellers?|charts?|top\s*\d+)\b/i, rule: "an Amazon ranking or badge claim" },
  { re: /\baward[\s-]?winning\b/i, rule: "an award claim (not supported by anything the platform can verify)" },
  { re: /\b(?:guarantee[sd]?|promise[sd]?)\b[^.]{0,60}\b(?:best[\s-]?sell|rank|#\s?1|number[\s-]?one)/i, rule: "a guarantee of rank" },
  { re: /\b(?:will|going to|set to|destined to)\s+(?:become|be|hit|reach)\s+(?:a\s+|the\s+)?(?:#\s?1|number[\s-]?one|best[\s-]?sell\w*|top\s+\d+)/i, rule: "a prediction of rank" },
]

/** PURE. Rank / bestseller / award language in the named public fields. Empty = none found (the positive control is in the guard). */
export function scanBookClaims(fields: Record<string, string | null | undefined>): BookClaimFinding[] {
  const out: BookClaimFinding[] = []
  for (const [where, text] of Object.entries(fields)) {
    const t = text ?? ""
    for (const p of RANK_PATTERNS) {
      const m = p.re.exec(t)
      if (m) out.push({ phrase: m[0], where, rule: p.rule })
    }
  }
  return out
}

// ── Metadata ─────────────────────────────────────────────────────────────────────────────────────

export interface BookChapterIn { heading: string; body: string }

export interface KdpBookInput {
  title: string
  subtitle: string | null
  tagline: string | null
  introduction: string | null
  closing: string | null
  chapters: BookChapterIn[]
  audience: "buyer" | "seller"
  area: string | null
  concept: string
  /** The pen-name / byline: the agent, else the brand. */
  authorName: string
  brokerageName: string
  /** The lead magnet's landing URL, for the optional "about the author" back-matter link. */
  landingUrl?: string | null
  year: number
}

export interface KdpMetadata {
  title: string
  subtitle: string | null
  authorName: string
  language: "English"
  /** HTML limited to what KDP's editor accepts; counted WITH tags. */
  descriptionHtml: string
  descriptionText: string
  keywords: string[]
  /** SUGGESTED browse paths — the author picks in KDP's own category picker (the tree changes). */
  categorySuggestions: string[]
  seriesName: null
  edition: null
  /** KDP can assign a free ISBN; none is stated here. */
  isbn: null
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}
function firstParagraph(s: string | null | undefined, max: number): string {
  const p = (s ?? "").split(/\n{2,}/).map((x) => x.trim()).find(Boolean) ?? ""
  return p.length <= max ? p : `${p.slice(0, max - 1).replace(/\s+\S*$/, "")}…`
}
export function wordsIn(text: string): number { return (text ?? "").trim().split(/\s+/).filter(Boolean).length }

/** PURE. KDP metadata composed from the finished book — deterministic (no model call, no invented fact). */
export function composeKdpMetadata(b: KdpBookInput): KdpMetadata {
  const lead = firstParagraph(b.tagline, 300) || firstParagraph(b.introduction, 500) || b.title
  const intro = firstParagraph(b.introduction, 600)
  const head = (b.audience === "buyer" ? "What you will learn about buying a home" : "What you will learn about selling a home")
  const bullets = b.chapters.map((c) => c.heading.trim()).filter(Boolean)
  const tail = `<p>Written by ${esc(b.authorName)} of ${esc(b.brokerageName)}. This book is general information, not legal, tax or lending advice.</p>`
  // Fit under 4,000 characters INCLUDING tags: drop trailing chapter bullets until it does.
  let n = bullets.length
  let html = ""
  for (;;) {
    html = `<p>${esc(lead)}</p>` + (intro && intro !== lead ? `<p>${esc(intro)}</p>` : "") +
      (n > 0 ? `<p><b>${esc(head)}:</b></p><ul>${bullets.slice(0, n).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "") + tail
    if (html.length <= KDP_SPEC.descriptionMaxChars || n === 0) break
    n--
  }
  const stop = new Set(["the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "your", "you", "is", "are", "with", "how", "what", "why"])
  const seeds = b.audience === "buyer"
    ? ["home buying guide", "how to buy a house", "first time home buyer", "home buyer checklist", "mortgage and closing explained"]
    : ["home selling guide", "how to sell your house", "selling a home checklist", "prepare house for sale", "home sale process explained"]
  const words = b.chapters.flatMap((c) => c.heading.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length > 3 && !stop.has(w))
  const topWords = [...new Set(words)].slice(0, 2)
  const kw = [...seeds, ...(b.area ? [`${b.area} real estate`] : []), ...(topWords.length === 2 ? [`${topWords[0]} ${topWords[1]}`] : [])]
  const keywords = [...new Set(kw.map((k) => k.trim()).filter((k) => k.length > 0 && k.length <= 50))].slice(0, KDP_SPEC.maxKeywords)
  const categorySuggestions = b.audience === "buyer"
    ? ["Kindle Store › Business & Money › Real Estate › Buying & Selling Homes", "Kindle Store › Business & Money › Personal Finance › Home Buying"]
    : ["Kindle Store › Business & Money › Real Estate › Buying & Selling Homes", "Kindle Store › Business & Money › Real Estate › Selling"]
  return {
    title: b.title.trim(), subtitle: b.subtitle?.trim() || null, authorName: b.authorName, language: "English",
    descriptionHtml: html, descriptionText: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    keywords, categorySuggestions, seriesName: null, edition: null, isbn: null,
  }
}

export interface KdpMetadataProblem { field: string; problem: string }

/** PURE. KDP's own limits on the composed metadata (length / count). Claims are scanBookClaims's job. */
export function validateKdpMetadata(m: KdpMetadata): KdpMetadataProblem[] {
  const p: KdpMetadataProblem[] = []
  if (!m.title) p.push({ field: "title", problem: "a title is required" })
  const ts = `${m.title} ${m.subtitle ?? ""}`.trim().length
  if (ts > KDP_SPEC.titleSubtitleMaxChars) p.push({ field: "title", problem: `title + subtitle is ${ts} characters; KDP needs under 200` })
  if (m.descriptionHtml.length > KDP_SPEC.descriptionMaxChars) p.push({ field: "description", problem: `description is ${m.descriptionHtml.length} characters including tags; KDP allows ${KDP_SPEC.descriptionMaxChars}` })
  if (m.descriptionText.length < 50) p.push({ field: "description", problem: "the description is too short to sell the book" })
  if (m.keywords.length > KDP_SPEC.maxKeywords) p.push({ field: "keywords", problem: `${m.keywords.length} keywords; KDP allows ${KDP_SPEC.maxKeywords}` })
  if (m.keywords.some((k) => k.length > 50)) p.push({ field: "keywords", problem: "a keyword is over 50 characters" })
  if (!m.authorName.trim()) p.push({ field: "author", problem: "an author name is required" })
  return p
}

// ── Rights + AI disclosure ───────────────────────────────────────────────────────────────────────

export interface KdpRightsRecord {
  authorOfRecord: string
  copyrightLine: string
  /** KDP's two AI questions (text / images / translations) answered from how THIS book was made. */
  aiDisclosure: { text: "ai_generated"; images: "ai_generated" | "none"; translations: "none"; explanation: string }
  provenance: { manuscriptLane: string; factCheckLane: string; coverArt: "image_rail" | "typographic_only" }
  /** What the human must confirm before uploading — approveKdpPackage requires every one. */
  attestations: ReadonlyArray<{ id: "i_hold_rights" | "ai_disclosure_confirmed" | "content_guidelines_reviewed" | "no_rank_claims" | "facts_reviewed"; text: string }>
}

export const KDP_ATTESTATIONS = [
  { id: "i_hold_rights", text: "I am the rights holder for this book and its cover, or hold the publishing rights I will tell KDP I hold." },
  { id: "ai_disclosure_confirmed", text: "I will tell KDP that the text (and the cover image, when AI-generated) was AI-generated — KDP requires this even when the content was edited afterwards." },
  { id: "content_guidelines_reviewed", text: "I reviewed KDP's content guidelines, including intellectual-property rights, and the back-matter link (if any) against them." },
  { id: "no_rank_claims", text: "I understand nothing guarantees or implies a sales rank, and I will add no ranking or bestseller claim to the title, cover, description or keywords." },
  { id: "facts_reviewed", text: "I reviewed the manuscript's facts — the fact-check pass flags unsupported figures, it does not certify the book." },
] as const satisfies KdpRightsRecord["attestations"]

/** PURE. The rights + AI-disclosure record for a book made by lib/lead-magnets/book-creator.ts. */
export function composeRightsRecord(b: { authorName: string; year: number; coverArt: "image_rail" | "typographic_only" }): KdpRightsRecord {
  return {
    authorOfRecord: b.authorName,
    copyrightLine: `© ${b.year} ${b.authorName}. All rights reserved.`,
    aiDisclosure: {
      text: "ai_generated",
      images: b.coverArt === "image_rail" ? "ai_generated" : "none",
      translations: "none",
      explanation: "The manuscript was written by AI models (routed lane book_manuscript), fact-checked by a second lane (book_fact_check) and edited under the fair-housing rewrite loop, then reviewed by the agent. KDP asks for AI-generated text and images to be disclosed even when substantially edited afterwards" + (b.coverArt === "image_rail" ? "; the cover art was generated through the platform's image rail." : "; the cover is typography only (no generated image)."),
    },
    provenance: { manuscriptLane: "book_manuscript", factCheckLane: "book_fact_check", coverArt: b.coverArt },
    attestations: KDP_ATTESTATIONS,
  }
}

// ── EPUB 3 ───────────────────────────────────────────────────────────────────────────────────────

// (The zip container writer — mimetype first and stored, UTF-8 names, per-entry CRC — lives in lib/lead-magnets/zip-writer.ts:1; it was
// extracted from this file so its one caller, buildEpub below, imports it. No behaviour changed.)

/** Plain-prose + light markup (#/## headings, "- " bullets, "1. " lists, **bold**) → XHTML body content. */
function proseToXhtml(body: string): string {
  const lines = (body ?? "").replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let para: string[] = [], list: { tag: "ul" | "ol"; items: string[] } | null = null
  const inline = (t: string) => esc(t).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = [] } }
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null } }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { flushPara(); flushList(); continue }
    const h = /^#{1,4}\s+(.*)$/.exec(line)
    const ul = /^[-*•]\s+(.*)$/.exec(line)
    const ol = /^\d+[.)]\s+(.*)$/.exec(line)
    if (h) { flushPara(); flushList(); out.push(`<h3>${inline(h[1])}</h3>`) }
    else if (ul) { flushPara(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] } } list.items.push(ul[1]) }
    else if (ol) { flushPara(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] } } list.items.push(ol[1]) }
    else { flushList(); para.push(line) }
  }
  flushPara(); flushList()
  return out.join("\n")
}

function xhtml(title: string, body: string, epubType?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">\n<head>\n<meta charset="utf-8"/>\n<title>${esc(title)}</title>\n<link rel="stylesheet" type="text/css" href="style.css"/>\n</head>\n<body${epubType ? ` epub:type="${epubType}"` : ""}>\n${body}\n</body>\n</html>\n`
}

const EPUB_CSS = `body { font-family: serif; line-height: 1.5; margin: 5%; }
h1 { font-size: 1.8em; margin: 1.5em 0 0.8em; text-align: left; page-break-before: always; }
h2 { font-size: 1.3em; margin: 1.2em 0 0.6em; }
h3 { font-size: 1.1em; margin: 1em 0 0.4em; }
p { margin: 0 0 0.9em; text-indent: 0; }
ul, ol { margin: 0 0 0.9em 1.2em; }
.title-page { text-align: center; margin-top: 25%; }
.title-page .sub { font-style: italic; margin-top: 0.5em; }
.title-page .by { margin-top: 3em; }
.small { font-size: 0.85em; }
img.cover { max-width: 100%; height: auto; }
`

export interface EpubInput extends KdpBookInput {
  /** A JPEG cover (KDP's required type). Omitted = no cover item (a cover-less EPUB is valid; KDP asks for the cover separately). */
  coverJpeg?: Buffer | null
  /** A stable identifier for the book (a uuid) — urn:uuid:<id>. */
  identifier: string
  /** Composed description (plain text) for dc:description. */
  description?: string | null
  now?: Date
}

/** PURE. A valid EPUB 3 package. Entry order: `mimetype` (stored), META-INF/container.xml, then OEBPS. */
export function buildEpub(b: EpubInput): Buffer {
  const now = b.now ?? new Date()
  const modified = now.toISOString().replace(/\.\d{3}Z$/, "Z")
  const files: Array<{ id: string; href: string; title: string; xhtml: string; spine: boolean; nav: boolean; type?: string; linear?: boolean }> = []
  const add = (id: string, href: string, title: string, body: string, opts: { spine?: boolean; nav?: boolean; type?: string } = {}) => files.push({ id, href, title, xhtml: xhtml(title, body, opts.type), spine: opts.spine ?? true, nav: opts.nav ?? true, type: opts.type })

  if (b.coverJpeg) add("cover", "cover.xhtml", "Cover", `<section epub:type="cover"><img class="cover" src="images/cover.jpg" alt="Cover of ${esc(b.title)}"/></section>`, { nav: false, type: "cover" })
  add("titlepage", "title.xhtml", "Title page", `<section class="title-page"><h1 style="page-break-before:auto">${esc(b.title)}</h1>${b.subtitle ? `<p class="sub">${esc(b.subtitle)}</p>` : ""}<p class="by">${esc(b.authorName)}</p></section>`, { type: "titlepage" })
  add("copyright", "copyright.xhtml", "Copyright", `<section><p class="small">© ${b.year} ${esc(b.authorName)}. All rights reserved.</p><p class="small">This book is general information, not legal, tax or lending advice. Programs, rates and requirements change — verify details with licensed professionals for your situation.</p><p class="small">Published by ${esc(b.brokerageName)}.</p></section>`, { nav: false, type: "copyright-page" })
  if (b.introduction?.trim()) add("intro", "intro.xhtml", "Introduction", `<section><h1>Introduction</h1>\n${proseToXhtml(b.introduction)}</section>`, { type: "introduction" })
  b.chapters.forEach((c, i) => add(`ch${String(i + 1).padStart(3, "0")}`, `ch${String(i + 1).padStart(3, "0")}.xhtml`, c.heading, `<section epub:type="chapter"><h1>${esc(c.heading)}</h1>\n${proseToXhtml(c.body)}</section>`, { type: "chapter" }))
  if (b.closing?.trim()) add("closing", "closing.xhtml", "Your next step", `<section><h1>Your next step</h1>\n${proseToXhtml(b.closing)}</section>`, { type: "conclusion" })
  add("about", "about.xhtml", "About the author", `<section><h1>About the author</h1><p>${esc(b.authorName)} of ${esc(b.brokerageName)}.</p>${b.landingUrl ? `<p class="small">More at ${esc(b.landingUrl)}</p>` : ""}</section>`, { type: "afterword" })

  const navItems = files.filter((f) => f.nav)
  const nav = xhtml("Contents", `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navItems.map((f) => `<li><a href="${f.href}">${esc(f.title)}</a></li>`).join("")}</ol></nav>\n<nav epub:type="landmarks" hidden="hidden"><h2>Guide</h2><ol>${b.coverJpeg ? `<li><a epub:type="cover" href="cover.xhtml">Cover</a></li>` : ""}<li><a epub:type="toc" href="nav.xhtml#toc">Contents</a></li><li><a epub:type="bodymatter" href="${(files.find((f) => f.type === "introduction" || f.type === "chapter") ?? files[0]).href}">Start</a></li></ol></nav>`)
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${esc(b.identifier)}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>${esc(b.title)}</text></docTitle><navMap>${navItems.map((f, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(f.title)}</text></navLabel><content src="${f.href}"/></navPoint>`).join("")}</navMap></ncx>\n`
  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    ...(b.coverJpeg ? [`<item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>`] : []),
    ...files.map((f) => `<item id="${f.id}" href="${f.href}" media-type="application/xhtml+xml"/>`),
  ].join("\n    ")
  const spine = [...files.filter((f) => f.id === "cover" || f.id === "titlepage" || f.id === "copyright"), { id: "nav", linear: false } as { id: string; linear?: boolean }, ...files.filter((f) => f.spine && !["cover", "titlepage", "copyright"].includes(f.id))]
    .map((f) => `<itemref idref="${f.id}"${(f as { linear?: boolean }).linear === false ? ` linear="no"` : ""}/>`).join("\n    ")
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${esc(b.identifier)}</dc:identifier>
    <dc:title>${esc(b.title)}${b.subtitle ? `: ${esc(b.subtitle)}` : ""}</dc:title>
    <dc:creator>${esc(b.authorName)}</dc:creator>
    <dc:language>en</dc:language>
    <dc:publisher>${esc(b.brokerageName)}</dc:publisher>
    <dc:rights>© ${b.year} ${esc(b.authorName)}. All rights reserved.</dc:rights>
${b.description ? `    <dc:description>${esc(b.description)}</dc:description>\n` : ""}    <meta property="dcterms:modified">${modified}</meta>
    <meta property="schema:accessMode">textual</meta>
    <meta property="schema:accessModeSufficient">textual</meta>
    <meta property="schema:accessibilityFeature">structuralNavigation</meta>
    <meta property="schema:accessibilityFeature">tableOfContents</meta>
    <meta property="schema:accessibilityHazard">none</meta>
    <meta property="schema:accessibilitySummary">A reflowable text book with a table of contents; it contains no audio, video or flashing content.</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine toc="ncx">
    ${spine}
  </spine>
</package>
`
  const container = `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n`
  const entries: ZipEntry[] = [
    { name: "mimetype", data: Buffer.from("application/epub+zip", "ascii"), store: true },
    { name: "META-INF/container.xml", data: Buffer.from(container, "utf8") },
    { name: "OEBPS/content.opf", data: Buffer.from(opf, "utf8") },
    { name: "OEBPS/nav.xhtml", data: Buffer.from(nav, "utf8") },
    { name: "OEBPS/toc.ncx", data: Buffer.from(ncx, "utf8") },
    { name: "OEBPS/style.css", data: Buffer.from(EPUB_CSS, "utf8") },
    ...(b.coverJpeg ? [{ name: "OEBPS/images/cover.jpg", data: b.coverJpeg, store: true }] : []),
    ...files.map((f) => ({ name: `OEBPS/${f.href}`, data: Buffer.from(f.xhtml, "utf8") })),
  ]
  return zipEntries(entries, now)
}

/** PURE. KDP's eBook-cover rules applied to a cover's measured size and type. */
export function validateEbookCover(c: { width: number; height: number; bytes: number; format: "jpeg" | "tiff" | "png" | string }): string[] {
  const s = KDP_SPEC.ebookCover, p: string[] = []
  if (c.format !== "jpeg" && c.format !== "tiff") p.push(`cover is ${c.format}; KDP takes JPEG or TIFF`)
  if (c.width < s.minWidth || c.height < s.minHeight) p.push(`cover is ${c.width}×${c.height}; the minimum is ${s.minWidth}×${s.minHeight}`)
  if (c.width > s.maxSide || c.height > s.maxSide) p.push(`cover side exceeds ${s.maxSide} px`)
  if (c.width > 0 && c.height / c.width < s.minRatio - 1e-6) p.push(`cover ratio ${(c.height / c.width).toFixed(2)}:1 is under ${s.minRatio}:1 (height to width)`)
  if (c.bytes >= s.maxBytes) p.push("cover is 50 MB or more")
  return p
}
