/**
 * lib/communication/call-compliance.ts
 *
 * Outbound call compliance helpers — runs BEFORE Twilio/VAPI dial:
 *   - Quiet hours: federal TCPA mandates outbound auto-dial calls 8am-9pm
 *     in the RECIPIENT'S local time. We resolve area code → timezone and
 *     check the recipient's local clock.
 *   - Recording disclosure: 12 two-party-consent states require an explicit
 *     "this call may be recorded" intro. We default to ALWAYS PLAY a brief
 *     disclosure (safer + no state-lookup logic gone wrong) but expose the
 *     state-aware helper for callers that want to skip in 1-party states.
 *
 * Both functions are pure / deterministic — no DB access, safe to call
 * synchronously in compliance pipelines.
 */

import "server-only"

// Two-party consent states — require ALL parties to consent to recording.
// Default platform behavior: play the disclosure ALWAYS (zero risk; ~3s overhead).
export const TWO_PARTY_CONSENT_STATES = new Set([
  "CA", "CT", "DE", "FL", "IL", "MD", "MA", "MT", "NV", "NH", "PA", "WA",
])

// Compact area-code → state mapping (US/CA). Some area codes span multiple
// states; we pick the dominant state. For exact precision in production,
// integrate Twilio Lookup or RealPhoneValidation.
const AREA_CODE_TO_STATE: Record<string, string> = {
  "201":"NJ","202":"DC","203":"CT","205":"AL","206":"WA","207":"ME","208":"ID","209":"CA","210":"TX","212":"NY","213":"CA","214":"TX","215":"PA","216":"OH","217":"IL","218":"MN","219":"IN","224":"IL","225":"LA","228":"MS","229":"GA","231":"MI","234":"OH","239":"FL","240":"MD","248":"MI","251":"AL","252":"NC","253":"WA","254":"TX","256":"AL","260":"IN","262":"WI","267":"PA","269":"MI","270":"KY","272":"PA","276":"VA","281":"TX","301":"MD","302":"DE","303":"CO","304":"WV","305":"FL","307":"WY","308":"NE","309":"IL","310":"CA","312":"IL","313":"MI","314":"MO","315":"NY","316":"KS","317":"IN","318":"LA","319":"IA","320":"MN","321":"FL","323":"CA","325":"TX","330":"OH","331":"IL","334":"AL","336":"NC","337":"LA","339":"MA","346":"TX","347":"NY","351":"MA","352":"FL","360":"WA","361":"TX","364":"KY","380":"OH","385":"UT","386":"FL","401":"RI","402":"NE","404":"GA","405":"OK","406":"MT","407":"FL","408":"CA","409":"TX","410":"MD","412":"PA","413":"MA","414":"WI","415":"CA","417":"MO","419":"OH","423":"TN","424":"CA","425":"WA","430":"TX","432":"TX","434":"VA","435":"UT","440":"OH","442":"CA","443":"MD","458":"OR","463":"IN","469":"TX","470":"GA","475":"CT","478":"GA","479":"AR","480":"AZ","484":"PA","501":"AR","502":"KY","503":"OR","504":"LA","505":"NM","507":"MN","508":"MA","509":"WA","510":"CA","512":"TX","513":"OH","515":"IA","516":"NY","517":"MI","518":"NY","520":"AZ","530":"CA","531":"NE","534":"WI","539":"OK","540":"VA","541":"OR","551":"NJ","559":"CA","561":"FL","562":"CA","563":"IA","564":"WA","567":"OH","570":"PA","571":"VA","573":"MO","574":"IN","575":"NM","580":"OK","585":"NY","586":"MI","601":"MS","602":"AZ","603":"NH","605":"SD","606":"KY","607":"NY","608":"WI","609":"NJ","610":"PA","612":"MN","614":"OH","615":"TN","616":"MI","617":"MA","618":"IL","619":"CA","620":"KS","623":"AZ","626":"CA","628":"CA","629":"TN","630":"IL","631":"NY","636":"MO","641":"IA","646":"NY","650":"CA","651":"MN","657":"CA","660":"MO","661":"CA","662":"MS","667":"MD","678":"GA","681":"WV","682":"TX","701":"ND","702":"NV","703":"VA","704":"NC","706":"GA","707":"CA","708":"IL","712":"IA","713":"TX","714":"CA","715":"WI","716":"NY","717":"PA","718":"NY","719":"CO","720":"CO","724":"PA","725":"NV","727":"FL","731":"TN","732":"NJ","734":"MI","737":"TX","740":"OH","743":"NC","747":"CA","754":"FL","757":"VA","760":"CA","762":"GA","763":"MN","765":"IN","769":"MS","770":"GA","772":"FL","773":"IL","774":"MA","775":"NV","779":"IL","781":"MA","785":"KS","786":"FL","801":"UT","802":"VT","803":"SC","804":"VA","805":"CA","806":"TX","808":"HI","810":"MI","812":"IN","813":"FL","814":"PA","815":"IL","816":"MO","817":"TX","818":"CA","828":"NC","830":"TX","831":"CA","832":"TX","843":"SC","845":"NY","847":"IL","848":"NJ","850":"FL","854":"SC","856":"NJ","857":"MA","858":"CA","859":"KY","860":"CT","862":"NJ","863":"FL","864":"SC","865":"TN","870":"AR","872":"IL","878":"PA","901":"TN","903":"TX","904":"FL","906":"MI","907":"AK","908":"NJ","909":"CA","910":"NC","912":"GA","913":"KS","914":"NY","915":"TX","916":"CA","917":"NY","918":"OK","919":"NC","920":"WI","925":"CA","928":"AZ","929":"NY","930":"IN","931":"TN","936":"TX","937":"OH","938":"AL","940":"TX","941":"FL","947":"MI","949":"CA","951":"CA","952":"MN","954":"FL","956":"TX","959":"CT","970":"CO","971":"OR","972":"TX","973":"NJ","978":"MA","979":"TX","980":"NC","984":"NC","985":"LA","986":"ID","989":"MI",
}

