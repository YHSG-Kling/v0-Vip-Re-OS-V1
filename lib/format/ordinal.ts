// lib/format/ordinal.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ORDINAL SPELLER (§6 — one vocabulary per function; §1.1 — merge onto
// the survivor). Three private copies of "spell N as an ordinal" lived in
// lib/kernel/anniversary-equity.ts, remotion/EquityReportReel.tsx and
// app/actions/brief-audio.ts; they are retired onto this module, each leaving a
// tombstone naming this file.
//
// PLACEMENT IS THE POINT: this is a PURE LEAF — no imports, no "server-only",
// no kernel, no Supabase — because its callers sit on OPPOSITE sides of two
// bundling walls at once:
//   · remotion/EquityReportReel.tsx is compiled into the Remotion render bundle
//     (@remotion/bundler), which must never drag the kernel in;
//   · lib/kernel/anniversary-equity.ts and app/actions/brief-audio.ts are
//     server code that must never pull a client/render dependency.
// A pure leaf is the only shape both can import. Nothing may ever be added here
// that imports anything.
//
// TWO EXPORTS, deliberately, because the copies were NOT all the same function:
// the display surfaces spell "1st / 2nd / 3rd" while the spoken brief says
// "First, …" (a TTS voice reads "1st" less reliably than a written word, and
// the brief caps at a top-5 list). Same idea — rank as a word — two output
// registers. One module owns both so they cannot drift apart again.
//
// NOT MERGED HERE, stated plainly: lib/video/anniversary-script.ts carries
// ordinalYear (the same suffix speller, trunc-hardened) — it belongs to the
// video lane's files, which a concurrent lane owns; folding it in is that
// lane's (or the integrator's) one-line follow-up: replace ordinalYear's body
// with a call to this ordinal().

/** "1st" / "2nd" / "3rd" / "4th" … — the display register. */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

/**
 * "First" / "Second" … "Fifth", then "Number 6" — the SPOKEN register, sized to
 * the morning brief's top-N list where it came from.
 */
export function ordinalWord(n: number): string {
  return ["First", "Second", "Third", "Fourth", "Fifth"][n - 1] ?? `Number ${n}`
}
