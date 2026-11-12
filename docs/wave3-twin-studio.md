# Wave 3 — Twin Studio (avatar + voice identity consolidation)

Status: IN PROGRESS (started 2026-08-08)
Branch: claude/settings-consolidation-ui-0cd7lo

## The ruling (owner, verbatim)
> twin studio is supposed to be where the user creates their avatar for video and if they dont have a
> voice to use with video and other features that use audio, then they need to create their cloned voice.
> once the avatar is created either by the user uploaded a picture or a short video, the finished avatar
> is downloaded to supabase bucket and given a url they will use. voice will give them a voiceid, they
> can also choose or create their assistant avatar and voice. elevenlabs has stock voices they can choose from.

## Six criteria
1. Twin Studio is THE place a user creates their avatar for video.
2. Avatar source is EITHER an uploaded picture OR a short video.
3. Finished avatar rehosted into a SUPABASE BUCKET; that URL is what downstream uses.
4. No voice -> led to create cloned voice; yields voiceId.
5. User can ALSO choose or create their ASSISTANT avatar + ASSISTANT voice.
6. ElevenLabs STOCK voices selectable (clone not the only option).

## Findings log
(appended incrementally)

### 2026-08-08 — read pass 1

**Files that make up the surface**
- `app/dashboard/settings/twin-studio/page.tsx` (server, loads `listMyTwins` + `listPendingApprovals`)
- `app/dashboard/settings/twin-studio/twin-studio-client.tsx` (Tabs: My Twins / Approval Queue + `TwinWizard`)
- `components/twin-wizard.tsx` — steps `look → (consent if video) → voice → personality → done`
- `app/actions/twin-studio.ts` — createTwinDraft / finalizeTwin / setDefaultTwin / deleteTwin / updateTwinDetails / approve / reject
- `app/actions/twin-studio-upload.ts` — buckets `twin-avatars`, `twin-voice-samples`
- `app/api/did/create-avatar/route.ts` — D-ID `/scenes/avatars` submit, consent gate for video
- `app/api/elevenlabs/voice-clone/route.ts` — the ONE clone path (cap + metering)
- `lib/did/avatar-completion.ts` — `rehostAvatarImage` + `applyAvatarOutcome`

**C2 (photo OR video): MET.** twin-wizard `LookStep` offers Photo / Short video, caps 10MB / 50MB,
mime-prefix checked again server-side in `uploadTwinAvatar`, consent step inserted only for video,
D-ID submit deferred past consent for video and immediate for photo. Verified end to end.

**C3 (rehost to Supabase bucket): MET.** `lib/did/avatar-completion.ts:rehostAvatarImage` downloads
the finished D-ID asset and uploads to bucket `twin-avatars` path `rehosted/{assetId}.{ext}`, then
`applyAvatarOutcome` writes that bucket URL to `agent_avatar_assets.avatar_url` + `.thumbnail_url`
and mirrors to `agent_voice_profiles.avatar_url` for the default twin. BOTH photo and video go
through the identical path (same route → same `/scenes/avatars` → same completion applier). Both
learners call it: `app/api/cron/poll-did-avatars/route.ts:130` and `app/api/webhooks/did/route.ts:112`.
TODO: confirm columns live; confirm downstream READS avatar_url.

**C6 (stock voices): NOT MET (confirmed).** Only importer of `avatar-voice-catalog.ts` is
EducationEditor. Twin Studio voice step (`VoiceStep`) offers ONLY record→clone or "skip".

**C5 (assistant avatar+voice): PARTIAL.** `listening-preferences-panel.tsx` wires
`updateMyVoicePreference` + `updateMyProspectVoice` from a `genericVoices` prop; NO avatar control,
so `updateMyAssistantAvatar` is unreachable.

### Live DB verification (project hrvaqgvukzxfskkcrwbt)
`agent_avatar_assets` has: id, agent_id, brokerage_id, label, source_type, source_url,
did_avatar_id, did_agent_id, voice_id, voice_sample_url, avatar_url, thumbnail_url, personality,
greeting, greeting_sentiment, status, approval_status, rejection_reason, approved_by, approved_at,
is_default, error_message, created_at, updated_at.  `agents` has assistant_avatar_id (text),
assistant_voice_id, prospect_voice_id, voice_preference, voice_id, avatar_id.
`agent_voice_profiles` has avatar_url, did_avatar_id, elevenlabs_voice_id. All confirmed present.

### The duplicate found (method step a)
TWO curated stock-voice lists:
- `lib/voice/voice-resolver.ts:GENERIC_VOICES` (8 voices, server-only module, passed as a prop to
  `listening-preferences-panel.tsx` and `phone-settings-client.tsx`)
