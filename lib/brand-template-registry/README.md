# System 4.4 – Brand & Template Registry

**Authoritative reference layer for brand requirements and template classification.**

## Overview

System 4.4 provides **declarative answers** about brand requirements and template trust levels. It does NOT store templates, does NOT generate content, and does NOT make approval decisions. It only answers questions:

- "Is this content using an approved template?"
- "What brand elements are required for this channel?"
- "Is this eligible for auto-approval based on template trust?"

## Architecture

```
┌─────────────────────────────────────────────────┐
│          Brand & Template Registry              │
│              (Reference Authority)              │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌─────────────────┐  ┌─────────────────────┐  │
│  │    Template     │  │   Brand Elements    │  │
│  │  Classifier     │  │   Requirements      │  │
│  │                 │  │                     │  │
│  │ • Trust Level   │  │ • Required Elements │  │
│  │ • Auto-Approval │  │ • Channel Rules     │  │
│  │ • Pattern Match │  │ • Legal Disclaimers │  │
│  └─────────────────┘  └─────────────────────┘  │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │      Registry Logger (Optional)         │   │
│  │  • Classification Signals               │   │
│  │  • Brand Validation History             │   │
│  │  • Statistics (activities table only)   │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
           ↓                    ↓
    System 4.3            System 4.1
  (Approval Workflow)  (Content Generation)
```

## Core Components

### 1. Template Classifier

**Purpose:** Determine if content matches approved templates

**File:** `template-classifier.ts`

**Output:**
```typescript
{
  trust_level: 'brokerage_approved' | 'team_approved' | 'unapproved',
  auto_approval_eligible: boolean,
  confidence_score: 0-100,
  classification_reason: string,
  matched_template?: {...}
}
```

**Classification Rules:**

1. **Brokerage-Approved** (Highest Trust)
   - Explicit brokerage template source
   - Matches brokerage patterns (80%+ confidence)
   - Content types: MLS listings, compliance-required content
   - Channels: Google Ads, Meta Ads

2. **Team-Approved** (Medium Trust)
   - Explicit team template source
   - Matches team patterns (70%+ confidence)
   - Content types: Newsletters, blogs, social posts
   - Channels: Instagram, Facebook, LinkedIn, email

3. **Unapproved** (No Trust)
   - Custom/AI-generated content
   - No pattern match
   - Requires manual review

### 2. Brand Requirements Provider

**Purpose:** Declare required brand elements for content

**File:** `brand-requirements.ts`

**Output:**
```typescript
{
  required_elements: [
    'brokerage_logo',
    'license_number',
    'equal_housing_logo',
    ...
  ],
  optional_elements: [...],
  legal_disclaimers: [...],
  channel_specific_notes: [...]
}
```

**Brand Element Rules:**

- **Public Content** → Brokerage logo + license number
- **Paid Ads** → Full compliance (EHO logo, disclaimers)
- **Email/Newsletter** → Unsubscribe link + privacy policy
- **SMS** → Agent contact + TCPA compliance
- **Direct Mail** → Full attribution (logo, photo, address, license)
- **Video/Audio** → Verbal disclosure

### 3. Registry Logger

**Purpose:** Optional audit trail (activities table only)

**File:** `registry-logger.ts`

**Logged Events:**
- `template_classified` - Template trust level determination
- `brand_requirements_evaluated` - Brand elements declared
- `brand_compliance_validated` - Brand validation result

## Usage Examples

### Example 1: Classify Template

```typescript
import { classifyTemplateAction } from "@/app/actions/brand-template-registry"

const result = await classifyTemplateAction({
  template_id: "tmpl_123",
  template_name: "Just Listed Email",
  template_category: "mls_listing",
  content_type: "email",
  channel_intent: "email",
  is_from_template: true,
  template_source: "brokerage"
}, {
  contentId: "content_uuid",
  logActivity: true
})

// Result:
// {
//   trust_level: 'brokerage_approved',
//   auto_approval_eligible: true,
//   confidence_score: 100,
//   classification_reason: 'Content explicitly created from brokerage-approved template'
// }
```

### Example 2: Get Brand Requirements

```typescript
import { getBrandRequirementsAction } from "@/app/actions/brand-template-registry"

const result = await getBrandRequirementsAction({
  content_type: "newsletter",
  channel_intent: "email",
  audience_scope: "public",
  requires_compliance: true
}, {
  contentId: "content_uuid",
  logActivity: true
})

// Result:
// {
//   required_elements: [
//     'brokerage_logo',
//     'license_number',
//     'unsubscribe_link',
//     'privacy_policy_link',
//     'brokerage_address',
//     'brokerage_disclaimer',
//     'equal_housing_logo'
//   ],
//   legal_disclaimers: [
//     'Email must comply with CAN-SPAM Act requirements',
//     'Content must adhere to all federal, state, and local fair housing laws'
//   ]
// }
```

### Example 3: Validate Brand Compliance

```typescript
import { validateBrandComplianceAction } from "@/app/actions/brand-template-registry"

const result = await validateBrandComplianceAction(
  {
    raw_content: "Your email content here with [logo] and license #12345",
    metadata: {}
  },
  brandRequirements,
  {
    contentId: "content_uuid",
    logActivity: true
  }
)

// Result:
// {
//   is_compliant: false,
//   missing_elements: ['unsubscribe_link', 'privacy_policy_link'],
//   warnings: ['Missing 2 required brand element(s)']
// }
```

