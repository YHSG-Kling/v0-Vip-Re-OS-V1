# The Provable OS — where this product wins, and what to build next

*Written after an end-to-end burn-down of the kernel, the egress system, the manager
registry, the live schema and the surfaces. Every claim below is anchored to code that
exists in this repo today, or is named explicitly as new work.*

---

## 1. The competitive read, honestly

MoxiWorks Rave, Lofty and RealScout are converging on the same pitch: *an AI that does
things for the agent.* Rave leads with an agentic assistant over the Moxi suite. Lofty
leads with AI ISA + workflow automation. RealScout leads with buyer-side search and
home-value nurture.

They are all racing on the same axis — **how much can the AI do autonomously**. That axis
saturates. Every vendor gets to "it can draft, send, call, post" within a release cycle or
two of each other, because the underlying models are the same models.

**Nobody is racing on the axis that actually decides enterprise real-estate purchases:
can the AI PROVE what it did.**

That is not a philosophical point. It is the single hardest constraint in this industry:

- The **broker holds the license**. Every touch an agent's software makes is imputed to
  the broker. An AI that sends 4,000 texts a week is 4,000 units of unshared liability.
- **TCPA** statutory damages are $500–$1,500 *per message*. One bad autonomous SMS
  campaign is an existential event for a mid-size brokerage.
- **Fair housing** exposure attaches to *targeting*, which is exactly what an AI matching
  engine does all day.
- **RESPA** attaches to *who you recommended and what you got for it* — which is exactly
  what a vendor marketplace does.
- Post-**NAR settlement**, buyer-agreement and compensation disclosure are now discovery
  material.

Every one of those is a question of the form *"show me what your system did, and prove
it."* An AI that answers "I recorded that I sent it" loses that conversation. An AI that
answers "here is the provider's own confirmation, timestamped, correlated by message id,
on an insert-only ledger" wins it — and is the only kind a broker's E&O carrier will ever
get comfortable with.

**The thesis: the moat is not more autonomy. It is provable autonomy.**

That is a moat because it cannot be bolted on. It has to be in the write path of every
action from day one, and a competitor who shipped "AI that does things" for three years
cannot retrofit provenance onto records that never captured it. We are already most of
the way there and, as far as I can tell, largely by accident of good instincts.

---

## 2. What we already have that they do not

This is the honest inventory. It is stronger than it looks from inside.

| Asset | Where | Why it matters competitively |
|---|---|---|
| **Outcome reconciliation** with four honest verdicts (`confirmed` / `contradicted` / `pending` / `unverifiable`) | `lib/outcomes/reconciliation.ts` | The OS distinguishes "we handed it to Twilio" from "it reached the human." Nobody else does this. `unverifiable` — a lane declaring it has *no* truth source — is the intellectually honest move that makes the whole ledger trustworthy. |
| **MLS syndication verification**, same vocabulary | `lib/listings/mls-verification.ts` | The listing claim itself is now reconciled, not just the messages. |
| **Insert-only compliance ledger** | `compliance_events`, `required_disclosures` | Already the right shape for discovery: append-only, tenant-anchored. |
| **AI disclosure ledger + CSV export** | task #23 | State AI-disclosure laws are arriving; we can already produce the record. |
| **Manager registry with named ownership** | `lib/kernel/manager-registry.ts` | Every capability has a manager who owns it and a `test:*` proof that it works. This *is* an accountability graph — most products have no equivalent. |
| **Autonomy gates + accuracy governance** | task #22, `test:autonomy-gate` | Autonomy is earned per-manager against measured accuracy, not a global on/off switch. |
| **4,283 executable proofs** in one guard chain | `npm run guard` | This is not test coverage. It is a *behavioural contract* that survives refactors. |
| **Connection OS self-healing egress** | `lib/integrations/connection-manager.ts` | One gateway, scoped agent→team→brokerage→platform, with credential rotation sweeps. |
| **Video as a payload, not a channel** | owner ruling, enforced in the channel taxonomy | Correct and rare. Competitors count "videos generated" as engagement. We count whether the SMS carrying it was delivered. |
| **Full funnel** — scrape → lead → deal → lifetime customer | across the kernel | Rave/Lofty/RealScout each own a slice. We own the arc. |

---

## 3. The defect class we should productise

The burn-down kept surfacing one shape, in many disguises:

