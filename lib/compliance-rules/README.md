# System 4.2 – Compliance Rules Engine (Evaluation-Only)

## Overview

System 4.2 is a **pure evaluation system** that checks draft content against regulatory, brokerage, brand, and AI-safety rules. It returns structured compliance verdicts **without persisting state, modifying content, or making approval decisions**.

## Key Principles

1. **Evaluation Only** - Returns verdict, never persists compliance state
2. **No Schema Dependencies** - All rules are code-based, no database tables required
3. **Ephemeral Results** - Verdicts are runtime-only, consumed by System 4.3
4. **Optional Logging** - Can log signals to `activities` table for audit trail

## Architecture

```
┌─────────────────────┐
│ Content Input       │
│ (Draft Content)     │
└──────────┬──────────┘
           │
           v
┌─────────────────────┐
│ Compliance Engine   │
│ - Regulatory Rules  │
│ - Brokerage Rules   │
│ - Brand Rules       │
│ - AI Safety Rules   │
└──────────┬──────────┘
           │
           v
┌─────────────────────┐
│ Compliance Verdict  │
│ (Ephemeral)         │
│ - pass/fail/review  │
│ - violations list   │
│ - required actions  │
└──────────┬──────────┘
           │
           ├──────────> System 4.3 (Approval Workflow)
           │
           └──────────> activities table (optional logging)
```

## Schema Compliance

### ALLOWED
- **Read:** None required (all context via input)
- **Write:** `activities` table only (optional signal logging)

### FORBIDDEN
- Creating/reading from `compliance_rules` tables
- Creating/reading from `compliance_violations` tables
- Creating/reading from `content_approval_queue` tables
- Persisting compliance verdicts as state
- Modifying content
- Making approval decisions

## Rule Categories

### 1. Regulatory Rules (Fair Housing, Advertising Laws)

**Critical Violations (Severity: High)**
- Protected class references (race, religion, sex, disability, familial status)
- Steering language ("perfect for families", "great for retirees")
- Age discrimination ("adult community", "young professional area")
- Guaranteed investment returns

**Medium Violations**
- Implicit steering ("safe area", "walk to church")
- Neighborhood characterization ("changing neighborhood")

**Low Violations**
- Accessibility language that could imply disability preferences

### 2. Brokerage Policy Rules

- Incorrect brokerage attribution
- Unsubstantiated claims ("#1 agent")
- Exclusive dealing language ("off-market")

### 3. Brand & Disclaimer Rules

- Missing Equal Housing Opportunity statements
- Missing unsubscribe links (emails)
- Missing physical address (emails)
- Pushy CTA language

### 4. AI Safety & Ethical Language Rules

- Manipulative language ("you'd be crazy not to")
- False urgency ("limited time offer")
- Pressure tactics ("act fast", "hurry")
- Low "Them First" score (<70% buyer-focused)

## Usage

### Basic Evaluation

```typescript
import { evaluateCompliance } from "@/app/actions/content-compliance"

const result = await evaluateCompliance(
  {
    content_type: "listing_description",
    channel_intent: "mls",
    raw_content: "Perfect for families! Safe neighborhood near church.",
    intended_audience: "first_time_buyers",
    context: {
      listing_id: "uuid-here",
    },
  },
  {
    log_to_activities: true,
    agent_id: "agent-uuid",
  }
)

if (result.success && result.verdict) {
  console.log("Compliance Status:", result.verdict.compliance_status)
  console.log("Violations:", result.verdict.violations.length)
  console.log("Required Actions:", result.verdict.required_actions)
}
```

### Quick Check (Critical Issues Only)

```typescript
import { quickCheck } from "@/app/actions/content-compliance"

const result = await quickCheck({
  content_type: "social_post",
  channel_intent: "instagram",
  raw_content: "Great for retirees! Adult community only.",
})

if (result.has_critical_issues) {
  console.log("BLOCKED:", result.critical_violations)
}
```

### Category-Specific Evaluation

```typescript
import { evaluateCategory } from "@/app/actions/content-compliance"

const result = await evaluateCategory(
  {
    content_type: "email",
    channel_intent: "email",
    raw_content: "Your dream home awaits...",
  },
  "regulatory" // Check Fair Housing only
)

console.log("Regulatory violations:", result.violations)
```

