# Lane A feature routing — working notes

Branch: `claude/settings-consolidation-ui-0cd7lo`
Scope (files owned by this agent):
- `app/actions/content-generation-engine.ts`
- `lib/content-generation/content-generator.ts`
- `lib/content-generation/generation-logger.ts`
- `lib/content-generation/index.ts`
- this notes file

Everything else is READ ONLY (another agent is editing in parallel).

---

## 0. Starting state (read, not assumed)

`lib/content-generation/content-generator.ts` emits four feature strings into
`runPipelineSimple(prompt, { feature })`:

| line | function | feature expression |
|---|---|---|
| 64  | `generateTextContent`  | `` `content_generation_${params.content_type}` `` |
| 100 | `generateAudioScript`  | `"content_generation_audio"` |
| 127 | `generateVideoScript`  | `"content_generation_video"` |
| 156 | `generateImagePrompt`  | `"content_generation_image_prompt"` |

`generateOmnipresentContent` (line 180) and `generateContentVariations` (line 263)
do NOT pass a feature of their own — they delegate to the four functions above
(`generateAudioScript`, `generateVideoScript`, `generateTextContent`). So fixing
the four sites fixes all six entry points. Recorded here so nobody re-hunts for
a fifth synthesized string.

`lib/ai/content-features.ts` (READ ONLY, already written) supplies
`contentFeatureForType(contentType)`.

---
## 1. Task 1 — routing verification (BEFORE / AFTER)

Method (models.ts is `server-only`, so no import): brace-matched the object literal
starting at `}> = {` in `lib/ai/models.ts` and parsed the 50 single-line entries
textually. **50 keys recovered**, matching the count in the brief. Default on a
miss is `AI_TASK_ROUTING["unspecified"]` (`models.ts:153`).

`runPipelineSimple` (`lib/ai/pipeline.ts:297`) passes `options.feature` straight
into `metadata.feature` on `generateAIResponse`, which is what both
`selectModelForTask` (`models.ts:434,442`) and the `ai_tool_usage` cost ledger
read. So the feature string is load-bearing for BOTH routing and the ledger.

| # | fn | content_type | BEFORE feature | hit? | BEFORE model → fallback | AFTER feature | hit? | AFTER model → fallback | model changed |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `generateTextContent` | `email` | `content_generation_email` | **MISS** | `claude-sonnet` → `gpt-4o` | `email_generation` | yes | `claude-sonnet` → `gpt-4o` | no |
| 2 | `generateTextContent` | `newsletter` | `content_generation_newsletter` | **MISS** | `claude-sonnet` → `gpt-4o` | `newsletter_generation` | yes | `claude-sonnet` → `gpt-4o` | no |
| 3 | `generateTextContent` | `sms_script` | `content_generation_sms_script` | **MISS** | `claude-sonnet` → `gpt-4o` | `sms_generation` | yes | `claude-sonnet` → `gpt-4o-mini` | **YES** |
| 4 | `generateTextContent` | `direct_mail` | `content_generation_direct_mail` | **MISS** | `claude-sonnet` → `gpt-4o` | `direct_mail_copy` | yes | `claude-sonnet` → `gpt-4o` | no |
| 5 | `generateTextContent` | `blog` | `content_generation_blog` | **MISS** | `claude-sonnet` → `gpt-4o` | `blog_post_generation` | yes | `claude-sonnet` → `gpt-4o` | no |
| 6 | `generateTextContent` | `social_post` | `content_generation_social_post` | **MISS** | `claude-sonnet` → `gpt-4o` | `social_post_generation` | yes | `claude-sonnet` → `gpt-4o` | no |
| 7 | `generateTextContent` | `listing_description` | `content_generation_listing_description` | **MISS** | `claude-sonnet` → `gpt-4o` | `listing_description` | yes | `claude-sonnet` → `gpt-4o` | no |
| 8 | `generateTextContent` | `ad_copy` | `content_generation_ad_copy` | **MISS** | `claude-sonnet` → `gpt-4o` | `social_post_generation` | yes | `claude-sonnet` → `gpt-4o` | no |
| 9 | `generateAudioScript` | `podcast_script / audio_script` | `content_generation_audio` | **MISS** | `claude-sonnet` → `gpt-4o` | `video_script_generation` | yes | `claude-sonnet` → `gpt-4o` | no |
| 10 | `generateVideoScript` | `video_script` | `content_generation_video` | **MISS** | `claude-sonnet` → `gpt-4o` | `video_script_generation` | yes | `claude-sonnet` → `gpt-4o` | no |
| 11 | `generateImagePrompt` | `image_prompt` | `content_generation_image_prompt` | **MISS** | `claude-sonnet` → `gpt-4o` | `generate_text` | yes | `claude-haiku` → `gpt-4o-mini` | **YES** |

