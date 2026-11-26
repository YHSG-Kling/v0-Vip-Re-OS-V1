> **DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE**

# Packet 6 — Schedule 6: Tenant-Owned Provider Connection and Authorization Schedule

Version: 0.1.0-draft (2026-11-09) · Document ID: VIP-LEGAL-P6 · Wave 151, lane 151A2 · Written against commit `b2c93720`

This Schedule is incorporated into the Platform Subscription and Services Agreement (Packet 1). It is a **reusable** schedule: `[[SUBSCRIBER_LEGAL_ENTITY]]` completes one connection record (Part 2) for each provider account it connects from its own side, the general terms in Part 3 apply to every connection, and Part 4 adds a variation only where a provider's terms or the Service's implementation require one. Nothing in this Schedule changes Subscriber's Tier, Seats or membership model; connecting a provider is a settings action, not a purchase.

## Variables

| Variable | Meaning | Status |
|---|---|---|
| `[[PLATFORM_LEGAL_ENTITY]]` | The contracting platform entity (Packet 1). | OPEN |
| `[[SUBSCRIBER_LEGAL_ENTITY]]` | The subscriber (Packet 1). | PER-SUBSCRIBER |
| `[[PROVIDER_NAME]]` | The provider being connected, by its canonical name in the Service. | PER-CONNECTION |
| `[[PROVIDER_TERMS_URL]]` | The provider's terms of service or developer terms that govern the account. | PER-CONNECTION |
| `[[PROVIDER_TERMS_CONFIRMATION_DATE]]` | The date the connection owner confirmed they have read and may bind the account to those terms. | PER-CONNECTION |
| `[[CONNECTION_OWNER_NAME]]` | The natural person who owns or administers the provider account and authorizes the connection. | PER-CONNECTION |
| `[[CONNECTION_OWNER_SCOPE]]` | The ownership scope the connection is stored at: agent, team or brokerage. | PER-CONNECTION |
| `[[PROVIDER_ACCOUNT_ID]]` | The provider's account, profile or workspace identifier — never a key, token or secret. | PER-CONNECTION |
| `[[CONNECTION_DATA_CATEGORIES]]` | The categories of data the connection sends to and receives from the provider. | PER-CONNECTION |
| `[[TERRITORY_DEFINITION]]` | Territory scope where the provider's data is territory-bound (Schedule 3). | OPEN |
| `[[CONNECTION_REFRESH_SCHEDULE]]` | How often the connection refreshes data or tokens. | PER-CONNECTION |
| `[[CONNECTION_DELETION_TERMS]]` | What is deleted from the Service, and from the provider, on disconnect. | PER-CONNECTION |
| `[[KEY_ROTATION_PERIOD_DAYS]]` | The period after which a stored key is flagged for rotation. | OPEN |
| `[[CONNECTION_INCIDENT_CONTACT]]` | Who at the subscriber is notified of a connection incident. | PER-CONNECTION |
| `[[CONNECTION_ACCEPTANCE_RECORD]]` | Where the connection owner's acceptance of this Schedule and the provider's terms is recorded. No per-connection acceptance record exists in code today. | OPEN |

---

## 1. Purpose and the two ownership models

1.1 The Service uses two kinds of provider. A **Platform-Owned Provider** is contracted, paid and metered by Platform under Subscriber's subscription (Schedule 3 §3). A **Tenant-Connected Provider** is an account `[[SUBSCRIBER_LEGAL_ENTITY]]` holds with a vendor and chooses to connect so the Service can act through it — send from its own mailbox, search its own MLS feed, publish to its own social accounts, send its own e-signature envelopes, keep its own books, collect its own payments. The tenancy matrix records which model applies to each vendor (`lib/providers/tenancy-matrix.ts::PROVIDER_TENANCY`) and the connection scope lists what may be connected by domain (`lib/connections/scope.ts::CONNECTOR_PROVIDERS`).

1.2 A Tenant-Connected Provider is Subscriber's vendor, not Platform's subprocessor (Schedule 4 Part B §B.4.3). Subscriber pays the vendor, holds the contract, grants the scopes, and may disconnect at any time. Platform transmits only what the connection and Subscriber's instructions require.

1.3 Some vendors are **built but not offered** — code exists but the vendor is deliberately absent from the connectable list until an ownership, storage or licensing decision is made (`lib/connections/scope.ts::CANDIDATE_PROVIDERS`). Such a vendor cannot be connected and this Schedule does not apply to it.

## 2. The connection record

Subscriber completes one record per connection. The record is kept in the Service's connection store with the provider's credential sealed under authenticated encryption; the fields below are the record's content, and the Service's settings surface is where they are entered.

