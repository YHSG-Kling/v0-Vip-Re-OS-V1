# Wave 29 — two rulings, and both of my measurements were wrong

Owner rulings this wave:

> "tenant only sees their own unless it is of course, training or knowledge base
> and support tickets for the platform. raw leads are only platform viewable…
> ai goes through vercel ai gateway."

I researched both before dispatching. **I got both numbers wrong**, in opposite
directions, and the agents caught them. That is the useful part of this document.

## Ruling 1 — the catalogue defect was a WRITE hole, not a read leak

I proved this one live before dispatch, and it held up. As an ordinary `agent`
in one tenant, RLS on, rolled back: **UPDATE and DELETE reached 66
onboarding_steps, 12 training_videos, 11 help_topics_kb, 13 service_status, 4
thank_you_note_templates and 3 api_response_logs.** One agent at any brokerage
could rewrite or wipe the platform's shared onboarding checklist, training
library and help KB **for every tenant**.

I briefed it as three tables. It was **six** — the agent measured rather than
taking my word.

### Why the obvious #156 reading would have been destructive

Every one of those tables is **100% platform rows** (`brokerage_id IS NULL`).
"Remove the escape everywhere else" — the natural reading — would have made all
66 onboarding steps, all 12 training videos and all 11 KB topics **invisible to
everyone**, emptying three live surfaces. The ruling is exactly that correction,
so the fix splits READ from WRITE:

| | before | after |
|---|---|---|
| SELECT | `brokerage_id IS NULL OR = tenant` | **unchanged** — that IS "own + platform-provided" |
| INSERT/UPDATE/DELETE | same escape | `is_platform_admin() OR brokerage_id = tenant` |

`support_tickets` additionally **loses** the NULL branch on SELECT — a ticket is
not shared catalogue — and gains `is_platform_admin()`, which is the "for the
platform" half. Its superadmin console existed but read through the **service
client**, bypassing RLS entirely; it now has a policy-level basis rather than
depending on a key that ignores policies.

Verified independently after: writes **0** on all six, reads still
66/12/11/13/4/17, and **platform admin still writes all of them** — checked
deliberately, because locking the platform out of its own catalogue is the
opposite failure and just as real.

### Three findings beyond the brief

- **Creating a content source has never worked.** `content_topic_sources` had
  exactly one policy, `FOR SELECT`, so writes were default-denied while
  `app/actions/content-intel/sources.ts` drives create/toggle/delete through the
  RLS-bound session client. It needed the **opposite** of narrowing.
- **`training_videos` write policies carried no tenant predicate at all** — a
  broker at brokerage A could edit brokerage B's videos — and `UPDATE` had no
  `WITH CHECK`, so it could move a row to another brokerage. The role list was
  preserved verbatim rather than swapped for `is_brokerage_admin()`, whose roster
  includes `broker_owner` and would have **widened** access under cover of a fix.
- **`raw_scraped_leads` needed nothing.** Its INSERT `WITH CHECK` is the
  platform-only expression, not `true`. My concern was unfounded.
  `knowledge_articles` was already correct too.

## Ruling 2 — "AI goes through the gateway" looked already-true. It was not.

I grepped for provider-SDK imports, found none, and reported to the owner that
nothing in the tree imported a direct provider SDK — that the ruling was
satisfied and only dead dependencies remained.

**Two live call paths reached providers directly**, both through a **dynamic
`await import(...)` inside a function body**, which an import-block grep cannot
see:

- `app/actions/workflows.ts:484` built an Anthropic client and called
  claude-sonnet-4 **off the gateway key, bill and egress** — skipping the routing
  table, the fair-use pre-flight, Data Guard redaction and the `ai_tool_usage`
  cost ledger.
- `lib/ai/models.ts:347` special-cased Perplexity into an OpenAI-compatible
  client pointed at the Perplexity base URL. That was **text generation**, live
  across six routing keys, and it **contradicted `generateTextRouted` 300 lines
  below in the same file**, which always sent the same two Perplexity models
  through `toGatewayModel`. One file, two opposite answers.

That is why the new guard scans every `from` / `import()` / `require()` anywhere
in a file rather than an import block.

### The transcription exception was dissolved, not documented

The gateway **does** proxy speech-to-text. The SDK surface needs `ai@7` (this
repo is on 6, a two-major upgrade touching every call site), but the **REST**
surface is version-independent and returns the same two fields the old SDK
result supplied, so nothing downstream changed. It now goes through
`callConnector`, the same pattern the gateway chat and image lanes already use.

**Not smoke-tested** — there is no `AI_GATEWAY_API_KEY` in the build
environment, so the request shape comes from vendor docs rather than an observed
200. One live call would settle it. Stated rather than glossed.

### Removing the SDKs made three readiness surfaces lie

`go-live-readiness`, `launch-checklist` and `tenancy-matrix` green-lit an
`OPENAI_API_KEY`-only deployment that would now have **no working AI at all**.
All three now require `AI_GATEWAY_API_KEY`. This is the kind of second-order
breakage a dependency deletion causes and a diff review does not show.

Seven dependencies removed, each verified by `npm ls` to have **only a root
edge** — no peer or transitive dependent. Lockfile shrank ~370 lines / 31
packages. Two carve-outs are named: Anthropic Managed Agents (an agent/session
resource surface, not inference) and the image-generation fallbacks that fire
only *after* the gateway image path returns nothing.

## My own error, and the lesson in it

Registering the new guard, I wrote the defect's literal constructs into the
`MAINTENANCE_DOMAINS` narrative — `createOpenAI(` and the gateway's REST
transcription path.

`lib/kernel/manager-registry.ts` is a **production module**. Every structural
guard that scans production files for a construct also reads that prose. So
`A6b` fired on the registry for "constructing a provider client", and `T12` fired
on it for "holding a speech-to-text vendor call". **The description of the defect
became an instance of it.**

Rewritten as prose that names the shape without spelling the token. The rule
worth keeping: *narratives in a scanned module must describe constructs, never
contain them.*

(A second, dumber version of the same mistake: the first write of that entry went
through `node -e "…"` in a double-quoted shell string, and the backticks were
eaten by command substitution — silently deleting the phrase they wrapped. Wrote
the fix to a script file instead, and verified by importing the module and
reading the value back.)

## Verification

Typecheck EXIT=0. Guard chain **225/225** in two halves, `test:sweep` last and
actually run (457 proofs). The new `test:ai-gateway-lane` (12 assertions, 18
controls) confirmed to have executed *inside* the chain, not just standalone.
m406 and m407 confirmed present in `supabase_migrations.schema_migrations` —
wave 27's lesson, applied.

## Still owner rulings

- **Two platform-role vocabularies disagree.** `callerIsPlatformStaff()` admits
  `platform_role` in (superadmin, admin, marketing, support);
  `is_platform_admin()` admits only superadmin. A `support` user would pass the
  app gate to publish a platform-wide KB article and be silently refused by RLS.
  Zero such users live today. One roster must become the source of truth.
- Two lockfiles disagree: `pnpm-lock.yaml` is stale (pins `@ai-sdk/anthropic`
  where npm had a newer version). `package-lock.json` is the live one.
- The un-metered STT lane in `lib/repurpose/actions.ts`, `voice_calls.recording_url`
  having no writer anywhere, and five swallowed reads in `loadScrapingDiagnostics`
  — carried in the task ledger.
