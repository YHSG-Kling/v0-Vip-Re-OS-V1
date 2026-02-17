# System 5.1B – Buyer-Initiated Search & Smart Match

## Overview

**System 5.1B** enables buyers to search for properties using natural language queries. The system translates buyer intent into smart property matches and returns buyer-persona-aware explanations—all without modifying the database schema or persisting profiles.

This is the **buyer-facing complement** to System 5.1A (agent-facing property→buyer matching).

## Key Principles

1. **Natural Language First**: Buyers search in plain English ("3 bed house under $400k in Austin")
2. **Runtime Intelligence**: All parsing, scoring, and persona inference happen at runtime—nothing persisted
3. **Buyer-Friendly Explanations**: No mention of AI, scores, or internal algorithms
4. **Persona-Aware**: Tone and focus adapt to inferred buyer type (first-time, investor, relocating, etc.)
5. **Schema Compliant**: Zero schema modifications, reads from existing tables only

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Buyer Input: "Looking for 3 bed house under $400k"    │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  1. INTENT PARSER (intent-parser.ts)                    │
│     - Extract price, beds, location, features           │
│     - Flag ambiguities                                   │
│     - Calculate parse confidence                         │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  2. CONTEXT ENRICHMENT                                   │
│     - Merge with conversation_insights                   │
│     - Apply existing preferences from contacts.notes     │
│     - Boost confidence with historical data              │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  3. PERSONA INFERENCE (persona-inference.ts)            │
│     - Detect: first-time, investor, relocation, etc.    │
│     - Determine tone: educational, analytical, warm      │
│     - Define focus areas                                 │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  4. LISTING QUERY                                        │
│     - Build SQL filters from intent                      │
│     - Fetch active listings from database                │
│     - Apply hard constraints (price, beds, location)     │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  5. RUNTIME SCORING (reuses match-scorer from 5.1A)     │
│     - Score each listing 1-100                           │
│     - Filter by minimum threshold                        │
│     - Sort by best match                                 │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  6. EXPLANATION GENERATOR (explanation-generator.ts)    │
│     - Create headline, bullets, narrative                │
│     - Adapt to buyer persona                             │
│     - Use second-person language                         │
│     - Suggest next action                                │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  7. SIGNAL LOGGING (search-logger.ts)                   │
│     - Log to activities table                            │
│     - Append preferences to contacts.notes (optional)    │
│     - Create audit trail                                 │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Return: Ranked properties with buyer-friendly reasons  │
└─────────────────────────────────────────────────────────┘
```

---

## Schema Usage

### READ ONLY Tables

| Table | Fields Used | Purpose |
|-------|-------------|---------|
| `listings` | id, price, bedrooms, bathrooms, city, state, property_type, features, status | Property inventory |
| `contacts` | id, first_name, last_name, notes, created_at | Buyer profile |
| `conversation_insights` | inferred_intent, urgency_level, sentiment, health_score | Contextual signals |

### WRITE ONLY Tables

| Table | Fields Written | Purpose |
|-------|----------------|---------|
| `activities` | entity_type='contact', entity_id=contact_id, activity_type='buyer_search_match', notes (JSON payload) | Audit trail of searches |
| `contacts.notes` (optional) | JSON append to `ai_inference.search` namespace | Non-authoritative preference cache |

### NO Schema Modifications

- No new tables
- No new columns
- No buyer_preferences table (inferred at runtime)
- No search_history table (logged as activities)
- No persona fields (computed on-the-fly)

---

## Server Actions

### Primary: `searchPropertiesWithNaturalLanguage()`

**Purpose**: Main buyer search endpoint

**Input**:
```typescript
{
  contactId: string // UUID of authenticated buyer
  naturalLanguageQuery: string // Free-text search
  options?: {
    limit?: number // Max results (default 20)
    minScore?: number // Internal threshold (default 40)
    logSignals?: boolean // Log to activities (default true)
    includeDebugInfo?: boolean // Expose persona/intent (default false)
  }
}
```

**Output**:
```typescript
{
  success: boolean
  results: BuyerSearchResult[] // Ranked matches with explanations
  metadata: {
    total_listings_evaluated: number
    results_returned: number
    search_confidence: number // 0-1
  }
}
```

**Example**:
```typescript
import { searchPropertiesWithNaturalLanguage } from '@/app/actions/buyer-property-search'

