# Wave 154 — owner action sheet

Every owner-only action left after wave 154, **ranked by release impact** (lane 154L, release convergence, 2026-11-18).
**No lane and no integrator has run anything on this page.** Supabase project `hrvaqgvukzxfskkcrwbt`. Executable SQL is NOT
restated here: it lives once, in `docs/operations/OWNER-SQL.md` (§F, §G, §I, §M.1 for the release blockers; **§P** for wave 154).
Each item gives: **what** it is in plain words, **why** it blocks or matters, the exact **step**, how to **read back** that it
worked, **who** can do it, and what the software **does today** while it waits.

**Where wave 154 stands.** Engineering: the integrated journeys of directive L1 run end to end in `test:wave154-canaries`
(SIMULATED — every provider, model and channel is a counting seam). Its JOURNEY MAP names, for each of journeys 1–15 + 7a/7b/7c/
9/9a/9b, the canary or guard-chain key that executes it and what stays PARTIAL. Nothing in wave 154 is LIVE-VERIFIED.
Release: **NOT production-live.** Live read-backs taken by lane 154K on 2026-11-18 (read-only SQL): O1 is still open
(`storage_bucket_policy_readiness()` reads five private buckets `open`), O2 is still open (4 of 4 portal seed accounts unlinked),
O3 is not done (no production deployment). Migrations applied live this wave: m968, m973, m974, m987, m988 (read back, stamped).

---

## 0 — Integrator steps before any owner step (not owner work)

1. Regenerate the generated docs and run the full chain once: `NODE_OPTIONS="--max-old-space-size=14336" npm run guard`;
   read `GUARD_EXIT` from the log. This sheet is pushed only on `GUARD_EXIT=0`.
2. Watch build + guard CI on the pushed SHA (re-run `next-build` unchanged on exit 134 or a 40-minute stall; CLAUDE.md §8).

---

## Release-blocking (nothing is production-live until all four are done)

### 1. O1 — storage policies on the five private document buckets (OWNER-SQL §F, §G, then §J) — OWNER-HELD, open
- **What:** the rules that keep one tenant's stored documents away from every other tenant.
- **Why:** until they exist, any signed-in session can read objects in `agent-documents`, `brokerage-forms`, `client-documents`,
  `transaction-documents`, `offer-documents` across tenants. A document leak. Release-blocking.
- **Step:** OWNER-SQL §K Q1–Q6 (read-only; Q1 says which route works), then §F and §G exactly as written, then §J.
- **Read-back:** `SELECT bucket_id, verdict, missing_policies, unscoped_policies FROM public.storage_bucket_policy_readiness() ORDER BY bucket_id;`
  → the four owner buckets `owner_scoped`, `documents` and `offer-documents` `service_only`, both arrays empty (today: five `open`).
- **Who:** owner (Supabase dashboard login). **Today:** the policies are open; the code never widens them.
- **Proves it:** `test:release-blockers` B2 and canary L15 (O1 derives OPEN from the m855 / m875 stamps).

### 2. O1-LM — listing-media RESTRICTIVE folder policies (OWNER-SQL §M.1) — OWNER-HELD, open
- **What:** listing photos — tenant staff write only into their own listing folders; the booked photographer only into its listing.
- **Why:** today any authenticated seat can write into any listing folder. Release-blocking.
- **Step:** the §M.1 block as `supabase_storage_admin` in one transaction; then write §M.1's status line
  `- Status: RESOLVED <YYYY-MM-DD> — N.1c shows the 3 RESTRICTIVE rows`.
- **Read-back:** OWNER-SQL §N.1c returns the three RESTRICTIVE rows. **Who:** owner.
- **Proves it:** `test:release-blockers` B′ and canary L15 (the ONE shared rule `listingMediaPoliciesResolved`).

### 3. O2 — the four unlinked portal seed accounts (OWNER-SQL §I) — OWNER-HELD, open
- **What:** four `users` rows typed `contact` with no linked Contact (live 2026-11-18: 4 of 4). They sign in to a portal that resolves to nobody.
- **Step:** §I census, then Remediation A (link `contacts.contact_user_id`) or B (archive) per account; write §I's status line
  `RESOLVED <date> — census 0`.
- **Read-back:** §I census returns **0**. **Who:** owner. **Proves it:** `test:release-blockers` C3.

