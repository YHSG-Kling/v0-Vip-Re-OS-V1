# System 5.1: Buyer Core Execution Engine

## Overview

System 5.1 is the **buyer-side execution engine** that orchestrates the complete buyer journey from initial contact through closing. It enforces financial verification gates, powers buyer-facing progress tracking, integrates with voice assistants, and enables multi-party updates from agents, lenders, and admins.

## Key Features

### 1. Journey Status & Progress Tracking
- Infers buyer lifecycle state from activities (no state columns)
- Calculates progress percentage (0-100%)
- Identifies next steps and blockers
- Tracks milestone completion dates
- Powers buyer portal progress bars

### 2. Financial Verification Gate
- **MANDATORY** before search, tour, or offer
- Checks for pre-approval, proof-of-funds, or lender confirmation
- Monitors expiration dates
- Enforced across ALL channels (portal, voice, API)
- Never silently fails - always provides reason

### 3. Voice Assistant Integration
- Explains journey progress ("Where am I?")
- Answers "What's next?" queries
- Executes property searches with NLP
- Schedules tours (with gate enforcement)
- Uses same execution logic as portal
- All actions logged to activities

### 4. Multi-Party Updates
- **Lender**: Confirm financial verification
- **Agent**: Configure search, advance stages
- **Admin/Broker**: Override gates (emergency only)
- Complete audit trail of all actions
- Role-based authorization

### 5. Buyer-Friendly Messaging
- Converts technical states to plain language
- Persona-aware communication
- Clear explanations of blockers
- Encouragement and progress affirmation

## Architecture

```
System 5.1 (Execution Layer)
├── buyer-execution-engine.ts       # Core orchestration
├── voice-assistant-integration.ts  # Voice interface
├── multi-party-updates.ts          # Agent/lender/admin
└── README.md                       # This file

Depends On:
├── System 5.1A: Property → Buyer Matching
├── System 5.1B: Buyer Search & Intent
├── System 5.1C: Buyer Lifecycle Governance
└── System 5.1D: Lifecycle Hardening
```

## Buyer Lifecycle States (Inferred)

| State | Progress | Can Search? | Can Tour? | Can Offer? |
|-------|----------|-------------|-----------|------------|
| BUYER_CONTACT_CREATED | 5% | ❌ | ❌ | ❌ |
| BUYER_FINANCIALLY_VERIFIED | 15% | ✅ | ❌ | ❌ |
| BUYER_SEARCH_CONFIGURED | 25% | ✅ | ❌ | ❌ |
| BUYER_SEARCHING | 35% | ✅ | ❌ | ❌ |
| BUYER_TOUR_ELIGIBLE | 45% | ✅ | ✅ | ❌ |
| BUYER_TOURING | 55% | ✅ | ✅ | ❌ |
| BUYER_OFFER_ELIGIBLE | 65% | ✅ | ✅ | ✅ |
| BUYER_OFFER_SUBMITTED | 75% | ✅ | ✅ | ✅ |
| BUYER_UNDER_CONTRACT | 85% | ✅ | ❌ | ❌ |
| BUYER_CLOSED | 100% | ❌ | ❌ | ❌ |

**Financial verification REQUIRED for all gates.**

## Usage Examples

### Example 1: Get Buyer Journey Status (Portal)

```typescript
import { getBuyerJourney } from '@/app/actions/buyer-execution'

const result = await getBuyerJourney({
  contactId: 'buyer-uuid',
  userId: 'user-uuid',
  source: 'buyer_portal'
})

if (result.success && result.journey) {
  console.log(`Progress: ${result.journey.progressPercentage}%`)
  console.log(`Current: ${result.journey.currentState}`)
  console.log(`Can Search: ${result.journey.canSearch}`)
  console.log(`Blockers: ${result.journey.blockers}`)
  
  // Buyer-friendly message
  console.log(result.message.greeting)
  console.log(result.message.statusMessage)
  console.log(result.message.nextAction)
}
```

### Example 2: Enforce Financial Gate

```typescript
import { checkBuyerCanPerformAction } from '@/app/actions/buyer-execution'

const gateCheck = await checkBuyerCanPerformAction({
  contactId: 'buyer-uuid',
  action: 'search',
  userId: 'user-uuid'
})

if (!gateCheck.allowed) {
  // Show friendly error
  alert(gateCheck.reason) // "Financial verification required before search"
  // Redirect to verification upload
}
```

### Example 3: Voice Assistant Integration

```typescript
import { handleBuyerVoiceAssistant } from '@/app/actions/buyer-execution'

const voiceResult = await handleBuyerVoiceAssistant({
  contactId: 'buyer-uuid',
  intent: 'whats_next',
  transcript: "What should I do next?",
  userId: 'user-uuid'
})

if (voiceResult.success) {
  // Speak response
  speakText(voiceResult.spokenResponse)
  
  // Show visual data
  if (voiceResult.displayData) {
    displayToUser(voiceResult.displayData)
  }
}
```

### Example 4: Lender Confirms Verification

```typescript
import { lenderConfirmBuyerFinancials } from '@/app/actions/buyer-execution'

const result = await lenderConfirmBuyerFinancials({
  contactId: 'buyer-uuid',
  lenderId: 'lender-uuid',
  verificationType: 'pre_approval',
  approvedAmount: 450000,
  loanType: 'conventional',
  interestRate: 6.5,
  lenderName: 'ABC Mortgage',
  expiresAt: new Date('2024-06-01'),
  notes: 'Verified with tax returns and pay stubs'
})

if (result.success) {
  // Buyer can now search
  notifyBuyer('Your financial verification is complete! You can now search for properties.')
}
```

