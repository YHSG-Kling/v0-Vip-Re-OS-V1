#!/usr/bin/env tsx
/**
 * scripts/marketing-qr-simulator.ts  (npm run test:marketing-qr)
 *
 * Tracked, scannable QR on PRINT/digital marketing material — listing flyers, the listing packet,
 * open-house & just-sold flyers, CMAs — REUSING the qr_codes backend + the shared tracked-QR core
 * (no new tables). Mirrors the video-qr simulator: a pure Layer 1 always runs; a live Layer 2 runs
 * only with SUPABASE_SERVICE_ROLE_KEY, seeds real rows, asserts, then reverse-deletes (cleanup == 0).
 */
// lib/marketing/marketing-qr.ts imports `server-only`, which throws outside a Server Component.
// Neutralize that guard in the require cache BEFORE importing the system under test.
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* nothing to shim */ }

import { randomUUID } from "node:crypto"
import type { MarketingQrKind } from "../lib/marketing/marketing-qr"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

async function main(): Promise<void> {
  const { qrDestinationForMaterial, mintMarketingQr } = await import("../lib/marketing/marketing-qr")

  console.log("\n[marketing QR · pure — material kind → destination_type + URL]")
  const ORIGIN = "https://app.example.com"
  const refs = { listingId: "L-1", agentSlug: "jane-doe" }
  const expected: Record<MarketingQrKind, { dt: string; urlPart: string }> = {
    listing_flyer:    { dt: "listing_detail", urlPart: "/listings/L-1" },
    listing_packet:   { dt: "listing_detail", urlPart: "/listings/L-1" },
    just_sold_flyer:  { dt: "listing_detail", urlPart: "/listings/L-1" },
    open_house_flyer: { dt: "book_meeting",   urlPart: "/listings/L-1/rsvp" },
    cma:              { dt: "landing_page",   urlPart: "/home-value/jane-doe" },
  }
  for (const kind of Object.keys(expected) as MarketingQrKind[]) {
    const d = qrDestinationForMaterial(kind)
    const url = d.buildTargetUrl(ORIGIN, refs)
    check(`${kind} → ${expected[kind].dt} @ ${expected[kind].urlPart}`,
      d.destinationType === expected[kind].dt && url.includes(expected[kind].urlPart))
  }
  // only enum-valid destination_types are emitted
  const dts = new Set((Object.keys(expected) as MarketingQrKind[]).map(k => qrDestinationForMaterial(k).destinationType))
  check("emits only enum-valid destination_types", [...dts].every(d => ["listing_detail", "book_meeting", "landing_page"].includes(d)))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[marketing QR · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the mapping")
  } else {
    console.log("\n[marketing QR · live — mint a real tracked code, idempotent re-mint, self-clean]")
    const { createServiceClient } = await import("../lib/supabase/service")
    const svc = createServiceClient()
    const tag = `MKTQR-${randomUUID().slice(0, 8)}`
    const brokerageId = randomUUID()
    let listingId: string | null = null
    try {
      await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} Brokerage`, city: "Austin", state: "TX" })
      const { data: lr } = await svc.from("listings").insert({ brokerage_id: brokerageId, status: "active", address: `${tag} 100 Main St` }).select("id").single()
      listingId = lr!.id as string

      const first = await mintMarketingQr({ brokerageId, kind: "listing_flyer", listingId })
      check("mints a tracked code with a resolvable scan URL", !!first && /\/api\/qr\/scan\?slug=/.test(first.scanUrl))
      check("returns a valid PNG data URL", !!first && first.qrCodeDataUrl.startsWith("data:image/png;base64,"))
      check("destination_type is listing_detail", first?.destinationType === "listing_detail")

      const second = await mintMarketingQr({ brokerageId, kind: "listing_flyer", listingId })
      check("re-mint is idempotent (same slug reused)", !!second && !!first && second.slug === first.slug)

      const { count } = await svc.from("qr_codes").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("label", `material:listing_flyer:${listingId}`)
      check("exactly ONE qr_codes row exists for (listing, kind)", (count ?? 0) === 1)
    } finally {
      await svc.from("qr_codes").delete().eq("brokerage_id", brokerageId)
      if (listingId) await svc.from("listings").delete().eq("id", listingId)
      await svc.from("brokerages").delete().eq("id", brokerageId)
      const { count } = await svc.from("qr_codes").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
      check("cleanup complete", (count ?? 0) === 0)
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MARKETING_QR_FAIL"); process.exit(1) }
  console.log(" ✅ MARKETING_QR_PASS — listing flyers/packets carry a tracked, scannable QR")
}

main().catch((e) => { console.error(e); process.exit(1) })