// IANA timezone per state (population-weighted primary timezone)
const STATE_TO_IANA_TIMEZONE: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix",
  AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York", DC: "America/New_York", DE: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York",
  LA: "America/Chicago", ME: "America/New_York", MD: "America/New_York",
  MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver",
  NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York",
  NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York",
  RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago",
  TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
}

// ─── Phone parsing ───────────────────────────────────────────────────────────

/** Extract the area code from any US/Canada phone string */
export function parseAreaCode(phone: string): string | null {
  const digits = phone.replace(/\D/g, "")
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits
  if (local.length < 10) return null
  return local.slice(0, 3)
}

/** Resolve phone number → US state code (best-effort, area-code-based) */
export function stateFromPhone(phone: string): string | null {
  const ac = parseAreaCode(phone)
  return ac ? AREA_CODE_TO_STATE[ac] ?? null : null
}

// ─── Quiet hours ─────────────────────────────────────────────────────────────

export interface QuietHoursResult {
  allowed: boolean
  recipientLocalHour: number | null
  recipientTimezone: string | null
  recipientState: string | null
  reason?: string
}

/**
 * TCPA: outbound auto-dialer calls must be 8am-9pm in the recipient's local
 * time. When the state can't be resolved (toll-free, unknown country code),
 * defaults to ALLOWED — production should use a phone validation service
 * for stricter compliance.
 */
export function checkQuietHours(phone: string, now: Date = new Date()): QuietHoursResult {
  const state = stateFromPhone(phone)
  if (!state) {
    return {
      allowed: true,
      recipientLocalHour: null,
      recipientTimezone: null,
      recipientState: null,
      reason: "Could not resolve recipient timezone — defaulted to allowed",
    }
  }

  const tz = STATE_TO_IANA_TIMEZONE[state]
  if (!tz) {
    return { allowed: true, recipientLocalHour: null, recipientTimezone: null, recipientState: state }
  }

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  })
  const hour = parseInt(fmt.format(now), 10)

  if (Number.isNaN(hour)) {
    return { allowed: true, recipientLocalHour: null, recipientTimezone: tz, recipientState: state }
  }

  const allowed = hour >= 8 && hour < 21 // 8am inclusive, 9pm exclusive
  return {
    allowed,
    recipientLocalHour: hour,
    recipientTimezone: tz,
    recipientState: state,
    reason: allowed
      ? undefined
      : `Recipient local time ${hour}:00 (${tz}) is outside TCPA-allowed window 8am-9pm`,
  }
}

// ─── Recording disclosure ────────────────────────────────────────────────────

const RECORDING_DISCLOSURE =
  "This call may be recorded for quality and training purposes. "

/**
 * Returns the disclosure string to PREPEND to the assistant's first message.
 * Default: always play (safe). Pass `onlyTwoPartyStates: true` to skip in
 * 1-party-consent states.
 */
export function getRecordingDisclosure(
  recipientPhone: string,
  options: { onlyTwoPartyStates?: boolean } = {}
): string {
  if (!options.onlyTwoPartyStates) return RECORDING_DISCLOSURE

  const state = stateFromPhone(recipientPhone)
  if (state && TWO_PARTY_CONSENT_STATES.has(state)) {
    return RECORDING_DISCLOSURE
  }
  return ""
}

export function withRecordingDisclosure(
  firstMessage: string,
  recipientPhone: string,
  options?: { onlyTwoPartyStates?: boolean }
): string {
  const disclosure = getRecordingDisclosure(recipientPhone, options)
  if (!disclosure) return firstMessage
  return `${disclosure}${firstMessage}`
}
