'use server'

/**
 * SYSTEM 6.1 v0 - CONTROLLED COMMAND LAYER
 * Main Entry: Voice Command Handler
 * 
 * Production-grade voice command execution interface for agents, team leaders,
 * and brokerage staff. Enforces authority, validates readiness, dispatches to
 * existing systems, and maintains complete audit trail.
 * 
 * Constraints:
 * - NO new database tables
 * - NO schema modifications
 * - Writes ONLY to activities table
 * - Agent-facing ONLY (not for buyers/sellers)
 * - Dispatches to existing system actions
 * - Full audit trail
 */

import { parseIntent } from './core/parse-intent'
import { validateAuthority } from './core/validate-authority'
import { validateReadiness } from './core/validate-readiness'
import { dispatchCommand } from './core/dispatch-command'
import { generateResponse } from './core/generate-response'
import { emitAuditEvent } from './core/emit-audit-event'
import { getAgentContext } from '@/lib/identity/get-agent-context'

export interface VoiceCommandRequest {
  voice_input: string
  /** ignored — derived from session */
  user_id?: string
  /** ignored — derived from session via users.user_type */
  user_role?: 'agent' | 'team_lead' | 'admin' | 'broker' | 'tc' | 'compliance_officer' | 'vendor'
  /** ignored — derived from session */
  brokerage_id?: string
  context?: {
    current_listing_id?: string
    current_buyer_id?: string
    location?: string
  }
}

export interface VoiceCommandResponse {
  success: boolean
  spoken_response: string
  text_response: string
  action_taken?: string
  requires_clarification?: boolean
  clarification_options?: string[]
  error?: string
}

/**
 * Main entry point for voice command execution
 * 
 * Execution Flow:
 * 1. Parse intent (LLM)
 * 2. Resolve entity IDs
 * 3. Validate authority
 * 4. Validate readiness
 * 5. Dispatch command
 * 6. Emit audit event
 * 7. Generate voice response
 */
