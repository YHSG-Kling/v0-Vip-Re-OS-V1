/**
 * SPOKEN CRITERIA → LIVING ALERT — conversation extraction tests.
 * Merge/refine logic across multi-utterance transcripts, speaker filtering,
 * confidence gating, and the property_alerts row mapping.
 */

import {
  extractCriteriaFromTranscript,
  criteriaToAlertRow,
  buyerUtterances,
  detectSupplementalCity,
  describeCriteria,
  spokenAlertCallMarker,
  SPOKEN_ALERT_SOURCE,
  VOICE_PROPOSAL_MARKER,
} from '../conversation-criteria'

describe('buyerUtterances', () => {
  test('labeled transcript keeps only the caller lines', () => {
    const transcript = [
      'AI: Hi, how can I help you today?',
      'Caller: I want a 3 bedroom house.',
      'AI: There are homes under $900k in Dallas.',
      'Caller: My budget is under 650k.',
    ].join('\n')

    const utterances = buyerUtterances(transcript)

    expect(utterances).toContain('I want a 3 bedroom house.')
    expect(utterances).toContain('My budget is under 650k.')
    expect(utterances).not.toContain('There are homes under $900k in Dallas.')
  })

  test('unlabeled text is split into sentences', () => {
    const utterances = buyerUtterances('Looking for 3 beds. Budget under 400k.')

    expect(utterances).toHaveLength(2)
    expect(utterances[0]).toBe('Looking for 3 beds.')
  })

  test('a caller utterance with multiple sentences refines in order', () => {
    const utterances = buyerUtterances('Caller: Under 700k works. Actually, under 650k.')

    expect(utterances).toHaveLength(2)
  })
})

describe('extractCriteriaFromTranscript — merge and refine', () => {
  test('later statement refines an earlier price ("under 700" then "under 650" → 650)', () => {
    const transcript = [
      'Caller: We were thinking somewhere under 700k.',
      'AI: Got it, under $700,000.',
      'Caller: Actually, make that under 650k.',
    ].join('\n')

    const result = extractCriteriaFromTranscript(transcript)

    expect(result.criteria.maxPrice).toBe(650000)
  })

  test('never extracts criteria from what the AI said', () => {
    const transcript = [
      'AI: We have great condos under $900k in Dallas.',
      'Caller: I want a 3 bed house under 650k in Mocksley.',
    ].join('\n')

    const result = extractCriteriaFromTranscript(transcript)

    expect(result.criteria.maxPrice).toBe(650000)
    expect(result.criteria.minBeds).toBe(3)
    expect(result.criteria.cities).toContain('Mocksley')
    expect(result.criteria.cities).not.toContain('Dallas')
    expect(result.criteria.propertyTypes).not.toContain('condo')
  })

  test('merges criteria stated across separate utterances', () => {
    const transcript = [
      'Caller: We need at least 3 bedrooms.',
      'Caller: Budget of 500k.',
      'Caller: Ideally in Austin with a pool.',
    ].join('\n')

    const result = extractCriteriaFromTranscript(transcript)

    expect(result.criteria.minBeds).toBe(3)
    expect(result.criteria.maxPrice).toBe(500000)
    expect(result.criteria.cities).toContain('Austin')
    expect(result.criteria.features).toContain('pool')
  })

  test('cities union rather than overwrite (either city serves the buyer)', () => {
    const transcript = [
      'Caller: Looking in Austin.',
      'Caller: Dallas could work too, under 400k.',
    ].join('\n')

    const result = extractCriteriaFromTranscript(transcript)

    expect(result.criteria.cities).toContain('Austin')
    expect(result.criteria.cities).toContain('Dallas')
  })

  test('drops a stale min price when a refinement moves the max below it', () => {
    const transcript = [
      'Caller: Our range is 300k to 400k.',
      'Caller: Actually we need to stay under 250k.',
    ].join('\n')

    const result = extractCriteriaFromTranscript(transcript)

    expect(result.criteria.maxPrice).toBe(250000)
    expect(result.criteria.minPrice).toBeUndefined()
  })

  test('evidence carries the exact utterances the criteria came from', () => {
    const transcript = [
      'Caller: Hi there, how are you?',
      'Caller: 3 bed under 650k in Mocksley.',
    ].join('\n')

    const result = extractCriteriaFromTranscript(transcript)

    expect(result.evidence).toContain('3 bed under 650k in Mocksley.')
    expect(result.evidence).not.toContain('Hi there, how are you?')
  })
})

