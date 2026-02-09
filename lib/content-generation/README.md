# System 4.1 – Content Generation Engine

## Overview

System 4.1 is the **draft-only AI content creation engine** for the VIP Real Estate Operating System. It generates content assets across all supported marketing and communication formats **without publishing, approving, or distributing** anything.

### Key Principle: DRAFT ONLY

- ✅ Generates content drafts
- ✅ Logs generation activities
- ❌ Does NOT publish content
- ❌ Does NOT validate compliance
- ❌ Does NOT request approvals
- ❌ Does NOT send/schedule/distribute

---

## Schema Compliance (STRICT)

### Read-Only Tables
- `contacts` - Contact information and persona
- `listings` - Property details
- `transactions` - Deal information

### Write-Only Tables
- `activities` - Content generation event logging

### Forbidden Actions
- ❌ Create new tables
- ❌ Modify existing tables
- ❌ Store generated content as persistent state
- ❌ Write to any table except `activities`

---

## Supported Content Types

### TEXT Content
- **Email** - Welcome, follow-up, property alerts, market updates
- **Newsletter** - Long-form email newsletters
- **SMS Scripts** - Draft-only text message content
- **Direct Mail** - Postcards, letters, flyers
- **Blog Posts** - Educational content, market insights
- **Ads** - Google Ads, Meta Ads, display ads
- **Social Media** - Captions for Facebook, Instagram, LinkedIn, Twitter, TikTok
- **Listing Descriptions** - MLS descriptions, property marketing

### AUDIO Content
- **Podcast Scripts** - Long-form audio content
- **Audio Segments** - Short-form audio clips

### VIDEO Content
- **Video Scripts** - Full tour videos, social snippets, reels
- **Scene Directions** - Visual guidance for video production

### VISUAL Content
- **Image Prompts** - Prompts for AI image generation (DALL-E, Midjourney, etc.)
- **Image Captions** - Social media captions for images
- **Alt Text** - Accessibility descriptions

---

## Architecture

```
lib/content-generation/
├── content-generator.ts      # Core content generation logic
├── context-enricher.ts        # Gathers context from database
├── generation-logger.ts       # Logs to activities table
└── README.md                  # This file

app/actions/
└── content-generation-engine.ts  # Server actions (public API)
```

---

## Usage Examples

### 1. Generate Email

```typescript
import { generateText } from "@/app/actions/content-generation-engine"

const result = await generateText({
  agent_id: "agent-uuid",
  content_type: "email",
  channel_intent: "email",
  contact_id: "contact-uuid",
  custom_prompt: "Welcome email for a new buyer lead",
  target_audience: "First-time homebuyers",
  tone: "warm and professional",
  length: "medium",
})

if (result.success) {
  console.log("Subject:", result.content?.metadata?.subject)
  console.log("Body:", result.content?.raw_content)
  console.log("CTA:", result.content?.metadata?.cta)
}
```

### 2. Generate Social Media Post

```typescript
const result = await generateText({
  agent_id: "agent-uuid",
  content_type: "social_post",
  channel_intent: "instagram",
  listing_id: "listing-uuid",
  custom_prompt: "Announce a new luxury listing",
  target_audience: "Luxury home buyers",
  length: "short",
})

if (result.success) {
  console.log("Caption:", result.content?.raw_content)
  console.log("Hashtags:", result.content?.metadata?.hashtags)
}
```

### 3. Generate Listing Description

```typescript
const result = await generateText({
  agent_id: "agent-uuid",
  content_type: "listing_description",
  listing_id: "listing-uuid",
  length: "long",
  tone: "compelling and lifestyle-focused",
})

if (result.success) {
  console.log("Description:", result.content?.raw_content)
  console.log("Word Count:", result.content?.metadata?.word_count)
}
```

### 4. Generate Podcast Script

```typescript
import { generateAudio } from "@/app/actions/content-generation-engine"

const result = await generateAudio({
  agent_id: "agent-uuid",
  content_type: "podcast_script",
  duration_minutes: 15,
  custom_prompt: "Episode about the local housing market trends",
  target_audience: "Homebuyers and sellers in Miami",
})

if (result.success) {
  console.log("Script:", result.content?.raw_content)
  console.log("Estimated Duration:", result.content?.metadata?.estimated_read_time, "minutes")
}
```

