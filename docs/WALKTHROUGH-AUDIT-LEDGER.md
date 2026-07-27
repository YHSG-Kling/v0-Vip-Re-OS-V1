# Live Walkthrough — Itemized Audit Ledger

Source: the owner's live-check document, *"Required documents — documents you need for file before
submitting to compliance"*. 134 findings, numbered here by their line in that document so every row
is traceable back to the original text.

Three states are used, and they mean different things:

- **CLOSED** — fixed, with the commit that did it. Verified beyond "it compiles".
- **CLOSED (class)** — fixed as part of a root-cause cluster rather than individually.
- **OPEN** — investigated and confirmed still outstanding. Each carries what it actually needs.

An item is never marked closed because the code merely runs. The owner's standing rule applies:
*"just because it works, doesn't mean that it is a closed item."*

---

## The single largest finding

Roughly a sixth of the document is **one root cause wearing different names**:

> [51] "Agent portal deny no access staff access required" · [53] "Open house — agent identity
> required" · [56] "Documentation unauthorized" · [82] "Transaction — is not authorized" ·
> [93] "Pipeline — same" · [98] "Inbox, AI Outreach, Comm Intelligence, Handoff cockpit — all
> bounced back" · [104] "Stale Queue — bounce back" · [105] "Financials — kicks me to login page" ·
> [110] "AI Command center — Bump" · [111] "Monthly Intelligence Report — Bump" · [116] "Daily
> Briefing failed to load agent context not available" · [120] "My goals — agent profile not
> found" · [121] "Voice intelligence — bounces" · [123] "Some boxes and buttons bounce" ·
> [124] "Challenges — bounce" · [130] "Home value tool — no agent record found for your account" ·
> [133] "ISA calling — Brokerage required" · [134] "Some bumps"

Every one is a signed-in agent whose account is missing a `brokerage_id` and/or an `agents` row,
landing on a work page that redirects them away instead of repairing the account.

**Fixed in `24e7e55`**, two parts:

1. Fourteen work pages resolved identity through the raw `getAgentContext` and redirected on an
   incomplete result. They now resolve through `ensureAgentContextInPlace`, which provisions the
   missing records and re-resolves, so the page renders. The redirect survives only as the
   genuinely-unprovisionable fallback (a pending brokerage invite, or a staff user whose brokerage
   comes from their org).
2. The deeper bug, found while verifying the first: `ensureAgentBrokerage` returned early on **any**
   user carrying a `brokerage_id` as "nothing to heal". Anchored is not complete — a user can hold a
   `brokerage_id` and still be missing their `agents` row, and that account stayed broken forever
   because the one function that could fix it declined to look. It now runs the canonical
   `createOrRepairUserDomainRecords` for that state, using the brokerage's real `plan_tier`.

Verified against the live schema, not asserted: the broken state was confirmed to **exist on real
accounts** (6 users with no brokerage; 4 agent-type users with no `agents` row — real accounts, left
untouched). A disposable probe reproduced the state, the repair resolved both `brokerage_id` and
`agents.id` through `get-agent-context`'s own resolution path, and the probe was removed to zero
residue. Locked by `test:identity-self-heal` (21 checks), owned by `data_steward`.

---

## Ledger

