import { NextResponse } from 'next/server'
import { embedAndStore, getArticlesNeedingEmbedding } from '@/lib/intelligence/kb-search'

export async function POST(request: Request) {
  // Verify internal API secret
  const authHeader = request.headers.get('authorization')
  const expectedSecret = process.env.INTERNAL_API_SECRET

  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { topicId, embedAll } = body as {
      topicId?: string
      embedAll?: boolean
    }

    let embedded = 0
    let errors = 0

    if (embedAll) {
      // Bulk embed all articles without embeddings
      const articleIds = await getArticlesNeedingEmbedding()

      for (const id of articleIds) {
        try {
          await embedAndStore(id)
          embedded++
        } catch (error) {
          console.error(`[kb-embed] Failed to embed article ${id}:`, error)
          errors++
        }
      }
    } else if (topicId) {
      // Single article embedding
      try {
        await embedAndStore(topicId)
        embedded = 1
      } catch (error) {
        console.error(`[kb-embed] Failed to embed article ${topicId}:`, error)
        errors = 1
      }
    } else {
      return NextResponse.json(
        { error: 'Either topicId or embedAll must be provided' },
        { status: 400 }
      )
    }

    return NextResponse.json({ embedded, errors })
  } catch (error) {
    console.error('[kb-embed] API error:', error)
    return NextResponse.json(
      { error: 'Failed to process embedding request' },
      { status: 500 }
    )
  }
}
