// lib/podcast/episode-audio.ts
//
// ASSEMBLE, LEVEL AND MEASURE A PODCAST EPISODE'S AUDIO (wave 143, lane 143F). The pure judge is episode-audio-spec.ts; this is the
// ffmpeg half (ffmpeg-static — the same binary lib/remotion/music-mixer.ts and lib/video/tv-spot-measure.ts run).
//
// WHY IT EXISTS: the manual studio path (app/actions/podcast-generation.ts generatePodcastAudio) synthesised one MP3 per script
// segment and published the FIRST one as the whole episode. assemblePodcastEpisode joins every segment into ONE file, levels it to the
// podcast target (−16 LUFS, −1 dBTP — loudnorm single pass, then ONE measured linear trim, the same pattern as the video masters) and
// returns the file's OWN measurements, so the caller records the real duration — not the sum of estimates — and a file that cannot be
// decoded never becomes an episode. The weekly auto-producer (one TTS call for the whole script) uses the same function with one input:
// the audio is levelled and probed before it is hosted, where before the bytes of a failed TTS call (a 200 with a JSON error body) would
// have been stored as `audio/mpeg` and handed to every podcast client.
//
// Never throws: a failed pass returns ok:false with the reason and the inputs untouched.
//
// The METER (duration / codec / EBU R128 loudness and true peak of a file) is lib/podcast/episode-audio-measure.ts:1 — extracted so this pass
// imports it. No behaviour changed.

import "server-only"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PODCAST_AUDIO_SPEC, evaluatePodcastAudio, podcastTrimGainDb, probeMp3, type PodcastAudioEvaluation, type PodcastAudioFacts } from "./episode-audio-spec"
import { ffmpegAvailable, measurePodcastAudio, runFfmpeg as run } from "./episode-audio-measure"

export type PodcastAssembleOutcome =
  | { ok: true; buffer: Buffer; facts: PodcastAudioFacts; evaluation: PodcastAudioEvaluation; trimDb: number | null; segments: number }
  | { ok: false; error: string }

/**
 * Join the segments (in order) into ONE episode file, level it, and return it with its own measurements. Every segment must probe as
 * an MP3 first — a failed TTS call's JSON body is refused here by name, before ffmpeg is asked to "decode" it.
 */
export async function assemblePodcastEpisode(segments: Buffer[], opts: { title?: string } = {}): Promise<PodcastAssembleOutcome> {
  if (!ffmpegAvailable()) return { ok: false, error: "ffmpeg-static unavailable" }
  if (segments.length === 0) return { ok: false, error: "no audio segments to assemble" }
  for (let i = 0; i < segments.length; i++) {
    const p = probeMp3(segments[i])
    if (!p.ok) return { ok: false, error: `segment ${i + 1} of ${segments.length} is not playable audio: ${p.reasons.join("; ")}` }
  }
  const dir = await fs.mkdtemp(join(tmpdir(), "podcast-assemble-"))
  const outPath = join(dir, "episode.mp3"), trimPath = join(dir, "trim.mp3")
  try {
    const inputs: string[] = []
    for (let i = 0; i < segments.length; i++) {
      const p = join(dir, `seg-${i}.mp3`)
      await fs.writeFile(p, segments[i])
      inputs.push("-i", p)
    }
    const t = PODCAST_AUDIO_SPEC.loudness
    const norm = segments.map((_, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[a${i}]`).join(";")
    const join_ = `${segments.map((_, i) => `[a${i}]`).join("")}concat=n=${segments.length}:v=0:a=1[cat]`
    const meta = opts.title ? ["-metadata", `title=${opts.title.slice(0, 120)}`] : []
    await run(["-y", ...inputs, "-filter_complex", `${norm};${join_};[cat]loudnorm=I=${t.targetLufs}:TP=${t.maxTruePeakDbtp}:LRA=11,aresample=44100[out]`, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", "-ac", "1", ...meta, outPath])
    let out = await fs.readFile(outPath)
    let measured = await measurePodcastAudio(out)
    if (!measured.ok) return { ok: false, error: `assembled file could not be re-measured: ${measured.error}` }
    // THE MEASURED TRIM — single-pass loudnorm misses a short programme by up to ~1 LU; one read, one linear gain.
    let trimDb: number | null = null
    if (measured.facts.integratedLufs !== null && measured.facts.truePeakDbtp !== null) {
      const gain = podcastTrimGainDb({ integratedLufs: measured.facts.integratedLufs, truePeakDbtp: measured.facts.truePeakDbtp })
      trimDb = gain
      if (gain !== 0) {
        await run(["-y", "-i", outPath, "-af", `volume=${gain}dB`, "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", "-ac", "1", ...meta, trimPath])
        out = await fs.readFile(trimPath)
        measured = await measurePodcastAudio(out)
        if (!measured.ok) return { ok: false, error: `trimmed file could not be re-measured: ${measured.error}` }
      }
    }
    return { ok: true, buffer: out, facts: measured.facts, evaluation: evaluatePodcastAudio(measured.facts), trimDb, segments: segments.length }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