- `lib/video/assistant-options.ts:ASSISTANT_VOICE_OPTIONS` (6 voices, client-safe, used by
  `AIIdentityEditor.tsx` and `app/actions/video-voice.ts:getVoiceOptionsForGeneration`)
5 of the 6 ids overlap. SURVIVOR: `lib/video/assistant-options.ts:ASSISTANT_VOICE_OPTIONS` — it is
the client-safe module (voice-resolver carries `import "server-only"`), so it is the only one of the
two a client picker can import directly. MERGE: port GENERIC_VOICES' extra voices (Elli, Arnold,
Sam) and its extra fields (gender, accent) onto the survivor; `GENERIC_VOICES` becomes a derived
projection so both call surfaces keep working with ZERO data duplication.

### NOT a duplicate (method step b)
- `updateMyAssistantAvatar` writes `agents.assistant_avatar_id`, read by
  `lib/voice/voice-resolver.ts:resolveSelfAvatar` — it picks which of the agent's OWN twins fronts
  their SELF-VIEW. `AIIdentityEditor` writes `ai_identity_profiles.avatar_url` /
  `.elevenlabs_voice_id` / `.did_expressive_avatar_id` — a DIFFERENT persona (the AI assistant that
  faces contacts). Different tables, different meanings. Both are kept; the orphan gets its surface.
- `listElevenLabsVoices` has ZERO importers (confirmed by grep). It BELONGS to the Twin Studio
  voice step. Wire it — after fixing a real defect in it (see below).

### Defect found in listElevenLabsVoices
`/v1/voices` on the PLATFORM ElevenLabs account returns every voice in that account — including
every agent's INSTANT VOICE CLONE created through `/api/elevenlabs/voice-clone`. Offering that list
unfiltered in a picker would hand agent A the cloned voice of agent B, which is the audio form of
"nobody else's face, ever". Fixed at the source: filter to `category === "premade"`.

### Build plan
A. Merge the two stock-voice lists onto ASSISTANT_VOICE_OPTIONS; GENERIC_VOICES derived.
B. Fix listElevenLabsVoices to premade-only and expose category.
C. twin-studio.ts: `listTwinVoiceOptions()` (curated ∪ live premade) + `setTwinStockVoice()`
   (allowlisted — an id outside the stock set is REFUSED, so this is not a metering-free back door
   to bind a paid clone id; that is the exact reason attachVoiceToTwin was deleted in w2s3).
D. Extract the wizard's voice step into a shared `twin-voice-step.tsx` with two modes:
   record→clone (existing route, cap + metering intact) OR pick a stock voice.
E. TwinCard "Add a voice" for a twin with no voice → the same shared step (C4).
F. Assistant-avatar picker in listening-preferences-panel → updateMyAssistantAvatar (C5).
G. Twin type gains `avatarUrl` (the rehosted bucket URL) and TwinCard prefers it (C3 visible).

### Progress
- [x] A merged ASSISTANT_VOICE_OPTIONS (9 voices, +gender/+accent); GENERIC_VOICES derived
      (`lib/video/assistant-options.ts`, `lib/voice/voice-resolver.ts`)
- [x] B listElevenLabsVoices filters to `category === "premade"`, returns category + description
      (`app/actions/avatar-voice-catalog.ts`)
- [x] C `listTwinVoiceOptions()` + `setTwinStockVoice()` (allowlisted) in `app/actions/twin-studio.ts`;
      Twin type gained `avatarUrl`
- [x] D shared `components/twin-voice-step.tsx` (clone OR stock); wizard's inline VoiceStep deleted
      in favour of it
- [x] E TwinCard: previews `avatarUrl` (bucket) first; "Add a voice" dialog for a voiceless twin
- [ ] F assistant-avatar picker → updateMyAssistantAvatar
- [ ] G cross-links / typecheck

### C1 VIOLATION FOUND — three avatar-creation surfaces, two of them broken
`grep -rn "did/create-avatar"` finds THREE creators:
1. `app/dashboard/settings/twin-studio/components/twin-wizard.tsx` — the survivor. Sends
   `source_type` + `twin_id`, defers the video submit until after `ConsentRecorder`, uploads to the
   `twin-avatars` bucket, and carries the approval gate, the voice step and the personality step.
2. `app/dashboard/videos/voice/voice-client.tsx:~356` — uploads to `agent-photos` via
   `/api/storage/upload-temp`, then FIRE-AND-FORGETS `/api/did/create-avatar` with **no
   `source_type`** (route default = "video") and **no `twin_id`**, with `.catch(console.error)`.
   A video avatar submitted there hits the route's CONSENT GATE and comes back 428 — swallowed —
   while the UI says *"D-ID is processing your avatar (1–3 min) — you'll be notified when it's
   ready."* Nothing was created and nobody is ever notified. This is the exact defect class the
   audit exists to remove: a control that reports success without doing the thing.
