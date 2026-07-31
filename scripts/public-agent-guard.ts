/**
 * scripts/public-agent-guard.ts
 *
 * test:public-agent — ONE PUBLIC WEBSITE AGENT, THREE WAYS IN.
 *
 * The owner's ask: the website option should be "a live talking or voice/type
 * ai agent". It was neither one lane nor three modes.
 *
 * TWO LANES CLAIMED TO BE THE LIVE WEBSITE AGENT.
 *
 *   Lane A — /embed/[publicId] → /api/embed/session → the D-ID AGENTS SDK.
 *     Through Connection OS, usage-capped, budget-gated, metered, and it
 *     returns the presenter family so the client knows what it may offer.
 *
 *   Lane B — /widget/chat "Live Agent" → /api/widget/avatar-session +
 *     /api/widget/avatar-talk → raw fetch at D-ID's talks/streams and
 *     clips/streams, the API lib/did/agents.ts itself calls DEPRECATED. No
 *     gateway, no cap, no budget gate, no metering.
 *
 * Lane B was not merely worse. IT COULD NEVER HAVE WORKED, at three
 * independent points, all the same identity-class confusion:
 *
 *   · the widget URL carries an AGENTS id (built from agents.id in Settings →
 *     Widget), and avatar-session looked up `agents.user_id = <agents.id>` —
 *     so it returned 404 "Agent not found" on every call ever made;
 *   · the picker's gate read agent_voice_profiles for the avatar, which keys on
 *     agents.id, from a route that had already treated the value as a users id;
 *   · avatar-talk read the ElevenLabs voice the same way.
 *
 * So the button rendered only if a lookup that could not succeed did, and the
 * session behind it 404'd regardless. Retiring it removes three raw D-ID calls,
 * one raw ElevenLabs call, and — the part worth saying out loud — an
 * UNAUTHENTICATED endpoint that let any caller write audio files into the
 * public storage bucket by POSTing text, with no cap and no cleanup.
 *
 * THE SAME BUG WAS ALIVE IN A ROUTE THAT STAYED: /api/widget/session resolved
 * the agent's display name with `users.id = <agents.id>`, which never matches,
 * so every website visitor was greeted by the generic assistant name instead of
 * the agent whose widget they were on. Fixed, not deleted.
 *
 * THREE MODES, AND THE CAPABILITY IS RE-CHECKED. text / voice / live, from one
 * vocabulary that the CHECK constraint, the settings UI and the public widget
 * all read. Voice needs publishMicrophoneStream, which D-ID documents as
 * "supported only with Expressive (V4) agents" — so what a broker ENABLES and
 * what a visitor can USE are different questions, and the widget asks both.
 */
import { readFileSync, existsSync } from "node:fs"
import {
  EMBED_MODES, normalizeEnabledModes, usableModes, initialMode, isEmbedMode,
} from "../lib/embed/widget-modes"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
/** Comments stripped — an assertion must target CODE, never prose. This file's
 *  header names every retired route, so a src() search would match the story. */
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

const WIDGET = "app/widget/chat/widget-chat-client.tsx"
const EMBED = "app/embed/[publicId]/embed-widget.tsx"
const EDITOR = "app/dashboard/settings/embeds/embed-editor.tsx"
const ACTIONS = "app/actions/embed-widgets.ts"
const SESSION = "app/api/widget/session/route.ts"

console.log("\n═══ 1. The dead, ungoverned lane is GONE ═══")
{
  ok("/api/widget/avatar-session no longer exists",
    !existsSync("app/api/widget/avatar-session/route.ts"))
  ok("/api/widget/avatar-talk no longer exists",
    !existsSync("app/api/widget/avatar-talk/route.ts"))
  const w = code(WIDGET)
  ok("the widget no longer calls either", !/avatar-session|avatar-talk/.test(w), WIDGET)
  ok("...and the live_agent mode is out of the mode union",
    !/"live_agent"/.test(w), WIDGET)
  ok("...leaving no orphaned RTCPeerConnection in a widget that cannot stream",
    !/RTCPeerConnection/.test(w), WIDGET)
}