> **A claim recorded as a fact, with nothing checking it.**

- `supabase-js` resolves a *failed* write — so a rejected write and a successful one are
  identical in the source.
- A manager writes `status: 'sent'` from a provider's *accept* response.
- A "Launch Listing" button with no `onClick` — the UI claims a capability the wire does
  not deliver.
- A panel rendered over a hard-coded `[]` — the surface claims data it never asked for.
- A readiness checklist that could read 7-of-7 while the kernel refused the launch.

These look like unrelated bugs. They are one bug: **the middle is missing, and nothing
notices, because a missing middle is invisible from both ends.**

**Recommendation 1 — ship the "Provenance Kernel" as a first-class product concept.**

Generalise `lib/outcomes/reconciliation.ts` from *delivery* to *every consequential
assertion the OS makes*. One table, one vocabulary:

```
assertion_ledger
  id, brokerage_id, actor (manager | agent_id | user_id)
  claim_type      'message_delivered' | 'listing_live_on_mls' | 'disclosure_shown'
                  | 'consent_captured' | 'vendor_booked' | 'commission_calculated'
                  | 'lead_contacted' | 'document_executed'
  subject_type, subject_id
  claimed_at, claimed_value
  verdict         confirmed | contradicted | pending | unverifiable
  truth_source    the provider signal, or NULL — declared, never implied
  verified_at, evidence jsonb
```

Every existing reconciliation becomes a row. Every new manager capability MUST declare
its truth source — including declaring that it has none. Make that a guard: a capability
in the manager registry with no declared truth source fails `npm run guard`.

**This is the differentiator, and it is a two-week build on top of what exists.**

**Recommendation 2 — the surface: "The Broker's Record."**

One page. Filter by date, agent, contact, claim type. Every row shows claim → verdict →
evidence → the manager who made it. Export to PDF with a cover sheet.

That page is what closes enterprise deals. It is what a broker forwards to their attorney
and their E&O carrier. Rave cannot generate it, because Moxi never captured the verdicts.

Concretely it answers, in one click:
- *"Prove you had consent before that text."* → consent capture event, timestamp, source.
- *"Prove the AI disclosed it was an AI."* → disclosure ledger row per conversation.
- *"Prove you showed the RESPA notice before recommending that lender."* → `compliance_events`.
- *"Prove those 400 texts were actually delivered and not to numbers on the DNC."* → per-message verdicts.

**Recommendation 3 — make `contradicted` route to a human automatically.**

We compute `needsManager` / `needsAttention` and it currently dead-ends into a UI badge.
A contradicted claim is the *only* signal in the system that is always worth a human's
attention, because it means the OS told someone something false. Route every one into the
existing approval rail with the manager that made the claim named on it. This is the
"self-healing" loop actually closing.

---

## 4. Where the multi-manager model should go next

The current design — named managers with owned capabilities — is right. Two upgrades:

**Recommendation 4 — managers should DISSENT, visibly.**

There is already `test:manager-dissent`. Push it further into the product. The most
valuable thing a real estate team does is *argue*: the listing agent wants the price held,
the deal coordinator sees the inspection risk, the compliance officer flags the
disclosure. Today AI products synthesise one confident answer, which is exactly the
behaviour a broker cannot trust.

Show the disagreement. A "Deal Desk" surface where, on any consequential decision, each
relevant manager posts a position with its evidence, and the human picks. That is not a
weakness of the AI — it is the single most human-team-like thing the product could do, and
it is *unfakeable* by a competitor with one assistant persona.

**Recommendation 5 — the voice admin should be a COMMAND SURFACE over the kernel, not a
chatbot.**

