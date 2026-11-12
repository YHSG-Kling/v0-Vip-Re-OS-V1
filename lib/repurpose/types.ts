// lib/repurpose/types.ts
// Type definitions for Layer 9.11 Omnipresence Repurposer

export type SourceType =
  | "video_project"
  | "blog_post"
  | "podcast_episode"
  | "social_post"
  | "script"
  | "newsletter"
  | "video_url"

export type OutputFormat = 
  | "instagram_reels"
  | "instagram_story"
  | "instagram_carousel"
  | "tiktok"
  | "youtube_shorts"
  | "facebook_reels"
  | "linkedin_post"
  | "twitter_thread"
  | "email_snippet"
  | "blog_excerpt"
  | "quote_graphic"
  | "google_business_post"

export interface PipelineConfig {
  id?: string
  pipelineName: string
  sourceType: SourceType
  outputFormats: OutputFormat[]
  autoApprove?: boolean
  brandVoiceOverride?: string
  hashtagPresets?: string[]
}

// TOMBSTONE: `PipelineExecution` — DELETED as a stale second contract.
// SURVIVOR: the parameter type of `executePipeline`,
// lib/repurpose/actions.ts (`{ pipelineId, brokerageId, sourceType?, sourceId? }`).
//
// This interface described a run request that the live function does not take
// and must not take. Three of its six fields — `userId`, `teamId`,
// `agentUserId` — are ACTOR AND TENANT identity, and executePipeline resolves
// all three from the session through getAgentContext, precisely so a caller
// cannot name them: "Tenant comes from the SESSION. Never from a request body,
// never from a parameter" (CLAUDE.md §4). Keeping an exported contract that
// invites a caller to pass them is an invitation to reintroduce the IDOR shape.
//
// NOTHING WAS LOST. It had no writer, no reader and no importer: its only
// mention anywhere was a dead `import type` in lib/repurpose/actions.ts, the
// very file whose live signature contradicts it. `PipelineConfig` above did NOT
// share its fate — that one describes a pipeline DEFINITION, has no identity
// fields, and is now composed into createRepurposePipeline's signature.

export interface RepurposedOutput {
  outputType: OutputFormat
  outputRefTable: string
  outputRefId: string
  platform: string
  contentPreview: string
  status: "pending" | "approved" | "rejected" | "published" | "scheduled" | "skipped" | "failed"
}

export interface ExecutePipelineResult {
  success: boolean
  pipelineId?: string
  outputs?: RepurposedOutput[]
  error?: string
  blockedReason?: string
}

export interface SavePipelineResult {
  success: boolean
  pipelineId?: string
  error?: string
}

// Platform configuration for output formats
export const OUTPUT_FORMAT_CONFIG: Record<OutputFormat, {
  displayName: string
  platform: string
  maxDuration?: number
  aspectRatio?: string
  maxLength?: number
  outputTable: string
}> = {
  instagram_reels: { 
    displayName: "Instagram Reels", 
    platform: "instagram", 
    maxDuration: 90, 
    aspectRatio: "9:16",
    outputTable: "video_snippets"
  },
  instagram_story: { 
    displayName: "Instagram Story", 
    platform: "instagram", 
    maxDuration: 15, 
    aspectRatio: "9:16",
    outputTable: "video_snippets"
  },
  instagram_carousel: { 
    displayName: "Instagram Carousel", 
    platform: "instagram",
    maxLength: 2200,
    outputTable: "social_posts"
  },
  tiktok: { 
    displayName: "TikTok Video", 
    platform: "tiktok", 
    maxDuration: 120, 
    aspectRatio: "9:16",
    outputTable: "video_snippets"
  },
  youtube_shorts: { 
    displayName: "YouTube Shorts", 
    platform: "youtube", 
    maxDuration: 60, 
    aspectRatio: "9:16",
    outputTable: "video_snippets"
  },
  facebook_reels: { 
    displayName: "Facebook Reels", 
    platform: "facebook", 
    maxDuration: 90, 
    aspectRatio: "varies",
    outputTable: "video_snippets"
  },
  linkedin_post: { 
    displayName: "LinkedIn Post", 
    platform: "linkedin",
    maxLength: 3000,
    outputTable: "social_posts"
  },
  twitter_thread: { 
    displayName: "Twitter Thread", 
    platform: "twitter",
    maxLength: 280,
    outputTable: "social_posts"
  },
  email_snippet: { 
    displayName: "Email Snippet", 
    platform: "email",
    maxLength: 5000,
    outputTable: "email_snippets"
  },
  blog_excerpt: { 
    displayName: "Blog Excerpt", 
    platform: "blog",
    maxLength: 2000,
    outputTable: "blog_posts"
  },
  quote_graphic: {
    displayName: "Quote Graphic",
    platform: "social",
    outputTable: "graphics"
  },
  google_business_post: {
    displayName: "Google Business",
    platform: "google_business",
    maxLength: 1500,
    outputTable: "social_posts"
  }
}
