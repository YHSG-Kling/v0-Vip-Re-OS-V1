// lib/video/broll-url.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE VIDEO-URL PREDICATE, in a module with no React in it.
//
// It lived in remotion/_BrollLayer.tsx, which is the right place for the LAYER
// to ask the question and the wrong place for a SERVER producer to import it
// from: that file imports ./components/SafeImg, which uses `useState`, and
// Next.js refuses any import path from a React Server Component module into a
// `useState` module — even a dynamic `await import(...)`, which webpack still
// traces. lib/agents/seller-update-reel-producer.ts reached it that way on
// 2026-09-06 and next-build went red on every commit of the branch:
//
//   remotion/components/SafeImg.tsx ← remotion/_BrollLayer.tsx
//     ← lib/agents/seller-update-reel-producer.ts ← lib/kernel/manager-signals.ts
//     ← app/actions/portal-lifetime.ts / app/api/cron/listing-seller-update-video
//
// §6 still holds — one extension list. The layer re-exports this function so
// scripts/broll-slot-guard.ts and every render path keep asking the same
// question; the producer imports THIS module and never the component file.

/**
 * Whether a URL points at a video by its extension. Purely syntactic — a
 * content-type is what the renderer sees at fetch time, which is the most a
 * URL check can offer.
 */
export function isVideoUrl(url: string): boolean {
  const ext = url.split("?")[0].split("#")[0].toLowerCase()
  return ext.endsWith(".mp4") || ext.endsWith(".webm") || ext.endsWith(".mov") || ext.endsWith(".m4v")
}