Already the right instinct (task #94). Extend it: every voice command should resolve to a
named kernel command with a preview and a confirmation, and land on the assertion ledger
with `actor = voice`. "Send the Hendersons the updated net sheet" → resolves the contact,
resolves the document, shows the draft, and only then dispatches. The command vocabulary
should be *the same registry* the managers use — one set of verbs, three entry points
(UI, voice, autonomous).

**Recommendation 6 — an autonomy budget, not an autonomy switch.**

Per manager, per tenant: N autonomous actions per day, spend visible, refill governed by
measured accuracy. A manager whose claims start coming back `contradicted` loses budget
automatically. This is the self-healing story with teeth, and it is directly buildable on
the accuracy governance already in place.

---

## 5. Video, marketing, and the Remotion + D-ID + ElevenLabs lane

Owner constraint: Remotion + D-ID + ElevenLabs clones, **no HeyGen**. Video is a payload
delivered by SMS/email/portal, never a channel.

Deterministic Remotion composition is already built (task #95), as is fact-keyed staleness
(#97) and the buyer-match reel (#98). The remaining unlock:

**Recommendation 7 — the "living listing" as the marketing primitive.**

Not "generate a video." A listing gets a *standing* video artifact that re-renders when a
FACT changes — price reduction, new photos, open house scheduled, back on market, days-on-
market crossing a threshold. Because the composition is deterministic and cacheable, only
the changed scenes re-render.

The competitive line is exact: *competitors generate a video once and it rots. Ours is
never wrong, because it is derived from the listing rather than authored against it.*

**Recommendation 8 — the seller update video, weekly, automatically.**

The single highest-retention artifact in residential real estate is the seller knowing
what happened this week. Agent's D-ID avatar + ElevenLabs clone + real numbers from the
OS (showings, feedback, portal views, market movement) → 45 seconds, delivered by the
channel the seller chose, with a delivery verdict.

That is a weekly, provable, personalised touch no competitor can match, and it is
assembled entirely from data the OS already holds.

**Recommendation 9 — one render budget, metered.**

D-ID and ElevenLabs cost per render. Meter them through the same vendor-metering rail
(`lib/vendor-governance/meter-vendor.ts`) so per-tenant video spend is visible and
capped. An agentic system that can spend money unboundedly will not survive contact with
a CFO.

---

## 6. Lead acquisition — the honest position

The owner's framing is *"scraping for leads for all tiers."* The expert advice here is
partly a caution, and it is worth stating plainly because it protects the moat:

**Scraping is a commodity and a liability. Provenance of the lead is the asset.**

Anyone can buy a scraper. What nobody has is a lead record that carries, from the first
touch: where it came from, what consent was captured, what disclosures were shown, and
which manager touched it when. That record is what makes an aggressive follow-up program
*defensible* rather than a TCPA exposure.

**Recommendation 10 — every lead source declares its consent basis at ingestion.**

Extend the intake path so a source cannot be configured without declaring: consent type
(express written / inquiry / none), retention, and permitted channels. A source with
`consent: none` may be enriched and researched but **may not be auto-dialed or texted** —
enforced in the dispatcher, not in a policy document. This turns compliance from a
constraint into a feature: the OS lets agents move fast precisely because it knows which
leads they can move fast on.

**Recommendation 11 — go where the intent is, not where the contact lists are.**

The durable edge in AI-era lead-gen is not more contacts, it is earlier signal:
expireds/FSBOs with public-record corroboration, probate and pre-foreclosure filings,
permit filings (a pulled kitchen permit predicts a listing 12–18 months out), rate-lock
and equity-threshold triggers in the existing sphere. Most of these are public record and
consent-clean, and several are already partially wired through the property intelligence
lane.

The lifetime-customer arc we already own is the real lead source. An agent's past client
at 8 years of equity with a growing family is a better lead than any scraped list, and
the OS is the only thing that knows it.

---

## 7. What I would do in the next four weeks

Ordered by moat-per-unit-effort, not by ease:

1. **Assertion ledger + guard that every manager capability declares a truth source.**
   Generalises what exists. This is the moat.
2. **"The Broker's Record" surface + PDF export.** The thing that closes enterprise deals.
3. **Route `contradicted` into the approval rail automatically.** Closes the self-healing loop.
4. **Finish the missing-middle sweep** as a permanent guard, not a one-time cleanup —
   detect UI-without-wire and action-without-caller in CI forever.
5. **Autonomy budget per manager per tenant**, spendable and accuracy-governed.
6. **Weekly seller update video**, automatic, provable delivery.
7. **Consent basis declared per lead source**, enforced at dispatch.
8. **Deal Desk** — managers post positions and disagree in the open.

---

## 8. The one-sentence positioning

> Every other AI real-estate product tells you what it did.
> This one can prove it — and hands the broker the record.

That sentence is defensible today on delivery outcomes and MLS syndication. Items 1–3
above make it defensible across the whole system, and once it is, it is very hard to
catch.
