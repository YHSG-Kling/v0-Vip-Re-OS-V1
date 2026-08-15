/**
 * API Route: GET /api/portal/[contactId]/modules
 * 
 * KERNEL CONTRACT COMPLIANCE:
 * Input Contract: PortalModulesInput { contactId, view, isPropertyOwner? }
 * Output Contract: PortalResponse<PortalModulesOutput>
 * 
 * Returns which portal modules should be visible for this contact.
 * Enforces portal visibility rules via kernel layer.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { determinePortalView, determinePortalModules } from '@/lib/kernel/portal'
import { requireContactAccess } from '@/lib/portal/require-contact-access'
import {
  PortalModulesOutput,
  PortalResponse,
  PORTAL_ERRORS,
  createPortalSuccess,
  createPortalErrorResponse,
  type PortalModulesInput,
} from '@/lib/kernel/portal-contracts'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ contactId: string }> }
): Promise<NextResponse<PortalResponse<PortalModulesOutput>>> {
  try {
    const { contactId } = await context.params

    // Validate input contract
    if (!contactId || typeof contactId !== 'string') {
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

    // Create Supabase client
    const supabase = await createClient()

    // Step 1: Determine portal view via kernel
    const viewOutput = await determinePortalView(supabase, { contactId })

    // Step 2: Determine portal modules with input contract
    const modulesInput: PortalModulesInput = {
      contactId,
      view: viewOutput.view,
      isPropertyOwner: viewOutput.isPropertyOwner,
    }
    const modulesOutput = await determinePortalModules(supabase, modulesInput)

    // Return success response with output contract
    return NextResponse.json(createPortalSuccess(modulesOutput), { status: 200 })
  } catch (error) {
    console.error('[Portal API] Error determining portal modules:', error)
    return NextResponse.json(
      createPortalErrorResponse(PORTAL_ERRORS.DATABASE_ERROR),
      { status: 500 }
    )
  }
}
