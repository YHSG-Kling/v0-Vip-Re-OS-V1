# System 5.1A - Integration Examples

This document shows how to integrate the Property → Buyer Smart Match Engine into existing workflows and systems.

---

## Example 1: Trigger Matching When Listing Goes Active

Automatically find buyers when an agent activates a new listing.

```typescript
// app/actions/listings.ts (existing file - conceptual addition)

import { matchBuyersForListing } from './property-buyer-matching'

export async function activateListing(listingId: string, agentId: string) {
  const supabase = createServiceClient()
  
  // Update listing status to active
  const { error } = await supabase
    .from('listings')
    .update({ status: 'active' })
    .eq('id', listingId)
  
  if (error) {
    return { success: false, error: error.message }
  }
  
  // Trigger smart matching in background
  matchBuyersForListing({
    listingId,
    minScore: 50,
    limit: 25,
    logSignals: true,
  }).then(result => {
    if (result.success) {
      console.log(`[v0] Found ${result.matches?.length} viable buyers for listing`)
    }
  })
  
  return { success: true, message: 'Listing activated and matching initiated' }
}
```

---

## Example 2: Agent Dashboard Widget

Display top buyers for a listing in the agent dashboard.

```typescript
// app/components/features/listings/BuyerMatchWidget.tsx

'use client'

import { useEffect, useState } from 'react'
import { matchBuyersForListing } from '@/app/actions/property-buyer-matching'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface BuyerMatchWidgetProps {
  listingId: string
}

export function BuyerMatchWidget({ listingId }: BuyerMatchWidgetProps) {
  const [matches, setMatches] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadMatches() {
      const result = await matchBuyersForListing({
        listingId,
        minScore: 45,
        limit: 10,
        logSignals: false, // Don't log from UI
      })

      if (result.success) {
        setMatches(result.matches || [])
      }
      setLoading(false)
    }

    loadMatches()
  }, [listingId])

  if (loading) {
    return <div className="text-muted-foreground">Finding buyers...</div>
  }

  if (matches.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Buyer Matches Yet</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No buyers in your database match this listing's criteria.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Buyer Matches ({matches.length})</CardTitle>
        <p className="text-sm text-muted-foreground">
          Potential buyers for this listing based on preferences and engagement
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {matches.map((match) => (
            <div
              key={match.contact_id}
              className="flex items-start justify-between border-b pb-3 last:border-0"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{match.buyer_name}</span>
                  <Badge
                    variant={
                      match.match_confidence === 'high'
                        ? 'default'
                        : match.match_confidence === 'medium'
                        ? 'secondary'
                        : 'outline'
                    }
                  >
                    {match.score}% Match
                  </Badge>
                </div>
                <ul className="mt-1 text-xs text-muted-foreground space-y-0.5">
                  {match.match_factors.slice(0, 3).map((factor: string, i: number) => (
                    <li key={i}>✓ {factor}</li>
                  ))}
                </ul>
                {match.caution_notes.length > 0 && (
                  <p className="mt-1 text-xs text-orange-600">
                    ⚠ {match.caution_notes[0]}
                  </p>
                )}
              </div>
              <button
                className="text-sm text-primary hover:underline"
                onClick={() => {
                  // Navigate to contact or initiate outreach
                  window.location.href = `/contacts/${match.contact_id}`
                }}
              >
                Contact →
              </button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
```

---

## Example 3: Batch Processing for New Listings

Run matching for all active listings that don't have recent match signals.

```typescript
// app/api/cron/run-listing-matching/route.ts

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { matchBuyersForListing } from '@/app/actions/property-buyer-matching'

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Find active listings created in last 7 days
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const { data: listings, error } = await supabase
    .from('listings')
    .select('id')
    .eq('status', 'active')
    .gte('created_at', sevenDaysAgo.toISOString())
    .limit(50)

  if (error || !listings) {
    return NextResponse.json({ error: 'Failed to fetch listings' }, { status: 500 })
  }

  const results = {
    processed: 0,
    matched: 0,
    errors: [] as string[],
  }

  for (const listing of listings) {
    try {
      const matchResult = await matchBuyersForListing({
        listingId: listing.id,
        minScore: 50,
        limit: 20,
        logSignals: true,
      })

      results.processed++
      if (matchResult.success && matchResult.matches && matchResult.matches.length > 0) {
        results.matched++
      }
    } catch (err) {
      results.errors.push(`${listing.id}: ${err}`)
    }
  }

  return NextResponse.json({
    success: true,
    ...results,
  })
}
```

