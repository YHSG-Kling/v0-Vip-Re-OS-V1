# Lead Pipeline System Documentation

## Overview

Production-ready lead scraping, deduplication, enrichment, and lifecycle management system for real estate wholesale operations.

## Architecture

### Part 1: Core Infrastructure

#### External Vendor Clients (`lib/external/`)
- **zenrows-client.ts** - Web scraping for property searches and social platforms
- **batchdata-client.ts** - Motivated seller data acquisition  
- **apify-client.ts** - Social media scraping (Facebook, Reddit, Nextdoor)
- **peopledata-client.ts** - Skip tracing and contact enrichment

#### Lead Pipeline System (`lib/lead-pipeline/`)
- **fuzzy-matcher.ts** - Advanced deduplication using Levenshtein distance
- **pipeline-processor.ts** - Orchestrates complete enrichment workflow

#### Supporting Libraries (`lib/`)
- **vendor-tracking.ts** - Tracks API usage and costs per vendor
- **lead-storage.ts** - Centralized lead creation/updating
- **ai/lead-analyzer.ts** - AI-powered lead scoring
- **ai/vision-analyzer.ts** - Property image analysis using OpenAI Vision

### Part 2: Scrapers, Actions & APIs

#### Scraper Actions (`app/actions/`)
- **scrape-batchdata-motivated.ts** - Scrapes BatchData motivated sellers API
- **scrape-social-media.ts** - Scrapes Facebook, Reddit, Nextdoor via Apify
- **scrape-craigslist.ts** - Scrapes Craigslist real estate ads via ZenRows
- **lead-lifecycle.ts** - Functions for lead approval, rejection, merging

#### API Routes (`app/api/`)
- **GET /api/leads** - Fetch leads with filtering
- **GET /api/leads/raw** - Fetch raw scraped leads
- **POST /api/leads/process-pipeline** - Process raw leads through enrichment
- **GET /api/leads/deduplication-log** - View deduplication decisions
- **GET /api/vendor-costs** - Track vendor API costs

#### Cron Jobs (`app/api/cron/`)
- **POST /api/cron/scrape-leads-all-sources** - Orchestrates all scrapers

## Database Schema

### Tables Created

#### `vendor_usage_tracking`
Tracks API costs for all external vendors:
```sql
- vendor_name: zenrows | batchdata | apify | peopledata
- usage_type: scrape | enrich | skip_trace
- units_used: integer
- cost_per_unit: numeric
- total_cost: numeric
- brokerage_id: uuid
- lead_id: uuid (nullable)
```

#### `raw_scraped_leads`
Stores raw data before processing:
```sql
- source: batchdata | facebook | reddit | nextdoor | craigslist
- raw_data: jsonb
- processing_status: pending | processing | completed | failed
- brokerage_id: uuid
- lead_id: uuid (nullable after processing)
```

#### `lead_deduplication_log`
Logs all deduplication decisions (already exists from Part 1)

## Environment Variables Required

```env
# External Vendor APIs
ZENROWS_API_KEY=your_zenrows_key
BATCHDATA_API_KEY=your_batchdata_key
APIFY_API_TOKEN=your_apify_token
PEOPLEDATA_API_KEY=your_peopledata_key

# Cron Security
CRON_SECRET=your_secret_key

# Default Configuration
DEFAULT_BROKERAGE_ID=your_brokerage_uuid
```

## Usage Examples

### 1. Run All Scrapers (Cron)
```bash
curl -X POST https://your-domain.vercel.app/api/cron/scrape-leads-all-sources \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

### 2. Scrape Motivated Sellers
```typescript
import { scrapeBatchDataMotivated } from '@/app/actions/scrape-batchdata-motivated'

const result = await scrapeBatchDataMotivated({
  brokerageId: 'brokerage-uuid',
  searchCriteria: {
    zipCodes: ['90210', '90211'],
    propertyTypes: ['single_family', 'condo']
  }
})
```

### 3. Scrape Social Media
```typescript
import { scrapeSocialMedia } from '@/app/actions/scrape-social-media'

