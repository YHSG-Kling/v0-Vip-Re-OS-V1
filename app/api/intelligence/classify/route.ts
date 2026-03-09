import { NextResponse } from 'next/server'
import { classifyIntent } from '@/lib/intelligence/intent-classifier'

export async function POST(request: Request) {
  // Verify internal API secret
  const authHeader = request.headers.get('x-internal-secret')
  if (authHeader !== process.env.INTERNAL_API_SECRET) {
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