---

## Example 4: Team Leader Dashboard

Show all high-confidence matches across team's listings.

```typescript
// app/actions/team-matching-insights.ts

'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { isValidUUID } from '@/lib/validations'

export async function getTeamMatchInsights(teamId: string) {
  if (!isValidUUID(teamId)) {
    return { success: false, error: 'Invalid team ID' }
  }

  const supabase = createServiceClient()

  // Get team's active listings
  const { data: listings, error: listingsError } = await supabase
    .from('listings')
    .select('id, address, city, agent_id')
    .eq('team_id', teamId)
    .eq('status', 'active')

  if (listingsError || !listings) {
    return { success: false, error: 'Failed to fetch listings' }
  }

  // Get recent high-confidence match signals
  const listingIds = listings.map((l) => l.id)

  const { data: signals, error: signalsError } = await supabase
    .from('activities')
    .select('entity_id, notes, created_at')
    .eq('activity_type', 'buyer_match_signal')
    .in('entity_id', listingIds)
    .order('created_at', { ascending: false })
    .limit(100)

  if (signalsError) {
    return { success: false, error: 'Failed to fetch signals' }
  }

  // Parse and filter high-confidence matches
  const highConfidenceMatches = signals
    ?.map((s) => {
      try {
        const payload = JSON.parse(s.notes || '{}')
        if (payload.match_confidence === 'high') {
          return {
            listing_id: s.entity_id,
            listing_address: listings.find((l) => l.id === s.entity_id)?.address,
            contact_id: payload.contact_id,
            score: payload.match_score,
            factors: payload.top_factors,
            generated_at: payload.generated_at,
          }
        }
      } catch {
        return null
      }
      return null
    })
    .filter(Boolean)

  return {
    success: true,
    insights: {
      total_listings: listings.length,
      total_signals: signals?.length || 0,
      high_confidence_matches: highConfidenceMatches?.length || 0,
      matches: highConfidenceMatches?.slice(0, 20), // Top 20
    },
  }
}
```

---

## Example 5: API Endpoint for External Tools

Expose matching as an API for integrations with CRMs or lead management tools.

```typescript
// app/api/match/buyers/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { matchBuyersForListing } from '@/app/actions/property-buyer-matching'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { listingId, minScore, limit } = body

    if (!listingId) {
      return NextResponse.json(
        { error: 'listingId is required' },
        { status: 400 }
      )
    }

    const result = await matchBuyersForListing({
      listingId,
      minScore: minScore || 45,
      limit: limit || 50,
      logSignals: true,
    })

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: 400 }
      )
    }

    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
```

Usage from external system:

```bash
curl -X POST https://your-domain.com/api/match/buyers \
  -H "Content-Type: application/json" \
  -d '{
    "listingId": "listing-uuid-here",
    "minScore": 60,
    "limit": 10
  }'
```

---

## Example 6: Notification System Integration

Notify agent when high-confidence matches are found.

```typescript
// lib/property-matching/notify-agent-matches.ts

import { matchBuyersForListing } from '@/app/actions/property-buyer-matching'
import { createServiceClient } from '@/lib/supabase/service'

export async function notifyAgentOfMatches(
  listingId: string,
  agentId: string,
  minScore = 70 // Only high-confidence
) {
  const result = await matchBuyersForListing({
    listingId,
    minScore,
    limit: 10,
    logSignals: true,
  })

  if (!result.success || !result.matches || result.matches.length === 0) {
    return { notified: false, reason: 'No high-confidence matches' }
  }

  const supabase = createServiceClient()

  // Create notification for agent
  await supabase.from('activities').insert({
    agent_id: agentId,
    activity_type: 'match_notification',
    title: `${result.matches.length} High-Confidence Buyer Matches`,
    description: `Found ${result.matches.length} buyers with ${minScore}%+ match for your listing`,
    notes: JSON.stringify({
      listing_id: listingId,
      matches: result.matches.slice(0, 5).map((m) => ({
        buyer_name: m.buyer_name,
        score: m.score,
      })),
    }),
    status: 'pending',
    priority: 'high',
  })

  return { notified: true, matchCount: result.matches.length }
}
```

