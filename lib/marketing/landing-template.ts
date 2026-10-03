/**
 * lib/marketing/landing-template.ts
 *
 * THE READER `listing_landing_pages.template_id` NEVER HAD.
 *
 * Two surfaces wrote that column and nothing in the tree read it: the value came
 * from a bare uuid box in the sequence step palette (lib/workflow/step-palette.ts:245,
 * labelled "Template"), was stored, and was never resolved, applied or shown back.
 * An agent who typed an id in that box got a silent no-op. The owner asked for
 * landing-page templates on 2026-09-05; this is the half that was missing.
 *
 * ── NO NEW TABLE (§1, §6) ────────────────────────────────────────────────────
 *
 * `public.content_templates` was already live with exactly the right shape —
 * template_body, structure, placeholders, variables, example_output,
 * seo_guidelines, category, content_type, platform, brokerage_id, agent_id,
 * is_global, is_active, usage_count. Measured 2026-09-05 it held 0 rows and had
 * ZERO code references anywhere: a shell built and never wired. That makes it the
 * right home, not a reason to avoid it — a second `listing_landing_page_templates`
 * table beside it would be a second spelling of "content template" and would leave
 * the shell orphaned for good. m606 declares the FK.
 *
 * The previous wave's note said "there is no landing-page template table anywhere
 * in this tree". That was true of the NAME and false of the CAPABILITY, which is
 * worth recording: a search scoped to the expected spelling reported absence.
 *
 * ── PRECEDENCE, AND WHY IT IS THIS WAY ROUND ─────────────────────────────────
 *
 * agent → brokerage → global. The same order resolveRequiredDocuments uses for the
 * compliance checklist, so the OS has ONE answer to "whose setting wins" (§6). The
 * narrowest owner wins because a template is a voice: an agent who has written
 * their own page copy should not have it silently replaced by a brokerage default,
 * and a brokerage default should not be replaced by a platform one.
 *
 * ── FAIL OPEN, DELIBERATELY, AND ONLY HERE ───────────────────────────────────
 *
 * §4's "fail closed" governs GATES — a thing that decides whether an action is
 * permitted. This is not a gate; it is a preference lookup, and the fallback is the
 * free-form generation that has always run. So a refused read returns null and the
 * page is still produced, rather than the agent's landing page failing to exist
 * because a template lookup had a bad minute. The refusal IS surfaced (logged and
 * carried on the result) so it cannot pass as "no template configured" — that
 * distinction is the same one the compliance gate draws between not_passed and
 * unknown, and it matters here for a smaller reason: an agent debugging why their
 * template did not apply must not be told it does not exist.
 */
import type { SupabaseClient } from "@supabase/supabase-js"

/** The one category value a landing-page template carries. */
export const LANDING_TEMPLATE_CATEGORY = "listing_landing_page" as const

export interface LandingTemplate {
  id:            string
  templateName:  string | null
  /** The body/shape the page copy should follow. Free text — steers, never executes. */
  templateBody:  string | null
  /** Optional structural hints (sections, order) the generator can honour. */
  structure:     unknown
  /** Named holes the generator is expected to fill, e.g. ["address","price"]. */
  placeholders:  string[]
  seoGuidelines: string | null
  /** Which owner supplied it — reported so a surface can say WHY this one won. */
  scope:         "agent" | "brokerage" | "global"
}

export interface LandingTemplateResolution {
  template: LandingTemplate | null
  /**
   * True when a read was REFUSED rather than returning nothing. supabase-js
   * RESOLVES refusals (CLAUDE.md §3), so without this the caller cannot tell
   * "no template configured" from "we could not look" — and only one of those
   * is something the agent should be told.
   */
  lookupFailed: boolean
  reason:       string | null
}

function toTemplate(row: Record<string, unknown>, scope: LandingTemplate["scope"]): LandingTemplate {
  const raw = row.placeholders
  return {
    id:            String(row.id),
    templateName:  (row.template_name as string | null) ?? null,
    templateBody:  (row.template_body as string | null) ?? null,
    structure:     row.structure ?? null,
    placeholders:  Array.isArray(raw) ? raw.map(String) : [],
    seoGuidelines: (row.seo_guidelines as string | null) ?? null,
    scope,
  }
}

const COLUMNS = "id, template_name, template_body, structure, placeholders, seo_guidelines, agent_id, brokerage_id, is_global"

/**
 * Resolve the landing-page template that applies, honouring an explicit choice first.
 *
 * `explicitTemplateId` is the id an agent picked in the step palette. It is checked
 * INSIDE the caller's tenant and against the category, so a copied id from another
 * brokerage — or an id naming a template for a different surface entirely — resolves
 * to nothing rather than pulling a stranger's copy onto this page. A wrong value can
 * only narrow to null.
 */