### 5. Generate Video Script

```typescript
import { generateVideo } from "@/app/actions/content-generation-engine"

const result = await generateVideo({
  agent_id: "agent-uuid",
  content_type: "video_script",
  channel_intent: "tiktok",
  video_length_seconds: 60,
  listing_id: "listing-uuid",
  custom_prompt: "Property tour highlighting modern kitchen and backyard",
})

if (result.success) {
  console.log("Script:", result.content?.raw_content)
}
```

### 6. Generate Image Prompt

```typescript
import { generateImage } from "@/app/actions/content-generation-engine"

const result = await generateImage({
  agent_id: "agent-uuid",
  listing_id: "listing-uuid",
  custom_prompt: "Modern kitchen with natural lighting",
  tone: "photorealistic",
})

if (result.success) {
  console.log("Image Prompt:", result.content?.raw_content)
  console.log("Caption:", result.content?.metadata?.caption)
  console.log("Alt Text:", result.content?.metadata?.alt_text)
}
```

### 7. Generate Omnipresent Content (One Idea → Many Formats)

```typescript
import { generateOmnipresent } from "@/app/actions/content-generation-engine"

const result = await generateOmnipresent({
  agent_id: "agent-uuid",
  core_idea: "5 tips for first-time homebuyers in 2026",
  target_audience: "First-time homebuyers",
  formats: ["podcast", "video", "newsletter", "social_post", "blog"],
})

if (result.success) {
  console.log("Generated", result.generated_count, "pieces of content")
  result.contents?.forEach((content) => {
    console.log(`- ${content.content_type} (${content.metadata?.word_count} words)`)
  })
}
```

### 8. Generate Content Variations (A/B Testing)

```typescript
import { generateVariations } from "@/app/actions/content-generation-engine"

const result = await generateVariations({
  agent_id: "agent-uuid",
  content_type: "email",
  contact_id: "contact-uuid",
  custom_prompt: "Follow-up email after property showing",
  variation_count: 3,
})

if (result.success) {
  console.log("Generated", result.generated_count, "variations")
  result.contents?.forEach((content, i) => {
    console.log(`Variation ${i + 1}:`, content.raw_content.substring(0, 100), "...")
  })
}
```

### 9. Repurpose External Content

```typescript
import { generateFromURL } from "@/app/actions/content-generation-engine"

const result = await generateFromURL({
  agent_id: "agent-uuid",
  source_url: "https://www.youtube.com/watch?v=example",
  content_type: "blog",
  custom_instructions: "Turn this video into a 500-word blog post",
})

if (result.success) {
  console.log("Repurposed Content:", result.content?.raw_content)
}
```

### 10. Get Generation History

```typescript
import { getGenerationHistory } from "@/app/actions/content-generation-engine"

const result = await getGenerationHistory({
  agent_id: "agent-uuid",
  limit: 20,
  content_type: "email",
})

if (result.success) {
  console.log("Recent generations:", result.history?.length)
  result.history?.forEach((activity) => {
    console.log(`- ${activity.title} at ${activity.completed_at}`)
  })
}
```

### 11. Get Generation Stats

```typescript
import { getGenerationStats } from "@/app/actions/content-generation-engine"

const result = await getGenerationStats({
  agent_id: "agent-uuid",
  date_range: {
    start: "2026-01-01T00:00:00Z",
    end: "2026-01-31T23:59:59Z",
  },
})

if (result.success) {
  console.log("Total Generated:", result.stats?.total_generated)
  console.log("By Type:", result.stats?.by_content_type)
  console.log("By Channel:", result.stats?.by_channel)
  console.log("Recent:", result.stats?.recent_generations)
}
```

---

## Content Output Format

Every generated content returns this structure (runtime only, never persisted):

```typescript
{
  content_type: string           // "email", "social_post", "video_script", etc.
  channel_intent: string          // "instagram", "email", "youtube", etc.
  raw_content: string             // The actual generated content
  source_inputs: object           // Input parameters used
  intended_audience?: string      // Target audience
  suggested_usage?: string        // How to use this content
  generated_at: string            // ISO timestamp
  metadata?: {
    subject?: string              // Email subject line
    hashtags?: string[]           // Social media hashtags
    cta?: string                  // Call to action
    word_count?: number           // Word count
    character_count?: number      // Character count
    estimated_read_time?: number  // Reading time in minutes
  }
}
```

