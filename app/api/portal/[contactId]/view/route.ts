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
import {
  PortalViewOutput,
  PortalResponse,
  PORTAL_ERRORS,
  createPortalSuccess,
  createPortalErrorResponse,
  type PortalViewInput,
} from '@/lib/kernel/portal-contracts'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ contactId: string }> }
): Promise<NextResponse<PortalResponse<PortalViewOutput>>> {
  try {
    const { contactId } = await context.params

    // Validate input contract
    if (!contactId || typeof contactId !== 'string') {
      return NextResponse.json(
        createPortalErrorResponse(PORTAL_ERRORS.INVALID_INPUT),
        { status: 400 }
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
