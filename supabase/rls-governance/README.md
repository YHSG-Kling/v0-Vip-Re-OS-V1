# Row Level Security (RLS) Governance System

## Overview

This folder contains the authoritative Row Level Security (RLS) policies for the Supabase-backed real estate CRM application. These policies define **who can access what data** based on user type and brokerage boundaries.

## Core Philosophy

### 1. User Type is Authority
- **user_type** field in the `users` table is the ONLY field that determines permissions
- **contact_persona** is UX-only and has ZERO impact on access control
- Personas are handled by the journey/portal systems for educational/transparency purposes only

### 2. Authoritative User Types

| User Type | Description | Access Scope |
|-----------|-------------|--------------|
| `admin` | System administrator | Bypass brokerage isolation, full access |
| `broker` | Brokerage owner/manager | All data within their brokerage |
| `agent` | Real estate agent | Own records + assigned records |
| `team_leader` | Team lead | Team-scoped records |
| `transaction_coordinator` | TC | Transaction milestones, documents |
| `compliance_manager` | Compliance officer | Read-only brokerage-wide compliance data |
| `vendor` | External vendor | Transaction-scoped only |
| `lender` | Mortgage lender | Transaction-scoped only |
| `title_agent` | Title/escrow agent | Transaction-scoped only |
| `contact` | End client/customer | Self-visibility only (own data) |

### 3. Brokerage Isolation

All primary business data MUST be isolated by `brokerage_id`:
- `admin` may bypass this isolation
- `broker` may access all records within their brokerage
- All other roles respect strict brokerage boundaries
- **NO cross-brokerage reads or writes** (except admin)

### 4. Agent & Team Ownership

- Agents may read/write records where `agent_id = auth.uid()`
- Team leaders may read records where team membership is explicit
- Agents may NOT see other agents' leads unless explicitly assigned
- Assignment must be recorded in `agent_id`, `assigned_agent_id`, or explicit sharing arrays

### 5. Contact Self-Visibility

Contacts (end clients) have LIMITED read-only access:
- ✅ Their own `contacts` record
- ✅ Their own `transactions`
- ✅ Their own `client_documents`
- ✅ Their own `journey_states` (educational layer)
- ❌ May NOT modify transaction truth
- ❌ May NOT see internal notes/scoring
- ❌ May NOT see other contacts
- ❌ May NOT see leads (leads are internal-only)

### 6. Transaction Coordinator Access

TCs have specialized transaction-focused permissions:
- ✅ Read/write `transaction_milestones`
- ✅ Upload and verify documents
- ✅ Read transaction details
- ❌ May NOT modify financials or commissions

### 7. Compliance Manager Authority

Compliance officers have broad read access for auditing:
- ✅ Read all transactions within brokerage
- ✅ Read/write `compliance_flags`
- ✅ Verify document completeness
- ✅ Approve/reject closing disclosures
- ❌ May NOT modify deal financials
- ❌ May NOT delete records

### 8. Vendor/Lender/Title Agent Scoping

External parties have transaction-scoped access only:
- Access limited to assigned transactions via `deal_team_members`
- No global visibility into brokerage
- Read/write only data explicitly related to their transaction
- No access to leads or unrelated contacts

### 9. Lead System Safety

Leads are strictly internal:
- Leads are NOT visible to `contact` user type
- Lead routing/scoring relies on agent-level policies
- Assignment writes must be agent- or system-authorized
- Enrichment data is protected

### 10. Journey & Transparency Layer

Journey system is educational, NOT authoritative:
- `journey_states` and `journey_blueprints` are READ-ONLY for contacts
- `transaction.stage` and `milestones` are the source of truth
- Journey mirrors transaction state for client education
- Transparency updates provide plain-language summaries

## Implementation Strategy

### Helper Functions

All policies use helper functions for consistency:

```sql
auth.user_type() → Returns current user's user_type
auth.user_brokerage_id() → Returns current user's brokerage_id
auth.is_admin() → Returns true if user_type = 'admin'
auth.is_broker() → Returns true if user_type = 'broker'
auth.is_agent() → Returns true if user_type = 'agent'
auth.is_contact() → Returns true if user_type = 'contact'
auth.owns_record(table, id) → Checks if user owns a specific record
```

### Policy Naming Convention

All policies follow this pattern:
```
[user_type]_[operation]_[table]_[condition]

Examples:
- admin_full_contacts
- broker_read_brokerage_transactions
- agent_read_own_leads
- contact_read_own_transactions
- tc_write_milestones
```

### Default to Least Privilege

When ambiguity exists:
- Default to **denying access**
- Require explicit grants for sensitive data
- Favor read-only over read-write
- Log access patterns for auditing

## File Structure

```
supabase/rls-governance/
├── README.md (this file)
├── 000-helper-functions.sql
├── 001-users-policies.sql
├── 002-contacts-policies.sql
├── 003-leads-policies.sql
├── 004-transactions-policies.sql
├── 005-listings-policies.sql
├── 006-documents-policies.sql
├── 007-journey-policies.sql
├── 008-compliance-policies.sql
├── 009-vendor-access-policies.sql
├── 010-team-policies.sql
└── 999-verification-queries.sql
```

## Integration with Application

### TypeScript Helper (Reference)

```typescript
// lib/auth/permissions.ts
export async function getCurrentUserType(supabase: SupabaseClient) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  
  const { data } = await supabase
    .from('users')
    .select('user_type, brokerage_id')
    .eq('id', user.id)
    .single()
  
  return data
}

export async function canAccessTransaction(
  supabase: SupabaseClient,
  transactionId: string
) {
  // RLS policies handle this automatically
  const { data, error } = await supabase
    .from('transactions')
    .select('id')
    .eq('id', transactionId)
    .single()
  
  return !error && data !== null
}
```

### Query Patterns

All queries automatically respect RLS:

```typescript
// ✅ Correct: RLS enforces access automatically
const { data: contacts } = await supabase
  .from('contacts')
  .select('*')
// Returns only contacts the user can access

// ✅ Correct: Explicit filtering still applies
const { data: myContacts } = await supabase
  .from('contacts')
  .select('*')
  .eq('agent_id', userId)
// Returns only user's own contacts (subset of RLS-allowed)

// ❌ Incorrect: Trying to bypass RLS won't work
const { data: allContacts } = await supabase
  .from('contacts')
  .select('*', { bypassRLS: true }) // Not possible without service role
```

## Testing RLS Policies

Use the verification queries in `999-verification-queries.sql` to test:

```sql
-- Test as agent
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub": "agent-uuid", "role": "authenticated"}';

SELECT * FROM contacts; -- Should see only own contacts
SELECT * FROM transactions; -- Should see only own transactions
SELECT * FROM leads; -- Should see only assigned leads
```

## Maintenance

### Adding New Tables

When adding new tables:
1. Identify if table needs brokerage isolation
2. Add `brokerage_id UUID REFERENCES brokerages(id)` if needed
3. Enable RLS: `ALTER TABLE new_table ENABLE ROW LEVEL SECURITY;`
4. Create policies following the patterns in this folder
5. Test with all user types
6. Document in this README

### Modifying Policies

When changing policies:
1. Document WHY the change is needed
2. Test with affected user types
3. Verify no unintended access grants
4. Update this README if philosophy changes
5. Run verification queries

### Security Audits

Regular security audits should:
1. Review all policies for least-privilege compliance
2. Check for missing policies on new tables
3. Verify helper functions are current
4. Test edge cases (team changes, brokerage transfers)
5. Review audit logs for suspicious patterns

## Contact

For questions about RLS governance:
- Review this README first
- Check the SQL comments in policy files
- Refer to Supabase RLS documentation
- Test with verification queries before asking

## License

Internal use only. These policies are specific to this application's security model.