export async function resolveLandingTemplate(
  supabase: SupabaseClient,
  params: { brokerageId: string; agentId?: string | null; explicitTemplateId?: string | null },
): Promise<LandingTemplateResolution> {
  const base = () =>
    supabase
      .from("content_templates")
      .select(COLUMNS)
      .eq("category", LANDING_TEMPLATE_CATEGORY)
      .eq("is_active", true)

  // 0 · An EXPLICIT choice outranks precedence — the agent asked for this one.
  if (params.explicitTemplateId) {
    const { data, error } = await base()
      .eq("id", params.explicitTemplateId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()
    if (error) {
      return { template: null, lookupFailed: true, reason: `template lookup refused: ${error.message}` }
    }
    if (data) {
      const row = data as Record<string, unknown>
      return {
        template: toTemplate(row, row.agent_id ? "agent" : "brokerage"),
        lookupFailed: false,
        reason: null,
      }
    }
    // Named but not found IN THIS TENANT and category. Fall through to precedence
    // rather than refusing — but say so, because "your chosen template was not
    // used" is exactly what an agent needs to hear and silence is what they got
    // before m606.
    const fell = await resolveByPrecedence(params, base)
    return {
      ...fell,
      reason: fell.reason ?? "the chosen template is not an active listing-page template in this brokerage; used the default instead",
    }
  }

  return resolveByPrecedence(params, base)
}

/**
 * The precedence walk. It takes `base` — the shared, already-filtered query builder —
 * and NOT a SupabaseClient, deliberately.
 *
 * The first draft accepted a `supabase` argument it never used, because every query
 * here goes through `base()`, which closes over the client. The opposite-missing
 * sweep flagged it as an INERT PARAMETER, and it was right to: a parameter a
 * function does not read is a lie in its signature. A reader would take it to mean
 * this helper does its own I/O against that client, and the next person to change it
 * would try to add a query using the argument rather than extending `base` — quietly
 * dropping the category and is_active filters that every arm here depends on.
 */
async function resolveByPrecedence(
  params: { brokerageId: string; agentId?: string | null },
  base: () => any,
): Promise<LandingTemplateResolution> {
  // 1 · The agent's own.
  if (params.agentId) {
    const { data, error } = await base()
      .eq("brokerage_id", params.brokerageId)
      .eq("agent_id", params.agentId)
      .order("created_at", { ascending: false })
      .limit(1)
    if (error) return { template: null, lookupFailed: true, reason: `agent template lookup refused: ${error.message}` }
    const row = (data ?? [])[0] as Record<string, unknown> | undefined
    if (row) return { template: toTemplate(row, "agent"), lookupFailed: false, reason: null }
  }

  // 2 · The brokerage's. `.is("agent_id", null)` matters — without it an arbitrary
  //     colleague's personal template would answer as the brokerage default.
  const { data: brk, error: brkErr } = await base()
    .eq("brokerage_id", params.brokerageId)
    .is("agent_id", null)
    .order("created_at", { ascending: false })
    .limit(1)
  if (brkErr) return { template: null, lookupFailed: true, reason: `brokerage template lookup refused: ${brkErr.message}` }
  const brkRow = (brk ?? [])[0] as Record<string, unknown> | undefined
  if (brkRow) return { template: toTemplate(brkRow, "brokerage"), lookupFailed: false, reason: null }

  // 3 · Platform-global.
  const { data: glob, error: globErr } = await base()
    .eq("is_global", true)
    .order("created_at", { ascending: false })
    .limit(1)
  if (globErr) return { template: null, lookupFailed: true, reason: `global template lookup refused: ${globErr.message}` }
  const globRow = (glob ?? [])[0] as Record<string, unknown> | undefined
  if (globRow) return { template: toTemplate(globRow, "global"), lookupFailed: false, reason: null }

  return { template: null, lookupFailed: false, reason: null }
}

/**
 * PURE. Fold a resolved template into the generation prompt.
 *
 * The template STEERS the model; it is never executed or interpolated as code, and
 * nothing here evaluates `structure` or a placeholder. That is deliberate: these
 * rows are tenant-authored content, and a template that could execute would be a
 * tenant-authored code path. Placeholders are named to the model as things to fill,
 * which is instruction, not substitution.
 *
 * Returns the prompt UNCHANGED when there is no template, so a brokerage that has
 * configured none gets exactly the behaviour it has today.
 */
export function applyLandingTemplateToPrompt(basePrompt: string, template: LandingTemplate | null): string {
  if (!template) return basePrompt
  const lines: string[] = [basePrompt, "", "Follow the brokerage's approved landing-page template."]
  if (template.templateName) lines.push(`Template: ${template.templateName}`)
  if (template.templateBody) lines.push(`Required shape and voice:\n${template.templateBody}`)
  if (template.placeholders.length > 0) {
    lines.push(`Every one of these must be addressed: ${template.placeholders.join(", ")}.`)
  }
  if (template.seoGuidelines) lines.push(`SEO guidance to honour:\n${template.seoGuidelines}`)
  return lines.join("\n")
}
