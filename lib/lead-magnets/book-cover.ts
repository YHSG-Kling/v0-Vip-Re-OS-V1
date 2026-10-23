// lib/lead-magnets/book-cover.ts
//
// THE BOOK COVER — AI ART FROM THE EXISTING IMAGE RAIL, TYPOGRAPHY SET BY US (wave 143, lane 143F).
// Image models cannot be trusted with lettering (garbled words on a retail cover are the first thing a buyer sees), so
// the art is requested TEXT-FREE and the title, subtitle and author are set here, deterministically, in next/og's
// bundled font (satori — the engine behind every OG image in the app; it carries its own font, so the cover does not
// depend on fonts installed on a Lambda). The result is a 1,600 × 2,560 JPEG — KDP's ideal eBook cover (2,560 px tall ×
// 1,600 px wide, ≥ 1.6:1, RGB, JPEG / TIFF only).
//
// NO ART IS NOT NO COVER: when the image rail is unavailable (no entitlement, no provider key, a refusal) the cover is a
// typographic cover on the brand colour, and the rights record says "typographic_only" — the book is never held for want
// of a picture, and nothing claims an AI image that was not made.
//
// The image request names NO people (fair housing: a cover that pictures who a home is "for" steers), no logos, no text.

import "server-only"
import { createElement } from "react"
import sharp from "sharp"

export const COVER_WIDTH = 1600
export const COVER_HEIGHT = 2560

/** The text-free art prompt for a book (sent to the image rail). PURE. */
export function coverArtPrompt(b: { title: string; audience: "buyer" | "seller"; area: string | null }): string {
  return (
    `Cover illustration for a book titled "${b.title}" — a plain-English real-estate guide for ${b.audience === "buyer" ? "people buying a home" : "people selling a home"}` +
    `${b.area ? ` in ${b.area}` : ""}. Calm, premium, editorial style: a welcoming house exterior at golden hour or a bright empty living room, soft depth of field, ` +
    `generous empty space in the upper and lower thirds. ABSOLUTELY NO text, letters, numbers, logos, signs or watermarks anywhere in the image. NO people or faces.`
  )
}

function hexOr(c: string | null | undefined, fallback: string): string {
  return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback
}

function titleSize(title: string): number {
  return title.length <= 28 ? 168 : title.length <= 52 ? 132 : title.length <= 80 ? 104 : 84
}

export interface BookCoverResult { jpeg: Buffer; width: number; height: number; bytes: number; usedArt: boolean }

/** Compose the cover. `art` is the image rail's bytes (any raster), or null for the typographic cover. Never throws on a bad art buffer — falls back to typography. */
export async function composeBookCover(input: { title: string; subtitle: string | null; authorName: string; primaryColor?: string | null; art?: Buffer | null }): Promise<BookCoverResult> {
  const W = COVER_WIDTH, H = COVER_HEIGHT
  const brand = hexOr(input.primaryColor, "#0F172A")
  let base: Buffer
  let usedArt = false
  if (input.art && input.art.length > 0) {
    try {
      base = await sharp(input.art, { failOn: "none" }).rotate().resize(W, H, { fit: "cover", position: "centre" }).removeAlpha().toBuffer()
      usedArt = true
    } catch {
      base = await sharp({ create: { width: W, height: H, channels: 3, background: brand } }).png().toBuffer()
    }
  } else {
    base = await sharp({ create: { width: W, height: H, channels: 3, background: brand } }).png().toBuffer()
  }

  const { ImageResponse } = await import("next/og")
  const h = createElement
  const textLayer = h("div", {
    style: { display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", padding: "190px 120px 170px", color: "#FFFFFF", textAlign: "center" },
  },
    // Over art the title sits in a dark panel at the top; with no art it is centred on the colour with an accent rule — a
    // typographic cover is a designed object, not an empty one.
    // (No `undefined` style values: satori calls .trim() on every value and throws on one — so the two variants are spread in.)
    h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", ...(usedArt ? {} : { flex: 1, justifyContent: "center" }), background: usedArt ? "rgba(0,0,0,0.5)" : "transparent", padding: usedArt ? "70px 60px" : "0", borderRadius: 8 } },
      h("div", { style: { fontSize: titleSize(input.title), fontWeight: 700, lineHeight: 1.08, letterSpacing: -2, display: "flex", textAlign: "center", justifyContent: "center" } }, input.title),
      usedArt ? null : h("div", { style: { display: "flex", width: 260, height: 8, background: "rgba(255,255,255,0.85)", marginTop: 56 } }),
      input.subtitle ? h("div", { style: { fontSize: 66, marginTop: 44, lineHeight: 1.25, opacity: 0.94, display: "flex", textAlign: "center", justifyContent: "center" } }, input.subtitle) : null,
    ),
    h("div", { style: { display: "flex", justifyContent: "center", fontSize: 76, letterSpacing: 6, textTransform: "uppercase", background: usedArt ? "rgba(0,0,0,0.5)" : "transparent", padding: usedArt ? "26px 60px" : "0" } }, input.authorName),
  )
  const layer = Buffer.from(await new ImageResponse(textLayer as never, { width: W, height: H }).arrayBuffer())
  const jpeg = await sharp(base).composite([{ input: layer, top: 0, left: 0 }]).flatten({ background: brand }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer()
  const meta = await sharp(jpeg).metadata()
  return { jpeg, width: meta.width ?? W, height: meta.height ?? H, bytes: jpeg.length, usedArt }
}