export async function handleVoiceCommand(
  request: VoiceCommandRequest
): Promise<VoiceCommandResponse> {
  const { voice_input, context } = request

  // Validate inputs
  if (!voice_input || voice_input.trim().length === 0) {
    return {
      success: false,
      spoken_response: 'I didn\'t hear anything. Could you try again?',
      text_response: 'No voice input received',
      error: 'Empty voice input'
    }
  }

  // SECURITY: never trust caller-supplied user_id / brokerage_id / user_role.
  // Resolve from the authenticated session.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return {
      success: false,
      spoken_response: 'I had trouble identifying your account. Please try again.',
      text_response: 'Unauthorized',
      error: 'Unauthorized'
    }
  }

  const user_id = ctx.userId
  const brokerage_id = ctx.brokerageId
  // Resolve role from session via users.user_type (never trust caller-supplied role)
  const user_role = ctx.userType as NonNullable<VoiceCommandRequest['user_role']>

  // Disallow buyer/seller roles
  if (['buyer', 'seller', 'anonymous'].includes(user_role as string)) {
    return {
      success: false,
      spoken_response: 'Voice assistant is available for brokerage staff only.',
      text_response: 'Access denied: buyer/seller roles not allowed',
      error: 'Unauthorized role'
    }
  }

  try {
    // STEP 1: Parse intent
    const intentResult = await parseIntent({
      raw_transcript: voice_input,
      user_id,
      user_role,
      brokerage_id,
      context
    })

    if (!intentResult.success || !intentResult.intent) {
      await emitAuditEvent({
        event_type: 'voice.command.failed',
        user_id,
        brokerage_id,
        metadata: {
          raw_command: voice_input,
          reason: 'Intent parsing failed',
          failure_type: 'parse_error'
        }
      })

      return {
        success: false,
        spoken_response: 'I didn\'t understand that command. Could you rephrase it?',
        text_response: intentResult.error || 'Failed to parse intent',
        error: intentResult.error
      }
    }

    const { intent } = intentResult

    // Check for clarification needed
    if (intent.requires_clarification) {
      await emitAuditEvent({
        event_type: 'voice.command.clarification_needed',
        user_id,
        brokerage_id,
        metadata: {
          raw_command: voice_input,
          missing_parameters: intent.missing_parameters,
          disambiguation_options: intent.disambiguation_options
        }
      })

      return {
        success: false,
        spoken_response: intent.clarification_message || 'I need more information. Could you be more specific?',
        text_response: intent.clarification_message || 'Clarification needed',
        requires_clarification: true,
        clarification_options: intent.disambiguation_options
      }
    }

    // STEP 2: Validate authority
    const authorityResult = await validateAuthority({
      user_id,
      user_role,
      brokerage_id,
      command: intent.target_action,
      target_system: intent.target_system,
      entities: intent.entities
    })

    if (!authorityResult.allowed) {
      await emitAuditEvent({
        event_type: 'voice.command.failed',
        user_id,
        brokerage_id,
        entity_type: intent.entities.listing_id ? 'listing' : intent.entities.buyer_id ? 'contact' : undefined,
        entity_id: intent.entities.listing_id || intent.entities.buyer_id,
        metadata: {
          raw_command: voice_input,
          parsed_action: intent.target_action,
          reason: authorityResult.denial_reason,
          failure_type: 'authority_denied'
        }
      })

      const response = generateResponse({
        type: 'authority_denied',
        command: intent.target_action,
        denial_reason: authorityResult.denial_reason,
        required_role: authorityResult.required_role
      })

      return {
        success: false,
        spoken_response: response.speakable,
        text_response: response.text,
        error: authorityResult.denial_reason
      }
    }

    // STEP 3: Validate readiness (for execution commands only)
    if (intent.intent_type === 'execute') {
      const readinessResult = await validateReadiness({
        target_action: intent.target_action,
        entities: intent.entities,
        brokerage_id
      })

      if (!readinessResult.ready) {
        await emitAuditEvent({
          event_type: 'voice.command.failed',
          user_id,
          brokerage_id,
          entity_type: intent.entities.listing_id ? 'listing' : intent.entities.buyer_id ? 'contact' : undefined,
          entity_id: intent.entities.listing_id || intent.entities.buyer_id,
          metadata: {
            raw_command: voice_input,
            parsed_action: intent.target_action,
            reason: readinessResult.blocker_description,
            failure_type: 'readiness_blocked',
            missing_events: readinessResult.missing_events
          }
        })

        const response = generateResponse({
          type: 'readiness_blocked',
          command: intent.target_action,
          blocker_description: readinessResult.blocker_description,
          missing_events: readinessResult.missing_events
        })

        return {
          success: false,
          spoken_response: response.speakable,
          text_response: response.text,
          error: readinessResult.blocker_description
        }
      }
    }

    // STEP 4: Dispatch command
    const dispatchResult = await dispatchCommand({
      target_system: intent.target_system,
      target_action: intent.target_action,
      parameters: {
        ...intent.parameters,
        user_id,
        brokerage_id,
        role: user_role
      },
      entities: intent.entities
    })

    if (!dispatchResult.success) {
      await emitAuditEvent({
        event_type: 'voice.command.failed',
        user_id,
        brokerage_id,
        entity_type: intent.entities.listing_id ? 'listing' : intent.entities.buyer_id ? 'contact' : undefined,
        entity_id: intent.entities.listing_id || intent.entities.buyer_id,
        metadata: {
          raw_command: voice_input,
          parsed_action: intent.target_action,
          reason: dispatchResult.error,
          failure_type: 'execution_error'
        }
      })

      const response = generateResponse({
        type: 'execution_error',
        command: intent.target_action,
        error_message: dispatchResult.error
      })

      return {
        success: false,
        spoken_response: response.speakable,
        text_response: response.text,
        error: dispatchResult.error
      }
    }

    // STEP 5: Emit success audit event
    await emitAuditEvent({
      event_type: 'voice.command.executed',
      user_id,
      brokerage_id,
      entity_type: intent.entities.listing_id ? 'listing' : intent.entities.buyer_id ? 'contact' : undefined,
      entity_id: intent.entities.listing_id || intent.entities.buyer_id,
      metadata: {
        raw_command: voice_input,
        parsed_action: intent.target_action,
        target_system: intent.target_system,
        success: true,
        result: dispatchResult.result
      }
    })

    // STEP 6: Generate success response
    const response = generateResponse({
      type: 'success',
      command: intent.target_action,
      result: dispatchResult.result
    })

    return {
      success: true,
      spoken_response: response.speakable,
      text_response: response.text,
      action_taken: intent.target_action
    }

  } catch (error) {
    console.error('[voice-command] Unexpected error:', error)

    await emitAuditEvent({
      event_type: 'voice.command.failed',
      user_id,
      brokerage_id,
      metadata: {
        raw_command: voice_input,
        reason: error instanceof Error ? error.message : 'Unknown error',
        failure_type: 'system_error'
      }
    })

    return {
      success: false,
      spoken_response: 'I encountered an unexpected error. Please try again or contact support.',
      text_response: 'System error occurred',
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