| Field | Entry |
|---|---|
| Provider | `[[PROVIDER_NAME]]` (canonical name as the Service lists it) |
| Provider terms | `[[PROVIDER_TERMS_URL]]`, confirmed on `[[PROVIDER_TERMS_CONFIRMATION_DATE]]` by the connection owner |
| Tenant account owner | `[[CONNECTION_OWNER_NAME]]`, acting for `[[SUBSCRIBER_LEGAL_ENTITY]]` |
| Ownership scope | `[[CONNECTION_OWNER_SCOPE]]` — agent (the user's own account), team (the team's account) or brokerage (the brokerage's account). Resolution cascades most-specific first: an agent's connection beats the team's, which beats the brokerage's, which beats any platform fallback (`lib/connections/resolve-scoped.ts::resolveScopedConnection`). |
| Provider account identifier | `[[PROVIDER_ACCOUNT_ID]]` — an account, profile, workspace or merchant identifier; **never a key, token, password or secret**, which are entered only in the credential field and are never displayed again. |
| Authority granted | One of: an API key the owner issued; an OAuth grant with the listed scopes; a webhook subscription the owner created in the provider's console. The Service records which. |
| Data categories | `[[CONNECTION_DATA_CATEGORIES]]` — what the Service sends to the provider and what it receives, by category. |
| Permitted collection, storage and AI use | What the Service may read from the provider, what it may store on Subscriber's records, how long, and whether the data may be sent to the AI gateway as part of a task; defaults per provider are in Part 4. |
| Territory | `[[TERRITORY_DEFINITION]]` where the provider's data is territory-bound; otherwise "not territory-bound". |
| Cost payer | Subscriber, directly to the provider. The Service books no cost for a Tenant-Connected call. |
| Limit controls | The provider's own plan limits and rate limits, which the Service honors; the Service's own per-Tenant caps where any apply (Part 4). |
| Refresh | `[[CONNECTION_REFRESH_SCHEDULE]]` for tokens and data. |
| Deletion on disconnect | `[[CONNECTION_DELETION_TERMS]]` — see Part 6 for the defaults. |
| Incident handling | `[[CONNECTION_INCIDENT_CONTACT]]` is notified of a credential expiry, a revoked grant, a signature failure or a provider-side incident; Part 3 §3.7 states what the Service does. |
| Key rotation | The stored credential is flagged for rotation after `[[KEY_ROTATION_PERIOD_DAYS]]` days (`lib/security/credential-rotation.ts::loadRotationRisks`). |
| Disconnect | The owner or a brokerage administrator may disconnect at any time from the same settings surface (Part 6). |
| Acceptance record | `[[CONNECTION_ACCEPTANCE_RECORD]]` — see the drafting note after Part 5. |

## 3. General terms applying to every connection

3.1 **Authority to connect.** The connection owner represents that they are authorized by `[[SUBSCRIBER_LEGAL_ENTITY]]` and by the provider's account terms to connect the account and to grant the scopes requested, and that the account is Subscriber's own (or the owner's own, for an agent-scoped personal mailbox, calendar or social account) and not another brokerage's or another person's.

3.2 **Who may connect what.** Agents, teams, brokerages and Platform may connect any offered domain. A vendor or Contact portal user may connect only a calendar, social or financial account for their own limited use and never an email, phone, CRM, listing, transaction or e-signature account (`lib/connections/scope.ts::CONNECTOR_PROVIDERS`).

3.3 **Credentials.** The Service stores the credential sealed with authenticated encryption under a key the Service requires to exist; if the key is unavailable the Service refuses to store the credential rather than storing it in plaintext (`lib/security/secret-crypto.ts::encryptSecret`). A credential is never displayed after entry, never written to a log, never included in an export, and never shared with another Tenant or another owner scope. Rotation risk is monitored and surfaced to the owner.

3.4 **Scopes and least privilege.** The Service requests only the scopes the connected capability needs and lists them at connection time. Subscriber may grant narrower scopes where the provider allows; the Service then performs only what the granted scopes permit and says so.

3.5 **Isolation of credentials across Tenants and scopes.** The credential of a transaction, e-signature or financial provider is Subscriber's own and is resolved from Subscriber's own row only; a platform-tier row is refused by name for those domains, so Subscriber's envelopes, loops and books never run on another account (`lib/integrations/providers/provider-resolver.ts::resolveTenantProviderCredentials`). A missing or revoked credential produces an honest refusal of the capability, never a fallback to another Tenant's or the platform's account.

3.6 **Inbound webhooks.** Where a provider pushes events to the Service, the Service verifies each delivery by the scheme the provider supports — a signature over the body, a verification token handshake, a shared secret compared in constant time, or a token the Service itself wrote into the callback URL — as recorded per route in the inbound webhook contract (`lib/providers/webhook-contract.ts::WEBHOOK_CONTRACT`). A delivery that fails verification is refused. Where a provider's scheme verifies only the handshake and not the payload, the contract records that gap and the capability is treated as advisory.

3.7 **Health and incidents.** The Service probes a connection's health and shows it honestly as connected, expiring, revoked or failing. When a token expires or a grant is revoked the Service does not retry with another account; it asks the account owner to reconnect through a notice (the self-healing playbook that handles a credential is a hand-off to the owner, never an automatic re-authorization — Schedule 2 §11). The Service records what a disconnection would break so the owner can see the impact before disconnecting (`lib/agentic-os/connection-impact.ts`).

3.8 **Outbound webhooks from the Service.** Where Subscriber subscribes its own endpoint to the Service's events, every delivery is signed with a per-subscription secret, carries an idempotency key, retries on a jittered backoff, carries both secrets during a rotation overlap, and is auto-disabled with a notice after repeated dead deliveries (`lib/platform/tenant-webhooks.ts`). Subscriber is responsible for the endpoint it subscribes.

3.9 **Provider terms.** Subscriber will comply with the provider's terms for the connected account, including content, rate, data-use and publishing rules, and acknowledges that the provider may suspend or change its service without Platform's involvement. Platform is not responsible for a provider's acts, omissions, data or availability (Packet 1 §17.4).

3.10 **Data received from a provider.** Data the Service receives through a Tenant-Connected Provider is Subscriber Content, subject to the provider's terms. The Service stores only what the capability needs, labels it with its source, and never redistributes it to another Tenant. A provider's data is sent to the AI gateway only as part of a task Subscriber enabled.

3.11 **No change to Tier, Seats or memberships.** Connecting a provider never adds a Seat, changes a Tier, creates an office, team or membership, or alters any entitlement. The one exception is the bring-your-own carrier model, which the Service offers on the Multi-Location Tier only (Part 4).

## 4. Per-provider variations

Variations are listed only where the provider's terms or the Service's implementation require something beyond Part 3. A provider not listed here has no variation.

| Provider | Domain | Variation |
|---|---|---|
| IDX Broker | Listing feed | The Tenant's own MLS feed answers listing searches and listing photographs for that Tenant, in place of the platform's property-data provider, because the MLS data is licensed to the Tenant by its board and not to Platform. Display, attribution, refresh and takedown follow the Tenant's board rules (Schedule 5 §7.3). The platform key is only the floor when no Tenant connection exists. |
| Stripe (the Tenant's own account) | Financial | The Tenant's account is the merchant of record for money the Tenant collects (client payments, vendor package fees) and the payer for money it pays out (agent payouts, vendor bills); amounts owed to Platform never run on it, and the Tenant's money never runs on Platform's account (`lib/billing/stripe-account-scope.ts::stripeAccountSideFor`). The connection is either the Tenant's own secret key or a Connect account identifier addressed per request; webhooks from the Tenant's account are verified against that account's own signing secret. A Tenant with no connected account is refused, not routed to Platform's. |
| QuickBooks Online (the Tenant's own company) | Financial | The Tenant's accountant's file is the Tenant's book. The Service synchronizes to it under the Tenant's OAuth grant and never owns the ledger; Platform's own QuickBooks company for platform revenue is a separate connection and the two are never mixed. |
| Gmail and Google Calendar; Outlook | Email and calendar | The connection is the **user's own** identity: agent-to-Contact email is sent from the user's own mailbox, lands in their own sent folder and receives replies there. The platform's transactional email provider is only a fallback. The Service requests send, read-for-reply-matching and calendar scopes as listed at connection; the user may narrow them. |
| Twilio (bring-your-own), Telnyx, Bandwidth | Phone | By default phone numbers and messaging run on Platform's master account with an isolated child account per Tenant, because carrier registration for application-to-person messaging is a platform job. A Tenant may bring its own carrier account **only on the Multi-Location Tier**; it then holds the carrier contract and the registration obligations, and the Service's consent, suppression and quiet-hour gates apply unchanged. |
| Meta (Facebook and Instagram), LinkedIn, X, TikTok, YouTube, Pinterest, Google Business Profile | Social | Publishing runs on the Tenant's own pages and channels under the Tenant's grant. Inbound direct messages from Meta are verified by Meta's handshake and body signature. The Tenant is responsible for the platform's content and advertising rules, including the housing special category (Schedule 5 §8.3). |
| GoHighLevel, Follow Up Boss, Lofty, HubSpot | CRM | **Synchronization is outbound only**: the Service pushes Contact updates to the connected CRM and never pulls the CRM's contacts in. Subscriber is responsible for the consent status of records it chooses to sync out. |
| Dotloop, DocuSign, SkySlope, Authentisign, Form Simplicity | E-signature and transaction forms | The envelope, loop or file is created on the **Tenant's own** account from a document a person approved; the credential is the Tenant's row only and a platform-tier row is refused (§3.5). No AI Manager sends a signature request (Schedule 2 §8.1). The Tenant's provider contract governs retention of the signed instrument at the provider; the Service keeps its own copy in the private documents bucket. |
| Brokermint | Transaction forms and back office | Transaction records are opened on the Tenant's own account; commission and payout data synchronized from it is the Tenant's financial information and is visible only to the Tenant's finance roles. |
| ShowingTime | Showings | Showing requests are scheduled on the Tenant's own account; the Tenant's listing permissions govern which listings may be scheduled. |
| Transistor | Podcast distribution | One per-Tier connection publishes an episode and the provider syndicates it under its managed feed; the Tenant holds the hosting plan and the rights in the audio. |
| Zoom | Meetings and virtual events | Each scope level connects its **own** Zoom; meetings, registrants and recordings run on the Tenant's licensed account under its plan limits and Platform books nothing per call. Registrant join and leave evidence is recorded for attendance; a meeting hosted on an external link records attendance as unverifiable. |
| YouTube (live) | Broadcast | Live broadcasts run on the Tenant's own channel and spend the Tenant's daily API quota, not money; no per-viewer identity is captured and attendance is never claimed from a broadcast. |
| Pexels | Stock media | A stock license covers each user's own use and never Platform's redistribution; a user's own key makes downloads theirs. The platform key is a search fallback only. |

## 5. Configuration and acceptance records

5.1 **Configuration record.** The Service records, for each connection: the provider, the owner scope and owner, the account identifier, the authority type and scopes, the time of connection and of each refresh, the health state and its history, the rotation flag, and the time and actor of disconnection. These are Subscriber's records and Platform's operational records.

5.2 **Terms confirmation.** Before a connection is activated the connection owner confirms that they have read the provider's terms at `[[PROVIDER_TERMS_URL]]` and are authorized to bind the account; the confirmation and its date are recorded as `[[PROVIDER_TERMS_CONFIRMATION_DATE]]`.

5.3 **Acceptance of this Schedule.** The connection owner's acceptance of this Schedule for the connection is recorded at `[[CONNECTION_ACCEPTANCE_RECORD]]`, with the Schedule version, the time, the actor and the connection it covers.

> **Drafting note (not contract text).** The configuration record in §5.1 exists today (the connection store, the health probe, the impact map, the rotation monitor). The terms confirmation in §5.2 and the per-connection acceptance in §5.3 do **not** exist as records in the code at this commit: nothing stores "this owner confirmed the provider's terms on this date" or "this owner accepted Schedule 6 version X for this connection". Both are listed in the review packet as engineering work for the lane that owns Settings → Connections (lane 151F), and this Schedule must not be published with §5.2 and §5.3 stated as present until they are. The `[[CONNECTION_ACCEPTANCE_RECORD]]` variable exists so the gap is visible rather than papered over.

## 6. Disconnect, rotation and offboarding

6.1 **Disconnect.** The connection owner or a brokerage administrator may disconnect at any time. On disconnect the Service revokes the grant where the provider's API allows, deletes the stored credential, stops every capability that depended on the connection with an honest refusal, and records the time and actor. Data already received through the connection remains Subscriber Content under `[[CONNECTION_DELETION_TERMS]]` and the provider's terms; the default is that it stays on Subscriber's records with its source label and is deleted with Subscriber Content under Schedule 4 Part E.

6.2 **Rotation.** A stored key flagged for rotation is shown to the owner with the age of the key; the owner rotates it at the provider and re-enters it. The Service never rotates a Tenant's key on its own.

6.3 **Revocation by the provider.** If the provider revokes or expires the grant, the Service treats it as a disconnect for operation, notifies `[[CONNECTION_INCIDENT_CONTACT]]`, and asks the owner to reconnect; it does not fall back to another account.

6.4 **Termination of the Agreement.** On termination of the Agreement every Tenant-Connected credential is deleted and every grant the Service can revoke is revoked, as part of the deletion in Schedule 4 Part E.

6.5 **Two-tenant isolation.** A connection stored at one Tenant's scope is never resolvable from another Tenant's session; the resolver walks only the requesting Tenant's own owner cascade and the platform fallback where the domain allows one, never sideways to another Tenant (`lib/connections/resolve-scoped.ts::resolveScopedConnection`).