### Batch Evaluation

```typescript
import { batchEvaluate } from "@/app/actions/content-compliance"

const result = await batchEvaluate(
  [
    { content_type: "email", channel_intent: "email", raw_content: "..." },
    { content_type: "sms", channel_intent: "sms", raw_content: "..." },
    { content_type: "social_post", channel_intent: "instagram", raw_content: "..." },
  ],
  {
    log_to_activities: true,
    agent_id: "agent-uuid",
  }
)

result.results?.forEach((r) => {
  console.log(`${r.input.content_type}: ${r.verdict.compliance_status}`)
})
```

### Human-Readable Report

```typescript
import { getComplianceReport } from "@/app/actions/content-compliance"

const result = await getComplianceReport({
  content_type: "listing_description",
  channel_intent: "mls",
  raw_content: "...",
})

console.log(result.report)
// Output:
// Compliance Status: FAIL
//
// Summary:
// - Total Violations: 3
// - Highest Severity: high
// - Evaluated: 2/9/2026, 3:45:23 PM
//
// Violations by Category:
// - regulatory: 2
// - ai_safety: 1
//
// Detailed Violations:
//
// [HIGH] Fair Housing Act Violation
//   Potentially violates Fair Housing Act...
//   Excerpt: "...perfect for families..."
//   Suggested Fix: Spacious layout with multiple bedrooms
//   Reference: Fair Housing Act § 3604(c)
```

## Compliance Verdict Structure

```typescript
interface ComplianceVerdict {
  compliance_status: "pass" | "fail" | "review_required"
  violations: Array<{
    rule_category: "regulatory" | "brokerage" | "brand" | "ai_safety"
    rule_name: string
    severity: "low" | "medium" | "high"
    description: string
    offending_excerpt?: string
    suggested_fix?: string
    regulation_reference?: string
  }>
  required_actions: string[] // e.g., ["legal_review_required", "content_rewrite_required"]
  evaluated_at: string // ISO timestamp
  summary: {
    total_violations: number
    by_category: Record<string, number>
    by_severity: Record<string, number>
    highest_severity: "low" | "medium" | "high" | null
  }
}
```

## Status Determination Logic

| Severity | Status |
|----------|--------|
| Any **high** severity violation | `fail` |
| Any **medium** severity violation (no high) | `review_required` |
| Only **low** severity violations | `review_required` |
| Zero violations | `pass` |

## Required Actions

Based on violations, the system recommends:

- `legal_review_required` - Regulatory violations detected
- `content_rewrite_required` - High severity issues
- `manual_approval_required` - High severity issues
- `add_required_disclaimers` - Missing brand elements
- `rewrite_for_buyer_focus` - Low "Them First" score
- `ready_for_use` - No violations
- `optional_review_recommended` - Only low severity issues

## Integration with System 4.1 (Content Generation)

```typescript
import { generateTextContent } from "@/app/actions/content-generation-engine"
import { evaluateCompliance } from "@/app/actions/content-compliance"

// Generate content
const content = await generateTextContent({
  content_type: "email",
  custom_prompt: "Write welcome email for new buyer lead",
  target_audience: "first_time_buyers",
})

// Evaluate compliance
const compliance = await evaluateCompliance(
  {
    content_type: content.content_type,
    channel_intent: content.channel_intent,
    raw_content: content.raw_content,
    intended_audience: content.intended_audience,
  },
  {
    log_to_activities: true,
    agent_id: "agent-uuid",
  }
)

if (compliance.verdict?.compliance_status === "pass") {
  console.log("Content is compliant!")
} else {
  console.log("Violations detected:", compliance.verdict?.violations)
}
```

## Activity Logging

When `log_to_activities: true`, the system writes to `activities` table:

```sql
INSERT INTO activities (
  agent_id,
  entity_type,
  entity_id,
  activity_type,
  title,
  description,
  notes,
  status
) VALUES (
  'agent-uuid',
  'content',
  'content-uuid',
  'compliance_evaluated',
  'Compliance check: pass',
  'Evaluated listing_description for mls channel',
  '{"compliance_status": "pass", "total_violations": 0, ...}',
  'completed'
)
```

**Note:** Only metadata is logged. Full content and violation details are NOT persisted.

