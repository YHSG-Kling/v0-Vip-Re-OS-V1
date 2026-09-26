#!/usr/bin/env tsx
/**
 * scripts/memory-video-modes-guard.ts   (npm run test:memory-video-modes)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO WAYS A MEMORY VIDEO IS MADE, PROVEN. Owner (wave 80, verbatim): "the
 * memory videos either can be a full video with the seller on screen walking
 * the home with the story or an uploaded audio of the seller talking about the
 * home to preserve the family's home and photos of the home are used for the
 * visuals." "wire d-id and add memory video photo slots."
 *
 * WHAT THIS PROVES
 *   §modes     MEMORY_VIDEO_MODES is the closed pair; assessSellerMedia FAILS
 *              CLOSED — an unknown mode, a chapter without the seller's
 *              recording, a recording of the wrong kind, an audio film with no
 *              photos all refuse naming what is missing; the last capture per
 *              chapter wins; the photo recommendation is reported, not enforced
 *   §voice     the narrator is the seller: MEMORY_VIDEO_VOICE_RULE is
 *              published; the render synthesizes NOTHING (no
 *              prepareReelVoiceover, no identity voice, no cloned voice) — the
 *              chapter's voiceoverUrl/videoUrl IS the seller's recording; the
 *              capture rail stores the mode + photos and the media verdict
 *   §plan      the plan is cut from the chapters' MEASURED frames (one beat per
 *              chapter): walkthrough → client_footage on every chapter, audio →
 *              property_photos with slots that tile each chapter and cover the
 *              photos (no hand timing); the memory reel's cover/outro are its
 *              registered bookends and the purpose max is the cap minus them
 *   §gate      the render refuses BEFORE the render row: media verdict, plan,
 *              dispatch gate — in that order and before recordRenderQueued
 *   §reel      MemoryVideoReel renders the seller's clip (chapter.videoUrl),
 *              the photos through the ONE KenBurnsPhoto survivor in plan-cut
 *              slots, a blurred-photo backdrop, and keeps the words-only
 *              layout for an older row; PhotoWalkthroughReel imports the
 *              survivor and keeps only a tombstone
 *   §surface   the action accepts the mode + photos and refuses an unknown
 *              mode; the card offers both modes, a recording per chapter and
 *              the photo list; the overview passes the saved media back
 *   §schema    seller_media rides video_metadata (jsonb, no CHECK) — no new
 *              column in the live snapshot, no m663 file (nothing to apply)
 *
 * No network. PURE modules only, plus stripped-source scans.
 */
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import {
  MEMORY_VIDEO_MODES, MEMORY_VIDEO_VOICE_RULE, MEMORY_VIDEO_MIN_PHOTOS, assessSellerMedia, isSellerAuthored, type SellerDictatedSegment,
} from "../lib/video/memory-video-gate"
import {
  MEMORY_VIDEO_COMPOSITION_ID, MEMORY_VIDEO_COVER_SECONDS, MEMORY_VIDEO_OUTRO_SECONDS, MEMORY_VIDEO_MAX_SECONDS,
  chapterDurationFrames, memoryChapterSegments, memoryVideoChapterLayout, memoryVideoDurationFrames,
} from "../lib/video/memory-video-composition"
import { COMPOSITION_DURATION_RULES, PURPOSE_DURATION_RULES, planDurationForProps } from "../lib/video/duration-model"
import { planBodyVisual, stageBodyVisualPlan, fitBodyVisualPlan, gateVisualPlanForDispatch, assetsFromProps, photoSlotsForSegment, PURPOSE_BODY_VISUAL_RULES } from "../lib/video/body-visual-model"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(join(root, rel), "utf8")
const readStripped = (rel: string): string => stripComments(read(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const seg = (promptId: string, over: Partial<SellerDictatedSegment> = {}): SellerDictatedSegment => ({
  promptId, sellerWords: `Words for ${promptId}. Another sentence here.`, capturedVia: "voice_recording", capturedAt: "2026-09-23T00:00:00Z",
  mediaUrl: `https://bucket/${promptId}.mp3`, mediaKind: "audio", mediaDurationSeconds: 12, ...over,
})
const AUDIO = ["arrival", "the_house", "the_people"].map((id) => seg(id))
const VIDEO = AUDIO.map((s) => ({ ...s, mediaUrl: s.mediaUrl!.replace(".mp3", ".mp4"), mediaKind: "video" as const }))
const PHOTOS = ["https://p/1.jpg", "https://p/2.jpg", "https://p/3.jpg", "https://p/4.jpg", "https://p/5.jpg"]

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §modes · two ways, and the media verdict fails closed ──")
{
  check("MEMORY_VIDEO_MODES is exactly seller_walkthrough / seller_audio_photos", MEMORY_VIDEO_MODES.join() === "seller_walkthrough,seller_audio_photos")
  const none = assessSellerMedia({ mode: null, segments: AUDIO, photoUrls: PHOTOS })
  check("no mode → refused, naming both modes", !none.ok && none.mode === null && /seller_walkthrough or seller_audio_photos/.test(none.reason))
  check("an unknown mode → refused (closed vocabulary)", !assessSellerMedia({ mode: "tts_narration", segments: AUDIO, photoUrls: PHOTOS }).ok)
  const okAudio = assessSellerMedia({ mode: "seller_audio_photos", segments: AUDIO, photoUrls: PHOTOS })
  check("audio mode with the seller's audio on every chapter and photos → ok", okAudio.ok && okAudio.mode === "seller_audio_photos" && okAudio.photoCount === 5)
  const missing = assessSellerMedia({ mode: "seller_audio_photos", segments: [AUDIO[0], { ...AUDIO[1], mediaUrl: null }, AUDIO[2]], photoUrls: PHOTOS })
  check("a chapter without the seller's recording → refused, naming the chapter and the voice rule", !missing.ok && missing.missingMedia.join() === "the_house" && /does not voice a family's story/.test(missing.reason))
  const wrongKind = assessSellerMedia({ mode: "seller_audio_photos", segments: VIDEO, photoUrls: PHOTOS })
  check("a video recording under the audio mode is the wrong kind → refused for every chapter", !wrongKind.ok && wrongKind.missingMedia.length === 3)
  const noPhotos = assessSellerMedia({ mode: "seller_audio_photos", segments: AUDIO, photoUrls: [] })
  check(`audio mode with no photos → refused (need ≥ ${MEMORY_VIDEO_MIN_PHOTOS}; the photos ARE the visuals)`, !noPhotos.ok && /none are attached/.test(noPhotos.reason))
  const okVideo = assessSellerMedia({ mode: "seller_walkthrough", segments: VIDEO })
  check("walkthrough mode with the seller's clip on every chapter → ok without any photo", okVideo.ok && okVideo.mode === "seller_walkthrough")
  const lastWins = assessSellerMedia({ mode: "seller_audio_photos", segments: [{ ...AUDIO[0], mediaUrl: null }, AUDIO[0]], photoUrls: PHOTOS })
  check("the last capture of a chapter wins (a re-record corrects), exactly as the words do", lastWins.ok)
  const few = assessSellerMedia({ mode: "seller_audio_photos", segments: AUDIO, photoUrls: PHOTOS.slice(0, 1) })
  check("fewer photos than chapters is ADMITTED and reported as a recommendation (photos repeat), never a refusal", few.ok && /one per chapter is the recommendation/.test(few.reason))
  check("nothing captured → refused", !assessSellerMedia({ mode: "seller_walkthrough", segments: [] }).ok)
  check("the authorship check stays (isSellerAuthored) — a row without the seller stamp is not a memory video", isSellerAuthored({ authored_by: "seller", dictation: AUDIO }) && !isSellerAuthored({ authored_by: "agent", dictation: AUDIO }))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §voice · the narrator is the seller; nothing is synthesized, no voice is cloned ──")
{
  check("MEMORY_VIDEO_VOICE_RULE is published and says no TTS and no cloned voice", /No text-to-speech, no cloned voice/.test(MEMORY_VIDEO_VOICE_RULE))
  const renderStripped = readStripped("lib/video/memory-video-render.ts")
  const render = blankStrings(renderStripped)
  check("memory-video-render.ts calls NO synthesiser and resolves NO narration voice (no prepareReelVoiceover, no resolveVideoIdentity, no elevenlabs)", !/prepareReelVoiceover\(|resolveVideoIdentity\(|elevenlabs|generateVideo\(|\/talks|clone/i.test(render))
  check("CONTROL: the synthesiser finder recognises the retired arm", /prepareReelVoiceover\(/.test("const vo = await prepareReelVoiceover({})"))
  check("the render maps the seller's recording onto the chapter by mode: audio → voiceoverUrl, walkthrough → videoUrl",
    /voiceoverUrl: mode === "seller_audio_photos" \? \(s\.mediaUrl \?\? null\) : null/.test(renderStripped) && /videoUrl: mode === "seller_walkthrough" \? \(s\.mediaUrl \?\? null\) : null/.test(renderStripped))
  check("a chapter's frames come from the recording's MEASURED seconds, estimated only when none was recorded — and the count of each is reported",
    /chapterDurationFrames\(secs \?\? estimatedChapterSeconds\(s\.sellerWords\), geo\.fps\)/.test(render) && /measured\+\+; else estimated\+\+/.test(render) && /estimated from the words/.test(read("lib/video/memory-video-render.ts")))
  const rail = readStripped("lib/video/memory-video.ts")
  check("the capture rail stores seller_media (mode + photo_urls) on video_metadata and the media verdict beside the words", /seller_media: sellerMedia/.test(rail) && /media_verdict: \{ ok: mediaVerdict\.ok/.test(rail) && /assessSellerMedia\(/.test(rail))
  check("the rail keeps a prior mode when the save carries none (a later chapter save does not wipe the film's mode)", /: priorMedia/.test(rail))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §plan · one beat per chapter, measured frames, plan-cut photo slots ──")
{
  const fps = 30
  const clips = [
    { id: "arrival", title: "q1", sellerWords: AUDIO[0].sellerWords, voiceoverUrl: "https://bucket/arrival.mp3", videoUrl: null, durationFrames: chapterDurationFrames(12, fps) },
    { id: "the_house", title: "q2", sellerWords: AUDIO[1].sellerWords, voiceoverUrl: "https://bucket/the_house.mp3", videoUrl: null, durationFrames: chapterDurationFrames(30, fps) },
    { id: "the_people", title: "q3", sellerWords: AUDIO[2].sellerWords, voiceoverUrl: "https://bucket/the_people.mp3", videoUrl: null, durationFrames: chapterDurationFrames(7.5, fps) },
  ]
  const segs = memoryChapterSegments(clips)
  check("memoryChapterSegments: one beat per chapter carrying its measured frames and its words", segs.length === 3 && segs.every((s) => s.kind === "beat" && s.frames > 0 && s.words > 0) && segs.map((s) => s.frames).join() === clips.map((c) => c.durationFrames).join())
  const spec = COMPOSITION_DURATION_RULES[MEMORY_VIDEO_COMPOSITION_ID]
  check("the memory reel's cover and end card ARE its registered bookends (one source: memory-video-composition's constants)", spec.introFrames === MEMORY_VIDEO_COVER_SECONDS * 30 && spec.outroFrames === MEMORY_VIDEO_OUTRO_SECONDS * 30)
  check("the memory purpose max body = film cap − cover − outro (assert the rule, derive the number)", PURPOSE_DURATION_RULES.memory.maxSeconds === MEMORY_VIDEO_MAX_SECONDS - MEMORY_VIDEO_COVER_SECONDS - MEMORY_VIDEO_OUTRO_SECONDS)
  const audioProps = { title: "t", familyName: "f", tenureLine: null, chapters: clips, mode: "seller_audio_photos", photoUrls: PHOTOS, videoPurpose: "memory", brand: {} }
  const dur = planDurationForProps(MEMORY_VIDEO_COMPOSITION_ID, audioProps)
  check("planDurationForProps honours the memory reel's own planner: the length is cover + Σ chapters + outro, the body is Σ chapters",
    dur.durationInFrames === memoryVideoDurationFrames({ chapters: clips }, fps) && dur.bodyFrames === clips.reduce((a, c) => a + c.durationFrames, 0) && dur.introFrames === spec.introFrames)
  const audio = stageBodyVisualPlan({ compositionId: MEMORY_VIDEO_COMPOSITION_ID, props: audioProps, purpose: "memory", segments: segs })
  check("audio mode plans property_photos on every chapter with a blurred-photo backdrop, and the segments ARE the chapter layout (frame-exact)",
    audio.ok && audio.plan.segments.every((s) => s.treatment === "property_photos" && s.background === "none")
    && audio.ok && audio.plan.segments.map((s) => `${s.from}:${s.durationInFrames}`).join() === memoryVideoChapterLayout({ chapters: clips }, fps).map((s) => `${s.from}:${s.durationInFrames}`).join())
  if (audio.ok) {
    const covered = new Set<number>()
    let tiles = true
    for (const s of audio.plan.segments) {
      const slots = photoSlotsForSegment(audio.plan, s.index, PHOTOS.length)
      let c = s.from
      for (const sl of slots) { if (sl.from !== c) tiles = false; c += sl.durationInFrames; covered.add(sl.photoIndex) }
      if (c !== s.from + s.durationInFrames) tiles = false
    }
    check("the photo slots per chapter tile the chapter exactly through the ONE tiler and the five photos are all placed across three chapters", tiles && covered.size === PHOTOS.length)
    check("re-fitting the plan to the reel's computed length leaves it byte-identical (the plan was already the layout)", fitBodyVisualPlan(audio.plan, MEMORY_VIDEO_COMPOSITION_ID, dur.durationInFrames) === audio.plan)
    const gate = gateVisualPlanForDispatch(audio.plan, assetsFromProps(audioProps, { compositionId: MEMORY_VIDEO_COMPOSITION_ID, avatarClip: false }))
    check("the dispatch gate passes the audio plan with photos on the row", gate.ok)
    const noPhotoGate = gateVisualPlanForDispatch(audio.plan, assetsFromProps({ ...audioProps, photoUrls: [] }, { compositionId: MEMORY_VIDEO_COMPOSITION_ID, avatarClip: false }))
    check("…and refuses it when the photos are gone (asset_missing:property_photos)", !noPhotoGate.ok && noPhotoGate.missing.includes("asset_missing:property_photos"))
  }
  const videoClips = clips.map((c) => ({ ...c, voiceoverUrl: null, videoUrl: c.voiceoverUrl!.replace(".mp3", ".mp4") }))
  const video = stageBodyVisualPlan({ compositionId: MEMORY_VIDEO_COMPOSITION_ID, props: { ...audioProps, mode: "seller_walkthrough", chapters: videoClips, photoUrls: [] }, purpose: "memory", segments: memoryChapterSegments(videoClips) })
  check("walkthrough mode plans client_footage on every chapter (the seller on screen) — never an avatar, never stock", video.ok && video.plan.segments.every((s) => s.treatment === "client_footage"))
  check("the memory rule allows no avatar and no b-roll (verdict never) and requires the seller's footage or the home's photos",
    PURPOSE_BODY_VISUAL_RULES.memory.avatarShare.max === 0 && PURPOSE_BODY_VISUAL_RULES.memory.broll.verdict === "never" && PURPOSE_BODY_VISUAL_RULES.memory.required.join() === "client_footage,property_photos")
  let threw = false
  try { planBodyVisual({ compositionId: MEMORY_VIDEO_COMPOSITION_ID, duration: dur, segments: segs, assets: { avatarClip: true, brollClips: 3, propertyPhotos: 0, screenshots: 0 } }) } catch { threw = true }
  check("CONTROL: an avatar clip cannot reach a memory plan (voiceover host — the planner never resolves an avatar treatment)", !threw && !planBodyVisual({ compositionId: MEMORY_VIDEO_COMPOSITION_ID, duration: dur, segments: segs, assets: { avatarClip: true, brollClips: 3, propertyPhotos: 0, screenshots: 0 } }).segments.some((s) => s.treatment === "full_avatar" || s.treatment === "avatar_pip" || s.treatment === "broll"))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §gate · refusals before the render row, in order ──")
{
  const render = readStripped("lib/video/memory-video-render.ts")
  const at = (re: RegExp) => { const m = re.exec(render); return m ? m.index : -1 }
  const media = at(/assessSellerMedia\(/), hold = at(/evaluateVideoRenderHold\(/), plan = at(/stageBodyVisualPlan\(/), gate = at(/gateVisualPlanForDispatch\(/), row = at(/recordRenderQueued\(/)
  check("order: media verdict → render hold → body-visual plan → dispatch gate → render row (every refusal precedes the one writer)", media > 0 && media < hold && hold < plan && plan < gate && gate < row)
  check("each refusal returns rather than proceeding", /if \(!media\.ok \|\| !media\.mode\) return/.test(render) && /if \(!visual\.ok\) return/.test(render) && /if \(!gate\.ok\) return/.test(render))
  check("the plan rides input_props.bodyVisualPlan and the mode + photos ride the props for the reel", /inputProps\.bodyVisualPlan = visual\.plan/.test(render) && /chapters: clips, mode, photoUrls/.test(render))
  check("usedVoiceover is true only in the audio mode (a separate track actually plays) — never a flag for a track that does not exist", /usedVoiceover: mode === "seller_audio_photos"/.test(render))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §reel · MemoryVideoReel renders footage, plan-cut photo slots, a blurred backdrop, and the words-only fallback ──")
{
  const reel = readStripped("remotion/MemoryVideoReel.tsx")
  check("the seller's clip fills the frame in the walkthrough (<Video src={chapter.videoUrl}> — the client_footage mark)", /<Video src=\{chapter\.videoUrl as string\}/.test(reel))
  check("photo slots come from the plan (photoSlotsForSegment) and the motion from the ONE Ken Burns planner; the photos mount through the KenBurnsPhoto survivor with its caption off",
    /photoSlotsForSegment\(plan, segment\.index, photoUrls\.length\)/.test(reel) && /kenBurnsPlan\(photoSlots\.map/.test(reel) && /<KenBurnsPhoto clip=\{clip\} brand=\{brand\} showCaption=\{false\} \/>/.test(reel))
  check("the blurred-photo backdrop is painted (filter: blur) and the seller's audio plays under the photos", /filter: "blur\(40px\)/.test(reel) && /<Audio src=\{chapter\.voiceoverUrl\} \/>/.test(reel))
  check("the plan is re-fitted to the reel's own length and read per chapter (segment i ↔ chapter i)", /fitBodyVisualPlan\(bodyVisualPlan, "MemoryVideoReel", durationInFrames\)/.test(reel) && /segment=\{plan\?\.segments\[i\] \?\? null\}/.test(reel))
  check("an older row (no plan / no media) keeps the words-only layout (pageAt over the seller's words)", /const \{ page, pageIndex, pages \} = pageAt\(chapter\.sellerWords, frame, chapter\.durationFrames\)/.test(reel))
  check("the reel declares NO frame constant of its own (the layout is memoryVideoChapterLayout)", !/const\s+[A-Z_]{3,}\s*=\s*\d/.test(reel) && /memoryVideoChapterLayout\(\{ chapters \}, fps\)/.test(reel))
  const walk = readStripped("remotion/PhotoWalkthroughReel.tsx")
  check("PhotoWalkthroughReel imports the KenBurnsPhoto survivor and no private copy remains (tombstone only)", /import \{ KenBurnsPhoto \} from "\.\/components\/KenBurnsPhoto"/.test(walk) && !/const KenBurnsPhoto:/.test(walk) && /TOMBSTONE \(wave 80C/.test(read("remotion/PhotoWalkthroughReel.tsx")))
  const survivor = readStripped("remotion/components/KenBurnsPhoto.tsx")
  check("the survivor keeps the S·T transform composition and the cross-fade the walkthrough was rendering with", /transform: `scale\(\$\{scale\}\) translate\(\$\{panX\}%, \$\{panY\}%\)`/.test(survivor) && /crossfadeFrames/.test(survivor) && /showCaption = true/.test(survivor))
  check("CONTROL: the private-copy finder recognises its shape", /const KenBurnsPhoto:/.test("const KenBurnsPhoto: React.FC<{}> = () => null"))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §surface · the action, the card and the overview carry the mode and the recordings ──")
{
  const action = readStripped("app/actions/video/memory-video.ts")
  check("saveMemoryVideoDictationAction accepts { mode, photoUrls } and refuses a mode outside MEMORY_VIDEO_MODES", /media\?: \{ mode: MemoryVideoMode; photoUrls\?: string\[\] \} \| null/.test(action) && /MEMORY_VIDEO_MODES as readonly string\[\]\)\.includes\(String\(media\.mode\)\)/.test(action) && /media: media \?\? null/.test(action))
  const card = readStripped("app/crm/contacts/[contactId]/components/memory-video-card.tsx")
  check("the card offers both modes (radio over MEMORY_VIDEO_MODES), a recording URL + seconds per chapter, the photo list in audio mode, and forwards them", /MEMORY_VIDEO_MODES\.map\(\(m\) =>/.test(card) && /mediaUrl: url \|\| null/.test(card) && /mediaDurationSeconds: Number\.isFinite\(secs\)/.test(card) && /saveMemoryVideoDictationAction\(contactId, segments, \{ mode, photoUrls \}\)/.test(card) && /mode === "seller_audio_photos" \?/.test(card))
  check("the card says the narrator is the seller and nothing is cloned", /no voice is cloned/.test(read("app/crm/contacts/[contactId]/components/memory-video-card.tsx")))
  const overview = readStripped("app/crm/contacts/[contactId]/seller-lifetime-overview.tsx")
  check("the overview reads seller_media + each chapter's recording off the row and hands them to the card", /seller_media\?\.mode/.test(overview) && /initialMode=\{memoryVideoMode\}/.test(overview) && /initialMedia=\{memoryVideoMedia\}/.test(overview) && /initialPhotoUrls=\{memoryVideoPhotoUrls\}/.test(overview))
  check("the browser never sends a brokerage id", !/brokerageId/.test(card))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §schema · jsonb, no column, no migration ──")
{
  const snapshot = read("scripts/schema-snapshot.ts")
  const cols = /ai_video_projects: \[([^\]]+)\]/.exec(snapshot)?.[1] ?? ""
  check("ai_video_projects carries video_metadata (jsonb) and NO seller_media / memory_mode column — the mode rides the jsonb", /"video_metadata"/.test(cols) && !/"seller_media"|"memory_mode"/.test(cols))
  const vocab = read("scripts/check-vocabularies.ts")
  check("no CHECK constrains video_metadata (check-vocabularies has no memory mode vocabulary) — nothing to migrate", !/seller_walkthrough|seller_audio_photos/.test(vocab))
  // The RULE, not a waypoint (§2): wave 80C reserved m663 and left it unused, and this check pinned
  // "m663 has no file" — true until wave 83F spent the number on an unrelated CHECK. What must stay
  // true is that NO migration carries the memory-mode vocabulary (the modes ride video_metadata jsonb).
  const migDir = join(root, "supabase/migrations")
  const memoryModeMigrations = readdirSync(migDir).filter((f) => f.endsWith(".sql") && /seller_walkthrough|seller_audio_photos/.test(stripComments(read(`supabase/migrations/${f}`))))
  check("no migration carries the memory-video mode vocabulary (seller_walkthrough / seller_audio_photos ride video_metadata jsonb) — nothing to migrate",
    memoryModeMigrations.length === 0, memoryModeMigrations.join(", "))
  check("POSITIVE CONTROL: the migration finder sees the vocabulary in a specimen",
    /seller_walkthrough|seller_audio_photos/.test(stripComments("alter table x add constraint c check (mode in ('seller_walkthrough','seller_audio_photos'));")))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
