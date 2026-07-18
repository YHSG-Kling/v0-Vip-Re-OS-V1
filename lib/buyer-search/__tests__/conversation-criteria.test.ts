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
  detectStatedSchoolDistrict,
  detectStatedAgeRestrictedCommunity,
  describeCriteria,
  spokenAlertCallMarker,
  writtenAlertMessageMarker,
  hashConversationText,
  SPOKEN_ALERT_SOURCE,
  TEXT_ALERT_SOURCE,
  VOICE_PROPOSAL_MARKER,
  TEXT_PROPOSAL_MARKER,
  AGE_RESTRICTED_LABEL,
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

describe('fair housing — capture buyer-STATED criteria, never steer', () => {
  // A buyer may lawfully ask for a school district or a 55+ community; we
  // capture their OWN words (evidence proves it) and never suggest, infer,
  // or recommend demographic/familial criteria in either direction.

  test('buyer-stated school district is captured as a keywords criterion', () => {
    const result = extractCriteriaFromTranscript(
      'Caller: We need to be in the Mocksley school district.'
    )

    expect(result.criteria.schoolDistricts).toContain('Mocksley school district')
  })

  test('"zoned for X Elementary" is captured as a stated school-zone criterion', () => {
    expect(detectStatedSchoolDistrict('We have to be zoned for Lincoln Elementary')).toBe('Lincoln Elementary')
  })

  test('generic school-quality talk is NOT a criterion ("good school district" stays out)', () => {
    expect(detectStatedSchoolDistrict('somewhere with a good school district')).toBeNull()
    expect(detectStatedSchoolDistrict('near good schools')).toBeNull()
  })

  test('buyer-stated 55+/age-restricted community is captured', () => {
    expect(detectStatedAgeRestrictedCommunity('We want a 55+ community')).toBe(true)
    expect(detectStatedAgeRestrictedCommunity('an active adult neighborhood')).toBe(true)
    expect(detectStatedAgeRestrictedCommunity('age-restricted only please')).toBe(true)
    expect(detectStatedAgeRestrictedCommunity('a house with a big yard')).toBe(false)

    const result = extractCriteriaFromTranscript('Caller: Looking for a 55+ community.')
    expect(result.criteria.ageRestrictedCommunity).toBe(true)
  })

  test('school district counts as a concrete signal toward confidence', () => {
    const result = extractCriteriaFromTranscript(
      'Caller: Under 650k in the Mocksley school district.'
    )

    expect(result.criteria.maxPrice).toBe(650000)
    expect(result.criteria.schoolDistricts).toContain('Mocksley school district')
    expect(result.signalCount).toBe(2)
    expect(result.confidence).toBe('high')
  })

  test('stated 55+ community counts as a concrete signal toward confidence', () => {
    const result = extractCriteriaFromTranscript(
      'Caller: A 55+ community in Austin would be perfect.'
    )

    expect(result.criteria.ageRestrictedCommunity).toBe(true)
    expect(result.criteria.cities).toContain('Austin')
    expect(result.signalCount).toBe(2)
    expect(result.confidence).toBe('high')
  })

  test('familial-status inference stays out — "good for kids" is never captured', () => {
    const result = extractCriteriaFromTranscript(
      'Caller: We want somewhere good for kids.'
    )

    expect(result.criteria.schoolDistricts).toBeUndefined()
    expect(result.criteria.ageRestrictedCommunity).toBeUndefined()
    expect(result.signalCount).toBe(0)
    expect(result.confidence).toBe('low')
  })

  test('evidence carries the buyer literal quote for stated school/age criteria', () => {
    const result = extractCriteriaFromTranscript(
      [
        'Caller: Hello there.',
        'Caller: We need to be in the Mocksley school district.',
        'Caller: And it should be a 55+ community under 650k.',
      ].join('\n')
    )

    expect(result.evidence).toContain('We need to be in the Mocksley school district.')
    expect(result.evidence).toContain('And it should be a 55+ community under 650k.')
    expect(result.evidence).not.toContain('Hello there.')
  })

  test('the AI mentioning a school district never becomes the buyer criteria', () => {
    const result = extractCriteriaFromTranscript(
      [
        'AI: Many buyers like the Westfield school district.',
        'Caller: Our budget is under 500k.',
      ].join('\n')
    )

    expect(result.criteria.schoolDistricts).toBeUndefined()
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

  test('stated school district lands in keywords; stated 55+ in must_have_features', () => {
    const extraction = extractCriteriaFromTranscript(
      'Caller: A 55+ community under 650k in the Mocksley school district.'
    )
    const row = criteriaToAlertRow(extraction.criteria, {
      contactId: 'c', agentUserId: null, brokerageId: 'b', alertName: 'n',
    })

    expect(row.keywords).toBe('Mocksley school district')
    expect(row.must_have_features).toContain(AGE_RESTRICTED_LABEL)
  })

  test('text-thread lane overrides source honestly; voice stays the default', () => {
    const ids = { contactId: 'c', agentUserId: null, brokerageId: 'b', alertName: 'n' }

    expect(criteriaToAlertRow({ maxPrice: 1 }, ids).source).toBe(SPOKEN_ALERT_SOURCE)
    expect(criteriaToAlertRow({ maxPrice: 1 }, { ...ids, source: TEXT_ALERT_SOURCE }).source).toBe('text_conversation')
    expect(criteriaToAlertRow({ maxPrice: 1 }, { ...ids, source: TEXT_ALERT_SOURCE }).is_active).toBe(false)
  })
})

describe('markers and labels', () => {
  test('call marker embeds the call id for per-call dedupe', () => {
    expect(spokenAlertCallMarker('abc-123')).toBe('[call:abc-123]')
  })

  test('proposal marker is a stable state discriminator', () => {
    expect(VOICE_PROPOSAL_MARKER).toBe('[VOICE_PROPOSAL]')
    expect(TEXT_PROPOSAL_MARKER).toBe('[TEXT_PROPOSAL]')
  })

  test('message marker embeds the message ref for per-message dedupe', () => {
    expect(writtenAlertMessageMarker('SM123')).toBe('[msg:SM123]')
  })

  test('content hash is stable for identical text, distinct for different text', () => {
    const a = hashConversationText('contact-1:3 bed under 650k in Mocksley')
    const b = hashConversationText('contact-1:3 bed under 650k in Mocksley')
    const c = hashConversationText('contact-1:2 bed under 400k in Austin')

    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
  })

  test('describeCriteria reads like the buyer spoke', () => {
    const label = describeCriteria({ minBeds: 3, maxPrice: 650000, cities: ['Mocksley'] })

    expect(label).toBe('3+ bed under $650k in Mocksley')
  })
})