### HONEST CORRECTION TO THE AUDIT'S FRAMING

The brief says the video path "misses `video_script_generation` … and gets the
static default instead." The miss is real — all 11 call shapes missed. But the
`unspecified` default is:

    unspecified: { model: "claude-sonnet", fallback: "gpt-4o",
                   reason: "Unknown feature — default to best general model" }

which is **byte-identical** to `video_script_generation`'s route
(`claude-sonnet` → `gpt-4o`). So the guarded Fair Housing video path was NOT
silently running on a weaker model. It was running on the right model *by
coincidence*, not by designation.

Only **2 of 11** call shapes actually change model/fallback:
  · `sms_script` — fallback `gpt-4o` → `gpt-4o-mini` (now matches `sms_generation`)
  · `image_prompt` — `claude-sonnet`/`gpt-4o` → `claude-haiku`/`gpt-4o-mini`
    (`generate_text`: "Generic short text")

I am recording this rather than overstating the fix. The durable win is not the
model swap, it is:
  1. Routing becomes DESIGNATED instead of accidental. Today `unspecified` happens
     to equal the content route; the moment someone retunes `unspecified` (it is
     the catch-all for 50-key misses) every Lane A path silently drifts. After
     this change Lane A is pinned to its own registry rows.
  2. LEDGER. `ai_tool_usage.feature` now carries real registry keys, so one
     `feature IN (CONTENT_GENERATION_FEATURES)` predicate finally spans Lane A
     and Lane B. That was impossible with two vocabularies.

Note `image_prompt` → `generate_text` is deliberately NOT in
`CONTENT_GENERATION_FEATURES` (content-features.ts documents why: `generate_text`
is product-wide, counting it would sweep unrelated spend into the content panel).
Consequence, stated plainly: **Lane A's image-prompt calls remain invisible to the
content cost panel.** That is a deliberate trade made upstream in
`lib/ai/content-features.ts` (read-only for me), not a defect I introduced.

---
## 2. Task 2 — `activities.agent_id` cross-space fallback

