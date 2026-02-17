# System 4.5 – Campaign & Distribution Readiness

## Overview

System 4.5 is the **final readiness gate** before any content is executed (sent, posted, mailed, scheduled).

It determines if approved content is operationally ready for execution across one or more channels.

**Core Question:** "Is this content ready to be executed, and for which channels?"

## System Boundaries

### What This System DOES

✅ Evaluates readiness across 5 dimensions:
1. **Approval Readiness** - Content must be approved with no blocking reasons
2. **Compliance Closure** - Compliance must be resolved (pass or review_required + approved)
3. **Brand Completeness** - All required brand elements must be satisfied
4. **Channel Eligibility** - Content type must support intended channels
5. **Context Readiness** - Required entities (listing, transaction, contact) must exist

✅ Returns simple decision: `ready` or `blocked` with reasons

✅ Optionally logs readiness signals to `activities` table

✅ Provides readiness history and statistics

### What This System DOES NOT

❌ Execute campaigns  
❌ Send messages  
❌ Post content  
❌ Schedule content  
❌ Persist readiness state  
❌ Trigger workflows  
❌ Modify content  
❌ Select vendors

## Schema Compliance (STRICT)

### Allowed Operations

- **READ:** None required (all inputs passed at runtime)
- **WRITE:** `activities` table only (optional logging)

### Forbidden Operations

- ❌ Create new tables
- ❌ Modify existing tables
- ❌ Assume campaign tables exist
- ❌ Persist readiness state

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   UPSTREAM SYSTEMS                      │
├─────────────────────────────────────────────────────────┤
│  4.1 Content Generation → content metadata             │
│  4.2 Compliance Rules   → compliance verdict           │
│  4.3 Approval Workflow  → approval decision            │
│  4.4 Brand Registry     → brand compliance result      │
│  Context Layer          → listing/transaction/contact  │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│              SYSTEM 4.5 READINESS GATE                  │
├─────────────────────────────────────────────────────────┤
│  ✓ Approval Check                                       │
│  ✓ Compliance Check                                     │
│  ✓ Brand Check                                          │
│  ✓ Channel Check                                        │
│  ✓ Context Check                                        │
│                                                          │
│  Decision: READY or BLOCKED                             │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                DOWNSTREAM SYSTEMS                       │
├─────────────────────────────────────────────────────────┤
│  Phase 3 Communication Systems                          │
│  Listing Marketing Stages                               │
│  Transaction Marketing                                  │
│  Journey Engine (future)                                │
└─────────────────────────────────────────────────────────┘
```

## Usage Examples

### Example 1: Basic Readiness Check

```typescript
import { evaluateContentReadiness } from "@/app/actions/campaign-readiness"
import type { ReadinessInput } from "@/lib/campaign-readiness/readiness-evaluator"

const input: ReadinessInput = {
  content_type: "email",
  channel_intent: ["email"],
  audience_scope: "private",
  content_id: "550e8400-e29b-41d4-a716-446655440000",
  
  compliance_verdict: {
    compliance_status: "pass",
    violations: [],
    required_actions: ["ready_for_use"],
    evaluated_at: new Date().toISOString(),
    summary: {
      total_violations: 0,
      by_category: {},
      by_severity: {},
      highest_severity: null,
    },
  },
  
  approval_decision: {
    approval_status: "approved",
    decided_at: new Date().toISOString(),
    metadata: {
      content_type: "email",
      channel_intent: "email",
      compliance_status: "pass",
      highest_violation_severity: null,
      auto_approved: true,
    },
  },
  
  context: {
    listing_id: "abc-123",
    requires_listing: true,
  },
}

const result = await evaluateContentReadiness(input, {
  log_to_activities: true,
})

if (result.success && result.readiness_output?.readiness_status === "ready") {
  console.log("Content is ready for:", result.readiness_output.ready_for_channels)
  // Proceed to execution
} else {
  console.log("Content blocked:", result.readiness_output?.blocking_reasons)
  // Handle blocking reasons
}
```

### Example 2: Channel-Specific Check

```typescript
import { checkSpecificChannelReadiness } from "@/app/actions/campaign-readiness"

const result = await checkSpecificChannelReadiness(input, "email", {
  log_to_activities: true,
})

if (result.success && result.is_ready) {
  console.log("Ready for email channel")
} else {
  console.log("Not ready:", result.reason)
}
```

### Example 3: Quick Approval + Compliance Check

```typescript
import { quickCheckReadiness } from "@/app/actions/campaign-readiness"

const result = await quickCheckReadiness(approvalDecision, complianceVerdict)

if (result.is_ready) {
  console.log("Quick check passed")
} else {
  console.log("Quick check failed:", result.reason)
}
```

### Example 4: Batch Evaluation

```typescript
import { batchEvaluateContentReadiness } from "@/app/actions/campaign-readiness"

const inputs: ReadinessInput[] = [
  // ... multiple content pieces
]

const result = await batchEvaluateContentReadiness(inputs, {
  log_to_activities: true,
})

for (const item of result.results || []) {
  if (item.readiness_output.readiness_status === "ready") {
    console.log("Ready:", item.input.content_id)
  } else {
    console.log("Blocked:", item.readiness_output.blocking_reasons)
  }
}
```

### Example 5: Readiness Statistics

```typescript
import { fetchReadinessStatistics } from "@/app/actions/campaign-readiness"

const stats = await fetchReadinessStatistics(
  "2026-01-01T00:00:00Z",
  "2026-01-31T23:59:59Z"
)

