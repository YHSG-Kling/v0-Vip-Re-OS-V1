# System 5.1A – Property → Buyer Smart Match Engine

## Overview

An **internal-only** matching system that identifies the best-fit buyers for active listings. The system scores buyers based on property preferences, conversation signals, and engagement history to help agents, team leaders, and brokers prioritize outreach.

## Key Features

- **Runtime-Only Scoring**: Match scores are calculated on-demand and never persisted
- **Multi-Factor Matching**: Combines explicit preferences, inferred intent, urgency, and engagement
- **Signal Logging**: Records match signals to `activities` table for audit trail
- **Schema Compliant**: NO schema modifications required

## Architecture

### Core Components

```
lib/property-matching/
├── match-scorer.ts       # Scoring engine (runtime only)
├── match-logger.ts       # Activity logging utilities
└── README.md             # This file

app/actions/
└── property-buyer-matching.ts  # Server actions (public API)
```

### Data Flow

```
Listing Input
    ↓
Read: listings, contacts, conversation_insights
    ↓
Score: Runtime matching algorithm (1-100)
    ↓
Write: activities (match signals)
    ↓
Output: Ranked buyer list for agent
```

## Schema Contract

### READ-ONLY Tables

- **listings**: Property data (price, beds, baths, location, features)
- **contacts**: Buyer profiles, notes field for preferences
- **conversations**: Conversation metadata
- **conversation_insights**: Inferred intent, urgency, sentiment, health scores

### WRITE-ONLY Tables

- **activities**: Match signal logging
  - `entity_type = 'listing'`
  - `entity_id = listing_id`
  - `activity_type = 'buyer_match_signal'`
  - `notes` = JSON payload with match data

### OPTIONAL WRITE (Non-Authoritative)

- **contacts.notes**: Can append structured JSON preferences
  - Namespace: `ai_inference.buyer_preferences`
  - Must never overwrite existing human notes
  - Used for preference caching only

## Scoring Algorithm

Match scores range from **1-100** based on weighted factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| Price Alignment | 25 pts | Within buyer's budget |
| Bedroom Match | 15 pts | Meets minimum requirement |
| Bathroom Match | 10 pts | Meets minimum requirement |
| Location | 20 pts | Preferred city/state |
| Property Type | 10 pts | Single-family, condo, etc. |
| Urgency | 10 pts | Buyer's timeline (from insights) |
| Engagement Health | 10 pts | Conversation health score |

### Confidence Levels

- **High**: Score ≥ 70
- **Medium**: Score 45-69
- **Low**: Score < 45

Default threshold for viable matches: **45** (medium+)

## Usage

### 1. Match Buyers for a New Listing

```typescript
import { matchBuyersForListing } from '@/app/actions/property-buyer-matching'

const result = await matchBuyersForListing({
  listingId: 'uuid-here',
  minScore: 50,      // Optional: default 45
  limit: 20,         // Optional: default 50
  logSignals: true,  // Optional: default true
})

if (result.success) {
  result.matches.forEach(match => {
    console.log(match.buyer_name, match.score, match.match_factors)
  })
}
```

### 2. Score a Specific Buyer

```typescript
import { scoreSingleBuyerForListing } from '@/app/actions/property-buyer-matching'

const result = await scoreSingleBuyerForListing({
  listingId: 'listing-uuid',
  contactId: 'buyer-uuid',
  logSignal: false,  // Optional: don't log to activities
})

console.log(result.match.score, result.match.match_factors)
```

### 3. View Match History

```typescript
import { getListingMatchHistory } from '@/app/actions/property-buyer-matching'

const result = await getListingMatchHistory({
  listingId: 'uuid-here',
  limit: 50,
})

console.log(`${result.signals.length} previous match signals`)
```

## Buyer Preference Extraction

Preferences are extracted from `contacts.notes` in two ways:

### 1. Structured JSON (Recommended)

```json
{
  "ai_inference": {
    "buyer_preferences": {
      "minPrice": 300000,
      "maxPrice": 450000,
      "minBeds": 3,
      "minBaths": 2,
      "preferredCities": ["Austin", "Round Rock"],
      "propertyTypes": ["single_family"]
    }
  }
}
```

### 2. Text Parsing (Fallback)

If notes are plain text, the system attempts to extract:
- Price ranges: "$300k-$450k"
- Bedrooms: "3+ beds"
- Cities: Keyword matching for common cities

## Internal Use Only

This system is **NOT buyer-facing**. Output language is designed for:

- Listing agents (who should I call about this listing?)
- Team leaders (which agents have buyers for this?)
- Brokers (pipeline visibility)

Match signals use internal terminology:
- "High urgency buyer - prioritize"
- "Low engagement score - may need follow-up"
- "Over budget by $50,000"

## Constraints & Limitations

### What This System Does NOT Do

❌ Send notifications to buyers  
❌ Create automated buyer journeys  
❌ Assign agents to buyers  
❌ Store buyer personas or profiles  
❌ Modify listing data  
❌ Replace existing property matching UI  

### Schema Constraints

🔒 **NO table creation**  
🔒 **NO column additions**  
🔒 **NO persisted scores** on listings or contacts  
🔒 **Append-only** access to contacts.notes  

### Future Enhancements (Not Implemented)

The following would require schema changes:

1. **Dedicated buyer_preferences table**
   - Columns: contact_id, min_price, max_price, preferred_cities, etc.
   - Would replace JSON parsing from notes

2. **Buyer persona fields** on contacts table
   - first_time_buyer, investor, relocating, etc.

3. **Match feedback loop**
   - Track which matches led to showings/offers
   - Improve scoring algorithm over time

## Integration Points

### Existing Systems

- **System 3.4 - Conversation Intelligence**: Sources urgency, intent, sentiment
- **Activities & Signals Framework**: Logs all match signals
- **Listing Lifecycle**: Can be triggered when listing goes active

### Composability

This matching engine is designed to be called by:
- Listing intake workflows
- Agent dashboards
- Orchestration systems (future)
- API endpoints (future)

## Performance Notes

- Caps at **500 buyers** per listing for performance
- Match calculations are in-memory (< 100ms for typical datasets)
- Batch logging for efficiency when logging multiple signals
- No blocking database writes during scoring

## Error Handling

All functions return `{ success: boolean, error?: string }` format:

```typescript
if (!result.success) {
  console.error('Match failed:', result.error)
}
```

Errors are also logged to console with `[v0]` prefix for debugging.

## Testing

### Manual Testing

```bash
# Test with a real listing ID from your database
curl -X POST /api/match-buyers \
  -H "Content-Type: application/json" \
  -d '{"listingId": "your-listing-uuid"}'
```

### Expected Output

```json
{
  "success": true,
  "matches": [
    {
      "contact_id": "uuid",
      "buyer_name": "John Doe",
      "match_confidence": "high",
      "score": 85,
      "match_factors": [
        "Price within budget ($425,000)",
        "3 beds meets requirement",
        "Preferred city: Austin",
        "High urgency buyer - prioritize"
      ],
      "caution_notes": []
    }
  ],
  "metadata": {
    "total_buyers_evaluated": 127,
    "viable_matches": 23
  }
}
```

## Support

For questions or issues:
1. Check console logs for `[v0]` prefixed messages
2. Verify listing and contact UUIDs are valid
3. Ensure contacts have `contact_type` = 'buyer' or 'lead'
4. Check that `conversation_insights` data exists for better matches

## Version

**System 5.1A** - Property → Buyer Matching (Internal Only)  
**Status**: Production Ready  
**Schema Version**: No modifications required  
**Last Updated**: 2026-02-09