3. `app/dashboard/videos/create/video-create-client.tsx:~1405` — same upload path, same missing
   `source_type`, so a PHOTO uploaded there is submitted to D-ID as a VIDEO and refused by the
   consent gate every time. The error IS surfaced here, but the page has no consent recorder, so
   the affordance can never succeed.

METHOD (a): duplicate. SURVIVOR = the Twin Studio wizard. Neither loser has a capability the
survivor lacks (their per-video avatar PICKERS are selection, not creation, and stay). Their
CREATION affordances are removed and replaced with a link to Twin Studio.

### C1 consolidation done
- `app/dashboard/videos/voice/voice-client.tsx` — the fire-and-forget `/api/did/create-avatar` call
  and the false "D-ID is processing your avatar … you'll be notified" line are GONE. The page still
  uploads the source photo/video onto the video profile (`did_photo_url` / `did_video_url`), which
  is the real fallback face `/api/did/generate-video` renders from; it just no longer claims to
  create an avatar. A pointer to Twin Studio was added.
  SURVIVOR NAMED: `app/dashboard/settings/twin-studio/components/twin-wizard.tsx`.
- `app/dashboard/videos/create/video-create-client.tsx` — `handleAddAvatar` + the inline uploader +
  its five dead state hooks DELETED; the "Add Avatar" button now routes to Twin Studio, and the
  "No avatar uploaded" alert points there too. The avatar PICKER (selection) is untouched.
  SURVIVOR NAMED: `app/dashboard/settings/twin-studio/components/twin-wizard.tsx`.
- `grep -rn "did/create-avatar" app --include=*.tsx` now finds calls in twin-wizard.tsx ONLY.

### Guards re-run after the changes (all green)
test:avatar-rehost 11/0 · test:partners-meeting-reel 106/0 · test:voice-clone-lifecycle 58/0 ·
test:did-webhook 66/0 · ui-delivery-guard 27/0 · video-script-compliance 33/0 ·
video-repurpose-wiring 108/0 · doc-kernel 264/0

### Orphan-export guard
`npm run test:orphan-exports` reports, in the section that names files:

    ↓ burned down in 2 file(s):
       app/actions/avatar-voice-catalog.ts: 1 → 0
       app/actions/voice-avatar-settings.ts: 1 → 0

Both orphans this slice was assigned are gone. The guard's global category-C counter moved
349 → 351 in the same run, but `git status` shows SIX other concurrent slices editing this branch
(buyer-execution, contact-enrichment, showings, voice-assistant, lib/enrichment/, portal access),
so that global delta is not attributable to this slice. Nothing in this slice's file set is
unreferenced: listTwinVoiceOptions + setTwinStockVoice are called by twin-voice-step.tsx,
TwinVoiceStep by twin-wizard.tsx and twin-card.tsx, updateMyAssistantAvatar by
listening-preferences-panel.tsx, listElevenLabsVoices by twin-studio.ts:listTwinVoiceOptions.

### Orphan attribution settled
`npm run orphan-exports:list` shows only TWO orphans anywhere in this slice's file set:
- `app/actions/twin-studio.ts:updateTwinDetails` — pre-existing; NOW WIRED (see below).
- `lib/voice/voice-resolver.ts:resolveContactFacing` — pre-existing, outside this slice.
Neither was created by this slice, so the guard's global 349 → 351 belongs to one of the six
concurrent slices on this branch, not to this one.

### Bonus orphan burned down
`updateTwinDetails` is wired to a new "Rename / edit personality" item on TwinCard's menu.
The card had carried a `canEdit` prop that promised an edit affordance and rendered only
Set-default and Delete, so a twin's name and personality were fixed at creation and the only way
to change either was to delete the twin and rebuild it. The dialog's maxLength values (64 / 2000)
mirror the action's ceilings, which refuse rather than truncate.

## FINAL VERDICT ON THE SIX CRITERIA
1. Twin Studio is THE place — **BUILT** (two rival creators removed; survivor named).
2. Photo OR video — **MET** (verified end to end, no change needed).
3. Rehost to Supabase bucket — **MET** (verified; `avatarUrl` surfaced onto the Twin type so the
   bucket URL is what the card renders too).
4. No voice → led to create a clone — **BUILT** ("Add a voice" on a voiceless twin card; the
   wizard step already existed but was a dead end once skipped).
5. Assistant avatar + voice — **MET** for the assistant persona (`AIIdentityEditor`, all three
   scopes); **BUILT** for the self-view avatar (`updateMyAssistantAvatar` now reachable);
   both cross-linked from Twin Studio.
6. ElevenLabs stock voices — **BUILT** (curated ∪ live premade, in the Twin Studio voice step;
   `listElevenLabsVoices` wired and fixed to premade-only).