### 4. O3 — the first real deployment (build machine, Node, domain) — OWNER-HELD, open
- **What:** there is no production deployment. The Vercel project is not live, has no custom domain, recent builds were canceled.
- **Step:** after item 0, choose the build machine that fits the heap (ACTIVATION-CHECKLIST §6.7 M1), confirm Node matches
  `engines`, attach the domain (M2), deploy a preview first; promote only when you choose.
- **Read-back:** the deployment reads READY; `GET /api/health` → 200; record M1 / M2 in ACTIVATION-CHECKLIST §6.7.
- **Who:** owner (Vercel login; build-machine pricing is yours). **Proves it:** `test:release-blockers` E4; canary L15 (O3 derives OPEN;
  even with every CI-side gate observed, production-live stays false — CI and guards never substitute).

---

## Required before launch, not code

### 5. Counsel approval of the agreement drafts, and the wave-154 rulings for counsel
- **What:** the platform-agreement drafts are drafts. Wave 154 adds for counsel: **R1 public-read / reword-before-store** (public
  posts on terms-restricted community sites read for TOPICS only, reworded before storing; recorded on
  `COMMUNITY_POST_TOPIC_RULES` as your accepted risk); R4 Refurbish (an idea is not protected expression; the originality gate is
  lexical, images / video blocked by rights mode); website questions turned into one anonymized FAQ topic (see item 17).
- **Step:** counsel approves or amends; publish only approved text. **Read-back:** approved versions recorded in ACTIVATION-CHECKLIST.
- **Today:** documents stay drafts (`test:operations-docs`); the R1 path stores only a reworded topic + minimal provenance.

### 6. Provider keys and LICENSES (each owner-held; nothing is activated, nothing was purchased)
| Item | What the software does today | Your step |
|---|---|---|
| IDX photo rights | photos are not displayed beyond the existing licensed path (OWNER-SQL §O.5) | sign the IDX vendor's display license |
| Remotion render hosting + company license | 34 compositions render locally only; no production render | choose hosting (render worker / Lambda), buy the company license |
| Datafiniti | connector built, `dormant_pending_rights`; every pull refused before a call | read the data license; set `DATAFINITI_API_TOKEN` yourself; ask for the one-line activation |
| Google Trends access | `not_connected` — nothing scraped, nothing invented (canary L12) | apply for the Trends API alpha (optional) |
| Search Console, per tenant | `not_connected` per tenant | each tenant grants `webmasters.readonly`; storage goes through `tenant_provider_connections` |
| Keyword-volume license | volume reads UNKNOWN; a relative index is never a count | license a volume provider or keep UNKNOWN |
| Apify key | the idea cron answers `disconnected_key` and runs nothing (canary L12) | set `APIFY_API_TOKEN` yourself; then item 9 per source |
| Licensed event feeds | the `licensed_event_feed` class refuses ("no transport configured") | contract a licensed feed (LICENSE reference + transport) |
- **Read-back:** a provider's matrix row moves from simulated to verified only after a recorded live call (`test:provider-gap-matrix`).

---

## Owner decisions gathered in wave 154 (each runs on its safe default today)

### 7. Nextdoor person-level leads — LICENSE-HELD (lanes 154C / 154F)
- **Today:** Nextdoor public posts yield **TOPICS only** (reworded, no author, no wording, no contact). A person-level Raw Lead
  from a Nextdoor post is held: the person path makes zero transport calls (canary J4).
- **The one-line switch:** `lib/providers/scrape-checkpoint.ts:123` — `const SCRAPE_TARGET_AGREEMENTS = Object.freeze({})`.
  Adding `"nextdoor.com": { reference, recordedAt, scope }` (a recorded written agreement) lifts the hold for every purpose
  (canary J4 proves a recorded agreement makes the same URL fetch). Do it only with a signed agreement read by counsel.

### 8. Facebook source activation (lane 154C)
- **Today:** Facebook group and Ad Library research is IDEAS ONLY and inactive. Each source needs `source_config` with `actor`,
  `input.resultsLimit`, `max_run_usd`, `rights`, and `visibility:'public'` for groups, plus the Apify key. A private group, a
  source with no recorded rights, an unbudgeted run or a platform-wide idea source makes no call (canary L7a).
- **Decision:** which sources, which budget per run; running an actor is a paid action.

