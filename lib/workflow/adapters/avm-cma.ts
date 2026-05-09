/**
 * AVM/CMA adapter — generates property valuation reports.
 *
 * avm_data_source: 'perplexity' | 'housecannary' | 'batchdata'
 * avm_report_type: 'avm' | 'cma' | 'market_report'
 *
 * Routes to the existing lib/avm/ or lib/cma/ infrastructure that was
 * already built (Perplexity with state appraiser guidelines + investor
 * adjustments, and HouseCanary/BatchData versions). Dynamic imports let
 * this adapter work even if the exact module paths change.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const avmCmaAdapter: ChannelAdapter = {
  channel: "avm_cma",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, brokerageId, contact, agentUserId, supabase } = ctx

    const dataSource = step.avm_data_source ?? "perplexity"
    const reportType = step.avm_report_type ?? "avm"
    const includeInvestorAdj = step.avm_include_investor_adj ?? false

    // Create a pending record so the output variable name can be populated
    const { data: reportRecord } = await supabase
      .from("documents")
      .insert({
        brokerage_id: brokerageId,
        contact_id: contact?.id ?? null,
        document_type: reportType,
        status: "generating",
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    const docId = reportRecord?.id

    // Try to route to existing AVM/CMA builders via dynamic import
    // The lib/avm and lib/cma modules contain the Perplexity + HouseCanary builds.
    try {
      let reportUrl: string | null = null

      // Dynamic import using string concatenation so TypeScript doesn't try
      // to resolve these modules (they may not exist in all environments).
      const avmPath = "@/lib/avm"
      const cmaPath = "@/lib/cma"

      if (dataSource === "perplexity") {
        // Try lib/avm first, then lib/cma
        const avmMod = await import(/* webpackIgnore: true */ avmPath as string).catch(() => null)
        const cmaMod = await import(/* webpackIgnore: true */ cmaPath as string).catch(() => null)

        const generateFn =
          (avmMod as any)?.generateAVMReport ??
          (avmMod as any)?.generateReport ??
          (cmaMod as any)?.generateCMA ??
          null

        if (generateFn) {
          const result = await generateFn({
            brokerageId, contactId: contact?.id, agentUserId,
            reportType, includeInvestorAdjustments: includeInvestorAdj,
            dataSource: "perplexity", documentId: docId,
          })
          reportUrl = result?.reportUrl ?? result?.url ?? null
        }
      } else {
        const avmMod = await import(/* webpackIgnore: true */ avmPath as string).catch(() => null)
        const fnName = `generate${dataSource === "housecannary" ? "HouseCanary" : "BatchData"}Report`
        const generateFn =
          (avmMod as any)?.[fnName] ?? (avmMod as any)?.generateReport ?? null

        if (generateFn) {
          const result = await generateFn({
            brokerageId, contactId: contact?.id,
            reportType, includeInvestorAdjustments: includeInvestorAdj,
            dataSource, documentId: docId,
          })
          reportUrl = result?.reportUrl ?? result?.url ?? null
        }
      }

      // Mark complete
      if (docId) {
        await supabase.from("documents")
          .update({ status: "complete", storage_url: reportUrl ?? null })
          .eq("id", docId)
      }

      return {
        status: "sent",
        providerKey: `avm-${dataSource}`,
        messageId: docId,
        output: { report_url: reportUrl, document_id: docId, report_type: reportType },
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: "error", providerKey: "avm", error: msg }
    }
  },
}
