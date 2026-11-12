/**
 * lib/marketing/content-winner-verdict.ts
 *
 * The PURE half of the content-winner emitter (lib/marketing/content-winner.ts
 * is server-only because the baseline reader is; the verdict is not, so the
 * proof can exercise it). One vocabulary: these thresholds are the only ones.
 */
import type { SocialBaseline } from "./social-baselines"

/** A post must have been SEEN this much to be judged at all. */
export const WINNER_MIN_IMPRESSIONS = 200
/** Engagement rate must beat the organic baseline by this multiple. */
export const WINNER_LIFT = 2
/** A baseline built from fewer posts than this is not a floor. */
export const WINNER_MIN_BASELINE_POSTS = 3
/** Only recent posts — a winner from months ago is not a "moment". */
export const WINNER_WINDOW_DAYS = 14

export interface WinnerVerdict {
  postId: string
  platform: string
  postType: string
  impressions: number
  engagementRate: number
  baselineRate: number
  lift: number
}

/** Pure: is this post a winner against its baseline? null when it cannot be judged. */
export function judgeContentWinner(
  post: { postId: string; platform: string; postType: string; impressions: number; engagements: number },
  baselines: SocialBaseline[],
): WinnerVerdict | null {
  if (post.impressions < WINNER_MIN_IMPRESSIONS) return null
  const base = baselines.find((b) => b.platform === post.platform && b.postType === post.postType)
  if (!base || base.postsMeasured < WINNER_MIN_BASELINE_POSTS) return null
  const baselineRate = base.engagementRate
  if (baselineRate === null || !(baselineRate > 0)) return null
  const engagementRate = post.engagements / post.impressions
  const lift = engagementRate / baselineRate
  if (lift < WINNER_LIFT) return null
  return { postId: post.postId, platform: post.platform, postType: post.postType, impressions: post.impressions, engagementRate, baselineRate, lift }
}

