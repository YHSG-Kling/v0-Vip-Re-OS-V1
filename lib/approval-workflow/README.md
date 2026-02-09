# System 4.3 – Content Approval & Authority Workflow

**Decision-Only Approval System**

## Purpose

System 4.3 determines whether draft content may proceed based on authority, context, and compliance results.

It answers:
- "Does this content require approval?"
- "Who has authority to approve?"
- "What is the decision?"

**This system does NOT:**
- Store approval state
- Publish content
- Modify content
- Queue approvals
- Notify approvers
- Create UI components

All execution happens in downstream systems.

---

## Schema Usage (STRICT)

### Read Permissions
- **NONE** - All inputs provided at runtime

### Write Permissions
- **activities** table ONLY (optional audit logging)

### Forbidden Tables
- content_approval_queue (does not exist)
- approval_workflow (does not exist)
- approval_history (does not exist)

---

## Core Decision Rules

### AUTO-APPROVED
Content is automatically approved if **ALL** conditions are met:
- ✅ `compliance_status === 'pass'`
- ✅ `content_origin === 'template'`
- ✅ `audience_scope === 'private'`

### REVIEW REQUIRED
Content requires manual review if **ANY** condition is met:
- 🟡 `compliance_status === 'review_required'`
- 🟡 `content_origin === 'ai_generated'`
- 🟡 `audience_scope === 'public'`
- 🟡 `is_new_campaign === true`

### BLOCKED
Content is rejected if:
- 🔴 `compliance_status === 'fail'`
- 🔴 Any high-severity violations exist

**Compliance failures CANNOT be overridden.**

---

## Authority Determination

System 4.3 determines who has authority to approve based on:

### Role Hierarchy
1. **Agent** - Can approve standard, private content
2. **Team Leader** - Can approve medium-risk, AI-generated content
3. **Broker/Admin** - Can approve public-facing content
4. **Compliance Manager** - Required for high-severity violations

### Authority Rules
- **High-severity violations** → Compliance Manager + Broker/Admin
- **Medium-severity violations** → Team Leader or higher
- **Public content** → Broker/Admin
- **High-value channels** (ads, email, newsletter) → Team Leader
- **Strict policy level** → Broker/Admin
- **New campaigns** → Team Leader

---

## API Reference

### Core Functions

#### `determineApprovalDecision(draft, complianceVerdict, context): ApprovalDecision`
Main decision function - determines if content is approved, pending, or rejected.

**Parameters:**
- `draft` - ContentGenerationOutput from System 4.1
- `complianceVerdict` - ComplianceVerdict from System 4.2
- `context` - ApprovalContext (requester role, origin, scope)

**Returns:**
```typescript
{
  approval_status: 'approved' | 'pending' | 'rejected',
  required_approvers?: ApproverRole[],
  blocking_reason?: string,
  approval_notes?: string[],
  decided_at: string,
  metadata: {
    content_type: string,
    channel_intent: string,
    compliance_status: string,
    highest_violation_severity: string | null,
    auto_approved: boolean
  }
}
```

#### `determineRequiredApprovers(draft, complianceVerdict, context): ApproverRole[]`
Determines who has authority to approve the content.

#### `hasApprovalAuthority(userRole, requiredApprovers): boolean`
Checks if a specific user role has authority to approve.

---

## Usage Examples

### Example 1: Auto-Approved Template
```typescript
import { determineApprovalDecision } from '@/lib/approval-workflow/approval-engine'

const decision = determineApprovalDecision(
  draft, // Template content
  complianceVerdict, // Status: PASS
  {
    requester_role: 'agent',
    content_origin: 'template',
    audience_scope: 'private'
  }
)

// Result: approval_status = 'approved', auto_approved = true
```

### Example 2: AI Content Requires Review
```typescript
const decision = determineApprovalDecision(
  draft, // AI-generated content
  complianceVerdict, // Status: PASS
  {
    requester_role: 'agent',
    content_origin: 'ai_generated',
    audience_scope: 'private'
  }
)

// Result: approval_status = 'pending', required_approvers = ['team_leader']
```

### Example 3: Public Content
```typescript
const decision = determineApprovalDecision(
  draft,
  complianceVerdict, // Status: PASS
  {
    requester_role: 'agent',
    content_origin: 'ai_generated',
    audience_scope: 'public'
  }
)

// Result: approval_status = 'pending', required_approvers = ['broker_admin', 'team_leader']
```

### Example 4: Compliance Failure (Blocked)
```typescript
const decision = determineApprovalDecision(
  draft,
  complianceVerdict, // Status: FAIL (high-severity violations)
  {
    requester_role: 'agent',
    content_origin: 'ai_generated',
    audience_scope: 'public'
  }
)

// Result: approval_status = 'rejected', blocking_reason = 'High-severity compliance violations detected'
```

---

## Server Actions

### `evaluateContentApproval(params)`
Evaluates approval decision for a single content piece.

**Example:**
```typescript
import { evaluateContentApproval } from '@/app/actions/content-approval-workflow'

const result = await evaluateContentApproval({
  draft: contentOutput,
  complianceVerdict: verdict,
  context: {
    requester_role: 'agent',
    content_origin: 'ai_generated',
    audience_scope: 'private'
  },
  log_signal: true, // Optional: log to activities
  agent_id: 'uuid',
  content_id: 'uuid'
})

if (result.success && result.decision) {
  console.log('Approval Status:', result.decision.approval_status)
  console.log('Required Approvers:', result.decision.required_approvers)
}
```