const result = await searchPropertiesWithNaturalLanguage({
  contactId: 'buyer-uuid-here',
  naturalLanguageQuery: 'Looking for 3+ bedroom house under $450k in Austin with a pool',
  options: { limit: 15 }
})

// result.results[0] = {
//   listing_id: '...',
//   headline: 'Excellent starter home in Austin',
//   bullets: [
//     'Priced at $425K – within your budget',
//     '3 bedrooms for your growing family',
//     'Austin location matches your search',
//     'Features: pool, garage, updated kitchen'
//   ],
//   narrative: 'Based on what you\'re looking for, this single-family home in Austin offers...',
//   callToAction: 'Schedule a tour to see if it feels like home',
//   price: 425000,
//   bedrooms: 3,
//   city: 'Austin',
//   ...
// }
```

---

### Secondary: `explainPropertyMatchForBuyer()`

**Purpose**: Explain why a specific listing was recommended

**Input**:
```typescript
{
  contactId: string
  listingId: string
  context?: string // Optional buyer question
}
```

**Output**:
```typescript
{
  success: boolean
  explanation: {
    headline: string
    bullets: string[]
    narrative: string
    callToAction: string
  }
  listing: { /* basic listing info */ }
  match_quality: 'low' | 'medium' | 'high'
}
```

---

### Utility: `previewSearchIntent()`

**Purpose**: Show buyer what we understood from their query (before executing search)

**Input**:
```typescript
{
  contactId: string
  naturalLanguageQuery: string
}
```

**Output**:
```typescript
{
  success: boolean
  preview: {
    understood: {
      price_range: string
      bedrooms: string
      location: string
      property_type: string
      features: string
    }
    confidence: number
    ambiguities: string[]
    persona_match: BuyerPersona
  }
}
```

---

## Buyer Personas

The system dynamically infers buyer type from search intent and conversation signals:

| Persona | Indicators | Tone | Focus Areas |
|---------|-----------|------|-------------|
| **first_time_buyer** | "first home", "starter", budget <$300k, family signals | Educational | Neighborhood, affordability, schools, safety |
| **investor** | "investment", "rental", "cash flow", "ROI" | Analytical | Cap rate, rental potential, price/sqft, appreciation |
| **relocation** | "moving to", "relocating", "transfer", high urgency | Professional | Commute, amenities, move-in ready, neighborhood info |
| **downsizer** | "downsize", "retirement", "empty nest", 1-2 beds, single-story | Warm | Low maintenance, accessibility, community, walkability |
| **luxury_buyer** | Budget >$1M, "luxury", "high-end", many features | Sophisticated | Exclusivity, premium finishes, privacy, prestige |
| **move_up_buyer** | "upgrade", "larger home" (from conversation context) | Professional | More space, upgraded features, schools, resale value |
| **bargain_hunter** | "deal", "bargain", "fixer", "below market" | Direct | Value, price reductions, potential, negotiation |
| **undetermined** | Insufficient signals | Neutral/Warm | Location, price, features, neighborhood |

**Key Rule**: Personas are **NOT persisted**—they're inferred at runtime and used only to tailor explanation language.

---

## Natural Language Parsing

### Supported Query Patterns

**Price**:
- "$400k", "$400,000"
- "under 500k", "below 400k", "max 450k"
- "300k-400k", "budget of 350000"
- "around 350k"

**Bedrooms**:
- "3 bed", "4+ bedroom", "3-4 beds"
- "at least 3 bedrooms"

**Bathrooms**:
- "2 bath", "2.5 bathrooms"
- "3+ baths"

**Location**:
- City names: "Austin", "Dallas", "Portland"
- State: "TX", "California", "FL"
- Neighborhoods (extracted if mentioned)

**Property Type**:
- "house", "condo", "townhouse", "apartment"
- "single family", "multi-family", "duplex"

**Features**:
- "pool", "garage", "backyard", "fireplace"
- "hardwood", "granite", "updated kitchen"
- "walk-in closet", "office", "bonus room"

**Urgency**:
- High: "asap", "urgent", "immediately", "soon"
- Medium: "next month", "within", "by [date]"
- Low: "browsing", "exploring", "just started"

**Lifestyle**:
- Family: "family", "kids", "schools", "playground"
- Professional: "commute", "downtown", "walkable", "transit"
- Retiree: "retirement", "quiet", "peaceful", "single story"
- Investor: "investment", "rental", "cash flow"

---

## Match Scoring

Reuses **System 5.1A match-scorer.ts** with the same factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| Price Alignment | 25 pts | Listing price vs. buyer budget |
| Bedroom Match | 15 pts | Meets minimum bedroom requirement |
| Bathroom Match | 10 pts | Meets minimum bathroom requirement |
| Location | 20 pts | Preferred city/state match |
| Property Type | 10 pts | Single-family, condo, townhouse, etc. |
| Urgency | 10 pts | High urgency buyers prioritized |
| Engagement Health | 10 pts | Based on conversation_insights.health_score |

**Confidence Levels**:
- **High**: 70+ points
- **Medium**: 45-69 points
- **Low**: <45 points

**Default Threshold**: 40 points (adjustable via `minScore` option)

---

## Buyer-Friendly Explanations

### Rules

1. **Second-Person Language**: Use "you" and "your" (not "buyer" or "they")
2. **Reference Their Input**: "Based on what you're looking for..."
3. **No Internal Logic**: Never mention AI, algorithms, scores, matching engines
4. **Persona-Aware Tone**: Educational for first-timers, analytical for investors, etc.
5. **Natural Language**: Write as a human agent would explain

### Example Output

**For First-Time Buyer**:
```
Headline: Excellent starter home in Austin
Bullets:
  - Priced at $320K – within your budget
  - 3 bedrooms for your growing family
  - In your preferred area: Austin
  - Features: updated kitchen, garage, backyard
  - Available now – move-in ready

