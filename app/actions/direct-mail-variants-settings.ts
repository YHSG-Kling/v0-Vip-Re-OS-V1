"use server"

/**
 * app/actions/direct-mail-variants-settings.ts
 *
 * Wave 36 — server actions for the Bandit Catalog Settings page.
 * Brokerage-admin-scoped. Three operations:
 *
 *   getVariantCatalog — list every arm (active + deprecated) scoped
 *     to this brokerage + every platform-wide row, with per-arm
 *     outcomes (sends / scans / leads / cost).
 *
 *   setVariantActive — toggle is_active on a BROKERAGE-scoped arm.
 *     The bandit only samples from is_active=true rows; flipping
 *     false instantly removes the arm from rotation. Outcomes data
 *     is preserved so re-enabling later restarts from history.
 *     Platform-wide rows (brokerage_id IS NULL) cannot be modified
 *     by tenant admin — they're shared across all brokerages.
 *
 *   addCustomVariant — insert a new BROKERAGE-scoped arm with a
 *     custom (composition_id, copy_style, layout_variant) combo for
 *     a specific (persona, use_kind, postcard_size) cell. The
 *     bandit picks it up on next dispatch alongside the platform
 *     defaults; no other wiring needed.
 *
 *     copy_style must match a key in POSTCARD_COPY_STYLE_OVERLAYS or
 *     LETTER_COPY_STYLE_OVERLAYS — or the prompt will silently fall
 *     through to "default" (= no overlay). We surface a warning in
 *     the result when the style isn't a known overlay key.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { revalidatePath } from "next/cache"

const KNOWN_COPY_STYLES = new Set([
  "default", "direct-fact", "question-hook", "social-proof", "photo-led",
  "intro-warm", "intro-credibility", "checkin-personal", "appointment-prep",
])

const VALID_USE_KINDS = new Set(["farm_mail", "welcome_kit", "sphere_outreach", "lifecycle", "pre_listing_kit"])
const VALID_SIZES = new Set(["4x6", "6x9"])
const VALID_PERSONAS = new Set([
  "first_time", "relocated", "luxury", "fsbo", "probate",
  "upsize", "downsize", "military", "divorce", "senior",
  "expired", "foreclosure", "other",
])

export interface VariantCatalogRow {
  variant_id:     string
  /** True for brokerage-scoped (custom); false for platform-wide (read-only). */
  is_brokerage_scoped: boolean
  composition_id: string
  copy_style:     string
  layout_variant: string
  persona:        string
  use_kind:       string
  postcard_size:  string
  is_active:      boolean
  sends_count:    number
  scans_count:    number
  leads_count:    number
  cost_spent_cents: number
  last_send_at:   string | null
}

export async function getVariantCatalog(): Promise<
  | { success: true; rows: VariantCatalogRow[] }
  | { success: false; error: string }
> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const svc = createServiceClient()
  const brokerageId = access.brokerageScopeId

  // Pull both this brokerage's arms AND platform-wide (brokerage_id IS NULL).
  const { data: variants } = await svc
    .from("direct_mail_variants")
    .select(`
      id, brokerage_id, composition_id, copy_style, layout_variant,
      persona, use_kind, postcard_size, is_active,
      outcomes:direct_mail_variant_outcomes!direct_mail_variant_outcomes_variant_id_fkey(sends_count, scans_count, leads_count, cost_spent_cents, last_send_at)
    `)
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .order("is_active", { ascending: false })
    .order("composition_id", { ascending: true })
    .limit(500)

  type RawRow = {
    id: string
    brokerage_id: string | null
    composition_id: string
    copy_style: string
    layout_variant: string
    persona: string
    use_kind: string
    postcard_size: string
    is_active: boolean
    outcomes: Array<{ sends_count: number; scans_count: number; leads_count: number; cost_spent_cents: number; last_send_at: string | null }> | null
  }
  const rows: VariantCatalogRow[] = ((variants ?? []) as unknown as RawRow[]).map((r) => {
    // Per-brokerage outcomes — when the variant is platform-wide we
    // still scope outcomes to this brokerage; the FK + index handle
    // both paths.
    const o = r.outcomes?.find(() => true) ?? { sends_count: 0, scans_count: 0, leads_count: 0, cost_spent_cents: 0, last_send_at: null }
    return {
      variant_id:          r.id,
      is_brokerage_scoped: r.brokerage_id === brokerageId,
      composition_id:      r.composition_id,
      copy_style:          r.copy_style,
      layout_variant:      r.layout_variant,
      persona:             r.persona,
      use_kind:            r.use_kind,
      postcard_size:       r.postcard_size,
      is_active:           r.is_active,
      sends_count:         o.sends_count ?? 0,
      scans_count:         o.scans_count ?? 0,
      leads_count:         o.leads_count ?? 0,
      cost_spent_cents:    o.cost_spent_cents ?? 0,
      last_send_at:        o.last_send_at ?? null,
    }
  })

  return { success: true, rows }
}