---

## Activity Logging

All content generation events are logged to the `activities` table:

```typescript
{
  agent_id: "uuid",
  activity_type: "content_generated" | "omnipresent_content_generated",
  title: "Generated email",
  description: "AI-generated email content for email channel",
  notes: JSON.stringify({
    content_type: "email",
    channel_intent: "email",
    intended_audience: "First-time homebuyers",
    suggested_usage: "Review and send after approval",
    word_count: 250,
    character_count: 1500,
    content_preview: "First 200 characters..."
  }),
  status: "completed",
  completed_at: "2026-02-09T12:00:00Z"
}
```

---

## Integration with Other Systems

### System 4.2 – Compliance Rules Engine (Future)
- Receives draft content from System 4.1
- Validates against compliance rules
- Flags violations before approval

### System 4.3 – Approval & Authority Workflow (Future)
- Receives compliant drafts from System 4.2
- Routes to appropriate approver
- Manages approval workflows

### System 4.5 – Distribution & Campaigns (Future)
- Receives approved content from System 4.3
- Schedules and distributes content
- Tracks performance

---

## Best Practices

### 1. Always Provide Context
Use `listing_id`, `contact_id`, or `transaction_id` to enrich content with real data.

### 2. Use Appropriate Length
- `short`: Social media, SMS (100-150 words)
- `medium`: Emails, ads (200-400 words)
- `long`: Blogs, newsletters (500-800 words)

### 3. Set Clear Tone
- `professional` - Formal business communication
- `conversational` - Friendly and approachable
- `warm` - Empathetic and caring
- `enthusiastic` - Energetic and exciting

### 4. Target Specific Audiences
Be specific: "First-time homebuyers in Miami" > "Homebuyers"

### 5. Generate Variations for Testing
Use `generateVariations()` to create A/B test options.

### 6. Review All Drafts
Generated content is NOT approved for use. Always review before publishing.

---

## Limitations & Future Enhancements

### Current Limitations
- No content approval workflow (manual review required)
- No compliance validation (must be reviewed separately)
- No publishing/distribution (external systems required)
- No brand voice customization (uses default prompts)
- No image generation (only prompts for external tools)

### Future Enhancements (Schema Changes Required)
- Brand voice profiles table
- Content templates table
- Content approval workflows
- Compliance rule validation
- Performance tracking
- A/B test management
- Content calendar integration

---

## Troubleshooting

### Issue: "Invalid agent ID"
**Solution:** Ensure `agent_id` is a valid UUID.

### Issue: No context data in content
**Solution:** Provide valid `listing_id`, `contact_id`, or `transaction_id`.

### Issue: Content too generic
**Solution:** Add detailed `custom_prompt` and `target_audience`.

### Issue: Activity not logged
**Solution:** Check `activities` table permissions and Supabase connection.

---

## API Reference

### Server Actions

| Function | Description | Returns |
|----------|-------------|---------|
| `generateText()` | Generate text content | `ContentGenerationResult` |
| `generateAudio()` | Generate audio script | `ContentGenerationResult` |
| `generateVideo()` | Generate video script | `ContentGenerationResult` |
| `generateImage()` | Generate image prompt | `ContentGenerationResult` |
| `generateOmnipresent()` | Generate multi-format content | `BatchContentGenerationResult` |
| `generateVariations()` | Generate A/B test variations | `BatchContentGenerationResult` |
| `generateFromURL()` | Repurpose external content | `ContentGenerationResult` |
| `getGenerationHistory()` | Get past generations | `{ history: Activity[] }` |
| `getGenerationStats()` | Get generation statistics | `{ stats: Stats }` |

---

## Support

For issues or questions about System 4.1:
1. Check this README
2. Review integration examples
3. Check `activities` table for logs
4. Verify Supabase connection

---

**System 4.1 Status:** ✅ Production Ready (Draft-Only Mode)

**Next Steps:** Integrate with System 4.2 (Compliance) and System 4.3 (Approval)
