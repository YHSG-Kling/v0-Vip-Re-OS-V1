# System 5.1A - Future Schema Enhancements

This document outlines schema improvements that would enhance the Property → Buyer Smart Match Engine once schema modifications are permitted.

---

## Current Limitations

As of implementation date (2026-02-09), the system operates under strict constraints:

- ❌ **NO** dedicated buyer preferences table
- ❌ **NO** match score persistence
- ❌ **NO** buyer persona fields on contacts
- ❌ **NO** match feedback tracking
- ✅ **Uses** JSON parsing from `contacts.notes` (non-authoritative)
- ✅ **Logs** match signals to `activities` table only

---

## Proposed Enhancement #1: Buyer Preferences Table

### Problem

Currently, buyer preferences are stored in `contacts.notes` as unstructured JSON. This makes querying, filtering, and updating preferences inefficient.

### Solution

Create a dedicated `buyer_preferences` table with structured fields.

```sql
CREATE TABLE buyer_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  
  -- Price Range
  min_price NUMERIC,
  max_price NUMERIC,
  
  -- Property Specs
  min_beds INTEGER,
  max_beds INTEGER,
  min_baths NUMERIC,
  max_baths NUMERIC,
  min_sqft INTEGER,
  max_sqft INTEGER,
  
  -- Location
  preferred_cities TEXT[],
  preferred_states TEXT[],
  preferred_zips TEXT[],
  excluded_cities TEXT[],
  
  -- Property Types
  property_types TEXT[], -- ['single_family', 'condo', 'townhouse']
  
  -- Features
  must_haves TEXT[], -- ['pool', 'garage', 'yard']
  nice_to_haves TEXT[],
  deal_breakers TEXT[], -- ['hoa', 'busy_street']
  
  -- Metadata
  source TEXT, -- 'manual', 'ai_inference', 'conversation'
  confidence NUMERIC, -- 0-1 confidence in these preferences
  last_updated_by UUID REFERENCES users(id),
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(contact_id)
);

CREATE INDEX idx_buyer_prefs_price ON buyer_preferences(min_price, max_price);
CREATE INDEX idx_buyer_prefs_beds ON buyer_preferences(min_beds);
CREATE INDEX idx_buyer_prefs_cities ON buyer_preferences USING GIN(preferred_cities);
```

### Migration Path

1. Parse existing `contacts.notes` JSON to extract preferences
2. Bulk insert into new table
3. Update `match-scorer.ts` to query table instead of parsing JSON
4. Add UI for agents to manually edit preferences

### Benefits

- ✅ Faster querying: "Find all buyers looking for 3+ beds in Austin under $500k"
- ✅ Data integrity: Type-safe fields instead of free-form JSON
- ✅ Easier updates: Direct UPDATE queries instead of JSON manipulation
- ✅ Better indexing: Postgres can optimize GIN indexes on arrays

---

## Proposed Enhancement #2: Match Score Persistence

### Problem

Match scores are ephemeral (runtime-only). Historical trends and score changes over time are lost.

### Solution

Create a `property_matches` table to store match results.

```sql
CREATE TABLE property_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  
  -- Match Data
  match_score INTEGER NOT NULL CHECK (match_score BETWEEN 0 AND 100),
  match_confidence TEXT NOT NULL CHECK (match_confidence IN ('low', 'medium', 'high')),
  match_factors JSONB, -- Array of reasons
  caution_notes JSONB, -- Array of concerns
  
  -- Metadata
  generated_by TEXT DEFAULT 'ai', -- 'ai', 'manual'
  algorithm_version TEXT DEFAULT '1.0',
  
  -- Engagement Tracking (Future)
  viewed_at TIMESTAMPTZ,
  contacted_at TIMESTAMPTZ,
  showing_scheduled_at TIMESTAMPTZ,
  offer_submitted_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(listing_id, contact_id, created_at::date) -- One match per listing-buyer per day
);

CREATE INDEX idx_matches_listing ON property_matches(listing_id);
CREATE INDEX idx_matches_contact ON property_matches(contact_id);
CREATE INDEX idx_matches_score ON property_matches(match_score DESC);
CREATE INDEX idx_matches_confidence ON property_matches(match_confidence);
```

### Benefits

- ✅ Track score trends over time (did score improve as preferences clarified?)
- ✅ Measure match-to-conversion rates
- ✅ A/B test different scoring algorithms
- ✅ Generate analytics: "Which factors lead to closed deals?"

### Usage Example

```typescript
// Store match results
await supabase.from('property_matches').upsert({
  listing_id: 'uuid',
  contact_id: 'uuid',
  match_score: 85,
  match_confidence: 'high',
  match_factors: ['price', 'location', 'urgency'],
  caution_notes: [],
})

// Query historical matches
const { data } = await supabase
  .from('property_matches')
  .select('*')
  .eq('listing_id', listingId)
  .gte('match_score', 70)
  .order('match_score', { ascending: false })
```