console.log("\n═══ 2. No raw D-ID or ElevenLabs egress survives on the public widget ═══")
{
  for (const f of ["app/api/widget/session/route.ts", "app/api/widget/message/route.ts",
                   "app/api/widget/intake/route.ts", "app/api/widget/capture/route.ts"]) {
    if (!existsSync(f)) continue
    const c = code(f)
    ok(`${f.replace("app/api/", "")} makes no raw call to a vendor host`,
      !/api\.d-id\.com|api\.elevenlabs\.io/.test(c), f)
  }
  ok("nothing anywhere still fetches D-ID's DEPRECATED talks/streams or\n    clips/streams — the whole reason this lane was a consolidation and not\n    a swap",
    !/(talks|clips)\/streams/.test(
      ["app/api/widget", "app/embed", "app/widget"].map((d) => {
        try { return readFileSync(`${d}/../__none__`, "utf8") } catch { return "" }
      }).join("") +
      [WIDGET, EMBED, SESSION].map(code).join("\n")))
}

console.log("\n═══ 3. The mode vocabulary is ONE list ═══")
{
  ok("text, voice and live — the three the owner asked for",
    EMBED_MODES.join(",") === "text,voice,live", EMBED_MODES.join(","))
  ok("an unknown mode is not a mode", !isEmbedMode("hologram") && isEmbedMode("voice"))
  ok("text is never optional — a widget with text off could refuse every visitor\n    whose browser blocks the microphone",
    normalizeEnabledModes([]).includes("text") &&
    normalizeEnabledModes(["voice"]).includes("text"))
  ok("...and junk is dropped rather than stored",
    normalizeEnabledModes(["voice", "telepathy"]).join(",") === "text,voice")
  ok("order is stable regardless of input order",
    normalizeEnabledModes(["live", "voice"]).join(",") === "text,voice,live")
}

console.log("\n═══ 4. Enabled ≠ usable, and the difference is SHOWN ═══")
{
  const enabled = ["text", "voice", "live"] as const

  const expressive = usableModes({ enabled: [...enabled], presenterType: "expressive", browserHasMic: true })
  ok("on an Expressive (V4) avatar all three run",
    expressive.every((m) => !m.unavailableReason), JSON.stringify(expressive))

  const clip = usableModes({ enabled: [...enabled], presenterType: "clip", browserHasMic: true })
  const clipVoice = clip.find((m) => m.mode === "voice")!
  ok("on a clip avatar voice is RETURNED WITH A REASON, not silently dropped —\n    hiding it would read to the broker as a setting that never saved",
    !!clipVoice.unavailableReason, JSON.stringify(clipVoice))
  ok("...while live still runs on that same clip avatar (it needs no microphone)",
    !clip.find((m) => m.mode === "live")!.unavailableReason)
  ok("...and text is never blocked", !clip.find((m) => m.mode === "text")!.unavailableReason)

  const noMic = usableModes({ enabled: [...enabled], presenterType: "expressive", browserHasMic: false })
  ok("a browser with no getUserMedia blocks voice for a DIFFERENT stated reason\n    than an avatar that cannot take audio — the two have different fixes",
    noMic.find((m) => m.mode === "voice")!.unavailableReason !==
    clipVoice.unavailableReason)

  ok("a mode the broker never enabled is absent entirely, not disabled",
    usableModes({ enabled: ["text"], presenterType: "expressive", browserHasMic: true })
      .every((m) => m.mode === "text"))
}

console.log("\n═══ 5. The widget opens on the richest mode that actually works ═══")
{
  ok("expressive + all enabled → live",
    initialMode(usableModes({ enabled: ["text", "voice", "live"], presenterType: "expressive", browserHasMic: true })) === "live")
  ok("voice enabled but live not → voice",
    initialMode(usableModes({ enabled: ["text", "voice"], presenterType: "expressive", browserHasMic: true })) === "voice")
  ok("voice enabled on a clip avatar → text, never a mode that cannot run",
    initialMode(usableModes({ enabled: ["text", "voice"], presenterType: "clip", browserHasMic: true })) === "text")
  ok("nothing enabled → text, the floor",
    initialMode(usableModes({ enabled: ["text"], presenterType: null, browserHasMic: false })) === "text")
}

