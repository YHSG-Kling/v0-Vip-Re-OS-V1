import { NextResponse } from 'next/server'
import { scrapeBatchDataMotivated } from '@/app/actions/scrape-batchdata-motivated'
import { scrapeSocialMedia } from '@/app/actions/scrape-social-media'
import { scrapeCraigslist } from '@/app/actions/scrape-craigslist'

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const brokerageId = process.env.DEFAULT_BROKERAGE_ID || ''
  const targetStates = ['FL']
  const targetCities = ['Miami', 'Tampa', 'Orlando', 'Jacksonville']

  const results = {
    batchData: null as any,
    socialMedia: [] as any[],
    craigslist: null as any,
    totalCost: 0,
    totalLeads: 0,
    timestamp: new Date().toISOString()
  }

  console.log('[v0] Starting cron job for all scraping sources')

  try {
    console.log('[v0] Scraping BatchData motivated sellers')
    results.batchData = await scrapeBatchDataMotivated({
      brokerageId,
      states: targetStates,
      limitPerType: 50
    })
    results.totalCost += results.batchData.totalCost
    results.totalLeads += results.batchData.leadsCreated

    for (const city of targetCities) {
      console.log(`[v0] Scraping social media for ${city}`)
      const socialResult = await scrapeSocialMedia({
        brokerageId,
        targetCity: city,
        targetState: 'Florida'
      })
      results.socialMedia.push(socialResult)
      results.totalCost += socialResult.totalCost
      results.totalLeads += socialResult.leadsCreated
    }

    console.log('[v0] Scraping Craigslist')
    results.craigslist = await scrapeCraigslist({
      brokerageId,
      targetCities
    })
    results.totalCost += results.craigslist.totalCost
    results.totalLeads += results.craigslist.leadsCreated

  } catch (error) {
    console.error('[v0] Cron scraping failed:', error)
    return NextResponse.json(
      { error: String(error), partialResults: results },
      { status: 500 }
    )
  }

  console.log(`[v0] Cron job completed: ${results.totalLeads} leads created, $${results.totalCost.toFixed(2)} cost`)

  return NextResponse.json({
    success: true,
    ...results
  })
}