## Get Historical Data

### Evaluation History

```typescript
import { getEvaluationHistory } from "@/app/actions/content-compliance"

const history = await getEvaluationHistory({
  agent_id: "agent-uuid",
  limit: 50,
  status_filter: "fail", // Optional: "pass", "fail", "review_required"
})

history.history?.forEach((evaluation) => {
  console.log(evaluation.title, evaluation.notes)
})
```

### Compliance Statistics

```typescript
import { getComplianceStatistics } from "@/app/actions/content-compliance"

const stats = await getComplianceStatistics({
  agent_id: "agent-uuid",
  date_range: {
    start: "2026-01-01T00:00:00Z",
    end: "2026-02-09T23:59:59Z",
  },
})

console.log("Total Evaluations:", stats.stats?.total_evaluations)
console.log("Pass Rate:", stats.stats?.pass_count / stats.stats?.total_evaluations)
console.log("Common Violations:", stats.stats?.common_violations)
```

## "Them First" Scoring

System 4.2 includes automatic "Them First" analysis:

- **Buyer-focused words:** you, your, yours, imagine, feel, enjoy, benefit, discover, experience
- **Agent-focused words:** I, me, my, mine, we, us, our, ours

**Score = buyer_words / (buyer_words + agent_words)**

Target: **70%+ buyer-focused**

If score < 70%, violation is raised:
```
{
  rule_category: "ai_safety",
  rule_name: "Insufficient 'Them First' Focus",
  severity: "medium",
  description: "Content is only 45% buyer-focused (target: 70%+)..."
}
```

## Extending Rules

To add new compliance rules, edit:

1. `/lib/compliance-rules/rule-evaluators.ts`
   - Add pattern to relevant violation array
   - Update evaluator function

2. NO database changes required
3. NO schema modifications
4. Rules are code-only

Example:

```typescript
// Add to FAIR_HOUSING_VIOLATIONS array
{
  pattern: /bachelor\s+pad/gi,
  phrase: "bachelor pad",
  severity: "medium" as const,
  fix: "Modern urban space",
  reference: "Fair Housing Act § 3604(c)",
}
```

## Testing

```typescript
import { evaluateCompliance } from "@/app/actions/content-compliance"

// Test Fair Housing violation
const test1 = await evaluateCompliance({
  content_type: "listing_description",
  channel_intent: "mls",
  raw_content: "Perfect for families with 4 bedrooms!",
})
// Expected: compliance_status = "fail", 1 high severity violation

// Test clean content
const test2 = await evaluateCompliance({
  content_type: "listing_description",
  channel_intent: "mls",
  raw_content: "Spacious 4-bedroom home with large backyard. Equal Housing Opportunity.",
})
// Expected: compliance_status = "pass", 0 violations

// Test "Them First" scoring
const test3 = await evaluateCompliance({
  content_type: "email",
  channel_intent: "email",
  raw_content: "I am the best realtor. I have 10 years experience. I can help you.",
})
// Expected: "Insufficient 'Them First' Focus" violation (too many "I" words)
```

## Boundaries & Non-Goals

**This system does NOT:**
- Approve or reject content
- Queue content for review
- Store compliance rules in database
- Persist compliance verdicts
- Edit or rewrite content
- Trigger workflows
- Enforce authority
- Make publishing decisions

**All authority decisions flow to:**
→ **System 4.3 – Content Approval & Authority Workflow**

## Troubleshooting

### Issue: False positives on Fair Housing

**Solution:** Rules are intentionally conservative. If needed, adjust patterns in `rule-evaluators.ts` or mark as `severity: "low"` instead of blocking.

### Issue: "Them First" score too strict

**Solution:** Adjust threshold in `evaluateAISafetyCompliance()` function (currently 0.7 / 70%).

### Issue: Missing context for evaluation

**Solution:** Provide full `ComplianceContentInput` including `context` object with `listing_id`, `transaction_id`, etc.

## Future Enhancements

When schema changes are allowed:

1. **Persistent Rule Management** - Store rules in database with version control
2. **Custom Brokerage Rules** - Per-brokerage rule customization
3. **ML-Based Detection** - Train models on historical violations
4. **Automated Remediation** - Suggest rewrites, not just fixes

For now, all rules are code-based and stateless by design.