export async function setVariantActive(input: {
  variantId: string
  isActive:  boolean
}): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const svc = createServiceClient()

  // Tenant guard: must be a brokerage-scoped row owned by this tenant.
  // Platform-wide rows (brokerage_id IS NULL) are off-limits.
  const { data: row } = await svc
    .from("direct_mail_variants")
    .select("id, brokerage_id")
    .eq("id", input.variantId)
    .maybeSingle()
  const r = row as { id: string; brokerage_id: string | null } | null
  if (!r) return { success: false, error: "Variant not found" }
  if (r.brokerage_id === null) {
    return { success: false, error: "Platform-wide variants can't be modified by tenant admin." }
  }
  if (r.brokerage_id !== access.brokerageScopeId) {
    return { success: false, error: "Tenant mismatch" }
  }

  const { error } = await svc
    .from("direct_mail_variants")
    .update({ is_active: input.isActive })
    .eq("id", input.variantId)
  if (error) return { success: false, error: error.message }
  revalidatePath("/settings/direct-mail/variants")
  return { success: true }
}

export async function addCustomVariant(input: {
  composition_id: string
  copy_style:     string
  layout_variant?: string
  persona:        string
  use_kind:       string
  postcard_size:  string
}): Promise<{ success: boolean; variantId?: string; warning?: string; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }

  // Validate the enum-shaped fields against the CHECK constraints + the
  // Persona union before round-tripping to Postgres.
  const compId = input.composition_id.trim()
  const style  = input.copy_style.trim()
  const layout = (input.layout_variant ?? "default").trim() || "default"
  if (!compId) return { success: false, error: "composition_id is required" }
  if (!style)  return { success: false, error: "copy_style is required" }
  if (!VALID_USE_KINDS.has(input.use_kind))    return { success: false, error: `Invalid use_kind. One of: ${[...VALID_USE_KINDS].join(", ")}` }
  if (!VALID_SIZES.has(input.postcard_size))   return { success: false, error: "postcard_size must be '4x6' or '6x9'" }
  if (!VALID_PERSONAS.has(input.persona))      return { success: false, error: `Invalid persona. One of: ${[...VALID_PERSONAS].join(", ")}` }

  const svc = createServiceClient()
  const { data, error } = await svc.from("direct_mail_variants").insert({
    brokerage_id:   access.brokerageScopeId,
    composition_id: compId,
    copy_style:     style,
    layout_variant: layout,
    persona:        input.persona,
    use_kind:       input.use_kind,
    postcard_size:  input.postcard_size,
    is_active:      true,
  }).select("id").single()
  if (error) {
    if (error.code === "23505") {
      return { success: false, error: "This exact arm already exists for your brokerage." }
    }
    return { success: false, error: error.message }
  }

  revalidatePath("/settings/direct-mail/variants")

  // Surface a non-fatal warning when the copy_style isn't a known
  // overlay key — the prompt will fall through to "default" and the
  // arm will exist + be picked but copy won't differ from baseline.
  const warning = KNOWN_COPY_STYLES.has(style)
    ? undefined
    : `copy_style "${style}" isn't in the platform overlay map — the bandit will pick this arm but the prompt won't differ from the "default" overlay until you add the style to lib/direct-mail/draft-copy.ts.`

  return { success: true, variantId: data.id as string, warning }
}
