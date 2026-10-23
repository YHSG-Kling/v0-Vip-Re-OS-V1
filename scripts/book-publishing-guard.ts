#!/usr/bin/env tsx
/**
 * scripts/book-publishing-guard.ts   (run: tsx --conditions=react-server scripts/book-publishing-guard.ts — key to add; see the lane notes)
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE BOOK → KDP PACKAGE (wave 143, lane 143F). Owner: "book creation is also for publishing — Amazon best-seller ambition; never
 * guarantee rank." Proven with REAL bytes (a real zip, a real JPEG cover), no network, no provider key:
 *
 *   A. KDP's NUMBERS as code (inside-margin chart boundaries, trim limits, even page counts, the paperback plan's OPEN BLOCKER — no
 *      embedded fonts — published, not hidden).
 *   B. THE CLAIM GUARD: rank / bestseller / "#1" / award / guarantee-of-rank language is caught in every public field, with a clean
 *      control that passes and a positive control for each pattern.
 *   C. METADATA: composed from the finished book, ≤ 4,000 characters INCLUDING tags even for a 60-chapter book, ≤ 7 keywords of ≤ 50
 *      characters, title + subtitle < 200, and the composed text itself carries no rank claim.
 *   D. RIGHTS + AI DISCLOSURE: the text is disclosed as AI-generated, the images only when the cover art really came from the image
 *      rail; five attestations the human must give.
 *   E. THE EPUB is a structurally valid EPUB 3: `mimetype` first and STORED with no extra field, every entry's CRC checked against
 *      node's own crc32 (an independent oracle), every XML part well-formed (xmllint), the OPF carries identifier / title / language /
 *      modified, the nav and NCX list every chapter, XML-special characters are escaped. EPUBCheck (W3C) runs when EPUBCHECK_JAR
 *      names a jar and Java exists — otherwise it says NOT RUN.
 *   F. THE COVER: a 1,600 × 2,560 JPEG both typographic and over art, meeting KDP's eBook-cover rules; text really present;
 *      violations of the rules (PNG, too small, too wide, too heavy) are each caught.
 *   G. THE PRODUCER on an in-memory database with seams: gates in order, the package recorded (counted, ledgered), files hosted in
 *      the PRIVATE documents bucket under the tenant's path, art falls back to typography when the tenant may not spend, a book not
 *      finished / awaiting the human / claiming rank / claiming 55+ without a verified exemption is NOT packaged, approval needs
 *      every attestation by a session user and a rebuild clears it, another tenant's magnet is not found.
 *   H. SOURCE RULES: the actions take the tenant from the session; KDP is never "published" by the platform (no login, no
 *      credential, no upload call); no "bestseller" template exists anywhere in the package.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { inflateRawSync, crc32 } from "node:zlib"
import sharp from "sharp"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  KDP_SPEC, kdpPaperbackPlan, scanBookClaims, composeKdpMetadata, validateKdpMetadata,
  composeRightsRecord, KDP_ATTESTATIONS, buildEpub, validateEbookCover, type KdpBookInput,
} from "../lib/lead-magnets/book-publishing"
import { kdpInsideMarginInches, kdpTrimAllowed, estimateTrimPages } from "../lib/lead-magnets/kdp-print-math"
import { zipEntries } from "../lib/lead-magnets/zip-writer"
import { composeBookCover, coverArtPrompt, COVER_WIDTH, COVER_HEIGHT } from "../lib/lead-magnets/book-cover"
import { buildKdpPackage, approveKdpPackage, kdpPackageOf } from "../lib/lead-magnets/book-publishing-produce"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(raw(p))
let passed = 0, failed = 0
const failures: string[] = []
const blind: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n[${t}]`)

const B1 = "00000000-0000-4000-8000-0000000000b1", B2 = "00000000-0000-4000-8000-0000000000b2", U1 = "00000000-0000-4000-8000-0000000000a1"
const MAGNET = "11111111-1111-4111-8111-111111111111"
const para = (n: number) => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} explains one practical step in plain English & stays calm about the process.`).join(" ")
const chapters = [
  { heading: "Getting your home ready", body: `${para(8)}\n\n- Declutter one room at a time\n- Fix the small things first\n\n## A note on timing\n\n${para(4)}` },
  { heading: "Pricing <it> right", body: `${para(9)}\n\n1. Study recent sales\n2. Walk the neighbourhood\n\n**Remember:** "price" is a conversation.` },
  { heading: "Showings & offers", body: para(10) },
  { heading: "From contract to keys — what happens at closing", body: `${para(9)}\n\n${para(5)}` },
]
const bookIn = (over: Partial<KdpBookInput> = {}): KdpBookInput => ({
  title: "The Calm Home Seller", subtitle: "A plain-English guide to selling your house", tagline: "Sell with a plan, not a panic.", introduction: `${para(6)}\n\nA second paragraph.`,
  closing: "When you are ready, we can walk through exactly how this applies to your home.", chapters, audience: "seller", area: "Tampa Bay", concept: "a calm guide to selling a house",
  authorName: "Dana Reyes", brokerageName: "Harbor Realty", landingUrl: "https://app.example.com/lm/calm-home-seller", year: 2026, ...over,
})

// ── a tiny independent unzip (central directory) — checks the writer without trusting it ──
interface ZEntry { name: string; method: number; extraLen: number; crc: number; data: Buffer; flags: number }
function unzip(buf: Buffer): ZEntry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const n = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16)
  const out: ZEntry[] = []
  let p = cdOff
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csz = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), com = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42), flags = buf.readUInt16LE(p + 8)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8")
    const lNameLen = buf.readUInt16LE(lho + 26), lExtra = buf.readUInt16LE(lho + 28)
    const start = lho + 30 + lNameLen + lExtra
    const comp = buf.subarray(start, start + csz)
    out.push({ name, method, extraLen: lExtra, crc, flags, data: method === 8 ? inflateRawSync(comp) : Buffer.from(comp) })
    p += 46 + nameLen + extra + com
  }
  return out
}

async function main() {
  // ═══════════════════ A · KDP's numbers ═══════════════════
  section("A · KDP numbers as code")
  const margin: Array<[number, number | null]> = [[23, null], [24, 0.375], [150, 0.375], [151, 0.5], [300, 0.5], [301, 0.625], [500, 0.625], [501, 0.75], [700, 0.75], [701, 0.875], [828, 0.875], [829, null]]
  for (const [pages, inches] of margin) check(`inside margin at ${pages} pages = ${inches ?? "none (outside 24–828)"}`, kdpInsideMarginInches(pages) === inches)
  check("trim limits: 6×9 allowed; 3.9 wide, 8.6 wide, 5.9 tall and 11.7 tall are not", kdpTrimAllowed(6, 9) && !kdpTrimAllowed(3.9, 9) && !kdpTrimAllowed(8.6, 9) && !kdpTrimAllowed(6, 5.9) && !kdpTrimAllowed(6, 11.7))
  check("estimateTrimPages is always EVEN (KDP rounds up to even) and grows with the words", [1, 999, 31000, 50001].every((w) => estimateTrimPages(w) % 2 === 0) && estimateTrimPages(60000) > estimateTrimPages(30000))
  const plan = kdpPaperbackPlan(30000)
  check("the paperback plan carries its OPEN BLOCKER by name (embedded fonts — no font file, no fontkit) and the margins for its page count", plan.blockers.some((b) => /EMBEDDED FONTS/.test(b) && /WAITING_EXTERNAL/.test(b)) && plan.insideMarginIn === kdpInsideMarginInches(plan.estimatedPages) && plan.pagesOk)
  check("…and a 4,000-word booklet is told it is under KDP's 24-page paperback minimum", kdpPaperbackPlan(4000).blockers.some((b) => /24-page/.test(b)) && !kdpPaperbackPlan(4000).pagesOk)
  check("the repo really has no font embedder (so the blocker is TRUE, not stale): no @pdf-lib/fontkit in node_modules or package.json", !existsSync(join(ROOT, "node_modules/@pdf-lib/fontkit")) && !/fontkit/.test(raw("package.json")))

  // ═══════════════════ B · the claim guard ═══════════════════
  section("B · rank / bestseller language is refused in every public field")
  const dirty: Array<[string, string]> = [
    ["the #1 Bestseller on Amazon", "bestseller"], ["a best-selling guide", "best-selling"], ["Best Sellers rank", "best sellers"], ["number one in real estate", "number one"], ["No. 1 home selling book", "no. 1"],
    ["top-selling title", "top-selling"], ["Amazon's Choice", "amazon's choice"], ["Kindle charts topper", "kindle charts"], ["award-winning author", "award-winning"],
    ["guaranteed to be a bestseller", "guaranteed"], ["will become a #1 bestseller", "will become"], ["this is going to hit number one", "going to hit"],
  ]
  for (const [t, label] of dirty) check(`CAUGHT (${label}): "${t}"`, scanBookClaims({ description: t }).length > 0)
  const clean = ["A plain-English guide to selling your home", "Chapter 1: Pricing — what the numbers mean", "How closing works, step by step", "Tips from one agent to another", "An easy-to-read guide for first-time sellers"]
  for (const t of clean) check(`CLEAN passes: "${t}"`, scanBookClaims({ description: t }).length === 0)
  const multi = scanBookClaims({ title: "The #1 Guide", subtitle: "Calm", description: "ok", keywords: "bestselling | home" })
  check("the finding NAMES the field and the rule (title, keywords), and fields that are clean add nothing", multi.some((f) => f.where === "title") && multi.some((f) => f.where === "keywords") && !multi.some((f) => f.where === "subtitle" || f.where === "description") && multi.every((f) => f.rule.length > 5))

  // ═══════════════════ C · metadata ═══════════════════
  section("C · KDP metadata — composed, limited, claim-free")
  const meta = composeKdpMetadata(bookIn())
  check("a normal book: description under 4,000 characters including tags; ≤ 7 keywords each ≤ 50; no validation problem", meta.descriptionHtml.length <= 4000 && meta.keywords.length >= 3 && meta.keywords.length <= 7 && meta.keywords.every((k) => k.length <= 50) && validateKdpMetadata(meta).length === 0, JSON.stringify(validateKdpMetadata(meta)))
  const big = composeKdpMetadata(bookIn({ chapters: Array.from({ length: 60 }, (_, i) => ({ heading: `Chapter ${i + 1}: a rather long descriptive heading about step number ${i + 1} of the home selling process`, body: para(5) })) }))
  check("a 60-chapter book: the chapter bullets are TRIMMED to fit 4,000 characters INCLUDING tags (never an over-long description)", big.descriptionHtml.length <= 4000 && /<ul>/.test(big.descriptionHtml) && validateKdpMetadata(big).length === 0, `len=${big.descriptionHtml.length}`)
  check("the description escapes markup in headings and carries the byline + the not-advice line", /Pricing &lt;it&gt; right/.test(meta.descriptionHtml) && /Dana Reyes of Harbor Realty/.test(meta.descriptionHtml) && /not legal, tax or lending advice/.test(meta.descriptionHtml))
  const longTitle = composeKdpMetadata(bookIn({ title: "T".repeat(120), subtitle: "S".repeat(100) }))
  check("title + subtitle ≥ 200 characters is caught by KDP's rule", validateKdpMetadata(longTitle).some((p) => p.field === "title" && /200/.test(p.problem)))
  check("a metadata object with 8 keywords / a too-short description is caught", validateKdpMetadata({ ...meta, keywords: Array.from({ length: 8 }, (_, i) => `k${i}`) }).some((p) => p.field === "keywords") && validateKdpMetadata({ ...meta, descriptionText: "short" }).some((p) => p.field === "description"))
  check("THE COMPOSED TEXT ITSELF carries no rank / bestseller claim (title, description, keywords, categories) — the platform never writes one", scanBookClaims({ title: meta.title, subtitle: meta.subtitle, description: meta.descriptionText, keywords: meta.keywords.join(" | "), categories: meta.categorySuggestions.join(" | ") }).length === 0)
  check("no ISBN, series or edition is invented (KDP can assign a free ISBN); categories are SUGGESTIONS", meta.isbn === null && meta.seriesName === null && meta.edition === null && meta.categorySuggestions.length >= 1)

  // ═══════════════════ D · rights + AI disclosure ═══════════════════
  section("D · rights record and AI disclosure")
  const withArt = composeRightsRecord({ authorName: "Dana Reyes", year: 2026, coverArt: "image_rail" }), noArt = composeRightsRecord({ authorName: "Dana Reyes", year: 2026, coverArt: "typographic_only" })
  check("the TEXT is always disclosed as AI-generated (KDP: even when substantially edited afterwards)", withArt.aiDisclosure.text === "ai_generated" && noArt.aiDisclosure.text === "ai_generated" && /even when substantially edited/.test(withArt.aiDisclosure.explanation))
  check("images are disclosed as AI-generated ONLY when the cover art came from the image rail (a typographic cover claims no image)", withArt.aiDisclosure.images === "ai_generated" && noArt.aiDisclosure.images === "none")
  check("five attestations, by id, none optional; the copyright line names the author and year", KDP_ATTESTATIONS.map((a) => a.id).join() === "i_hold_rights,ai_disclosure_confirmed,content_guidelines_reviewed,no_rank_claims,facts_reviewed" && withArt.copyrightLine === "© 2026 Dana Reyes. All rights reserved.")

  // ═══════════════════ E · the EPUB ═══════════════════
  section("E · the EPUB is a structurally valid EPUB 3")
  const tmp = mkdtempSync(join(tmpdir(), "kdp-guard-"))
  const coverArtPng = await sharp({ create: { width: 1024, height: 1792, channels: 3, background: { r: 30, g: 90, b: 140 } } }).png().toBuffer()
  const cover = await composeBookCover({ title: meta.title, subtitle: meta.subtitle, authorName: "Dana Reyes", primaryColor: "#14532D", art: coverArtPng })
  const epub = buildEpub({ ...bookIn(), coverJpeg: cover.jpeg, identifier: "0b2f7f0e-1c1d-4a55-9d0e-3a1b7d6c5e4f", description: meta.descriptionText, now: new Date("2026-10-23T12:00:00Z") })
  const entries = unzip(epub)
  check("the FIRST entry is `mimetype`, STORED, with no extra field, content exactly application/epub+zip", entries[0]?.name === "mimetype" && entries[0].method === 0 && entries[0].extraLen === 0 && entries[0].data.toString("ascii") === "application/epub+zip")
  check("every entry's CRC equals node's own crc32 (an independent oracle for the writer) and every name is UTF-8 flagged", entries.every((e) => e.crc === crc32(e.data) && (e.flags & 0x0800) !== 0), entries.filter((e) => e.crc !== crc32(e.data)).map((e) => e.name).join())
  const names = entries.map((e) => e.name)
  check(`the package has container.xml, content.opf, nav, NCX, CSS, the cover item and ${chapters.length} chapter files + title/copyright/intro/closing/about`, ["META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml", "OEBPS/toc.ncx", "OEBPS/style.css", "OEBPS/images/cover.jpg", "OEBPS/cover.xhtml", "OEBPS/ch001.xhtml", `OEBPS/ch00${chapters.length}.xhtml`, "OEBPS/title.xhtml", "OEBPS/copyright.xhtml", "OEBPS/intro.xhtml", "OEBPS/closing.xhtml", "OEBPS/about.xhtml"].every((n) => names.includes(n)), names.join(","))
  const opf = entries.find((e) => e.name === "OEBPS/content.opf")!.data.toString("utf8")
  check("OPF: version 3.0, identifier urn:uuid, title (+subtitle), creator, language en, dcterms:modified, a cover-image item, accessibility metadata", /version="3\.0"/.test(opf) && /<dc:identifier id="book-id">urn:uuid:0b2f7f0e-1c1d-4a55-9d0e-3a1b7d6c5e4f</.test(opf) && /<dc:title>The Calm Home Seller: A plain-English guide/.test(opf) && /<dc:creator>Dana Reyes/.test(opf) && /<dc:language>en/.test(opf) && /dcterms:modified">2026-10-23T12:00:00Z</.test(opf) && /properties="cover-image"/.test(opf) && /accessibilityFeature/.test(opf))
  const nav = entries.find((e) => e.name === "OEBPS/nav.xhtml")!.data.toString("utf8"), ncx = entries.find((e) => e.name === "OEBPS/toc.ncx")!.data.toString("utf8")
  check("the nav and the NCX list EVERY chapter heading (escaped)", chapters.every((c) => nav.includes(c.heading.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")) && ncx.includes(c.heading.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))))
  const ch2 = entries.find((e) => e.name === "OEBPS/ch002.xhtml")!.data.toString("utf8")
  check("XML-special characters are ESCAPED in text, lists become <ol>/<ul>, ## becomes <h3>, **bold** becomes <strong>", /Pricing &lt;it&gt; right/.test(ch2) && /<ol>.*<li>Study recent sales<\/li>/s.test(ch2) && /<strong>Remember:<\/strong>/.test(ch2) && /&quot;price&quot;/.test(ch2) && /<h3>A note on timing<\/h3>/.test(entries.find((e) => e.name === "OEBPS/ch001.xhtml")!.data.toString("utf8")) && /<ul>/.test(entries.find((e) => e.name === "OEBPS/ch001.xhtml")!.data.toString("utf8")))
  const spineIds = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]), manifestIds = new Set([...opf.matchAll(/<item id="([^"]+)"/g)].map((m) => m[1]))
  check("every spine itemref points at a manifest item; every manifest href is a file in the zip", spineIds.every((i) => manifestIds.has(i)) && [...opf.matchAll(/<item id="[^"]+" href="([^"]+)"/g)].every((m) => names.includes(`OEBPS/${m[1]}`)))
  const xmlParts = entries.filter((e) => /\.(xhtml|opf|ncx|xml)$/.test(e.name))
  const lint = spawnSync("xmllint", ["--version"], { encoding: "utf8" })
  if (lint.error || lint.status === undefined) { blind.push("xmllint is not installed in this runner — XML well-formedness was NOT checked here"); console.log("  · xmllint NOT AVAILABLE — well-formedness NOT RUN") }
  else {
    const bad: string[] = []
    for (const e of xmlParts) { const f = join(tmp, e.name.replace(/\//g, "_")); writeFileSync(f, e.data); const r = spawnSync("xmllint", ["--noout", f], { encoding: "utf8" }); if (r.status !== 0) bad.push(`${e.name}: ${(r.stderr ?? "").split("\n")[0]}`) }
    check(`all ${xmlParts.length} XML parts are well-formed (xmllint --noout)`, bad.length === 0, bad.join(" | "))
    const brokenProbe = join(tmp, "broken.xml"); writeFileSync(brokenProbe, "<a><b></a>")
    check("CONTROL: xmllint DOES reject malformed XML (the check is not blind)", spawnSync("xmllint", ["--noout", brokenProbe], { encoding: "utf8" }).status !== 0)
  }
  const jar = process.env.EPUBCHECK_JAR
  if (jar && existsSync(jar)) {
    const f = join(tmp, "book.epub"); writeFileSync(f, epub)
    const r = spawnSync("java", ["-jar", jar, f], { encoding: "utf8", timeout: 120_000 })
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
    console.log(`    EPUBCheck: ${/No errors or warnings detected/.test(out) ? "No errors or warnings detected" : out.split("\n").filter((l) => /ERROR|FATAL|WARNING|Messages:/.test(l)).slice(0, 6).join(" | ")}`)
    check("EPUBCheck (W3C) reports no ERROR or FATAL", r.status === 0 && !/\bERROR\b|\bFATAL\b/.test(out), out.slice(0, 400))
  } else { blind.push("EPUBCheck was NOT RUN (set EPUBCHECK_JAR to a w3c/epubcheck jar and have Java on PATH) — structure is proven by the independent unzip + xmllint, not by the W3C validator"); console.log("  · EPUBCheck NOT RUN (EPUBCHECK_JAR unset)") }
  const noCover = unzip(buildEpub({ ...bookIn(), identifier: "x", now: new Date("2026-10-23T12:00:00Z") }))
  check("a cover-less EPUB is still a valid package (no cover item, no cover.xhtml) — KDP takes the cover separately", !noCover.some((e) => /cover/.test(e.name)) && !/cover-image/.test(noCover.find((e) => e.name === "OEBPS/content.opf")!.data.toString("utf8")))
  const z = unzip(zipEntries([{ name: "mimetype", data: Buffer.from("application/epub+zip"), store: true }, { name: "a/b.txt", data: Buffer.from("héllo wörld ".repeat(50)) }]))
  check("zipEntries round-trips a deflated UTF-8 entry byte for byte", z[1].method === 8 && z[1].data.toString("utf8") === "héllo wörld ".repeat(50))

  // ═══════════════════ F · the cover ═══════════════════
  section("F · the cover — a 1,600×2,560 JPEG that meets KDP's eBook rules")
  const typo = await composeBookCover({ title: meta.title, subtitle: meta.subtitle, authorName: "Dana Reyes", primaryColor: "#14532D", art: null })
  for (const [label, c] of [["typographic", typo], ["over art", cover]] as const) {
    const m = await sharp(c.jpeg).metadata()
    check(`${label}: ${COVER_WIDTH}×${COVER_HEIGHT} JPEG, RGB, under 50 MB, passes validateEbookCover`, m.format === "jpeg" && m.width === COVER_WIDTH && m.height === COVER_HEIGHT && m.space === "srgb" && validateEbookCover({ width: m.width!, height: m.height!, bytes: c.bytes, format: m.format! }).length === 0 && c.usedArt === (label === "over art"))
  }
  const blank = await composeBookCover({ title: " ", subtitle: null, authorName: " ", primaryColor: "#14532D", art: null })
  const centre = async (b: Buffer) => (await sharp(b).extract({ left: 100, top: 400, width: 1400, height: 1200 }).stats()).channels.map((c) => c.stdev).reduce((a, x) => a + x, 0)
  check("the TITLE is really drawn: the typographic cover's centre has far more variation than a cover with no text (the text layer is not silently empty)", (await centre(typo.jpeg)) > (await centre(blank.jpeg)) * 5 + 5, `${(await centre(typo.jpeg)).toFixed(1)} vs ${(await centre(blank.jpeg)).toFixed(1)}`)
  const garbage = await composeBookCover({ title: "T", subtitle: null, authorName: "A", art: Buffer.from("not an image") })
  check("an unreadable art buffer falls back to typography (usedArt false) — never throws, never a broken cover", garbage.usedArt === false && garbage.width === COVER_WIDTH)
  check("KDP cover rules are each CAUGHT: PNG, 500×800 (under minimum), 1,600×1,900 (ratio under 1.6:1), 12,000 px side, 50 MB", validateEbookCover({ width: 1600, height: 2560, bytes: 1, format: "png" }).length === 1 && validateEbookCover({ width: 500, height: 800, bytes: 1, format: "jpeg" }).length >= 1 && validateEbookCover({ width: 1600, height: 1900, bytes: 1, format: "jpeg" }).some((p) => /ratio/.test(p)) && validateEbookCover({ width: 1600, height: 12000, bytes: 1, format: "jpeg" }).some((p) => /10000/.test(p)) && validateEbookCover({ width: 1600, height: 2560, bytes: 50 * 1024 * 1024, format: "jpeg" }).some((p) => /50 MB/.test(p)))
  const prompt = coverArtPrompt({ title: meta.title, audience: "seller", area: "Tampa Bay" })
  check("the art prompt asks for NO text, NO people, NO logos (lettering is set by us; faces would steer)", /NO text/.test(prompt) && /NO people/.test(prompt) && /logos/.test(prompt))

  // ═══════════════════ G · the producer ═══════════════════
  section("G · buildKdpPackage / approveKdpPackage on an in-memory database")
  const project = (over: Record<string, unknown> = {}) => ({
    stage: "ready_for_review", concept: "a calm guide to selling a house", audience: "seller", area: "Tampa Bay", brand: "Harbor Realty",
    title: "The Calm Home Seller", subtitle: "A plain-English guide to selling your house", tagline: "Sell with a plan, not a panic.", introduction: para(6), closing: "When you are ready, we can walk through it.",
    research: null, outline: null, chapters: chapters.map((c) => ({ ...c, words: c.body.split(/\s+/).length, written_at: "2026-10-01", edited: { fact_findings: 0, fair_housing_rewrites: 0, escalated: false, findings: [] } })),
    fact_check: null, pdf_url: "https://cdn/book.pdf", document_id: null, page_count: null, cost: { tokens: 0, model_calls: 0 }, needs_human_review: [], started_by: U1, started_at: "2026-10-01", updated_at: "2026-10-01", log: [], ...over,
  })
  const seed = (p: Record<string, unknown> = project(), tenant = B1) => memSupabase({ lead_capture_forms: [{ id: MAGNET, brokerage_id: tenant, name: "Calm Home Seller", slug: "calm-home-seller", agent_id: null, settings: { book: p }, landing_content: null }], agent_action_ledger: [] }, { uuidIds: true })
  const hosted: Array<{ path: string; type: string; bytes: number }> = []
  const deps = (o: Record<string, unknown> = {}) => ({
    brandResolver: async () => ({ brokerageName: "Harbor Realty", agentName: "Dana Reyes", primaryColor: "#14532D" }),
    entitlement: async () => ({ allowed: true, reason: "ok" }),
    coverArt: async () => ({ bytes: coverArtPng, note: null, costUsd: 0.08 }),
    host: async (_s: unknown, path: string, bytes: Buffer, type: string) => { hosted.push({ path, type, bytes: bytes.length }) },
    olderPersons: [] as never, now: new Date("2026-10-23T12:00:00Z"), id: "0b2f7f0e-1c1d-4a55-9d0e-3a1b7d6c5e4f", ...o,
  })
  {
    const db = seed()
    const r = await buildKdpPackage({ brokerageId: B1, magnetId: MAGNET, actorUserId: U1, landingUrl: "https://app.example.com/lm/calm-home-seller" }, { client: db as never, ...deps() } as never)
    const saved = kdpPackageOf(db.tables.lead_capture_forms[0].settings)
    check("a finished book is PACKAGED: recorded on settings.book_publishing (counted), EPUB + cover hosted, art from the image rail", r.ok && !!saved && saved.cover_art === "image_rail" && saved.files.epub.bytes > 1000 && saved.files.cover.width === 1600 && saved.approval === null, JSON.stringify(r).slice(0, 300))
    check("both files go to the PRIVATE documents bucket under the TENANT's path (never a public bucket; the tenant id is in the key)", hosted.length === 2 && hosted.every((h) => h.path.startsWith(`client-docs/${B1}/kdp/${MAGNET}/`)) && saved?.files.epub.bucket === "documents" && saved.files.cover.bucket === "documents" && hosted.some((h) => h.type === "application/epub+zip") && hosted.some((h) => h.type === "image/jpeg"))
    check("the book itself (settings.book) is untouched by packaging", (db.tables.lead_capture_forms[0].settings as { book: { stage: string; chapters: unknown[] } }).book.stage === "ready_for_review" && (db.tables.lead_capture_forms[0].settings as { book: { chapters: unknown[] } }).book.chapters.length === 4)
    check("evidence: a marketing.lead_magnet.kdp_package ledger row, HUMAN_REQUESTED", db.tables.agent_action_ledger.some((l) => l.action === "marketing.lead_magnet.kdp_package" && l.reason_code === "HUMAN_REQUESTED"))
    check("the record carries the rights/AI-disclosure record, the paperback plan WITH its blocker, and the paperback warning", !!saved && saved.rights.aiDisclosure.images === "ai_generated" && saved.paperback.blockers.length >= 1 && saved.warnings.some((w) => /PAPERBACK/.test(w)))
    const noAll = await approveKdpPackage({ brokerageId: B1, magnetId: MAGNET, actorUserId: U1, attested: ["i_hold_rights", "no_rank_claims"] }, { client: db as never })
    check("approval with a MISSING attestation is refused and names exactly the missing ones", !noAll.ok && /ai_disclosure_confirmed/.test((noAll as { error: string }).error) && /facts_reviewed/.test((noAll as { error: string }).error) && !/i_hold_rights,/.test((noAll as { error: string }).error))
    check("…and nothing was approved", kdpPackageOf(db.tables.lead_capture_forms[0].settings)?.approval === null)
    const ok = await approveKdpPackage({ brokerageId: B1, magnetId: MAGNET, actorUserId: U1, attested: KDP_ATTESTATIONS.map((a) => a.id) }, { client: db as never, now: new Date("2026-10-23T13:00:00Z") })
    check("every attestation, by a session user → approved, recording WHO and WHEN, ledgered as a human approval", ok.ok && kdpPackageOf(db.tables.lead_capture_forms[0].settings)?.approval?.by === U1 && db.tables.agent_action_ledger.some((l) => l.action === "marketing.lead_magnet.kdp_approve"))
    const rebuilt = await buildKdpPackage({ brokerageId: B1, magnetId: MAGNET, actorUserId: U1 }, { client: db as never, ...deps() } as never)
    check("REBUILDING the package clears the approval (the files changed — the human attests again)", rebuilt.ok && kdpPackageOf(db.tables.lead_capture_forms[0].settings)?.approval === null)
    check("another tenant cannot approve or build this magnet (not found, nothing changed)", !(await approveKdpPackage({ brokerageId: B2, magnetId: MAGNET, actorUserId: U1, attested: KDP_ATTESTATIONS.map((a) => a.id) }, { client: db as never })).ok && !(await buildKdpPackage({ brokerageId: B2, magnetId: MAGNET, actorUserId: U1 }, { client: db as never, ...deps() } as never)).ok)
  }
  {
    hosted.length = 0
    const db = seed()
    const r = await buildKdpPackage({ brokerageId: B1, magnetId: MAGNET, actorUserId: U1 }, { client: db as never, ...deps({ entitlement: async () => ({ allowed: false, reason: "budget_exhausted" }) }) } as never)
    const saved = kdpPackageOf(db.tables.lead_capture_forms[0].settings)
    check("the tenant may not spend on art → a TYPOGRAPHIC cover, the rights record claims NO AI image, the warning says why — the book is not held for want of a picture", r.ok && saved?.cover_art === "typographic_only" && saved.rights.aiDisclosure.images === "none" && saved.warnings.some((w) => /typography only/.test(w) && /budget_exhausted/.test(w)))
    const fail = await buildKdpPackage({ brokerageId: B1, magnetId: MAGNET, actorUserId: U1 }, { client: seed() as never, ...deps({ coverArt: async () => ({ bytes: null, note: "image rail returned no image (provider key missing)", costUsd: null }) }) } as never)
    check("the image rail failing (no provider key) → typographic cover, never an error", fail.ok && fail.record.cover_art === "typographic_only" && /provider key missing/.test(fail.record.cover_art_note ?? ""))
  }
  const blocked = async (label: string, db: ReturnType<typeof seed>, expect: (r: Awaited<ReturnType<typeof buildKdpPackage>>) => boolean, d: Record<string, unknown> = {}) => {
    hosted.length = 0
    const r = await buildKdpPackage({ brokerageId: B1, magnetId: MAGNET, actorUserId: U1 }, { client: db as never, ...deps(d) } as never)
    check(label, !r.ok && expect(r) && hosted.length === 0 && kdpPackageOf(db.tables.lead_capture_forms[0].settings) === null, JSON.stringify(r).slice(0, 300))
  }
  await blocked("a book still being written (stage chapters) is NOT packaged and nothing is hosted", seed(project({ stage: "chapters" })), (r) => !r.ok && /still being written/.test(r.error))
  await blocked("a book with a chapter still waiting on the human (needs_human_review) is NOT packaged", seed(project({ needs_human_review: [2] })), (r) => !r.ok && /need your rewrite/.test(r.error))
  await blocked("a book whose tagline CLAIMS rank ('the #1 bestseller') is NOT packaged — the blocker names the field, the phrase and the rule", seed(project({ tagline: "The #1 bestseller on selling a home" })), (r) => !r.ok && !!r.blockers?.claims?.some((c) => c.where === "tagline" || c.where === "description"))
  await blocked("a book whose TITLE claims age-qualified housing with NO verified exemption (55+) is NOT packaged — the fair-housing gate names it", seed(project({ title: "Selling in a 55+ community", subtitle: null })), (r) => !r.ok && !!r.blockers?.fairHousing?.some((f) => /55\+/.test(f)))
  {
    hosted.length = 0
    const verified = { community_name: "Sun Palms", basis: "55_plus", governing_rules: "CC&Rs", occupied_units: 200, qualifying_units: 172, survey_completed_on: "2026-03-01", policies_published: true, policies_reference: "handbook", age_verification_procedures: true, program_name: null, program_determination_ref: null, sworn_certification_on_file: true, certifying_representative: "A. Manager", certification_date: "2026-03-05", state: "FL", state_law_reviewed: true }
    const db = seed(project({ title: "Selling in Sun Palms, a 55+ community", subtitle: null }))
    const r = await buildKdpPackage({ brokerageId: B1, magnetId: MAGNET, actorUserId: U1 }, { client: db as never, ...deps({ olderPersons: [verified] }) } as never)
    check("…the SAME title passes when the tenant has a VERIFIED exemption for the community it names (the claim is verified, not forbidden)", r.ok, JSON.stringify(r).slice(0, 200))
  }
  await blocked("a magnet with no book project is not a book", memSupabase({ lead_capture_forms: [{ id: MAGNET, brokerage_id: B1, name: "x", slug: "x", settings: {}, landing_content: null }], agent_action_ledger: [] }, { uuidIds: true }) as never, (r) => !r.ok && /no book project/.test(r.error))

  // ═══════════════════ H · source rules ═══════════════════
  section("H · source rules — the platform never logs in to KDP, stores a credential or claims a publication")
  const produce = code("lib/lead-magnets/book-publishing-produce.ts"), pubMod = code("lib/lead-magnets/book-publishing.ts"), coverMod = code("lib/lead-magnets/book-cover.ts")
  const actions = code("app/actions/lead-magnets-actions.ts")
  const kdpActions = ["getKdpPackageAction", "buildKdpPackageAction", "approveKdpPackageAction", "getKdpDownloadsAction"]
  check("the four KDP actions are async exports in the lead-magnet actions file, tenant + actor from getAgentContext (no tenant parameter)", kdpActions.every((a) => new RegExp(`export async function ${a}\\((magnetId: string|magnetId: string, attested: string\\[\\])\\)`).test(actions)) && kdpActions.every((a) => { const body = actions.slice(actions.indexOf(`export async function ${a}`)); return /getAgentContext\(\)/.test(body.slice(0, 700)) }))
  check("no KDP / Amazon API call, login, credential or upload exists in the package code (KDP has no publishing API; a person uploads)", !/(kdp\.amazon\.com|amazon\.com\/|fetch\([^)]*amazon|signIn|password|api[_-]?key|client[_-]?secret)/i.test(produce + pubMod + coverMod))
  check("the package code NEVER writes a publication fact (no 'published_to_kdp', no status 'published' write) — approval means 'approved for upload'", !/published_to_kdp|kdp_published|status:\s*"published"/.test(produce))
  check("no 'bestseller' TEMPLATE: the only rank words in the package modules are inside the claim guard's patterns and the prose that forbids them", (() => { const noPatterns = pubMod.replace(/const RANK_PATTERNS[\s\S]*?\n\]\n/, ""); const lines = (noPatterns + produce + coverMod).split("\n").filter((l) => /best[\s-]?sell|#\s?1\b|number[\s-]?one/i.test(l)); return lines.every((l) => /(never|no |not |refus|prohibit|guarantee|imply|claim)/i.test(l)) })())
  check("the producer reads the tenant's older-persons exemption and runs the PUBLIC-COPY fair-housing gate on the retail text (surface 'book')", /scanPublicCopy\([\s\S]{0,300}"book", \{ brokerageName, olderPersons \}/.test(produce))
  check("the panel is mounted in the book panel only when the book is DONE and nothing awaits the human", /\{done && book\.needsHumanReview\.length === 0 && <KdpPublishingPanel magnetId=\{magnetId\} \/>\}/.test(code("app/components/features/lead-magnets/BookProjectPanel.tsx")))
  rmSync(tmp, { recursive: true, force: true })

  console.log("\n──────────────────────────────────────────────────")
  console.log(` Denominators: ${margin.length} margin boundaries; ${dirty.length} rank phrases / ${clean.length} clean; ${entries.length} EPUB entries (${xmlParts.length} XML parts); 2 covers; 7 producer scenarios`)
  console.log(" Blind spots:")
  for (const b of [
    "KDP has no publishing API and the author's KDP account is WAITING_EXTERNAL: nothing here proves KDP ACCEPTS the files — KDP's own upload checks and review do",
    "the PAPERBACK interior PDF is NOT produced (KDP requires embedded fonts; the repo ships no font file or embedder) — only the plan, margins and the named blocker exist",
    "the claim guard is a pattern list: a rank claim worded in a way it does not list is not caught; the human attestation (no_rank_claims) and KDP's own review are the backstops",
    "the cover art comes from the image rail with a fixture here — no provider is called; legibility is argued from pixel statistics, not from a person looking at it (the lane notes record one hand-checked render)",
    "keyword effectiveness, category fit and pricing are NOT measured — suggestions only; KDP's own category tree and keyword rules at upload time govern (the 50-character keyword limit is not confirmed by the KDP page read and is applied as a conservative cap)",
    ...blind,
  ]) console.log(`   · ${b}`)
  if (failures.length) { console.log(" FAILURES:"); for (const f of failures) console.log(`   - ${f}`) }
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ❌ BOOK_PUBLISHING_FAIL"); process.exit(1) }
  console.log(" ✅ BOOK_PUBLISHING_PASS — a finished book becomes a valid EPUB + KDP-grade cover + claim-free metadata + an attested rights record; nothing guarantees or implies rank")
}

main().catch((e) => { console.error(e); process.exit(1) })