---

## Proposed Enhancement #3: Buyer Persona Fields

### Problem

Buyer personas (first-time buyer, investor, relocating) affect matching but aren't captured.

### Solution

Add persona fields to `contacts` table.

```sql
ALTER TABLE contacts
ADD COLUMN buyer_persona TEXT CHECK (buyer_persona IN (
  'first_time_buyer',
  'upgrader',
  'downsizer',
  'investor',
  'relocating',
  'vacation_home',
  'multi_gen'
)),
ADD COLUMN buyer_motivation TEXT[], -- ['schools', 'job_relocation', 'investment']
ADD COLUMN timeline_urgency TEXT CHECK (timeline_urgency IN ('immediate', '1-3_months', '3-6_months', '6-12_months', 'flexible')),
ADD COLUMN financing_status TEXT CHECK (financing_status IN ('cash', 'pre_approved', 'pre_qualified', 'not_started'));

CREATE INDEX idx_contacts_persona ON contacts(buyer_persona);
CREATE INDEX idx_contacts_urgency ON contacts(timeline_urgency);
```

### Enhanced Scoring

```typescript
// Add persona-specific scoring logic
if (buyer.buyer_persona === 'investor') {
  // Investors prioritize ROI, not school districts
  score += analyzeROIPotential(listing)
}

if (buyer.buyer_persona === 'first_time_buyer') {
  // First-timers may need more hand-holding
  cautionNotes.push('First-time buyer - plan extra time for education')
}
```

---

## Proposed Enhancement #4: Match Feedback Loop

### Problem

No way to track which matches led to successful outcomes (showings, offers, closings).

### Solution

Create a `match_outcomes` table.

```sql
CREATE TABLE match_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES property_matches(id) ON DELETE CASCADE,
  
  outcome_type TEXT NOT NULL CHECK (outcome_type IN (
    'contacted',
    'showed',
    'offered',
    'closed',
    'rejected_by_buyer',
    'rejected_by_seller',
    'expired'
  )),
  
  outcome_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  recorded_by UUID REFERENCES users(id),
  
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_outcomes_match ON match_outcomes(match_id);
CREATE INDEX idx_outcomes_type ON match_outcomes(outcome_type);
```

### Machine Learning Potential

With outcome tracking, the system can learn:

- Which match factors correlate with closed deals
- Optimal score thresholds for different personas
- Time-to-close predictions based on initial score

```typescript
// Analyze conversion rates
const conversionRate = await supabase.rpc('calculate_match_conversion', {
  min_score: 70,
  persona: 'first_time_buyer'
})

console.log(`70+ score buyers close ${conversionRate}% of the time`)
```

---

## Proposed Enhancement #5: Smart Notifications

### Problem

Agents are not automatically notified when high-value matches occur.

### Solution

Create a `match_notifications` table and notification rules.

```sql
CREATE TABLE match_notification_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  
  -- Trigger Conditions
  min_match_score INTEGER DEFAULT 70,
  notify_on_confidence TEXT[] DEFAULT ARRAY['high'], -- ['high', 'medium']
  notify_on_urgency TEXT[] DEFAULT ARRAY['high'],
  
  -- Notification Channels
  send_email BOOLEAN DEFAULT TRUE,
  send_sms BOOLEAN DEFAULT FALSE,
  send_push BOOLEAN DEFAULT TRUE,
  
  -- Frequency Controls
  max_notifications_per_day INTEGER DEFAULT 5,
  quiet_hours_start TIME,
  quiet_hours_end TIME,
  
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Workflow

```typescript
// After generating matches
if (match.score >= agent.notification_threshold) {
  await sendNotification(agent.id, {
    type: 'high_confidence_match',
    listing_id: listingId,
    buyer_name: match.buyer_name,
    score: match.score,
  })
}
```

---

## Proposed Enhancement #6: Geo-Spatial Matching

### Problem

Current location matching is city-name-based. Buyers may have radius preferences.

### Solution

Add PostGIS support and geo-fencing.

```sql
-- Add to buyer_preferences
ALTER TABLE buyer_preferences
ADD COLUMN preferred_locations GEOGRAPHY(POINT),
ADD COLUMN search_radius_miles NUMERIC DEFAULT 10;

-- Add to listings
ALTER TABLE listings
ADD COLUMN location GEOGRAPHY(POINT);

