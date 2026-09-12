// lib/voice/recording-playback-path.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE PURE FUNCTION, in its own module ON PURPOSE.
//
// Every call-recording player in the app is a CLIENT component, and every one of
// them needs to know where to point its `<audio src>`. The rest of the recording
// machinery (lib/voice/call-recording.ts) resolves brokerage settings and talks
// to Twilio through the connector gateway — server-side code that has no
// business being pulled into a browser bundle just because a table cell needed a
// URL string. So the shared, client-safe half lives here alone.
//
// WHY A PATH AND NOT `voice_calls.recording_url` — the column holds the VENDOR
// url (api.twilio.com/2010-04-01/Accounts/<AccountSid>/Recordings/<Sid>.mp3),
// which Twilio serves behind HTTP Basic auth. A browser pointed at it gets 401,
// and handing the browser the tenant's auth token to fix that would publish
// telephony credentials to every agent's devtools. Playback therefore goes
// through the authenticated, tenant-scoped same-origin proxy at
// app/api/voice/recording/[callId]/route.ts, which resolves those credentials
// server-side and streams the audio back.
//
// The column stays the vendor URL because that is what the server-side readers
// need: app/actions/ai-voice-transcription.ts fetches it, and
// lib/security/audio-source-allowlist.ts rule 3 is written to admit that host.

/** PURE: the same-origin path a BROWSER plays a call recording from.
 *  Takes the `voice_calls.id`, never the recording URL. */
export function recordingPlaybackPath(voiceCallId: string): string {
  return `/api/voice/recording/${encodeURIComponent(voiceCallId)}`
}
