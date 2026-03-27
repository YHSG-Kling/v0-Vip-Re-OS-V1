'use server'

import { createClient } from '@/lib/supabase/server'
import { fetchMotivatedSellers } from '@/lib/external'
import { trackVendorUsage } from '@/lib/vendor-tracking'
import { processRawRecord } from '@/lib/lead-pipeline'

const MOTIVATION_TYPES = [
  'probate',
  'divorce',
  'foreclosure',
  'tax_lien',
  'pre_foreclosure',
  'distressed',
]

export async function scrapeBatchDataMotivated(params: {
  brokerageId: string
  states: string[]
  limitPerType?: number
}) {
  const supabase = await createClient()
  const { brokerageId, states, limitPerType = 100 } = params
  
  const results = {
    totalRecords: 0,
    leadsCreated: 0,
    leadsMerged: 0,
    leadsSkipped: 0,
    totalCost: 0,
    errors: [] as string[]
  }

  for (const state of states) {
    for (const motivationType of MOTIVATION_TYPES) {
      try {
        const batchDataResult = await fetchMotivatedSellers({
          state,
          motivationTypes: [motivationType],
          limit: limitPerType
        })

        results.totalCost += batchDataResult.cost
        results.totalRecords += batchDataResult.records.length

        for (const record of batchDataResult.records) {
          // Write to raw_scraped_leads — the canonical table for all scraped data.
          // batchdata_motivated_sellers_raw is the legacy table and is no longer used.
          const sourceRecordId = [
            'batchdata',
            motivationType,
            record.firstName?.toLowerCase(),
            record.lastName?.toLowerCase(),
            (record.propertyAddress || record.address)?.toLowerCase().replace(/\s+/g, '-'),
          ].filter(Boolean).join('-')

          const { data: rawRecord } = await supabase
            .from('raw_scraped_leads')
            .insert({
              brokerage_id:      brokerageId,
              source:            'batchdata_motivated',
              source_record_id:  sourceRecordId,
              raw_data:          record as unknown as Record<string, unknown>,
              normalized_preview: {
                firstName:       record.firstName    ?? null,
                lastName:        record.lastName     ?? null,
                email:           record.email        ?? null,
                phone:           record.phone        ?? null,
                city:            record.city         ?? null,
                state:           record.state        ?? null,
                intentType:      'seller',
                behaviorType:    'motivated_seller',
                motivationScore: record.motivationConfidence
                  ? Math.round(record.motivationConfidence * 100)
                  : null,
                intentSignals:   [motivationType],
                propertyAddress: (record.propertyAddress || record.address) ?? null,
              },
              processing_status: 'pending',
            })
            .select('id')
            .single()

          if (!rawRecord?.id) {
            results.errors.push(`Failed to insert raw record for ${record.firstName} ${record.lastName}`)
            continue
          }

          const pipelineResult = await processRawRecord(rawRecord.id, brokerageId)

          if (pipelineResult.action === 'created') {
            results.leadsCreated++
          } else if (pipelineResult.action === 'merged') {
            results.leadsMerged++
          } else if (pipelineResult.action === 'skipped') {
            results.leadsSkipped++
          }

          await trackVendorUsage({
            vendorName: 'batchdata',
            usageType: 'motivated_seller_list',
            unitsUsed: 1,
            costPerUnit: 0.05,
            totalCost: 0.05,
            leadId: pipelineResult.leadId,
            brokerageId,
            requestMetadata: { state, motivationType }
          })
        }

      } catch (error) {
        console.error(`[v0] Failed to fetch BatchData ${motivationType} for ${state}:`, error)
        results.errors.push(`${state}-${motivationType}: ${String(error)}`)
      }
    }
  }

  return {
    success: true,
    ...results
  }
}
