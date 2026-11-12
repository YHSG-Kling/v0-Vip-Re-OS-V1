# Build next — the AI team that can prove its work

*Companion to `STRATEGY-THE-PROVABLE-OS.md`. That doc argues WHERE the moat is.
This one is the build: three systems, in order, each grounded in code that exists.*

---

## Why these three

The burn-down keeps surfacing the same shape — **a claim recorded as a fact with
nothing checking it**, and **a surface that looks finished but reaches nothing**.
Those are not separate problems. They are both *provenance* failures: the OS
cannot tell you what actually happened.

Three builds close it, and each one is a differentiator a competitor cannot
retrofit:

1. **The Assertion Ledger** — every consequential claim carries its proof.
2. **The Deal Desk** — managers disagree in the open, and the disagreement is the product.
3. **The Living Listing** — video that is never wrong, because it is derived rather than authored.

---

## 1. The Assertion Ledger

**What exists:** `lib/outcomes/reconciliation.ts` proves *delivery* claims against
provider truth with four verdicts. `lib/listings/mls-verification.ts` now does the
same for *syndication*. `compliance_events` is insert-only. The manager registry
names an owner and a proof for every capability.

**What's missing:** those verdicts dead-end in a UI badge. Nothing accumulates.

### The table

```sql
assertion_ledger
  id, brokerage_id
  actor_kind        'manager' | 'agent' | 'system' | 'voice'
  actor_id          manager key | agents.id | null
  claim_type        'message_delivered' | 'listing_live_on_mls' | 'disclosure_shown'
                    | 'consent_captured' | 'vendor_booked' | 'commission_calculated'
                    | 'document_executed' | 'lead_contacted'
  subject_type, subject_id
  claimed_at, claimed_value  jsonb
  verdict           'confirmed' | 'contradicted' | 'pending' | 'unverifiable'
  truth_source      text NULL          -- NULL means "no proof exists", said out loud
  verified_at, evidence jsonb
```

### The three rules that make it worth having

**Rule 1 — a capability with no declared truth source fails the build.**
Add it to the existing proof-ownership guard: every `MAINTENANCE_DOMAINS` entry
must name a `truth_source`, or explicitly declare `null` with a reason. This is
what stops the ledger from quietly becoming decorative. It is a ~30-line change
to a guard that already runs.

**Rule 2 — `contradicted` routes to a human automatically.**
We already compute `needsManager` / `needsAttention` and then do nothing with it.
A contradicted claim is the *only* signal in this system that is always worth
interrupting someone for: it means the OS told a person something false. Route
every one into the existing approval rail, with the manager that made the claim
named on it. This is the self-healing loop actually closing rather than being
described.

**Rule 3 — `pending` is never rendered as success.**
Already true in the delivery lane. Make it structural: the ledger has no "sent"
state to fall back to.

### The surface: "The Broker's Record"

One page. Filter by date / agent / contact / claim type. Each row: claim →
verdict → evidence → the manager who made it. PDF export with a cover sheet.

That page is what closes a brokerage deal, because it answers, in one click, the
questions that decide whether a broker can let AI touch their license:

| Question | Answered from |
|---|---|
| "Prove you had consent before that text." | consent capture event + timestamp + source |
| "Prove the AI disclosed it was an AI." | disclosure ledger, per conversation |
| "Prove the RESPA notice was shown before you recommended that lender." | `compliance_events` |
| "Prove those 400 texts were delivered and none went to a DNC number." | per-message verdicts |
| "Prove the listing actually went live when you told the seller it did." | MLS syndication verdict |

Rave cannot generate that page. Not because it is hard — because Moxi never
captured the verdicts, and you cannot backfill proof.

**Effort:** one migration, one guard change, one page. Two weeks. Everything it
reads already exists.

---

## 2. The Deal Desk — managers that disagree

**What exists:** named managers with owned capabilities, `test:manager-dissent`,
an approval rail, autonomy gates.

**The insight:** the most valuable thing a real estate team does is *argue*. The
listing agent wants the price held; the deal coordinator sees inspection risk;
the compliance officer flags a disclosure. Every AI product on the market
synthesises this into one confident answer — which is exactly the behaviour a
broker cannot trust, because a single voice gives them nothing to weigh.

**Build:** on any consequential decision — price reduction, offer response, going
autonomous on a sequence, firing a vendor — each relevant manager posts a
*position* with its evidence, and the human picks.

```
DEAL DESK · 412 Oak — offer received, $18k under
  listing_concierge   HOLD.  Comparable at 408 Oak closed at ask 9 days ago.
                             DOM 12 is below the market median of 21.
  deal_coordinator    COUNTER. Buyer is cash, no financing contingency.
                             Our seller's stated deadline is 31 days out.
  compliance_officer  NOTE.  Buyer's agent is unrepresented — dual agency
                             disclosure required before any counter goes out.
  → [Hold] [Counter at …] [Accept] [Ask the desk]
```

Three properties that make this unfakeable:

- **Positions cite evidence, not vibes.** Each line traces to a row.
- **Dissent is recorded**, so the outcome later proves which manager read it right
  — which is exactly the input the autonomy-accuracy governance already consumes.
- **A manager that is repeatedly wrong loses autonomy budget** (see below).

This is the single most "real team" thing the product could do, and it is
architecturally *downstream* of what's already built.

### Autonomy budget, not an autonomy switch

