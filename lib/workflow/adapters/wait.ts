/**
 * Wait adapter — no-op; the delay is encoded in delay_days/delay_hours on the
 * next step and applied by advanceEnrollment. This adapter just signals "sent"
 * so the executor records the wait step as completed and schedules the next.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const waitAdapter: ChannelAdapter = {
  channel: "wait",
  async execute(_ctx: StepContext): Promise<StepResult> {
    return { status: "sent", providerKey: "wait" }
  },
}
