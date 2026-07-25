"use server"

/**
 * Print-ready postcard preview. Renders the SAME front+back 4×6 images that
 * dispatchDirectMail hands to lob.postcards.create({ front, back }) — the real
 * Remotion render (brand colors, logo, license line, Fair-Housing disclosure,
 * AI-drafted compliance-gated copy, QR), uploaded to Vercel Blob. So the preview
 * IS what Lob will mail, not a CSS approximation.
 *
 * On demand (a "Generate print preview" button), because the render costs an AI
 * draft + a headless render + a blob upload — too heavy to run on every keypress.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { renderPostcardBothSides4x6 } from "@/lib/direct-mail/render-postcard"

// audience label → the renderer's persona enum (tonal targeting only).
function toPersona(audience?: string): string {
  const a = (audience ?? "").toLowerCase()
  if (a.includes("first")) return "first_time_buyer"
  if (a.includes("move") || a.includes("up")) return "mover_up"
  if (a.includes("downsiz")) return "downsizing"
  if (a.includes("invest")) return "investor"
  if (a.includes("luxury") || a.includes("high")) return "luxury"
  if (a.includes("probate")) return "probate"
  if (a.includes("divorce")) return "divorce"
  return "sphere"
}

export async function renderPostcardPreviewAction(input: {
  templateType?: string
  audienceSegment?: string
}): Promise<{
  success: boolean
  error?: string
  frontUrl?: string
  backUrl?: string
  copy?: { headline: string; body: string; cta: string }
  violations?: string[]
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const supabase = await createClient()
  const { data: agent } = await supabase
    .from("users")
    .select("first_name, last_name")
    .eq("id", ctx.userId)
    .maybeSingle()
  const agentName = [agent?.first_name, agent?.last_name].filter(Boolean).join(" ") || null

  try {
    const result = await renderPostcardBothSides4x6({
      brokerageId: ctx.brokerageId,
      copyCtx: {
        brokerageId: ctx.brokerageId,
        teamId: (ctx as any).teamId ?? null,
        agentUserId: ctx.userId,
        contactId: null, // farm/preview — no specific recipient
        persona: toPersona(input.audienceSegment),
        qrDestinationType: "landing_page",
      } as any,
      qrScanUrl: null, // preview QR is a placeholder; the real send mints a slug
      agentName,
      agentPhotoUrl: null, // agent headshot is optional on the render
    })

    if (!result.ok) {
      return {
        success: false,
        error: result.error === "compliance_gate_failed"
          ? "The AI copy did not pass the compliance gate — adjust and retry, or a static template is used at send."
          : result.error ?? "Render failed",
        violations: result.violations,
      }
    }
    return { success: true, frontUrl: result.frontUrl, backUrl: result.backUrl, copy: result.copy }
  } catch (e: any) {
    return { success: false, error: `Preview render failed: ${e?.message ?? String(e)}` }
  }
}
