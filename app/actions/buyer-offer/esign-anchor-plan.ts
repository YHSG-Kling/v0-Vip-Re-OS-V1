"use server"

/**
 * Build the e-sign anchor plan for a filled offer form + the brokerage's connected provider — the
 * data the wizard's "confirm each area is set for e-signing" step renders. Provider-agnostic: the
 * canonical anchors are derived from the PDF's own fields, then translated to the connected provider's
 * native tags. Ambiguous fields (no party / two parties) are surfaced for MANUAL placement, never
 * auto-assigned — a signature can't reach the wrong party. Read-only.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { buildEsignAnchorPlan } from "@/lib/forms/esign-anchor-plan"
import type { EsignProvider } from "@/lib/forms/esign-anchor-adapters"

const FORMS_BUCKET = "brokerage-forms"
const SUPPORTED: EsignProvider[] = ["dotloop", "docusign", "skyslope", "authentisign", "generic"]

export interface EsignAnchorPlanInput {
  /** storage path of the filled PDF (from prefillStorageFormAction) or the source form. */
  filledPath: string
  /** the brokerage's connected e-sign provider; falls back to "generic". */
  provider?: string | null
}

export async function buildEsignAnchorPlanAction(input: EsignAnchorPlanInput): Promise<{
  success: boolean
  provider?: EsignProvider
  anchorCount?: number
  recipientRoles?: string[]
  ambiguous?: Array<{ fieldName: string; reason: string }>
  needsManualPlacement?: boolean
  safe?: boolean
  safetyViolations?: string[]
  error?: string
}> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { success: false, error: "unauthorized" }
  if (!input.filledPath?.toLowerCase().endsWith(".pdf")) return { success: false, error: "a filled PDF path is required" }

  const provider: EsignProvider = SUPPORTED.includes((input.provider ?? "") as EsignProvider)
    ? (input.provider as EsignProvider) : "generic"

  const svc = createServiceClient()
  // Same service-client read as prefillStorageFormAction, same tenant check (lane 88C):
  // the caller-named path must be in the SESSION's own scope before a byte is read.
  const { data: me, error: meErr } = await authClient.from("users").select("brokerage_id, team_id").eq("id", user.id).maybeSingle()
  if (meErr) return { success: false, error: `could not read your account: ${meErr.message}` }
  if (!me?.brokerage_id) return { success: false, error: "unauthorized" }
  const { checkFormPathsInScope } = await import("@/lib/forms/form-path-scope")
  const scope = await checkFormPathsInScope(svc, [input.filledPath], {
    brokerageId: me.brokerage_id as string, teamId: (me.team_id as string | null) ?? null, userId: user.id,
  })
  if (!scope.ok) return { success: false, error: scope.error ?? "that form is not in your library" }
  try {
    const { data: file, error } = await svc.storage.from(FORMS_BUCKET).download(input.filledPath)
    if (error || !file) return { success: false, error: `could not load the form: ${error?.message ?? "not found"}` }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const plan = await buildEsignAnchorPlan(bytes, provider)
    return {
      success: true,
      provider,
      anchorCount: plan.anchors.length,
      recipientRoles: plan.recipientRoles,
      ambiguous: plan.ambiguous.map((a) => ({ fieldName: a.fieldName, reason: a.reason })),
      needsManualPlacement: plan.needsManualPlacement,
      safe: plan.safety.ok,
      safetyViolations: plan.safety.violations,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "anchor plan failed" }
  }
}
