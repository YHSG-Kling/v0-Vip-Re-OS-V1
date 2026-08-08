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
