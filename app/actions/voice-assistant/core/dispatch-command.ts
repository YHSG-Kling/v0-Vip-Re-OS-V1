'use server'

/**
 * SYSTEM 6.1 - Command Dispatcher
 * Maps voice commands to system actions and executes them
 */

import { COMMAND_MAP } from '../helpers/command-map'

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
    // Get command mapping
    const mapping = COMMAND_MAP[target_action as keyof typeof COMMAND_MAP]

    if (!mapping) {
      return {
        success: false,
        error: `Command "${target_action}" not mapped to system action`
      }
    }

    // Dynamically import action module
    const actionModule = await import(mapping.module_path)
    const actionFunction = actionModule[mapping.function_name]

    if (!actionFunction) {
      return {
        success: false,
        error: `Action function "${mapping.function_name}" not found`
      }
    }

    // Build parameters for action
    const actionParams = buildActionParams(
      target_action,
      parameters,
      entities,
      mapping.param_mapping
    )

    // Execute action
    const result = await actionFunction(actionParams)

    return {
      success: result.success !== false,
      result,
      error: result.error
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