Narrative: Based on what you're looking for, this single-family home in Austin 
offers everything you need to confidently start homeownership. It's move-in ready 
and positioned in a neighborhood that's perfect for building your future.

Call to Action: Schedule a tour to see if it feels like home
```

**For Investor**:
```
Headline: High-potential investment in Dallas
Bullets:
  - Listed at $180K, below your target threshold
  - 3 beds – strong rental appeal
  - Dallas location matches your search
  - 1,200 sq ft at $150/sq ft

Narrative: Based on what you're looking for, this multi-family property in Dallas 
presents a solid investment opportunity. The fundamentals are strong, and the area 
shows consistent demand.

Call to Action: Request detailed financials and comparable sales
```

---

## Signal Logging

All buyer searches create audit records in the `activities` table:

**Activity Record**:
```json
{
  "entity_type": "contact",
  "entity_id": "buyer-uuid",
  "activity_type": "buyer_search_match",
  "title": "Property Match: HIGH",
  "description": "Matched listing abc-123 via natural language search",
  "notes": {
    "listing_id": "abc-123",
    "confidence_level": "high",
    "inferred_focus": "affordability, neighborhood, safety",
    "persona_detected": "first_time_buyer",
    "generated_at": "2024-01-15T10:30:00Z"
  },
  "status": "completed",
  "created_at": "2024-01-15T10:30:00Z"
}
```

**Optional: contacts.notes Append**:
```json
{
  "ai_inference": {
    "search": {
      "last_search_at": "2024-01-15T10:30:00Z",
      "recent_intent": {
        "price_range": { "max": 400000 },
        "min_beds": 3,
        "cities": ["Austin"],
        "features": ["pool", "garage"]
      },
      "inferred_persona": {
        "type": "first_time_buyer",
        "confidence": 0.85,
        "last_updated": "2024-01-15T10:30:00Z"
      }
    }
  }
}
```

**Important**: `contacts.notes` appending is **non-authoritative**—it's an inference cache only, never treated as ground truth.

---

## Integration Examples

### 1. Buyer Portal Search Bar

```tsx
'use client'

import { useState } from 'react'
import { searchPropertiesWithNaturalLanguage } from '@/app/actions/buyer-property-search'

