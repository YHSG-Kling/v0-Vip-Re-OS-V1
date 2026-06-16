// lib/forms/esign-anchor-plan.ts
//
// Tie the canonical e-sign anchors to a REAL filled PDF + a chosen provider — the data the wizard's
// "confirm each area is set for e-signing" preview renders and the send step uses. Reads the PDF's
// AcroForm field names (pdf-lib, Node), derives the anchors, evaluates placement safety, and
// translates to the provider's native tags. Read-only on the PDF. No fabrication: ambiguous fields
// are surfaced for manual placement, never auto-tagged.

import { listPdfFields } from "./pdf-form-fill"
import { deriveEsignAnchors, rolesInAnchors, type DerivedAnchors } from "./esign-anchors"
import { evalAnchorPlacement, type AnchorPlacementResult } from "./esign-anchor-eval"
import { anchorsForProvider, recipientRolesForProvider, type EsignProvider, type ProviderTag } from "./esign-anchor-adapters"

export interface EsignAnchorPlan extends DerivedAnchors {
  provider: EsignProvider
  /** the canonical roles that must sign. */
  roles: ReturnType<typeof rolesInAnchors>
  /** provider-native recipient role labels. */
  recipientRoles: string[]
  /** provider-native tags to place. */
  tags: ProviderTag[]
  /** placement-safety eval — ok=true means no anchor can reach the wrong party. */
  safety: AnchorPlacementResult
  /** does the agent need to manually place any field? */
  needsManualPlacement: boolean
}

/** Build the e-sign anchor plan for a filled PDF + provider. */
export async function buildEsignAnchorPlan(
  pdfBytes: Uint8Array | ArrayBuffer, provider: EsignProvider,
): Promise<EsignAnchorPlan> {
  const fields = await listPdfFields(pdfBytes)
  const derived = deriveEsignAnchors(fields)
  const safety = evalAnchorPlacement(derived)
  const tags = anchorsForProvider(provider, derived.anchors)
  return {
    ...derived,
    provider,
    roles: rolesInAnchors(derived.anchors),
    recipientRoles: recipientRolesForProvider(provider, derived.anchors),
    tags,
    safety,
    needsManualPlacement: derived.ambiguous.length > 0,
  }
}
