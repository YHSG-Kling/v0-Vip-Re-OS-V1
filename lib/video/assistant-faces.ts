// lib/video/assistant-faces.ts
// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY half of the assistant wardrobe: generating the headshot gallery
// through the image-gen rail. Split out of lib/video/assistant-options.ts so
// that module stays client-safe — AIIdentityEditor.tsx ("use client") imports
// the voice/face/avatar DATA from assistant-options, and must never pull the
// server-only image-generation chain into the client bundle (a build-time
// boundary error: "You're importing a module that depends on server-only").
// The only caller is app/actions/ai-identity.ts (the server action the editor
// invokes).
import "server-only"
import { ASSISTANT_FACE_BRIEFS, type AssistantFaceOption } from "./assistant-options"

/** Generate the headshot GALLERY through the existing image-gen rail.
 *  Best-effort per option — a single generation failure shrinks the gallery
 *  instead of blocking it; zero successes returns [] (the UI says so). */
export async function generateAssistantFaceOptions(count = 3): Promise<AssistantFaceOption[]> {
  const briefs = ASSISTANT_FACE_BRIEFS.slice(0, Math.max(1, Math.min(count, ASSISTANT_FACE_BRIEFS.length)))
  const { generateImage } = await import("@/lib/ai/image-generation")
  const results = await Promise.all(briefs.map(async (b) => {
    try {
      const img = await generateImage({ prompt: b.prompt, purpose: "generic", size: "1024x1024", style: "natural" })
      return img.success && img.imageUrl ? { key: b.key, imageUrl: img.imageUrl } : null
    } catch { return null }
  }))
  return results.filter((r): r is AssistantFaceOption => !!r)
}