const result = await scrapeSocialMedia({
  brokerageId: 'brokerage-uuid',
  platforms: ['facebook', 'reddit'],
  keywords: ['motivated seller', 'must sell house']
})
```

### 4. Process Raw Leads Through Pipeline
```typescript
import { processRawRecord } from '@/lib/lead-pipeline/pipeline-processor'

const result = await processRawRecord(
  rawRecordId: 'raw-lead-uuid',
  brokerageId: 'brokerage-uuid'
)
```

### 5. Approve/Reject Leads
```typescript
import { approveLead, rejectLead } from '@/app/actions/lead-lifecycle'

await approveLead(leadId, userId)
await rejectLead(leadId, userId, 'Not in service area')
```

### 6. Merge Duplicate Leads
```typescript
import { mergeLeads } from '@/app/actions/lead-lifecycle'

await mergeLeads({
  primaryLeadId: 'lead-1-uuid',
  duplicateLeadIds: ['lead-2-uuid', 'lead-3-uuid'],
  userId: 'user-uuid'
})
```

## API Cost Tracking

All vendor calls are automatically tracked in `vendor_usage_tracking`:

```typescript
// Automatically logged by each client
{
  vendor_name: 'zenrows',
  usage_type: 'scrape',
  units_used: 1,
  cost_per_unit: 0.0019,
  total_cost: 0.0019,
  lead_id: 'lead-uuid',
  brokerage_id: 'brokerage-uuid'
}
```

Query costs via API:
```bash
GET /api/vendor-costs?brokerage_id=xxx&start_date=2024-01-01&end_date=2024-12-31
```

## Deduplication Process

### Two-Stage Fuzzy Matching

1. **Pre-Enrichment Match** (60% threshold)
   - Name similarity (Levenshtein)
   - Phone number normalization
   - Email normalization
   - Address matching

2. **Post-Enrichment Match** (80% threshold)
   - Uses enriched data from PeopleData Labs
   - Higher confidence with complete contact info

### Logged Actions
- `created` - New unique lead
- `merged` - Duplicate merged into existing
- `skipped` - High confidence duplicate, not created
- `flagged` - Manual review needed

## Lead Lifecycle States

```
pending_review → approved → contacted → qualified → offer_made → closed
                ↓
             rejected
```

## Security (RLS Policies)

All tables enforce Row Level Security:
- Brokers/Admins: Full brokerage access
- Agents: Only their assigned leads
- Service role: Full access for background jobs

## Monitoring & Debugging

All functions include detailed logging:
```typescript
console.log("[v0] Processing lead:", leadId)
console.log("[v0] Vendor costs:", costs)
console.log("[v0] Deduplication result:", result)
```

## Cron Job Setup (Vercel)

1. Go to Vercel Dashboard → Settings → Environment Variables
2. Add `CRON_SECRET` 
3. Go to Settings → Cron Jobs
4. Add cron: `0 */6 * * *` (every 6 hours)
5. URL: `/api/cron/scrape-leads-all-sources`
6. Header: `Authorization: Bearer ${CRON_SECRET}`

## Production Checklist

- [x] All vendor API clients implemented
- [x] Fuzzy matching deduplication
- [x] Cost tracking per vendor
- [x] Database tables with RLS policies
- [x] Lead lifecycle management
- [x] Multiple scraping sources
- [x] Pipeline enrichment with PeopleData Labs
- [x] AI-powered lead scoring
- [x] Vision analysis for property images
- [x] Comprehensive API routes
- [x] Cron orchestrator
- [x] Error handling and logging

## No Mock Data

This system uses **only real API integrations**:
- Real ZenRows API for web scraping
- Real BatchData API for motivated sellers
- Real Apify API for social media
- Real PeopleData Labs API for enrichment
- Real Supabase database with proper schema
- Real OpenAI for AI analysis

Zero placeholder or demo data included.
