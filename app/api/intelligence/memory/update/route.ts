import { NextRequest, NextResponse } from 'next/server'
import { updateConversationMemory } from '@/lib/intelligence/conversation-memory'

/**
 * POST /api/intelligence/memory/update
 * Internal endpoint to update conversation memory via AI extraction
 * Protected with INTERNAL_API_SECRET header
 */
export async function POST(request: NextRequest) {
  // Verify internal API secret
  const authHeader = request.headers.get('authorization')
  const expectedSecret = process.env.INTERNAL_API_SECRET

  if (!expectedSecret) {
    return NextResponse.json(
      { error: 'Server misconfiguration: INTERNAL_API_SECRET not set' },
      { status: 500 }
    )
  }

  if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  try {
    const body = await request.json()
    const { conversationId, brokerageId } = body

    if (!conversationId || !brokerageId) {
      return NextResponse.json(
        { error: 'Missing required fields: conversationId, brokerageId' },
        { status: 400 }
      )
    }

    await updateConversationMemory(conversationId, brokerageId)

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Memory update failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Memory update failed' },
      { status: 500 }
    )
  }
}