export function BuyerSearchBar({ contactId }: { contactId: string }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)

  async function handleSearch() {
    setLoading(true)
    const response = await searchPropertiesWithNaturalLanguage({
      contactId,
      naturalLanguageQuery: query,
      options: { limit: 20 }
    })

    if (response.success) {
      setResults(response.results)
    }
    setLoading(false)
  }

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Try: 3 bed house under $400k in Austin"
      />
      <button onClick={handleSearch} disabled={loading}>
        {loading ? 'Searching...' : 'Search'}
      </button>

      {results.map((result) => (
        <div key={result.listing_id}>
          <h3>{result.headline}</h3>
          <p>{result.narrative}</p>
          <ul>
            {result.bullets.map((bullet, i) => <li key={i}>{bullet}</li>)}
          </ul>
          <button>{result.callToAction}</button>
        </div>
      ))}
    </div>
  )
}
```

### 2. Chatbot Integration

```typescript
// In your AI chatbot handler
async function handleBuyerMessage(contactId: string, message: string) {
  // Detect if message is a search query
  if (isSearchIntent(message)) {
    const result = await searchPropertiesWithNaturalLanguage({
      contactId,
      naturalLanguageQuery: message,
      options: { limit: 5 }
    })

    if (result.success && result.results.length > 0) {
      return {
        type: 'property_recommendations',
        message: `I found ${result.results.length} properties that match:`,
        properties: result.results
      }
    } else {
      return {
        type: 'no_results',
        message: 'No properties match those criteria. Want to adjust your search?'
      }
    }
  }
}
```

### 3. Intent Preview (Clarification UI)

```tsx
'use client'

import { previewSearchIntent } from '@/app/actions/buyer-property-search'

export function SearchPreview({ contactId, query }: { contactId: string, query: string }) {
  const [preview, setPreview] = useState(null)

  async function showPreview() {
    const response = await previewSearchIntent({ contactId, naturalLanguageQuery: query })
    if (response.success) {
      setPreview(response.preview)
    }
  }

  return (
    <div>
      {preview && (
        <div>
          <h4>Here's what I understood:</h4>
          <ul>
            <li>Price: {preview.understood.price_range}</li>
            <li>Bedrooms: {preview.understood.bedrooms}</li>
            <li>Location: {preview.understood.location}</li>
          </ul>
          {preview.ambiguities.length > 0 && (
            <p>Could you clarify: {preview.ambiguities.join(', ')}</p>
          )}
        </div>
      )}
    </div>
  )
}
```

---

## Troubleshooting

### Low confidence scores

**Symptom**: `search_confidence` < 0.5
**Cause**: Ambiguous query, missing key details
**Fix**: Use `previewSearchIntent()` to show what was understood, prompt buyer to clarify

### No results returned

**Symptom**: `results_returned: 0`
**Cause**: Query too restrictive, no matching listings in database
**Fix**: Relax `minScore` threshold, suggest alternative locations/price ranges

### Wrong persona detected

**Symptom**: Investor tone for first-time buyer
**Cause**: Insufficient conversation history
**Fix**: Build conversation_insights over time, use explicit signals ("first home", "investment")

### Listings not matching intent

**Symptom**: Results don't align with query
**Cause**: Intent parser missed constraints
**Fix**: Check `includeDebugInfo: true` to see parsed intent, improve parser patterns

---

## Future Enhancements

When schema changes are allowed:

1. **saved_searches table**: Persist buyer searches for notifications
2. **buyer_preferences table**: Store authoritative preferences
3. **search_history table**: Detailed search analytics
4. **listing_views table**: Track which listings buyer clicked
5. **favorite_listings table**: Buyer saves/favorites

For now, these are logged as **activities** only.

---

## Testing

See `/lib/buyer-search/__tests__/` for unit tests:

```bash
npm test lib/buyer-search
```

Tests cover:
- Intent parsing edge cases
- Persona inference accuracy
- Explanation generation
- Context merging logic

---

## Related Systems

- **System 5.1A**: Property→Buyer matching (agent-facing)
- **System 3.4**: Conversation Intelligence (provides buyer signals)
- **Future System 5.2**: Listing lifecycle management

---

## Support

For questions or issues:
1. Check this README
2. Review integration examples
3. Inspect debug output: `includeDebugInfo: true`
4. Check activities table for audit trail
