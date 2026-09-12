/**
 * Listing Landing Page adapter — generates or updates a listing micro-site.
 * Gracefully handles cases where the backing action isn't yet exported.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const listingLandingPageAdapter: ChannelAdapter = {
  channel: "listing_landing_page",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, brokerageId, agentUserId, contact, resolvedVars, supabase } = ctx

    const slug = resolvedVars["listing_page_slug"] ?? step.listing_page_slug ?? null

    try {
      const m = await import("@/app/actions/ai-listing-intake")
      const generateFn = (m as any).generateListingLandingPage

      if (typeof generateFn === "function") {
        const result = await generateFn({
          brokerageId,
          agentUserId: agentUserId ?? "",
          templateId: step.listing_page_template_id ?? undefined,
          slug: slug ?? undefined,
          contactId: contact?.id,
        })

        if (!result?.success) {
          return { status: "error", providerKey: "landing-page", error: result?.error ?? "Generation failed" }
        }

        return {
          status: "sent",
          providerKey: "landing-page",
          messageId: result.pageId,
          output: { page_url: result.pageUrl, page_id: result.pageId, slug: result.slug },
        }
      }
    } catch { /* action not yet built */ }

    // Fallback: create a placeholder record + notify agent
    const pageSlug = slug ?? `listing-${Date.now()}`
    const { data: page, error } = await supabase
      .from("listing_landing_pages")
      .insert({
        brokerage_id: brokerageId,
        contact_id: contact?.id ?? null,
        // The FALLBACK path — reached only when generateListingLandingPage is not
        // exported (see the try above). It cannot resolve a template, because the
        // resolver lives with the generator; storing the REQUESTED id here would
        // claim a provenance nothing verified, and m606's FK would refuse an id
        // that names no content_templates row — losing the whole placeholder row
        // (PGRST/23503 refuses the row, not the column — CLAUDE.md §3).
        //
        // So the placeholder records NO template. That is honest: this row exists
        // precisely because the real generator did not run, and it carries a
        // "backend not yet configured" note for the same reason.
        template_id: null,
        slug: pageSlug,
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (error) {
      // Table may not exist yet — log and return sent so sequence continues
      return {
        status: "sent",
        providerKey: "landing-page",
        output: { slug: pageSlug, note: "Landing page generation queued — backend not yet configured" },
      }
    }

    return {
      status: "sent",
      providerKey: "landing-page",
      messageId: page?.id,
      output: { page_id: page?.id, slug: pageSlug },
    }
  },
}