### LIVE DATABASE VERDICT (project `hrvaqgvukzxfskkcrwbt`)

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid='public.activities'::regclass and contype='f';
```
```
activities_agent_id_fkey       FOREIGN KEY (agent_id)       REFERENCES agents(id)      ON DELETE CASCADE
activities_agent_user_id_fkey  FOREIGN KEY (agent_user_id)  REFERENCES users(id)       ON DELETE SET NULL
activities_brokerage_id_fkey   FOREIGN KEY (brokerage_id)   REFERENCES brokerages(id)  ON DELETE CASCADE
activities_contact_id_fkey     FOREIGN KEY (contact_id)     REFERENCES contacts(id)    ON DELETE SET NULL
activities_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id)ON DELETE SET NULL
```

**THE FK EXISTS AND IS VALID** (no `NOT VALID` in the definition). The audit's
claim is CONFIRMED, not refuted.

Nullability (`information_schema.columns`):

| column | type | nullable | default |
|---|---|---|---|
| `brokerage_id`  | uuid | **NO**  | — |
| `agent_id`      | uuid | YES | — |
| `agent_user_id` | uuid | YES | — |
| `entity_id`     | uuid | YES | — |
| `entity_type`   | text | NO  | `'unknown'` |

And the killer datum:

```sql
select count(*) from public.agents a join public.users u on u.id = a.id;  -- → 0
```
(agents: 5 rows, users: 23 rows, **overlap: 0**)

`agents.id` and `users.id` are DISJOINT id spaces in the live data. So
`return { agentId: ctx.userId }` does not "sometimes" fail — it can **never**
satisfy `activities_agent_id_fkey`. Every broker/admin/TC content generation
insert was FK-rejected (23503), and `logContentGeneration` swallows it: it logs
to `console.error` and returns `{ success: false }`, which the calling server
action never inspects (`await logContentGeneration(...)` — return value dropped
at content-generation-engine.ts:144, 201, 284, 337, 436, 541). The user saw
"success" and got content; the audit trail silently recorded nothing.

Corroborating: only 2 rows in `activities` have
`activity_type in ('content_generated','omnipresent_content_generated')` out of
24 total, and 3 rows have `agent_id IS NULL` — consistent with a path that
mostly fails to write.

### THE SCHEMA ALREADY HAS THE HONEST ANSWER

`agent_id` is NULLABLE and there is a dedicated `agent_user_id → users(id)`
column. The brief's own guidance ("if it is nullable, writing NULL with the user
recorded elsewhere is honest") is exactly what this schema was built for. Better
still, the BEFORE INSERT trigger already handles it:

```sql
CREATE TRIGGER activities_set_brokerage_trg BEFORE INSERT ON public.activities
  FOR EACH ROW EXECUTE FUNCTION activities_set_brokerage()
```
```plpgsql
  IF NEW.brokerage_id IS NULL THEN
    ... contact_id / listing_id / transaction_id / entity_type branches ...
    ELSIF NEW.agent_id      IS NOT NULL THEN SELECT brokerage_id ... FROM agents WHERE id = NEW.agent_id;
    ELSIF NEW.agent_user_id IS NOT NULL THEN SELECT brokerage_id ... FROM users  WHERE id = NEW.agent_user_id;
    END IF;
  END IF;
```

The DB author anticipated the agent-less actor and gave it `agent_user_id`.
Lane A just never used the column.

### FIX APPLIED (RESOLVE, never substitute)

1. `resolveAuthorizedAgentId()` now returns `agentId: string | null`. For a
   caller with no `agents` row it returns `agentId: null` + the real `userId`,
   instead of substituting a `users.id` into an `agents.id` slot.
2. `logContentGeneration` / `logOmnipresentGeneration` / `logBatchContentGeneration`
   take `agent_id: string | null` plus `agent_user_id` and `brokerage_id`, and
   write `agent_user_id` on every row (agents too — it is the human behind the
   agent row and the FK is `ON DELETE SET NULL`, so it is safe and strictly more
   information).
3. History/stats reads branch: filter by `agent_id` when there is an agent row,
   otherwise by `agent_user_id`. Without this, a broker's history query would
   `.eq("agent_id", null)` and silently return everything-or-nothing.

### TENANT-ANCHOR GAP — CONFIRMED AND FIXED

`logContentGeneration` did **not** set `brokerage_id`, and the column is
`NOT NULL`. It only survived at all because `activities_set_brokerage_trg`
back-fills it from `agents`. For the broker/admin path that back-fill could
never run (the row was rejected on the FK first). Both loggers now pass
`brokerage_id` explicitly from the already-verified `auth.brokerageId`, so the
tenant anchor is set by the application rather than inferred by a trigger.

### ALSO FOUND — `entity_id` / `entity_type` were accepted and DISCARDED

`logContentGeneration` declared `entity_id` and `entity_type` params and never
put either in the `.insert({...})`. Callers pass the runtime `content_id` UUID at
content-generation-engine.ts:147-148, 204, 287, 340, 439, 544 — all thrown away,
and `entity_type` defaulted to `'unknown'`. Both columns exist, `entity_id` has
no FK, so writing them is safe. Fixed (`entity_type` defaults to `'content'`).
Checked the trigger for interference: its `entity_type = 'contact'/'listing'/
'transaction'` branches do not match `'content'`, and we now set `brokerage_id`
explicitly anyway, so the trigger short-circuits.

---