### `batchEvaluateContentApproval(params)`
Batch evaluate multiple content pieces.

### `checkApprovalAuthority(params)`
Check if a user has authority to approve.

### `previewContentApproval(params)`
Preview likely approval outcome without executing.

### `getApprovalHistory(params)`
Get historical approval decisions from activities table.

### `getApprovalStatistics(params)`
Get aggregated approval statistics.

### `getMyPendingApprovals(params)`
Get pending approvals for a specific role.

### `evaluateContentWorkflow(params)`
Complete workflow: accepts draft + compliance verdict, returns approval decision.

---

## Integration Patterns

### Pattern 1: Content Studio Integration
```typescript
// 1. Generate content (System 4.1)
const draft = await generateTextContent({ ... })

// 2. Evaluate compliance (System 4.2)
const verdict = await evaluateContentCompliance({ ... })

// 3. Evaluate approval (System 4.3)
const decision = await evaluateContentApproval({
  draft,
  complianceVerdict: verdict,
  context: { ... },
  log_signal: true
})

// 4. Handle decision
if (decision.approval_status === 'approved') {
  // Pass to downstream publishing system
} else if (decision.approval_status === 'pending') {
  // Display required approvers to user
} else {
  // Show blocking reason, require content rewrite
}
```

### Pattern 2: Approval Dashboard
```typescript
// Get pending approvals for current user
const { pending } = await getMyPendingApprovals({
  approver_role: 'team_leader',
  limit: 20
})

// Display pending items
// User reviews content and compliance verdict
// Downstream system handles actual approval execution
```

### Pattern 3: Authority Check
```typescript
// Before showing "Approve" button
const { has_authority, required_approvers } = await checkApprovalAuthority({
  user_role: currentUserRole,
  draft,
  complianceVerdict: verdict,
  context
})

if (has_authority) {
  // Show "Approve" button
} else {
  // Show "Request Approval" with required approvers
}
```

---

## Audit Trail

All approval decisions can be logged to the `activities` table:

```typescript
await logApprovalDecision({
  agent_id: 'uuid',
  content_id: 'uuid',
  decision: approvalDecision,
  requester_role: 'agent',
  content_preview: 'First 200 chars...'
})
```

**Activity Types:**
- `approval_auto_granted` - Auto-approved content
- `approval_required` - Manual review required
- `approval_rejected` - Content blocked

---

## Statistics & Reporting

### Get Approval Stats
```typescript
const stats = await getApprovalStatistics({
  agent_id: 'uuid',
  date_range: {
    start: '2024-01-01',
    end: '2024-01-31'
  }
})

console.log('Total Decisions:', stats.total_decisions)
console.log('Auto-Approved:', stats.auto_approved_count)
console.log('Approval Rate:', stats.approved_count / stats.total_decisions)
```

### Common Blocking Reasons
```typescript
stats.common_blocking_reasons.forEach(({ reason, count }) => {
  console.log(`${reason}: ${count}`)
})
// Example output:
// "High-severity compliance violations detected": 12
// "Compliance failure with high-severity violations": 8
```

---

## Testing

### Unit Tests
```typescript
import { determineApprovalDecision } from '@/lib/approval-workflow/approval-engine'

// Test auto-approval
const decision1 = determineApprovalDecision(
  mockTemplateDraft,
  mockPassVerdict,
  { requester_role: 'agent', content_origin: 'template', audience_scope: 'private' }
)
expect(decision1.approval_status).toBe('approved')
expect(decision1.metadata.auto_approved).toBe(true)

// Test compliance blocking
const decision2 = determineApprovalDecision(
  mockDraft,
  mockFailVerdict,
  { requester_role: 'agent', content_origin: 'ai_generated', audience_scope: 'public' }
)
expect(decision2.approval_status).toBe('rejected')
expect(decision2.blocking_reason).toBeTruthy()
```

---

## Error Handling

All server actions return `{ success, data?, error? }`:

```typescript
const result = await evaluateContentApproval({ ... })

if (!result.success) {
  console.error('Approval evaluation failed:', result.error)
  // Handle error
} else {
  // Process result.decision
}
```

---

## Constraints & Boundaries

### What System 4.3 Does
✅ Determines approval status (approved/pending/rejected)
✅ Identifies required approvers
✅ Provides blocking reasons
✅ Logs audit signals to activities
✅ Returns ephemeral decisions

### What System 4.3 Does NOT Do
❌ Store approval state in database
❌ Queue approvals for later
❌ Send notifications to approvers
❌ Publish or distribute content
❌ Execute approval workflows
❌ Modify content
❌ Override compliance failures

---

## Future Enhancements

When approval persistence is needed:
1. Create `approval_queue` table
2. Create `approval_history` table
3. Add workflow state management
4. Add notification triggers
5. Build approval UI components

Currently flagged as "Future Schema Enhancement" per strict constraints.

---

## Dependencies

### Upstream Systems
- **System 4.1** - Content Generation Engine (provides drafts)
- **System 4.2** - Compliance Rules Engine (provides verdicts)

### Downstream Systems
- Campaign readiness systems (future)
- Publishing systems (future)
- Notification systems (future)

---

## Support

For questions or issues:
1. Check decision rules in this README
2. Review audit trail in activities table
3. Test with `previewContentApproval()` before executing
4. Validate inputs with provided TypeScript types

---

**System Status:** ✅ Production Ready (Decision Logic Only)

**Schema Compliance:** ✅ Strict (No Schema Modifications)

**Integration Status:** ✅ Ready for Systems 4.1 & 4.2
