// lib/video/verbal-disclosure.ts
//
// THE BROKERAGE VERBAL DISCLOSURE — one implementation, every render door.
//
// WHY THIS FILE EXISTS
//
// Real-estate advertising law requires a rendered marketing video to name the
// brokerage (and, where the state requires it, the licence). The avatar speaks
// it, because the ffmpeg visual overlay is deferred (see lib/did/index.ts), so
// the disclosure has to be baked into the SCRIPT THAT IS SENT TO THE PROVIDER —
// not into the stored script, which is the agent's own text.
//
// It also has to be recorded, because `checkVideo` in lib/kernel/brand-compliance.ts
// (:305) reports a violation on any rendered public-marketing video whose
// `ai_video_projects.has_verbal_disclosure` is false. A render door that injects
// nothing and stamps nothing therefore produces a video that is both illegal to
// run and permanently non-compliant in the ledger.
//
// Until this module existed there was exactly ONE implementation, inline in
// app/api/did/generate-video/route.ts, and the OTHER live D-ID door —
// app/actions/video-generation.ts:generateVideoFromScript — had none: it
// imported `checkBrandCompliance` and called neither it nor any disclosure step,
// so every video rendered through the "render a saved script" path went out with
// no brokerage attribution and a permanently-false `has_verbal_disclosure`.
//
// Rather than copy the block (two spellings of one legal requirement is exactly
// the §6 defect this repo keeps paying for), the inline version was lifted here
// verbatim and both doors now call this. The MLS carve-out is part of the rule,
// not an optimisation: MLS submissions forbid brokerage attribution, so an
// `usage_intent = 'mls'` project must be left clean and stamped FALSE — which is
// what `checkVideo` asserts in the inverse direction (:276).

import type { SupabaseClient } from "@supabase/supabase-js"

export interface VerbalDisclosureOutcome {
  /** The script to send to the provider — the input, plus the disclosure when one applies. */
  renderScript: string
  /** True when a disclosure was appended. Mirrors what was stamped on the project. */
  injected: boolean
  /** `ai_video_projects.usage_intent`, defaulted to 'public_marketing' as the column's readers do. */
  usageIntent: string
  /** `ai_video_projects.captions_enabled`, read in the same round trip callers already pay for. */
  captionsEnabled: boolean
  /**
   * A refused STAMP, surfaced rather than swallowed. supabase-js resolves a
   * refusal, so an un-destructured update here would have reported a compliant
   * render over a column that never changed.
   */
  stampError?: string
}

/**
 * Append the brokerage verbal disclosure to `script` and stamp
 * `ai_video_projects.has_verbal_disclosure` to match.
 *
 * Never throws: a read that fails degrades to "no trade name, no disclosure,
 * stamped false", which is the state `checkBrandCompliance` will then correctly
 * report as a violation. Failing silently OPEN (stamping true without injecting)
 * is the one outcome this must never produce.
 */
export async function applyBrokerageVerbalDisclosure(
  supabase: SupabaseClient,
  args: {
    script: string
    projectId: string
    brokerageId: string | null | undefined
  },
): Promise<VerbalDisclosureOutcome> {
  const { script, projectId, brokerageId } = args

  let renderScript = script
  let injected = false

  const { data: videoRow } = await supabase
    .from("ai_video_projects")
    .select("usage_intent, captions_enabled")
    .eq("id", projectId)
    .maybeSingle()

  const usageIntent: string = (videoRow as { usage_intent?: string } | null)?.usage_intent ?? "public_marketing"
  const captionsEnabled: boolean = (videoRow as { captions_enabled?: boolean } | null)?.captions_enabled ?? false

  if (usageIntent !== "mls" && brokerageId) {
    const { data: brokerage } = await supabase
      .from("brokerages")
      .select("name, dba, license_number, license_state")
      .eq("id", brokerageId)
      .maybeSingle()
    const b = brokerage as {
      name?: string | null
      dba?: string | null
      license_number?: string | null
      license_state?: string | null
    } | null
    const tradeName = b?.dba ?? b?.name
    if (tradeName) {
      const licenseSuffix = b?.license_number
        ? `, License ${b.license_number}${b?.license_state ? ` ${b.license_state}` : ""}`
        : ""
      // Concise verbal disclosure — kept short so it doesn't disrupt the
      // narrative. Equal Housing Opportunity is included because most
      // listing-related videos count as housing-related advertising
      // under the federal Fair Housing Act.
      const disclosure = `. Brought to you by ${tradeName}${licenseSuffix}. Equal Housing Opportunity.`
      renderScript = `${script.replace(/[.!?\s]+$/, "")}${disclosure}`
      injected = true
    }
  }

  const { error: stampError } = await supabase
    .from("ai_video_projects")
    .update({ has_verbal_disclosure: injected })
    .eq("id", projectId)

  return {
    renderScript,
    injected,
    usageIntent,
    captionsEnabled,
    stampError: stampError?.message,
  }
}
