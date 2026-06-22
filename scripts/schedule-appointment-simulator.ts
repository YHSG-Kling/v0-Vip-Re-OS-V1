/**
 * Simulator for the pure core of the ISA "Book Appointment" flow.
 *
 * Exercises lib/ai-isa/appointment-form.ts with real assertions and no mocks.
 * The server action (scheduleAppointment) and kernel scheduler are pure
 * delegation + DB writes and are NOT simulated here — only the pure form logic.
 *
 * Run: npx tsx scripts/schedule-appointment-simulator.ts
 */

import {
  APPOINTMENT_TYPES,
  buildAppointmentTimes,
  defaultDurationMinutes,
  labelForType,
  resolveTimezoneName,
} from '../lib/ai-isa/appointment-form'

let passed = 0
let failed = 0

function check(name: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`)
  }
}

const NOW = new Date('2026-06-22T12:00:00.000Z')
const future = '2026-06-23T15:30' // datetime-local style (no tz suffix)

console.log('defaultDurationMinutes / labelForType')
check('buyer_consult duration is 45', defaultDurationMinutes('buyer_consult') === 45)
check('listing_appt duration is 60', defaultDurationMinutes('listing_appt') === 60)
check('showing duration is 30', defaultDurationMinutes('showing') === 30)
check('unknown type falls back to 30', defaultDurationMinutes('nope') === 30)
check('label resolves known type', labelForType('phone_followup') === 'Phone Follow-up')
check('label echoes unknown type', labelForType('weird') === 'weird')
check(
  'every type has a positive duration',
  APPOINTMENT_TYPES.every((t) => t.defaultMinutes > 0),
)

console.log('buildAppointmentTimes — happy path')
const ok = buildAppointmentTimes(future, 'listing_appt', NOW)
check('valid input returns ok', ok.ok === true)
if (ok.ok) {
  const start = new Date(ok.times.startAt)
  const end = new Date(ok.times.endAt)
  const diffMin = (end.getTime() - start.getTime()) / 60_000
  check('end is start + 60m for listing_appt', diffMin === 60)
  check('startAt is valid ISO', !Number.isNaN(start.getTime()))
  check('start is after NOW', start.getTime() > NOW.getTime())
}

console.log('buildAppointmentTimes — duration varies by type')
const showing = buildAppointmentTimes(future, 'showing', NOW)
check('showing produces 30m window', showing.ok === true &&
  (new Date(showing.times.endAt).getTime() - new Date(showing.times.startAt).getTime()) / 60_000 === 30)

console.log('buildAppointmentTimes — validation failures')
const empty = buildAppointmentTimes('', 'showing', NOW)
check('empty value rejected', empty.ok === false)
check('empty error mentions date', !empty.ok && /date/i.test(empty.error))

const garbage = buildAppointmentTimes('not-a-date', 'showing', NOW)
check('garbage value rejected', garbage.ok === false)

const past = buildAppointmentTimes('2026-06-21T10:00', 'showing', NOW)
check('past datetime rejected', past.ok === false)
check('past error mentions future', !past.ok && /future/i.test(past.error))

const exactlyNow = buildAppointmentTimes('2026-06-22T12:00:00', 'showing', NOW)
check('start equal to NOW rejected (strictly future)', exactlyNow.ok === false)

console.log('resolveTimezoneName')
const tz = resolveTimezoneName()
check('timezone is a non-empty string', typeof tz === 'string' && tz.length > 0)

console.log('')
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