### 9. Gamification — six reward rules (lane 154E)
1. REFERRAL_CREATED — pay only on a proven close (today) or also on partner-portal submission? 2. TRAINING_COMPLETED — per course
needs a graded assessment writer (today: certification / CE / competency). 3. OPEN_HOUSE_HOSTED — is a captured sign-in count
enough evidence? 4. VENDOR_REVIEW_WRITTEN, FOLLOWUP_SENT, CAP_HIT — no trusted event; retire or name the event. 5. FIRST_APPOINTMENT
— fires on booking (not advertised); keep or retire until a held-appointment writer exists. 6. CLIENT_REVIEW_RECEIVED = 25 points —
re-price if wanted. Also: should team members see only their own team's board? **Today:** 13 rewards advertised, 0 unearnable; no
self-award door (canary J5).

### 10. Website-chat consent flag (lane 154I)
- **Today:** website questions become one aggregate, reworded FAQ topic only at 3+ distinct askers in 60 days, with no identity.
- **Decision:** add a per-visitor "may be used anonymously" flag on `chat_sessions` (a column → a migration; not written).

### 11. Portal home-service vendor spellings (lane 154I)
- `vendorCategoryFor` still emits legacy trade labels (plumbing, roofing, inspection, general_contractor, home_services) as message
  labels only. Aligning them with the `vendors.category` CHECK changes simulator assertions — your call.

### 12. Command Center visibility (lane 154G2)
- Should a reel's agent see the proposal on their own row (today: brokerage scope only)? Should `visibility_scope='team'` items show
  to teammates (today: own + brokerage-shared)? Canary L13 proves each tenant structure sees exactly its slice today.

### 13. Paid pilot, Zyte vs ZenRows, vendor terms (lane 154J)
- No paid matched sample is approved (the ~50k / month pilot is a proposal). Recommendation: ZenRows conditional, Zyte dormant
  (reverse it if a portal agreement is signed). Vendor terms (resale, AI use, outreach) to be read per provider.

### 14. Arbitration questions (lanes 154A1 / 154A3)
- **One risk scale for assistant tools:** 34 tools read IRREVERSIBLE under the persona policy yet the staff route runs them with
  spoken confirmation. Recommendation: classify the voice tools explicitly in `TOOL_RISK_CLASS` (one scale), keep the human spoken
  confirmation for FINANCIAL / LEGAL classes.
- **Is a registered manager the decision owner?** 538 of 1,054 autonomous rows name no gate. Recommendation: no — only a rule recorded
  on `agent_action_ledger` counts.
- **`referral_converted`** stays held until the referral rule (item 9.1) is ruled.
- **Milestone-overdue double notify:** mapping the deadline monitor's `milestone.overdue` label to a kernel event would notify twice.
  Today: one notification (the deadline monitor's). Decide per handler.

### 15. Topic Refurbish authoring and variants (lane 154H2)
- **No accountable sender → HOLD.** A brokerage-level topic with no brand owner and no office claim is held today. Should a named
  content author take it? (No such setting exists.)
- **Variants after approval:** variants are drafted on the next daily sweep after the master is approved. A tenant may prefer master
  and variants drafted together.

### 16. Document and role hygiene still in code (lane 154K) — engineering, listed so you see the release impact
- Ten-year persisted signed URLs were REMOVED in wave 154 (lane 154M; lib/storage/signed-doc-url.ts tombstone): rows store docref://
  references and every view mints a 5-minute link after a seat check (wave 155 lane 155A adds the seat-standing re-read). 31 hard-coded
  `.in("user_type", [...])` role lists remain (143G-OL-05) — code work, not an owner step.

### 17. Small items (no action needed unless you want a change)
- `FIRST_PARTY_MIN_CONTACTS = 3` (lib/content-intel/search-demand.ts:291) is a privacy floor you may change.
- `engagement_score` is NOT NULL DEFAULT 0: an unmeasured topic reads 0 there; the truth is `raw_data.popularity_evidence_type`.
- `ad_campaign_launched` stays an evidence-only event with no consumer (paid ads; no personal send depends on it).
- Engineering notes, not owner actions: `system_sync_completed` and `search_alert_triggered` are tombstone candidates (lane 154H2).

---

## Owner SQL (OWNER-SQL §P — none is release-blocking)
- **Required before two tenants can store the same competitor ad:** `DROP INDEX public.uq_competitor_ads_source_provider_id;`
- Optional: four redundant partial unique indexes; `contacts.ai_predicted_close_date`; the three empty legacy Google tables
  (**not recommended** until you confirm the replacements). Exact statements, reasons and read-backs: OWNER-SQL §P.

## After you act
Tell the integrator which items you did. The integrator re-runs the read-backs read-only, writes the stamps / status lines the
guards read, and re-runs `test:release-blockers`, `test:production-readiness` and `test:wave154-canaries`. CI green alone is never
production-live.