| # | Finding (abridged) | State | Evidence |
|---|---|---|---|
| 2 | Required-docs seed defaults: no upload / no add to transaction checklist | CLOSED | `m282` + template-form attach on the checklist |
| 4 | Feature governance — can't change enrollment, not really functional | OPEN | Platform-tier surface; needs a real enrollment write path |
| 6 | Video analytics looks old / plain | CLOSED | `afade62` — distribution vs hook vs missing-ask diagnosis |
| 8 | SLA monitor — plain dashboard | CLOSED | `ccfe9b1` — leads with silent (un-notified) breaches |
| 10 | Visitor tracking — snippet with no directions | OPEN | Needs install instructions + verification ping |
| 12 | Billing navigation knocked me to login | CLOSED (class) | `24e7e55` — identity bounce |
| 14 | Usage meter — monitor AI/storage/voice consumption | OPEN | Confirm platform-only placement, then give it a read |
| 16 | System intelligence says all providers up with none configured | OPEN | Readiness must distinguish *up* from *unconfigured* |
| 18 | Audit trail — basic reporting | CLOSED | `87f8698` — honest capped-window limitation stated |
| 20 | AI audit trail — plain | CLOSED | `c7e5a10` — unreviewed AI output + age of oldest |
| 22 | Error handler — plain dashboard | CLOSED | `5a0ae11` — "one broken thing repeating" triage |
| 24 | What's new — too much detail pre-launch | OPEN (by owner's choice) | Owner asked to hold this until launch |
| 26–29 | Settings tree duplicates (General / Integrations / Email-calendar) | CLOSED | `5b29659` — Integrations redirects to the advanced `/settings/connections`; the other 14 settings surfaces investigated and confirmed distinct, not duplicates |
| 27 | General settings names the *app*, not the tenant | OPEN | Should carry tenant identity, not app naming |
| 30 | Facebook OAuth connect button failed → bounced to profile | OPEN | Needs a live OAuth round trip; cannot close headless |
| 31–34 | CRM sync / phone-SMS / brand voice / brand settings | CLOSED | Advanced connections surface retained per the keep-the-advanced rule |
| 35 | Email templates — no place to view them | OPEN | List/preview view missing |
| 36–37 | Notifications, commission calculation | CLOSED | Present and wired |
| 38 | Agent downline? | CLOSED | Referral downline in Agent 360, tenant-gated on the recruiting program |
| 43 | User Management + Invite can only change Roles | CLOSED | `d46dc92`/`6eff902` Agent 360 · `770838f` Staff 360 — full user view, not just role edit |
| 44–45 | Profile goes to settings / Settings goes to settings | OPEN | Nav destinations need separating |
| 46 | Inbox has no window to type in | CLOSED | Unified inbox compose + outbound social DM (`7e2f551`) |
| 47 | Can't bring up an agent's account and apply/remove onboarding | CLOSED | `6eff902` — `OnboardingControl` on the Agent 360 panel |
| 49 | Property type should be a selection | OPEN | Free-text → constrained select, tenant-scoped to target area |
| 50 | Upload errors with no bucket | CLOSED | `m278` — 11 buckets provisioned, verified live |
| 51–56 | Agent portal / open house / showing prep / documentation authz | CLOSED (class) | `24e7e55` |
| 57–77 | Brokerage plan onboarding chain (license, E&O, phone, connects, twins) | PARTIAL | Twin Studio surfaced (task 39); the connect legs need live OAuth to close |
| 82–86 | Transaction authz, closing concierge, contract page, overdue, weekly insights | CLOSED (class) + OPEN [84] | `24e7e55`; [84] contract review page still needs its load path traced |
| 87–88 | Forms library, office pipeline basic | CLOSED | Forms library work (tasks 11–15, 19) |
| 90–94 | Video credits / twin studio / my videos spinner / pipeline | PARTIAL | Twin Studio + video surfaces consolidated (tasks 37–39, 49); the credit-gate UX remains |
| 95–96 | Market same as admin; campaign only repurpose | CLOSED | Tasks 26, 38, 44 — Ops Center and Market Studio merged |
| 98 | Inbox / AI Outreach / Comm Intelligence / Handoff all bounced | CLOSED (class) | `24e7e55` |
| 99–103 | Market insights setup, behavioral/agent/campaign patterns | OPEN | Pattern filters return nothing for the agent lens |
| 104–105 | Stale queue bounce, financials kicks to login | CLOSED (class) | `24e7e55` |
| 106 | My fees separate from commissions — should be one umbrella | OPEN | Directly adjacent to the commission keep-one (`m283`/`m284`); the fee ledger should fold into the same spine |
| 107 | Credit pipeline — unclear budget figures | OPEN | Needs a real read of what the numbers mean |
| 109 | Academy — My Template and My Path buttons go nowhere | CLOSED | Tasks 19, 50 — education/academy split and content generation |
| 110–111 | AI Command center, Monthly Intelligence Report — bump | CLOSED (class) | `24e7e55` |
| 113 | AI Toolkit — page can't load | OPEN | Needs its own trace; not the identity class |
| 114 | AI Chat — no unified box | CLOSED | Task 54 — three floating assistants merged into one |
| 115 | Voice assistant speaks as admin to an agent | OPEN | Persona must follow the viewer's role |
| 116 | Daily briefing — agent context not available | CLOSED (class) | `24e7e55` |
| 117 | Pipeline analytics plain | OPEN | Candidate for the "dashboard reads itself" pattern |
| 118 | Trains & Coaching — analyze-goals button goes nowhere | OPEN | Unwired button |
| 119 | Objection practice hard-coded cards | CLOSED | Task 56 — scenarios generated from real mishandled-objection calls |
| 120–121 | My goals / voice intelligence bounce | CLOSED (class) | `24e7e55` |
| 122 | Motivations — well built | — | Owner marked this good |
| 123–124 | Boxes bounce; challenges bounce | CLOSED (class) | `24e7e55` |
| 125 | Business diagnosis — good | — | Owner marked this good |
| 126 | Reports basic; commission shouldn't show | CLOSED | Task 57 — commission removed, Summary made a real snapshot |
| 128 | Business cards — file won't add | CLOSED | `m278` — `business-cards` bucket provisioned |
| 129 | QR codes 404 | CLOSED | Route resolves; all 224 nav hrefs audited against real pages |
| 130 | Home value tool — no agent record found | CLOSED (class) | `24e7e55` |
| 131 | Calculators — good | — | Owner marked this good |
| 133–134 | ISA calling brokerage required; some bumps | CLOSED (class) | `24e7e55` |
| 135 | Token not working / settings page sends to another settings page | PARTIAL | The settings-tree redirects are resolved; the token path still needs a live check |

---

## Duplicate sweep

Per the owner's rule — *"we either merge them or keep one and let the others removed but only after
a full investigation of dependencies and business process"*:

| Duplicate pair | Decision | Basis |
|---|---|---|
| `commissions` vs `agent_commissions` | **Merged onto `agent_commissions`** (`m283` superset, `m284` drop) | 25 consumers vs 7; keeper has the dispute/approval lifecycle and QuickBooks export. All 7 exclusive columns ported, all consumers repointed, three drop-blockers investigated individually rather than CASCADE'd |
| `/settings/*` vs `/dashboard/settings/*` | **No duplication to remove** | `branding`, `general`, `notification-rules`, `teams` are already redirects to `/settings/*`; the other 14 are distinct surfaces. Investigated before touching |
| `/settings/integrations` vs `/settings/connections` | **Kept connections** (advanced) | `5b29659` — matches the owner's "take the advanced" rule; the manual provider list became a documented redirect and its orphaned action was removed |
| Market Studio vs Ops Center | **Merged** | Tasks 26, 38 |
| Three floating AI assistants | **Merged into one** | Task 54 |
| Two KB embedding pipelines | **Merged into one** | Task 18 |

## Cannot be closed headless

Two loops need a preview environment with real credentials, and are honestly still open:

1. **Social DM live-fire** — the send path is built and guarded (`7e2f551`), but proving a real
   outbound DM requires live OAuth tokens on a connected account.
2. **Countersigned commission-agreement webhook return** — needs a real e-sign provider callback.
