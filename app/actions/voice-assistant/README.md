# SYSTEM 6.1 v0 - CONTROLLED COMMAND LAYER

**Production-Grade Voice Command Execution Interface**

## Overview

System 6.1 is a controlled execution interface that accepts natural language voice input from agents, team leaders, and brokerage staff, validates authority and readiness, dispatches commands to existing system actions, and maintains a complete audit trail—all without modifying the database schema.

### What System 6.1 DOES

✅ Accepts natural language voice input  
✅ Parses intent using LLM  
✅ Validates role-based authority  
✅ Validates readiness using lifecycle events  
✅ Dispatches to existing system actions (5.1/5.2/5.3/4.8/Communications)  
✅ Emits audit events to activities table  
✅ Generates TTS responses  
✅ Enforces all governance rules  

### What System 6.1 DOES NOT DO

❌ Own lifecycle logic  
❌ Store journey state  
❌ Create workflows  
❌ Manage background subscriptions  
❌ Execute macros  
❌ Store conversation memory  
❌ Modify database schema  
❌ Accept commands from buyers/sellers  

## Architecture

```
Voice Input 
  → Intent Parse (LLM)
    → Entity Resolution (DB lookup)
      → Authority Validation (role + entity access)
        → Readiness Validation (lifecycle events)
          → Dispatch Command (system action)
            → Audit Event (activities table)
              → TTS Response
```

## File Structure

```
/app/actions/voice-assistant/
├── handle-voice-command.ts        # Main entry point
├── core/
│   ├── parse-intent.ts            # LLM intent parsing
│   ├── resolve-entities.ts        # Address → ID, Name → ID
│   ├── validate-authority.ts      # Role + entity access checks
│   ├── validate-readiness.ts      # Lifecycle event checks
│   ├── dispatch-command.ts        # Execute system actions
│   ├── generate-response.ts       # TTS response generation
│   └── emit-audit-event.ts        # Activities table logging
├── helpers/
│   ├── authority-matrix.ts        # Role permissions matrix
│   ├── command-map.ts             # Voice → system action mappings
│   └── readiness-rules.ts         # Required events per command
└── README.md                      # This file
```

## Supported Roles

✅ **Allowed:**
- agent
- team_leader
- admin
- broker
- transaction_coordinator
- compliance_manager
- vendor (limited scope)

❌ **Disallowed:**
- buyer
- seller
- anonymous

## Supported Commands (v0 Scope)

### Query Commands (Read-Only)

| Command | Description | Roles |
|---------|-------------|-------|
| `query_listing_status` | Get current listing stage | agent, team_leader, admin, broker |
| `query_buyer_stage` | Get buyer journey stage | agent, team_leader, admin, broker |
| `query_showing_schedule` | View scheduled showings | agent, team_leader |
| `query_mls_readiness` | Check MLS readiness blockers | agent, team_leader, admin |
| `query_agreement_status` | Check agreement signature status | agent, team_leader, transaction_coordinator |
| `query_media_approval_status` | Check media approval status | agent, team_leader |

### Execution Commands

| Command | Description | Roles | Required Events |
|---------|-------------|-------|----------------|
| `generate_cma` | Generate CMA | agent, team_leader | seller.appointment.scheduled |
| `generate_net_sheet` | Generate net sheet | agent, team_leader | seller.appointment.scheduled |
| `generate_presentation` | Generate presentation | agent, team_leader | seller.appointment.scheduled |
| `schedule_appointment` | Schedule listing appointment | agent | - |
| `schedule_media` | Schedule photography | agent | - |
| `approve_media` | Approve photos/video | agent, team_leader | - |
| `activate_coming_soon` | Activate coming soon | agent, team_leader | seller.media.approved |
| `submit_to_mls` | Submit to admin for MLS | agent, team_leader | (multiple) |
| `activate_mls` | Activate MLS (admin only) | admin | (multiple) |
| `schedule_open_house` | Schedule open house | agent | - |
| `approve_open_house_marketing` | Approve OH marketing | agent, team_leader | seller.mls.ready |
| `schedule_showing` | Schedule showing | agent | - |
| `configure_buyer_search` | Set buyer search prefs | agent | buyer.financial.verified |
| `lender_confirm_financials` | Confirm pre-approval | vendor | - |
| `admin_override_financial_gate` | Override financial gate | admin, broker | - |

## Usage Examples

### Basic Voice Command

```typescript
import { handleVoiceCommand } from '@/app/actions/voice-assistant/handle-voice-command'

const result = await handleVoiceCommand({
  voice_input: "Generate CMA for 123 Main Street",
  user_id: "agent-uuid",
  user_role: "agent",
  brokerage_id: "brokerage-uuid"
})

console.log(result.spoken_response)
// "I've generated the Comparative Market Analysis. It's ready for review."
```

### Voice Command with Context

```typescript
const result = await handleVoiceCommand({
  voice_input: "Activate MLS for this listing",
  user_id: "admin-uuid",
  user_role: "admin",
  brokerage_id: "brokerage-uuid",
  context: {
    current_listing_id: "listing-uuid"
  }
})
```

### Authority Denial

