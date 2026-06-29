'use server'

/**
 * SYSTEM 6.1 - Command Dispatcher
 * Maps voice commands to system actions and executes them
 */

import { COMMAND_MAP } from '../helpers/command-map'
import { COMMAND_EXECUTORS } from '../helpers/command-executors'

export interface DispatchResult {
  success: boolean
  result?: any
  error?: string
}

interface DispatchCommandRequest {
  target_system: string
  target_action: string
  parameters: Record<string, any>
  entities: Record<string, any>
}

/**
 * Dispatch command to appropriate system action
 */
export async function dispatchCommand(request: DispatchCommandRequest): Promise<DispatchResult> {
  const { target_system, target_action, parameters, entities } = request

  try {
    // Resolve the param-mapping (for buildActionParams) + the STATIC executor (bundled + build-validated,
    // unlike the old runtime-string import that never resolved on Vercel).
    const mapping = COMMAND_MAP[target_action as keyof typeof COMMAND_MAP]
    const executor = COMMAND_EXECUTORS[target_action as keyof typeof COMMAND_EXECUTORS]

    if (!mapping || !executor) {
      return {
        success: false,
        error: `Command "${target_action}" not mapped to a system action`
      }
    }

    // Build parameters for the action (apply the voice → action param mapping).
    const actionParams = buildActionParams(
      target_action,
      parameters,
      entities,
      mapping.param_mapping
    )

    // Execute the action (static import — actually runs on Vercel).
    const result = await executor(actionParams)

    return {
      success: result?.success !== false,
      result,
      error: result?.error
    }

  } catch (error) {
    console.error('[dispatch-command] Error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Command execution failed'
    }
  }
}

/**
 * Build action parameters from voice command data
 */
function buildActionParams(
  targetAction: string,
  parameters: Record<string, any>,
  entities: Record<string, any>,
  paramMapping?: Record<string, string>
): Record<string, any> {
  const params: Record<string, any> = {
    ...parameters,
    ...entities
  }

  // Apply parameter mapping if provided
  if (paramMapping) {
    for (const [voiceParam, actionParam] of Object.entries(paramMapping)) {
      if (params[voiceParam]) {
        params[actionParam] = params[voiceParam]
        if (actionParam !== voiceParam) {
          delete params[voiceParam]
        }
      }
    }
  }

  return params
}
