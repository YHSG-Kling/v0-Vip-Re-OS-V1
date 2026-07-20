// app/manifest.ts — PWA web-app manifest (Next 15 metadata route → /manifest.webmanifest).
// ─────────────────────────────────────────────────────────────────────────────
// MOBILE POSTURE (v1, honest):
//   • INSTALLABLE APP SHELL, NO OFFLINE SERVICE WORKER. Modern Chrome/Edge/Android
//     install from manifest + icons alone; iOS installs via Add to Home Screen
//     (apple-touch-icon + appleWebApp metadata in app/layout.tsx). We deliberately
//     ship NO caching service worker in v1: Next 15 App Router streams RSC payloads
//     and carries Supabase auth cookies — a cache-first/stale SW is a known footgun
//     (stale RSC payloads, broken auth redirects) and would be worse than none.
//     The ONLY service worker in the app is /push-sw.js (web-push display + click
//     routing, registered on demand by push-permission-toggle.tsx). It has no fetch
//     handler, so it can never intercept navigation or break auth.
//   • BRAND: the platform's name is a DB setting (platform_settings.product_brand,
//     lib/platform/product-brand.ts) — never hardcoded. This route resolves it per
//     request; if the DB/env is unavailable (e.g. static build), it falls back to
//     DEFAULT_PRODUCT_BRAND so the manifest is always valid.
//   • ICONS are static build assets generated from the default brand lettermark
//     (VIP / #0F172A / #F59E0B): icon-192/512 (purpose any, rounded) and
//     icon-maskable-192/512 (full-bleed, mark in the 80% safe zone). If the brand
//     is renamed, regenerate the icon set — the manifest name updates itself.
//   • start_url is /dashboard: unauthenticated opens redirect to /login and return.
// See MOBILE.md for the full mobile-readiness story and the v2 roadmap.

import type { MetadataRoute } from "next"
import { DEFAULT_PRODUCT_BRAND, type ProductBrand } from "@/lib/platform/product-brand"

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  // Resolve the DB-driven brand; never let brand loading break installability.
  let brand: ProductBrand = DEFAULT_PRODUCT_BRAND
  try {
    const { loadProductBrand } = await import("@/lib/platform/product-brand")
    const { createServiceClient } = await import("@/lib/supabase/service")
    brand = await loadProductBrand(createServiceClient())
  } catch {
    brand = DEFAULT_PRODUCT_BRAND
  }

  return {
    name: brand.name,
    short_name: brand.name.length <= 12 ? brand.name : brand.name.slice(0, 12).trim(),
    description: brand.tagline,
    id: "/dashboard",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#ffffff",
    theme_color: brand.primaryColor,
    categories: ["business", "productivity"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Dashboard", url: "/dashboard", icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "CRM", url: "/crm", icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "Calendar", url: "/calendar", icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }] },
    ],
  }
}
