// lib/ads/facebook-audience-sync-types.ts
// Types extracted from facebook-audience-sync.ts so the latter can be
// a clean "use server" file. The canonical AudienceType / SourceRule
// definitions still live on @/lib/kernel/ads — these are forwarding
// re-exports kept for the existing call sites.

export type { AudienceType, SourceRule } from "@/lib/kernel/ads"
import type { AudienceType, SourceRule } from "@/lib/kernel/ads"

export interface CreateAudienceParams {
  brokerageId: string
  agentId: string
  audienceName: string
  audienceType: AudienceType
  sourceRule: SourceRule
  consentBasis: string
  adCampaignId?: string
}

export interface SyncAudienceParams {
  brokerageId: string
  agentId: string
  audienceId: string
}

// LoadAudiencesParams — DELETED with its only consumer (orphan burn-down lane C).
// It typed lib/ads/facebook-audience-sync.ts:loadFacebookAudiences, which was
// removed as a duplicate of lib/kernel/ads.ts:261 loadAdsWorkspace; see the
// tombstone in that file. Left behind it would have been a new orphan export.