console.log("Total evaluations:", stats.statistics?.total_evaluations)
console.log("Ready percentage:", stats.statistics?.ready_percentage)
console.log("Top blockers:", stats.statistics?.top_blocking_reasons)
```

### Example 6: Readiness History

```typescript
import { fetchReadinessHistory } from "@/app/actions/campaign-readiness"

const history = await fetchReadinessHistory(contentId, 10)

for (const evaluation of history.evaluations || []) {
  console.log(evaluation.activity_type, evaluation.created_at)
  console.log(evaluation.payload)
}
```

## Readiness Checks Explained

### 1. Approval Readiness

**Requirement:** `approval_status === 'approved'` AND no `blocking_reason`

**Blocks if:**
- Approval status is `pending` or `rejected`
- Blocking reason exists

### 2. Compliance Closure

**Requirement:** One of:
- `compliance_status === 'pass'`
- `compliance_status === 'review_required'` AND `approval_status === 'approved'`

**Blocks if:**
- Compliance status is `fail`
- High-severity violations exist
- Review required but not approved

### 3. Brand Completeness

**Requirement:** All required brand elements satisfied

**Blocks if:**
- Missing required disclaimers
- Missing required attribution
- Missing license numbers
- Missing logos/branding

### 4. Channel Eligibility

**Requirement:** Content type supports intended channels

**Blocks if:**
- Email content sent to SMS channel
- Social post sent to email channel
- Public content sent to private channels (SMS, direct mail)

### 5. Context Readiness

**Requirement:** Required entities exist

**Blocks if:**
- `requires_listing = true` but no `listing_id`
- `requires_transaction = true` but no `transaction_id`
- `requires_contact = true` but no `contact_id` or `contact_eligibility = false`

## Integration Patterns

### Pattern 1: Content Generation → Readiness Check

```typescript
// Generate content
const draft = await generateEmailContent(...)

// Evaluate compliance
const complianceVerdict = await evaluateContentCompliance(...)

// Determine approval
const approvalDecision = await determineApprovalDecision(...)

// Check brand compliance
const brandCompliance = await checkBrandCompliance(...)

// Evaluate readiness
const readiness = await evaluateContentReadiness({
  content_type: draft.content_type,
  channel_intent: draft.channel_intent,
  audience_scope: "private",
  compliance_verdict: complianceVerdict,
  approval_decision: approvalDecision,
  brand_compliance: brandCompliance,
  context: {
    listing_id: listingId,
    requires_listing: true,
  },
})

if (readiness.readiness_output?.readiness_status === "ready") {
  // Execute campaign
}
```

### Pattern 2: Pre-Execution Gate in Communication Systems

```typescript
// Before sending email
async function sendListingEmail(listingId: string, contactId: string) {
  // Prepare content
  const content = await prepareEmailContent(listingId)
  
  // Run all checks
  const readiness = await evaluateContentReadiness({...})
  
  if (readiness.readiness_output?.readiness_status !== "ready") {
    throw new Error(`Cannot send: ${readiness.readiness_output?.blocking_reasons}`)
  }
  
  // Safe to execute
  await sendEmail(content)
}
```

## API Reference

### Server Actions

1. `evaluateContentReadiness(input, options)` - Main readiness evaluation
2. `batchEvaluateContentReadiness(inputs, options)` - Batch evaluation
3. `quickCheckReadiness(approval, compliance)` - Quick check
4. `checkSpecificChannelReadiness(input, channel, options)` - Channel check
5. `fetchReadinessHistory(contentId, limit)` - Get history
6. `fetchReadinessStatistics(startDate, endDate)` - Get statistics
7. `fetchReadinessTrends(startDate, endDate)` - Get trends
8. `formatReadinessResult(output)` - Format for display
9. `validateReadinessInput(input)` - Validate input structure

## Best Practices

### ✅ DO

- Always check readiness before executing campaigns
- Log readiness evaluations for audit trail
- Use batch evaluation for multiple content pieces
- Handle blocking reasons gracefully
- Monitor readiness statistics to improve content quality

### ❌ DON'T

- Don't bypass readiness checks
- Don't execute blocked content
- Don't persist readiness state
- Don't modify content within readiness system
- Don't trigger execution from readiness system

## Troubleshooting

### Issue: Content always blocked

**Check:**
1. Is approval status `approved`?
2. Is compliance status `pass` or `review_required` + `approved`?
3. Are all required brand elements present?
4. Is content type compatible with channels?
5. Are required context entities present?

### Issue: Channel not in ready list

**Check:**
1. Content type supports channel (e.g., email content → email channel)
2. Audience scope allows channel (public content can't use SMS/direct mail)

### Issue: Readiness history not found

**Check:**
1. Content ID is valid UUID
2. Logging was enabled (`log_to_activities: true`)
3. Activities table is accessible

## Performance Considerations

- All checks run in parallel where possible
- No database queries required for evaluation
- Logging is optional and async
- Batch evaluation recommended for multiple items

## Future Enhancements

When schema restrictions are lifted:

1. **Campaign Persistence** - Store campaign configs
2. **Scheduling Logic** - Add time-based readiness
3. **Vendor Selection** - Choose execution vendors
4. **Analytics Integration** - Track campaign performance
5. **A/B Test Readiness** - Support variant testing

## Dependencies

- System 4.1 (Content Generation)
- System 4.2 (Compliance Rules)
- System 4.3 (Approval Workflow)
- System 4.4 (Brand & Template Registry)

## Downstream Consumers

- Phase 3 Communication Systems
- Listing Marketing Stages
- Transaction Marketing
- Journey Engine (future)