-- Create spatial index
CREATE INDEX idx_listings_location ON listings USING GIST(location);
```

### Usage

```sql
-- Find buyers within 15 miles of a listing
SELECT bp.contact_id
FROM buyer_preferences bp
WHERE ST_DWithin(
  bp.preferred_locations,
  (SELECT location FROM listings WHERE id = :listing_id),
  15 * 1609.34 -- 15 miles to meters
);
```

---

## Proposed Enhancement #7: Multi-Listing Matching

### Problem

System only matches one listing at a time. Agents may want to see "top buyers across all my listings."

### Solution

Batch matching endpoints and aggregate views.

```typescript
// New function: rankBuyersAcrossListings
export async function rankBuyersAcrossListings(params: {
  listingIds: string[]
  minScore?: number
  limit?: number
}) {
  // Score each buyer against all listings
  // Return aggregated "hottest buyers" list
}
```

### Use Case

Team leader dashboard:
- "Show me the top 20 buyers across our 47 active listings"
- "Which buyers match multiple listings (strong intent signal)?"

---

## Proposed Enhancement #8: External Data Enrichment

### Problem

Matching is limited to data in our database. External data could improve accuracy.

### Solution

Integrate with:

- **MLS data**: Historical property views, saved searches
- **Credit bureaus**: Pre-approval amounts
- **Zillow/Redfin APIs**: Buyer behavior signals
- **Social media**: Public intent signals

```typescript
// Hypothetical integration
const enrichedScore = baseScore + getMLSEngagementBoost(buyer.mlsId, listing.mlsNumber)
```

---

## Implementation Priority

### Phase 1 (High Impact, Low Complexity)

1. **Buyer Preferences Table** - Most critical for performance
2. **Match Feedback Loop** - Essential for learning
3. **Buyer Persona Fields** - Easy to add, high value

### Phase 2 (Medium Impact, Medium Complexity)

4. **Match Score Persistence** - Needed for analytics
5. **Smart Notifications** - Quality of life improvement

### Phase 3 (High Impact, High Complexity)

6. **Geo-Spatial Matching** - Requires PostGIS expertise
7. **Multi-Listing Matching** - Architectural changes
8. **External Data Enrichment** - Depends on integrations

---

## Migration Strategy

When schema enhancements are approved:

### 1. Additive Changes First

Add new tables without modifying existing:
- ✅ `buyer_preferences`
- ✅ `property_matches`
- ✅ `match_outcomes`

### 2. Dual-Write Period

Update code to write to both old (notes) and new (table) locations:

```typescript
// Write to both during transition
await appendBuyerPreferenceInference(contactId, prefs) // Old way
await supabase.from('buyer_preferences').upsert(prefs) // New way
```

### 3. Data Migration

Batch process existing `contacts.notes` to extract preferences:

```typescript
const { data: contacts } = await supabase
  .from('contacts')
  .select('id, notes')
  .not('notes', 'is', null)

for (const contact of contacts) {
  const prefs = extractBuyerPreferences(contact.notes)
  if (prefs.maxPrice) {
    await supabase.from('buyer_preferences').insert({
      contact_id: contact.id,
      ...prefs,
      source: 'migration',
      confidence: 0.7,
    })
  }
}
```

### 4. Switch to New System

Update `match-scorer.ts` to query table instead of parsing notes.

### 5. Remove Fallback Code

After confirming stability, remove old JSON parsing logic.

---

## Backward Compatibility

All enhancements should maintain backward compatibility:

- ✅ Old code continues to work (reads from notes)
- ✅ New code prefers table data, falls back to notes
- ✅ Gradual cutover, no big-bang migration

---

## Testing Strategy

### Before Schema Changes

1. **Simulate with Mock Data**: Use in-memory data structures that mimic new tables
2. **Benchmark Performance**: Measure runtime improvements
3. **A/B Test Scoring**: Run old vs. new algorithms in parallel

### After Schema Changes

1. **Integration Tests**: Verify CRUD operations on new tables
2. **Migration Tests**: Confirm data integrity post-migration
3. **Load Tests**: Ensure new queries scale with 10k+ buyers

---

## ROI Projections

### Expected Benefits

| Enhancement | Expected Impact | Timeline |
|-------------|----------------|----------|
| Buyer Prefs Table | 10x faster matching | Month 1 |
| Match Persistence | 2x conversion insights | Month 2 |
| Persona Fields | 15% better matches | Month 3 |
| Feedback Loop | 20% score accuracy | Month 6 |
| Geo-Spatial | 25% more matches | Month 9 |

### Cost Considerations

- **Database Storage**: +50MB per 10k matches
- **Compute**: Negligible (scoring is already fast)
- **Maintenance**: Additional tables to manage

---

## Conclusion

While the current System 5.1A is functional and production-ready **without schema modifications**, these enhancements would dramatically improve:

- Match accuracy
- Performance at scale
- Agent productivity
- Data-driven insights

When the time is right, use this document as a roadmap for evolving the system.

---

**Document Version**: 1.0  
**Last Updated**: 2026-02-09  
**Status**: Planning / Not Yet Implemented
