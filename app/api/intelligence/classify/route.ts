import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { classifyIntent } from '@/lib/intelligence/intent-classifier'

export async function POST(request: Request) {
  // Verify internal API secret — FAIL CLOSED (lane 88E). The old raw compare
  // `header !== process.env.INTERNAL_API_SECRET` PASSED when the secret was set
  // to an empty string (the shape .env.example's blank values produce when
  // copied verbatim) and the caller sent an empty `x-internal-secret` header:
  // '' !== '' is false. This door became reachable past proxy.ts in the same
  // lane (SESSIONLESS_API_DOORS), so its own gate must hold on its own.
  const expected = process.env.INTERNAL_API_SECRET ?? ''
  const given = request.headers.get('x-internal-secret') ?? ''
  if (!expected || !given || Buffer.byteLength(expected) !== Buffer.byteLength(given)
    || !timingSafeEqual(Buffer.from(expected), Buffer.from(given))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { message, contactId, conversationId, brokerageId } = await request.json()

    if (!message || !contactId || !conversationId || !brokerageId) {
      return NextResponse.json(
        { error: 'Missing required fields: message, contactId, conversationId, brokerageId' },
        { status: 400 }
      )
    }

    const result = await classifyIntent(message, contactId, conversationId, brokerageId)

    return NextResponse.json(result)
  } catch (error) {
    console.error('Intent classification error:', error)
    return NextResponse.json(
      { error: 'Classification failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
