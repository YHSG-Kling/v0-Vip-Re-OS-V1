import type { WaterfallContext } from '../types'

/**
 * STEP 8: Team Split
 * If agent belongs to team, split commission among team members
 * For now, stub - returns agent net unchanged
 */
export async function applyTeamSplit(
  context: WaterfallContext
): Promise<WaterfallContext> {
  // TODO: Query team_splits table when implemented
  // For now, agent keeps full amount
  
  return {
    ...context,
    teamDistributions: []
  }
}