describe('extractCriteriaFromTranscript — confidence gating', () => {
  test('one signal alone is low confidence', () => {
    const result = extractCriteriaFromTranscript('Caller: My budget is under 500k.')

    expect(result.signalCount).toBe(1)
    expect(result.confidence).toBe('low')
  })

  test('two concrete signals (price + location) are high confidence', () => {
    const result = extractCriteriaFromTranscript('Caller: Under 600k in Mocksley.')

    expect(result.signalCount).toBe(2)
    expect(result.confidence).toBe('high')
  })

  test('beds + location count as two concrete signals', () => {
    const result = extractCriteriaFromTranscript('Caller: I need 3 bedrooms in Austin.')

    expect(result.confidence).toBe('high')
  })

  test('features alone never make an alert proposable', () => {
    const result = extractCriteriaFromTranscript('Caller: I need a pool and a garage.')

    expect(result.criteria.features).toContain('pool')
    expect(result.signalCount).toBe(0)
    expect(result.confidence).toBe('low')
  })

  test('empty transcript yields no signals', () => {
    const result = extractCriteriaFromTranscript('')

    expect(result.signalCount).toBe(0)
    expect(result.confidence).toBe('low')
    expect(result.evidence).toHaveLength(0)
  })
})

describe('detectSupplementalCity', () => {
  test('picks up a proper-noun city the parser city list misses', () => {
    expect(detectSupplementalCity('near good schools in Mocksley')).toBe('Mocksley')
  })

  test('ignores state names and lowercase words', () => {
    expect(detectSupplementalCity('somewhere in Texas')).toBeNull()
    expect(detectSupplementalCity('somewhere in the suburbs')).toBeNull()
  })
})

describe('criteriaToAlertRow', () => {
  test('maps to the real property_alerts columns, always inactive', () => {
    const extraction = extractCriteriaFromTranscript(
      'Caller: 3 bed house under 650k in Mocksley with a garage.'
    )
    const row = criteriaToAlertRow(extraction.criteria, {
      contactId: 'contact-1',
      agentUserId: 'user-1',
      brokerageId: 'brok-1',
      alertName: 'Spoken criteria',
    })

    expect(row.is_active).toBe(false)
    expect(row.source).toBe(SPOKEN_ALERT_SOURCE)
    expect(row.contact_id).toBe('contact-1')
    expect(row.agent_user_id).toBe('user-1')
    expect(row.brokerage_id).toBe('brok-1')
    expect(row.max_price).toBe(650000)
    expect(row.bedrooms_min).toBe(3)
    expect(row.cities).toContain('Mocksley')
    expect(row.property_types).toContain('single_family')
    expect(row.must_have_features).toContain('garage')
    expect(row.frequency).toBe('daily')
    expect(row.delivery_channels).toContain('email')
  })

  test('missing criteria land as nulls / empty arrays, not fabricated values', () => {
    const row = criteriaToAlertRow({ maxPrice: 400000, cities: ['Austin'] }, {
      contactId: 'c', agentUserId: null, brokerageId: 'b', alertName: 'n',
    })

    expect(row.min_price).toBeNull()
    expect(row.bedrooms_min).toBeNull()
    expect(row.bathrooms_min).toBeNull()
    expect(row.must_have_features).toEqual([])
    expect(row.zip_codes).toEqual([])
    expect(row.keywords).toBeNull()
  })
})

describe('markers and labels', () => {
  test('call marker embeds the call id for per-call dedupe', () => {
    expect(spokenAlertCallMarker('abc-123')).toBe('[call:abc-123]')
  })

  test('proposal marker is a stable state discriminator', () => {
    expect(VOICE_PROPOSAL_MARKER).toBe('[VOICE_PROPOSAL]')
  })

  test('describeCriteria reads like the buyer spoke', () => {
    const label = describeCriteria({ minBeds: 3, maxPrice: 650000, cities: ['Mocksley'] })

    expect(label).toBe('3+ bed under $650k in Mocksley')
  })
})