```typescript
// Agent tries to activate MLS (admin only)
const result = await handleVoiceCommand({
  voice_input: "Activate MLS",
  user_id: "agent-uuid",
  user_role: "agent",  // ❌ Not authorized
  brokerage_id: "brokerage-uuid",
  context: { current_listing_id: "listing-uuid" }
})

console.log(result.spoken_response)
// "You are not authorized to activate MLS. Admin role is required."
```

### Readiness Blocker

```typescript
// Try to activate MLS before media approved
const result = await handleVoiceCommand({
  voice_input: "Activate MLS",
  user_id: "admin-uuid",
  user_role: "admin",
  brokerage_id: "brokerage-uuid",
  context: { current_listing_id: "listing-uuid" }
})

console.log(result.spoken_response)
// "MLS activation blocked. Media approval is missing."
```

## Audit Trail

All voice commands emit events to the `activities` table:

### Success Event

```json
{
  "activity_type": "voice.command.executed",
  "brokerage_id": "uuid",
  "user_id": "uuid",
  "listing_id": "uuid",
  "status": "completed",
  "metadata": {
    "raw_command": "Generate CMA for 123 Main Street",
    "parsed_action": "generate_cma",
    "target_system": "cma",
    "success": true,
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

### Failure Event

```json
{
  "activity_type": "voice.command.failed",
  "brokerage_id": "uuid",
  "user_id": "uuid",
  "status": "failed",
  "metadata": {
    "raw_command": "Activate MLS",
    "reason": "You do not have permission to activate MLS",
    "failure_type": "authority_denied",
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

## Integration with Web Speech API

```typescript
// Client-side (browser)
if ('webkitSpeechRecognition' in window) {
  const recognition = new webkitSpeechRecognition()
  recognition.continuous = false
  recognition.interimResults = false

  recognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript
    
    // Send to server
    const result = await handleVoiceCommand({
      voice_input: transcript,
      user_id: currentUser.id,
      user_role: currentUser.role,
      brokerage_id: currentUser.brokerage_id
    })

    // Speak response
    const utterance = new SpeechSynthesisUtterance(result.spoken_response)
    speechSynthesis.speak(utterance)
  }

  recognition.start()
}
```

## Security

### Authority Validation

1. **Role-based:** User role must be in allowed list for command
2. **Entity-level:** User must have access to listing/contact
3. **Brokerage scope:** All entities must belong to user's brokerage

### Readiness Validation

1. **Event-driven:** Uses activities table events (NOT columns)
2. **Governance enforced:** Cannot bypass lifecycle requirements
3. **Fail-closed:** Validation failures deny execution

### Audit Trail

1. **Complete logging:** All attempts logged (success + failure)
2. **Full context:** Raw command, parsed action, reason, timestamp
3. **Immutable:** Activities table provides audit trail

## Schema Compliance

✅ **Reads from:**
- listings (entity lookup)
- contacts (entity lookup)
- activities (readiness validation + audit history)

✅ **Writes to:**
- activities (audit events ONLY)

❌ **Does NOT:**
- Create new tables
- Modify schema
- Store conversation memory
- Store session state

## Error Handling

### Low Confidence Intent
```
User: "Do the thing"
Response: "I didn't understand that command. Could you rephrase it?"
```

### Entity Disambiguation
```
User: "Generate CMA for Main Street"
Response: "I found 3 properties matching Main Street. Which one did you mean?"
Options: ["123 Main St, City, ST 12345", "456 Main St, City, ST 12345", ...]
```

### Authority Denial
```
User: "Activate MLS"
Response: "You are not authorized to activate MLS. Admin role is required."
```

### Readiness Blocker
```
User: "Activate MLS"
Response: "I can't activate MLS yet. You need to complete: media approval, coming soon activation."
```

### Execution Error
```
User: "Generate CMA"
Response: "I encountered an error trying to generate CMA. Please try again or contact support."
```

## Extending System 6.1

### Add New Command

1. **Add to authority matrix** (`helpers/authority-matrix.ts`)
2. **Add to command map** (`helpers/command-map.ts`)
3. **Add readiness rules** (`helpers/readiness-rules.ts`) if needed
4. **Add response template** (`core/generate-response.ts`)

### Add New System Integration

Update `command-map.ts`:

```typescript
my_new_command: {
  module_path: '@/app/actions/my-system/my-action',
  function_name: 'myActionFunction',
  param_mapping: {
    voice_param: 'action_param'
  }
}
```

## Production Checklist

✅ LLM intent parsing works  
✅ Entity resolution works  
✅ Authority enforced for all commands  
✅ Readiness enforced for all execution commands  
✅ Commands dispatch to real system actions  
✅ Errors handled cleanly  
✅ Audit events emitted  
✅ No schema changes  
✅ No workflow duplication  
✅ No journey manipulation  
✅ Mobile compatible  
✅ No mock logic  
✅ No console-only output  

## Known Limitations (v0)

- No multi-step chaining
- No batch execution
- No macros
- No conversation memory
- No background subscriptions
- Agent-facing only (no buyer/seller access)
- Single command per request

## Future Enhancements (Post-v0)

- Multi-turn conversations (with explicit user session management)
- Proactive notifications (separate system)
- Voice biometric authentication
- Custom wake words
- Multi-language support
