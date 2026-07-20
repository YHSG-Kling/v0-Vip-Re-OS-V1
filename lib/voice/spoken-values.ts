// lib/voice/spoken-values.ts
//
// PURE spoken-value resolvers shared by the deterministic NL parser
// (lib/voice/parse-team-command.ts), the voice backends, and their simulators.
// No I/O, no server-only imports — importable from tests directly.
//
// Conservative by design: every resolver returns null when it isn't SURE, so
// callers ask the speaker to rephrase instead of acting on a guess (the same
// rule the team-command parser follows for acting verbs).

/**
 * Parse a spoken price into dollars.
 *   "450"          → 450        (assumed literal dollars only when ≥ 1000? No —
 *                                bare numbers under 10k are treated as thousands
 *                                is a GUESS; we stay literal and let the caller
 *                                decide. See below.)
 *   "450k" / "450 thousand"     → 450_000
 *   "1.2m" / "1.2 million"      → 1_200_000
 *   "$450,000" / "450,000"      → 450_000
 * Returns null when no number is present.
 *
 * Bare small numbers ("450") are AMBIGUOUS in real-estate speech (agents say
 * "counter at 450" meaning $450k). We resolve: numbers < 10_000 with no
 * suffix are treated as THOUSANDS (450 → 450_000); numbers ≥ 10_000 are taken
 * literally ("450,000" → 450_000). This matches how spokenPrice() reads prices
 * back, so the round-trip is consistent and the backend always confirms the
 * resolved figure aloud before anything irreversible happens.
 */
export function parseSpokenPrice(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 0 ? (raw < 10_000 ? raw * 1000 : raw) : null
  }
  const text = String(raw).toLowerCase().trim()
  const m = text.match(/\$?\s*([\d][\d,]*(?:\.\d+)?)\s*(k|thousand|grand|m|mm|million)?\b/)
  if (!m) return null
  const n = parseFloat(m[1].replace(/,/g, ""))
  if (!Number.isFinite(n) || n <= 0) return null
  const suffix = m[2] ?? ""
  if (suffix === "m" || suffix === "mm" || suffix === "million") return Math.round(n * 1_000_000)
  if (suffix === "k" || suffix === "thousand" || suffix === "grand") return Math.round(n * 1000)
  return n < 10_000 ? Math.round(n * 1000) : Math.round(n)
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const

/**
 * Resolve a spoken date to ISO YYYY-MM-DD relative to `todayISO`.
 * Handles: ISO dates, "today", "tomorrow", weekday names ("saturday",
 * "this saturday" = next occurrence; "next saturday" = the occurrence after
 * that when today-relative occurrence is within this week), and M/D.
 * Returns null when unsure (caller asks for the date).
 */
export function resolveSpokenDate(raw: string | null | undefined, todayISO: string): string | null {
  if (!raw) return null
  const text = String(raw).toLowerCase().trim().replace(/[?.!,]+$/g, "")
  const today = new Date(`${todayISO}T12:00:00Z`)
  if (Number.isNaN(today.getTime())) return null

  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (iso) return iso[1]

  if (/\btoday\b/.test(text)) return todayISO
  if (/\btomorrow\b/.test(text)) {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
  }

  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(text)) {
      const todayDow = today.getUTCDay()
      let delta = (i - todayDow + 7) % 7
      if (delta === 0) delta = 7 // "saturday" spoken ON a saturday = next week's
      if (/\bnext\b/.test(text) && delta <= 3) delta += 7 // "next mon" said on a sun
      const d = new Date(today); d.setUTCDate(d.getUTCDate() + delta)
      return d.toISOString().slice(0, 10)
    }
  }

  // "7/25" or "07/25/2026"
  const md = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
  if (md) {
    const month = Number(md[1]), day = Number(md[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year = md[3] ? Number(md[3]) : today.getUTCFullYear()
      if (year < 100) year += 2000
      const d = new Date(Date.UTC(year, month - 1, day, 12))
      if (!md[3] && d.getTime() < today.getTime()) d.setUTCFullYear(d.getUTCFullYear() + 1)
      return d.toISOString().slice(0, 10)
    }
  }

  return null
}

/**
 * Resolve a spoken time to HH:MM (24h).
 *   "2pm" / "2 p.m." → "14:00"   "2:30pm" → "14:30"   "14:00" → "14:00"
 *   "noon" → "12:00"   "9" (bare, 1–7) → assumed PM ("2" → 14:00, showing
 *   hours); bare 8–11 assumed AM. Returns null when unsure.
 */
export function resolveSpokenTime(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = String(raw).toLowerCase().trim().replace(/\./g, "")
  if (/\bnoon\b/.test(text)) return "12:00"
  if (/\bmidnight\b/.test(text)) return null // never a showing time — ask again

  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const meridiem = m[3] ?? null
  if (hour > 23 || minute > 59) return null

  if (meridiem === "pm" && hour < 12) hour += 12
  else if (meridiem === "am" && hour === 12) hour = 0
  else if (!meridiem && !m[2]) {
    // Bare hour with no minutes and no am/pm — business-hours assumption:
    // 1–7 → PM (showings happen afternoons), 8–11 → AM, 12+ → literal.
    if (hour >= 1 && hour <= 7) hour += 12
  }
  if (hour < 6 || hour > 21) {
    // Outside plausible showing hours after resolution — refuse the guess.
    if (!meridiem && !m[2]) return null
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}