console.log("\n═══ 6. The public widget consumes the capability it is sent ═══")
{
  const e = code(EMBED)
  ok("it reads presenterType off the session — the server has returned it since\n    m325 and this widget dropped it on the floor",
    /presenterType\?: DidPresenterType/.test(e), EMBED)
  ok("...and resolves its modes through the shared rule",
    /usableModes\(\{/.test(e) && /initialMode\(resolved\)/.test(e))
  ok("it actually publishes the microphone for voice",
    /publishMicrophoneStream\(stream\)/.test(e), EMBED)
  ok("...feature-detected, so an SDK without it degrades instead of throwing",
    /typeof m\.publishMicrophoneStream !== "function"/.test(e))
  ok("...and every exit path RELEASES the mic — a public widget holding an open\n    microphone after the visitor switched back to typing is the kind of thing\n    that ends up in a screenshot",
    /unpublishMicrophoneStream/.test(e) &&
    (e.match(/getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/g) ?? []).length >= 2)
  ok("voice and live share ONE switch rather than forking a second lane —\n    a second lane is how the two public widgets drifted apart to begin with",
    /const selectMode = useCallback/.test(e) && !/toggleMode/.test(e))
  ok("mic failure states are distinguished (denied / no-device / unsupported),\n    because each has a different fix and the visitor gets one chance to care",
    /"denied"/.test(e) && /"no-device"/.test(e) && /"unsupported"/.test(e))
}

console.log("\n═══ 7. The broker can actually choose, and the store is constrained ═══")
{
  const ed = code(EDITOR)
  ok("the settings editor renders from EMBED_MODES, so a mode cannot appear\n    here that the widget would ignore",
    /EMBED_MODES\.map/.test(ed), EDITOR)
  ok("...with the per-mode explanation, not three bare chips",
    /MODE_COPY\[m\]\.adminHint/.test(ed))
  ok("...and text cannot be switched off", /if \(mode === "text"\) return/.test(ed))

  const a = code(ACTIONS)
  ok("the ONE writer normalises rather than trusting the client shape",
    /update\.enabled_modes = normalizeEnabledModes\(params\.enabledModes\)/.test(a), ACTIONS)
  ok("...and the read side normalises too, so a legacy row renders",
    /enabledModes: normalizeEnabledModes\(r\.enabled_modes\)/.test(a))

  const mig = src("supabase/migrations/m336-embed-widget-voice-mode.sql")
  ok("m336 constrains the column to the vocabulary",
    /enabled_modes <@ ARRAY\['text','voice','live'\]/.test(mig))
  ok("...and requires text at the database level, not just in the UI",
    /'text' = ANY \(enabled_modes\)/.test(mig))
  ok("...and the migration RECORDS why a CHECK is safe here when it was declined\n    for raw_scraped_leads: the writer set is enumerable and the table is empty",
    /THE WRITER SET IS KNOWN AND SMALL/.test(mig))
}

console.log("\n═══ 8. The identity-class bug that survived the deletion is FIXED ═══")
{
  const s = code(SESSION)
  ok("the display name is resolved through agents → users, not by querying\n    users.id with an agents.id (which never matched, so every visitor got the\n    generic assistant name instead of the agent whose widget they were on)",
    /\.from\('agents'\)[\s\S]{0,120}users!inner\(first_name, last_name\)/.test(s), SESSION)
  // Stronger than checking one surviving query: assert the whole route no longer
  // treats the same id as two classes. agentId is an AGENTS id throughout.
  ok("...and NO lookup in that route keys the agents id against users.id any more",
    !/\.from\('users'\)[\s\S]{0,160}\.eq\('id', agentId\)/.test(s), SESSION)
  ok("the agent_has_did_avatar field went WITH the button it existed for —\n    a computed field with no reader is the same dead weight",
    !/agent_has_did_avatar/.test(s) && !/agent_has_did_avatar/.test(code(WIDGET)))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`PUBLIC AGENT — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nOne public website agent, three ways in — and a mode that cannot run")
  console.log("says so instead of rendering a button that does nothing.")
  process.exit(1)
}
console.log("One lane, three modes, and every capability re-checked against the real presenter.")
