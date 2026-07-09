// lib/remotion/media-host.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE media host for every finished render (owner rule: the finished product
// lives in SUPABASE STORAGE — we host the delivery URL). video-assets bucket
// (public, exists live). Vercel Blob remains the FALLBACK so a storage hiccup
// never loses a finished render. Used by the render coordinator (final MP4),
// the render endpoint (stills + thumbnails), and the voiceover pipeline.

export async function hostRenderedMedia(
  svc: any, path: string, bytes: Buffer, contentType: string,
): Promise<string> {
  try {
    const { error } = await svc.storage.from("video-assets")
      .upload(path, bytes, { contentType, upsert: true })
    if (!error) {
      const { data: pub } = svc.storage.from("video-assets").getPublicUrl(path)
      if (pub?.publicUrl) return pub.publicUrl
    }
  } catch { /* fall through to blob */ }
  const { put } = await import("@vercel/blob")
  const uploaded = await put(path, bytes, { access: "public", contentType })
  return uploaded.url
}
