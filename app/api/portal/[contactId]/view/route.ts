/**
 * API Route: GET /api/portal/[contactId]/view
 * 
 * KERNEL CONTRACT COMPLIANCE:
 * Input Contract: PortalViewInput { contactId: string }
 * Output Contract: PortalResponse<PortalViewOutput>
 * 
 * Returns the portal view type and metadata using kernel determination logic.
 * Uses explicit normalized contracts at every layer.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { determinePortalView } from '@/lib/kernel/portal'
import { requireContactAccess } from '@/lib/portal/require-contact-access'
import { isValidUUID } from '@/lib/validations'
import {
  PortalViewOutput,
  PortalResponse,
  PORTAL_ERRORS,
  PORTAL_VALIDATION_RULES,
  createPortalSuccess,
  createPortalErrorResponse,
  type PortalViewInput,
} from '@/lib/kernel/portal-contracts'

export async function GET(
  // Deliberately unread — every input is the route param below plus the session gate.
  _request: NextRequest,
  context: { params: Promise<{ contactId: string }> }
): Promise<NextResponse<PortalResponse<PortalViewOutput>>> {
  try {
    const { contactId } = await context.params

    // ── VALIDATE INPUT AGAINST THE DECLARED CONTRACT ────────────────────────
    //
    // `PORTAL_VALIDATION_RULES.contactIdFormat` has said 'uuid' since the
    // contract file was written, and NOTHING read it — the rule was declared,
    // exported, and enforced by no one, while this check accepted any non-empty
    // string. So a caller could hand this route arbitrary text; it reached
    // `requireContactAccess` and then a `.eq("id", <text>)`, where Postgres
    // answers 22P02 (invalid input syntax for type uuid) rather than a clean
    // 400. The rule is now the thing being enforced, so contract and code cannot
    // drift.
    //
    // NOT enforced here, and deliberately: `PORTAL_VALIDATION_RULES
    // .validBuyerStages` is a THIRD buyer-stage vocabulary
    // ('DISCOVERY'/'SEARCHING'/'UNDER_OFFER'/…) that matches neither the
    // BuyerState union (lib/buyer-lifecycle/lifecycle-definitions.ts:13) nor the
    // lowercase `contacts.buyer_stage` values. Gating on it would refuse every
    // real contact. It is left as an open §6 finding rather than wired to a
    // spelling nothing produces.
    if (
      !contactId ||
      typeof contactId !== 'string' ||
      (PORTAL_VALIDATION_RULES.contactIdFormat === 'uuid' && !isValidUUID(contactId))
    ) {
      return NextResponse.json(
        createPortalErrorResponse(PORTAL_ERRORS.INVALID_INPUT),
        { status: 400 }
      )
    }

    // Authorize: caller must be the contact themselves or staff in the same
    // brokerage. Previously this route trusted the URL contactId with no check.
    const access = await requireContactAccess(contactId)
    if (!access.ok) {
      return NextResponse.json(
        createPortalErrorResponse(PORTAL_ERRORS.UNAUTHORIZED),
        { status: access.error === 'Unauthorized' ? 401 : 403 }
      )
    }

    // Create Supabase client for authenticated requests
    const supabase = await createClient()

    // Call kernel function with input contract
    const input: PortalViewInput = { contactId }
    const output = await determinePortalView(supabase, input)

    // Return success response with output contract
    return NextResponse.json(createPortalSuccess(output), { status: 200 })
  } catch (error) {
    console.error('[Portal API] Error determining portal view:', error)
    return NextResponse.json(
      createPortalErrorResponse(PORTAL_ERRORS.DATABASE_ERROR),
      { status: 500 }
    )
  }
}