---

## Example 7: Orchestration - Auto-Assign Follow-Up Tasks

Create follow-up tasks for top matches automatically.

```typescript
// lib/property-matching/create-match-tasks.ts

import { matchBuyersForListing } from '@/app/actions/property-buyer-matching'
import { createServiceClient } from '@/lib/supabase/service'

export async function createMatchFollowUpTasks(
  listingId: string,
  agentId: string
) {
  const result = await matchBuyersForListing({
    listingId,
    minScore: 60,
    limit: 10,
    logSignals: true,
  })

  if (!result.success || !result.matches || result.matches.length === 0) {
    return { success: true, tasksCreated: 0 }
  }

  const supabase = createServiceClient()
  const tasks = []

  // Create a task for each high/medium match
  for (const match of result.matches.slice(0, 5)) {
    tasks.push({
      assigned_to_agent_id: agentId,
      contact_id: match.contact_id,
      title: `Follow up: ${match.buyer_name} - ${match.match_confidence} match`,
      description: `Reach out about new listing. Match score: ${match.score}%. Key factors: ${match.match_factors.join(', ')}`,
      priority: match.match_confidence === 'high' ? 'high' : 'medium',
      due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 2 days
      status: 'pending',
      tags: ['listing_match', 'follow_up'],
    })
  }

  const { error } = await supabase.from('tasks').insert(tasks)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, tasksCreated: tasks.length }
}
```

---

## Best Practices

### 1. **Don't Block User Actions**

Run matching asynchronously when possible:

```typescript
// ✅ Good: Don't wait for matching to complete
activateListing(id).then(() => {
  matchBuyersForListing({ listingId: id }) // Fire and forget
})

// ❌ Bad: Blocking the user
await activateListing(id)
await matchBuyersForListing({ listingId: id }) // User waits
```

### 2. **Cache Results in UI**

Don't re-run matching on every page load:

```typescript
// Use SWR or React Query
import useSWR from 'swr'

const { data } = useSWR(
  `/api/match/buyers?listingId=${listingId}`,
  fetcher,
  { revalidateOnFocus: false, refreshInterval: 3600000 } // 1 hour
)
```

### 3. **Set Appropriate Thresholds**

Adjust `minScore` based on context:

- **Agent dashboard**: 45+ (show all viable)
- **Notifications**: 70+ (only high-confidence)
- **Auto-task creation**: 60+ (medium-high)

### 4. **Respect Privacy**

Never expose match details to buyers. This is an internal tool.

```typescript
// ❌ Bad: Buyer-facing
"You're a 85% match for 123 Main St"

// ✅ Good: Agent-facing
"John Doe is an 85% match (price aligned, high urgency)"
```

---

## Troubleshooting

### No Matches Found

1. **Check buyer contact_type**: Must be 'buyer' or 'lead'
2. **Verify contact status**: Must be 'active', 'qualified', or 'nurture'
3. **Inspect notes field**: Does it contain preference data?
4. **Check conversation_insights**: Are there recent insights?

### Low Match Scores

1. **Enrich contact notes**: Add structured preferences
2. **Encourage conversations**: More data = better scoring
3. **Adjust scoring weights**: Modify `match-scorer.ts` if needed

### Performance Issues

1. **Limit buyer pool**: System caps at 500, but can be lowered
2. **Batch processing**: Run matching during off-peak hours
3. **Cache results**: Store recent match results in Redis/memory

---

## Next Steps

Now that you understand how to integrate the matching engine, consider:

1. Building a UI component to display matches
2. Creating automated workflows triggered by new listings
3. Integrating with notification systems
4. Adding analytics to track match-to-closing conversion

For questions or enhancements, refer to the main README.md.
