/**
 * Condition adapter — evaluates a branch condition.
 * The executor reads step.condition_field/operator/value and either continues
 * or skips. This adapter just returns "sent" (condition check happens in the
 * executor's branching logic, not here).
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const conditionAdapter: ChannelAdapter = {
  channel: "condition",
  async execute(_ctx: StepContext): Promise<StepResult> {
    return { status: "sent", providerKey: "condition" }
  },
}