### Example 4: Integration with System 4.3 (Approval Workflow)

```typescript
import { classifyTemplateAction } from "@/app/actions/brand-template-registry"
import { determineApprovalDecision } from "@/lib/approval-workflow/approval-engine"

// Step 1: Classify template
const classification = await classifyTemplateAction({
  content_type: "email",
  channel_intent: "email",
  is_from_template: true,
  template_source: "brokerage"
})

// Step 2: Use classification in approval decision
const approval = determineApprovalDecision(
  contentDraft,
  complianceVerdict,
  {
    requester_role: "agent",
    content_origin: classification.data.trust_level === "brokerage_approved" 
      ? "template" 
      : "ai_generated",
    audience_scope: "private"
  }
)

// If brokerage template + private + compliant → AUTO-APPROVED
```

### Example 5: Get Brand Element Descriptions

```typescript
import { getBrandElementDescriptionAction } from "@/app/actions/brand-template-registry"

const result = await getBrandElementDescriptionAction("equal_housing_logo")

// Result:
// "Equal Housing Opportunity (EHO) logo image"
```

### Example 6: Batch Operations

```typescript
import { batchClassifyTemplatesAction } from "@/app/actions/brand-template-registry"

const results = await batchClassifyTemplatesAction([
  { content_type: "email", channel_intent: "email", ... },
  { content_type: "social_post", channel_intent: "instagram", ... },
  { content_type: "newsletter", channel_intent: "email", ... }
])

// Returns array of classifications
```

### Example 7: Statistics & Analytics

```typescript
import { getBrandTemplateStatisticsAction } from "@/app/actions/brand-template-registry"

const stats = await getBrandTemplateStatisticsAction({
  start: "2024-01-01",
  end: "2024-12-31"
})

// Result:
// {
//   total_classifications: 1250,
//   brokerage_approved_count: 450,
//   team_approved_count: 600,
//   unapproved_count: 200,
//   auto_approval_eligible_count: 850,
//   average_confidence_score: 78.5,
//   total_brand_validations: 1100,
//   compliant_count: 950,
//   non_compliant_count: 150
// }
```

## Server Actions (Public API)

### Template Classification
- `classifyTemplateAction()` - Classify single template
- `batchClassifyTemplatesAction()` - Classify multiple templates
- `checkAutoApprovalEligibilityAction()` - Check auto-approval eligibility

### Brand Requirements
- `getBrandRequirementsAction()` - Get brand requirements for context
- `batchGetBrandRequirementsAction()` - Batch brand requirements
- `validateBrandComplianceAction()` - Validate brand compliance
- `getBrandElementDescriptionAction()` - Get element description

### History & Statistics
- `getTemplateClassificationHistoryAction()` - Get classification history
- `getBrandComplianceHistoryAction()` - Get compliance history
- `getBrandTemplateStatisticsAction()` - Get statistics

### Utilities
- `formatTemplateClassificationAction()` - Format for display
- `formatBrandRequirementsAction()` - Format for display

## Schema Compliance

**READ:** None required (all runtime inputs)

**WRITE:** `activities` table only (optional logging)

**FORBIDDEN:**
- `templates` table (does NOT exist)
- `brand_assets` table (does NOT exist)
- `template_library` table (does NOT exist)
- Any persistent template storage

## Integration Points

### Upstream (Consumers)
- **System 4.3** (Approval Workflow) - Uses template trust for auto-approval
- **System 4.2** (Compliance Rules) - Uses brand requirements for validation
- **System 4.1** (Content Generation) - Can query requirements before generation

### Downstream (Dependencies)
- None (foundational system)

## Design Principles

1. **Reference Authority** - Declares what is approved, doesn't enforce
2. **Stateless Evaluation** - No persistent state except activity logs
3. **Pattern-Based Matching** - Logical classification, not file storage
4. **Channel-Aware** - Different rules per channel
5. **Compliance-First** - Legal requirements built-in

## Non-Goals

- ❌ Template storage (no CMS)
- ❌ Asset management (no DAM)
- ❌ Content generation
- ❌ Approval enforcement
- ❌ Publishing
- ❌ UI components

## Future Enhancements

When schema changes are allowed:

1. **Persistent Template Library** - Store template definitions
2. **Brand Asset Storage** - Store logos, images, signatures
3. **Template Versioning** - Track template changes over time
4. **Visual Template Builder** - UI for creating templates
5. **A/B Testing** - Track template performance

## Troubleshooting

**Q: Template not classified as approved?**
- Check `template_source` is set to "brokerage" or "team"
- Verify `is_from_template` is true
- Review confidence score and patterns

**Q: Missing brand requirements?**
- Check `audience_scope` (public requires more)
- Verify `is_paid_ad` flag for ads
- Review channel-specific requirements

**Q: Brand validation failing?**
- Check required elements are in content
- Use element descriptions to understand what's needed
- Review legal disclaimers

## Production Checklist

- [x] Template classifier implemented
- [x] Brand requirements provider implemented
- [x] Activity logging (optional)
- [x] Server actions (public API)
- [x] Input validation
- [x] Error handling
- [x] Documentation complete
- [x] Zero schema modifications
- [x] Integration examples provided

---

**System Status:** ✅ Production Ready

**Dependencies:** System 4.3 (Approval Workflow), System 4.1 (Content Generation)

**Schema Modifications:** ZERO (compliant)