### Example 5: Agent Configures Search

```typescript
import { agentConfigureBuyerSearch } from '@/app/actions/buyer-execution'

const result = await agentConfigureBuyerSearch({
  contactId: 'buyer-uuid',
  agentId: 'agent-uuid',
  searchPreferences: {
    minPrice: 300000,
    maxPrice: 500000,
    minBeds: 3,
    maxBeds: 4,
    minBaths: 2,
    cities: ['Austin', 'Round Rock'],
    propertyTypes: ['single_family'],
    features: ['pool', 'garage']
  },
  notes: 'Buyer wants move-in ready homes with good schools nearby'
})

if (result.success) {
  console.log('Search preferences configured')
}
```

### Example 6: Admin Override (Emergency)

```typescript
import { adminOverrideFinancialVerification } from '@/app/actions/buyer-execution'

const result = await adminOverrideFinancialVerification({
  contactId: 'buyer-uuid',
  adminId: 'admin-uuid',
  reason: 'Buyer is cash buyer - verified $2M in bank account via wire confirmation. No mortgage needed.',
  expiresAt: new Date('2024-12-31')
})

if (result.success) {
  console.log('Financial gate overridden - fully logged for compliance')
}
```

## Schema Compliance

### READ Tables
- `contacts` - Buyer profile, notes, preferences
- `activities` - ALL lifecycle events
- `conversations` - Chat history
- `conversation_insights` - Inferred buyer intent
- `documents` - Pre-approval, proof-of-funds
- `listings` - Property data for matching
- `users` - Role verification

### WRITE Tables
- `activities` - ALL events/signals ONLY

### NO Schema Changes
- No new tables
- No new columns
- No new enums
- Lifecycle is INFERRED

## Event Types

All events logged to `activities` table:

### Journey Events
- `buyer.lifecycle.transitioned` - State change
- `buyer.journey.viewed` - Buyer viewed progress
- `buyer.voice.interaction` - Voice assistant usage

### Gate Events
- `buyer.search.blocked` - Search attempted without verification
- `buyer.tour.blocked` - Tour attempted without verification
- `buyer.offer.blocked` - Offer attempted without verification

### Financial Events
- `buyer.financial.lender_confirmed` - Lender confirmed verification
- `buyer.financial.gate_overridden` - Admin override

### Agent Events
- `buyer.search.agent_configured` - Agent set preferences
- `buyer.lifecycle.agent_advanced` - Agent advanced stage

## Integration Points

### Upstream (Depends On)
- System 5.1A: Property → Buyer matching scores
- System 5.1B: Natural language search
- System 5.1C: Lifecycle governance rules
- System 5.1D: Lifecycle hardening

### Downstream (Used By)
- Buyer Portal UI
- Voice Assistant
- Agent Dashboard
- Lender Portal
- Mobile App

## Error Handling

### Principle: Never Silently Fail

All blocked actions return:
- `success: false`
- `reason: string` (buyer-friendly)
- `actionsRequired: string[]` (next steps)

### Example Blocked Search

```json
{
  "success": false,
  "reason": "Financial verification required before search",
  "actionsRequired": ["financial_verification"],
  "verification": {
    "isVerified": false,
    "signals": []
  }
}
```

## Voice Assistant Best Practices

1. **Always enforce gates** - No shortcuts for voice
2. **Speak naturally** - No technical jargon
3. **Provide context** - Explain why action is blocked
4. **Offer alternatives** - Guide to next step
5. **Log everything** - Full audit trail

## Multi-Party Authorization

| Action | Agent | Lender | Admin | Broker |
|--------|-------|--------|-------|--------|
| View journey | ✅ | ❌ | ✅ | ✅ |
| Configure search | ✅ | ❌ | ✅ | ✅ |
| Confirm financials | ❌ | ✅ | ✅ | ✅ |
| Override gate | ❌ | ❌ | ✅ | ✅ |
| Advance stage | ✅ | ❌ | ✅ | ✅ |

## Testing

### Test Financial Gate

```typescript
// Should BLOCK search without verification
const result = await checkBuyerCanPerformAction({
  contactId: 'test-buyer',
  action: 'search'
})
expect(result.allowed).toBe(false)

// Should ALLOW after verification
await lenderConfirmBuyerFinancials({
  contactId: 'test-buyer',
  lenderId: 'test-lender',
  verificationType: 'pre_approval'
})

const result2 = await checkBuyerCanPerformAction({
  contactId: 'test-buyer',
  action: 'search'
})
expect(result2.allowed).toBe(true)
```

## Future Enhancements

When schema changes are allowed:

1. Add `buyer_preferences` table for structured search storage
2. Add `buyer_journey_snapshots` for historical analysis
3. Add `buyer_education_progress` for tracking content consumption
4. Add `buyer_tour_requests` for scheduling workflow

Until then: All data stored in `activities` as events.

## Production Checklist

- [ ] Financial gates enforced on ALL channels
- [ ] Voice assistant tested with real transcripts
- [ ] Multi-party role verification working
- [ ] Buyer-friendly messages reviewed
- [ ] Error handling provides clear guidance
- [ ] All events logging to activities
- [ ] Progress bar UI connected
- [ ] Agent dashboard integrated
- [ ] Lender portal connected
- [ ] Audit trail queryable