Per manager, per tenant: N autonomous actions per day, spend visible, refill
governed by measured accuracy. A manager whose claims start coming back
`contradicted` loses budget automatically. That is the self-healing story with
teeth, and it converts the accuracy governance from a report into a control.

---

## 3. The Living Listing — video that cannot go stale

Constraint, restated: **Remotion + D-ID + ElevenLabs clones. No HeyGen.** Video
is a payload delivered by SMS/email/portal, never a channel — the reconciliation
module is already correct about this and should stay that way.

**What exists:** deterministic cacheable Remotion composition, fact-keyed
staleness, the buyer-match reel, D-ID render polling with provider status.

### The primitive: a listing has a STANDING video, not a rendered one

Not "generate a video." A listing owns a video *artifact* whose scenes are
derived from listing facts. When a fact changes — price reduction, new photos,
open house scheduled, back on market, DOM crossing a threshold — only the scenes
bound to that fact re-render. Because composition is deterministic and cacheable,
that is cheap.

The competitive line is exact and provable:

> Competitors generate a video once and it rots. Ours is never wrong, because it
> is derived from the listing rather than authored against it.

A stale video is not a cosmetic problem in this industry — a reel still
advertising a price that dropped three weeks ago is an advertising accuracy
issue, and it is the agent's name on it.

### The highest-retention artifact nobody ships: the weekly seller update

The single thing sellers most want is *what happened this week*. Assemble it
entirely from data the OS already holds:

- showings booked / completed (`vendor_bookings`, `showings`)
- feedback captured
- portal views
- market movement on comparable inventory
- what the AI team did — outreach sent, with **delivery verdicts**, not claims

Render: agent's D-ID avatar + their ElevenLabs clone + real numbers. 45 seconds.
Delivered on the channel the seller chose, with a reconciled delivery outcome.

Weekly. Automatic. Personalised. Provable. No competitor can match it, because
it requires exactly the two things this codebase has and they don't: a unified
lifecycle and a delivery ledger.

### Three production rules

1. **Meter the render spend.** D-ID and ElevenLabs cost per render. Route them
   through the existing vendor-metering rail (`lib/vendor-governance/meter-vendor.ts`)
   so per-tenant video cost is visible and capped. An agentic system that can
   spend money unboundedly does not survive contact with a CFO.
2. **A render is a production fact, not an outcome.** Already correct — keep
   `ai_video_projects.provider_status` separate from the delivery verdict. A
   finished render nobody saw is not a touch.
3. **Consent for the clone is a compliance event.** A voice clone of a real
   person is biometric-adjacent; several states now regulate synthetic likeness
   in advertising. The consent record belongs on `compliance_events` where the
   Broker's Record can produce it.

---

## 4. Lead acquisition — the honest expert position

The ask is "scraping for leads at all tiers." The expert advice is partly a
caution, and it protects the moat rather than limiting it:

**Scraping is a commodity and a liability. The lead's PROVENANCE is the asset.**

Anyone can buy a scraper. What nobody has is a lead record that carries, from
first touch: where it came from, what consent basis applies, what disclosures
were shown, which manager touched it when. That record is what makes an
aggressive follow-up program *defensible* instead of a TCPA exposure at
$500–$1,500 per message.

**Build: every lead source declares its consent basis at ingestion.**
A source cannot be configured without declaring consent type (express written /
inquiry / none), retention, and permitted channels. A source with `consent: none`
may be researched and enriched but **may not be auto-dialed or texted** —
enforced *in the dispatcher*, not in a policy document.

This inverts compliance from a brake into an accelerator: the OS lets agents move
fast precisely because it knows which leads they can move fast on.

**And go where the intent is, not where the lists are.** The durable edge in
AI-era lead-gen is earlier signal, most of it public record and consent-clean:

- expireds / FSBOs with public-record corroboration
- probate and pre-foreclosure filings
- **permit filings** — a pulled kitchen permit predicts a listing 12–18 months out
- rate-lock and equity-threshold triggers inside the existing sphere

The last one is the real unlock, and it needs no scraping at all: **the lifetime
customer arc we already own is the best lead source in the product.** A past
client at 8 years of equity with a growing family is a better lead than any
purchased list, and this OS is the only thing that knows it.

---

## 5. Sequence

| # | Build | Why here | Size |
|---|---|---|---|
| 1 | Assertion ledger + truth-source guard | The moat. Everything else cites it. | M |
| 2 | The Broker's Record + PDF | What closes brokerage deals. | S |
| 3 | `contradicted` → approval rail | Closes the self-healing loop. | S |
| 4 | Autonomy budget per manager | Makes accuracy governance a control. | M |
| 5 | Deal Desk | The "real team" differentiator. | L |
| 6 | Weekly seller update video | Highest-retention artifact in the product. | M |
| 7 | Consent basis per lead source, enforced at dispatch | Turns compliance into speed. | M |
| 8 | Living listing re-render on fact change | Video that cannot rot. | M |

Items 1–3 are two weeks together and are all extensions of code already written.

---

## 6. The positioning, in one sentence

> Every other AI real-estate product tells you what it did.
> This one can prove it — and hands the broker the record.

Defensible today on delivery outcomes and MLS syndication. Items 1–3 make it
defensible across the whole system. Once it is, it is very hard to catch, because
a competitor cannot backfill proof they never captured.
