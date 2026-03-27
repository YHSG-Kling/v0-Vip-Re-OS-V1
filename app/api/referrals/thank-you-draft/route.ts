import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateText } from 'ai'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { contactId, referralName, referralId } = await req.json() as {
    contactId: string
    referralName: string
    referralId: string
  }

  if (!referralId) return NextResponse.json({ error: 'referralId required' }, { status: 400 })

  // Load agent name from users table
  const [{ data: agentData }, { data: contactData }] = await Promise.all([
    supabase.from('users').select('first_name, last_name').eq('id', user.id).maybeSingle(),
    contactId
      ? supabase.from('contacts').select('first_name, last_name, notes').eq('id', contactId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const agentName = agentData
    ? `${agentData.first_name ?? ''} ${agentData.last_name ?? ''}`.trim()
    : 'your agent'

  const contactName = contactData
    ? `${contactData.first_name ?? ''} ${contactData.last_name ?? ''}`.trim()
    : 'there'

  const systemPrompt = `You are a real estate agent assistant writing a warm, genuine thank-you message on behalf of ${agentName}.
Keep the tone personal, concise (3-5 sentences), and grateful without being over-the-top.
Do NOT include placeholders — write the full message ready to send.`

  const userPrompt = `Write a thank-you message to ${contactName} for referring ${referralName || 'a client'} to me.
${contactData?.notes ? `Context about this person: ${contactData.notes}` : ''}
The referral has converted, so express genuine appreciation and mention I look forward to continuing to be a resource for them.`

  const { text: draft } = await generateText({
    model: 'openai/gpt-4o-mini',
    system: systemPrompt,
    prompt: userPrompt,
  })

  return NextResponse.json({ draft })
}
