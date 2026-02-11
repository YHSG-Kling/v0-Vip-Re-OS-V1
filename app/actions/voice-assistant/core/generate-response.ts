'use server'

/**
 * SYSTEM 6.1 - Response Generator
 * Generates text and speakable responses for voice output
 */

export interface GenerateResponseRequest {
  type: 'success' | 'authority_denied' | 'readiness_blocked' | 'execution_error'
  command: string
  result?: any
  denial_reason?: string
  required_role?: string
  blocker_description?: string
  missing_events?: string[]
  error_message?: string
}

export interface GeneratedResponse {
  text: string
  speakable: string
}

/**
 * Generate human-friendly responses for TTS
 */
export function generateResponse(request: GenerateResponseRequest): GeneratedResponse {
  const { type, command, result, denial_reason, required_role, blocker_description, missing_events, error_message } = request

  switch (type) {
    case 'success':
      return generateSuccessResponse(command, result)

    case 'authority_denied':
      return generateAuthorityDeniedResponse(command, denial_reason, required_role)

    case 'readiness_blocked':
      return generateReadinessBlockedResponse(command, blocker_description, missing_events)

    case 'execution_error':
      return generateExecutionErrorResponse(command, error_message)

    default:
      return {
        text: 'Response generation failed',
        speakable: 'I encountered an error generating the response'
      }
  }
}

/**
 * Generate success response
 */
function generateSuccessResponse(command: string, result: any): GeneratedResponse {
  const commandFriendly = command.replace(/_/g, ' ')

  // Command-specific responses
  switch (command) {
    case 'generate_cma':
      return {
        text: 'CMA generated successfully',
        speakable: 'I\'ve generated the Comparative Market Analysis. It\'s ready for review.'
      }

    case 'generate_net_sheet':
      return {
        text: 'Net sheet generated successfully',
        speakable: 'The seller net sheet is ready. It shows estimated proceeds at closing.'
      }

    case 'schedule_showing':
      return {
        text: 'Showing scheduled successfully',
        speakable: `Showing has been scheduled for ${result?.scheduled_date || 'the requested time'}.`
      }

    case 'activate_mls':
      return {
        text: 'MLS activated successfully',
        speakable: `Listing is now active on MLS with number ${result?.mls_number || 'assigned'}.`
      }

    case 'approve_media':
      return {
        text: 'Media approved successfully',
        speakable: 'Photos and video have been approved. Listing is ready for coming soon.'
      }

    case 'query_listing_status':
      return {
        text: `Listing status: ${result?.status || 'unknown'}`,
        speakable: `This listing is currently ${result?.status || 'in an unknown stage'}.`
      }

    case 'query_buyer_stage':
      return {
        text: `Buyer stage: ${result?.stage || 'unknown'}`,
        speakable: `This buyer is in ${result?.stage || 'an unknown stage'} of their journey.`
      }

    default:
      return {
        text: `${commandFriendly} completed successfully`,
        speakable: `I've completed ${commandFriendly} successfully.`
      }
  }
}

/**
 * Generate authority denied response
 */
function generateAuthorityDeniedResponse(
  command: string,
  denialReason?: string,
  requiredRole?: string
): GeneratedResponse {
  const commandFriendly = command.replace(/_/g, ' ')

  return {
    text: denialReason || `Unauthorized to ${commandFriendly}`,
    speakable: denialReason || `You are not authorized to ${commandFriendly}. ${requiredRole ? `${requiredRole} role is required.` : ''}`
  }
}

/**
 * Generate readiness blocked response
 */
function generateReadinessBlockedResponse(
  command: string,
  blockerDescription?: string,
  missingEvents?: string[]
): GeneratedResponse {
  const commandFriendly = command.replace(/_/g, ' ')

  if (blockerDescription) {
    return {
      text: blockerDescription,
      speakable: blockerDescription
    }
  }

  const missing = missingEvents?.map(e => e.replace(/\./g, ' ').replace(/_/g, ' ')).join(', ')

  return {
    text: `Cannot ${commandFriendly}. Missing: ${missing}`,
    speakable: `I can't ${commandFriendly} yet. You need to complete: ${missing}.`
  }
}

/**
 * Generate execution error response
 */
function generateExecutionErrorResponse(command: string, errorMessage?: string): GeneratedResponse {
  const commandFriendly = command.replace(/_/g, ' ')

  return {
    text: errorMessage || `Failed to ${commandFriendly}`,
    speakable: `I encountered an error trying to ${commandFriendly}. ${errorMessage || 'Please try again or contact support.'}`
  }
}
