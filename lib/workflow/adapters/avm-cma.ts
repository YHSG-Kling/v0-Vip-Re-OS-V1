/**
 * AVM/CMA adapter — generates property valuation reports.
 *
 * Routes to the production-grade infrastructure already built:
 *   - lib/cma/ai-cma-orchestrator.runAiCma()  — provider-sourced comps (RentCast
 *                                               by default, the brokerage's connected
 *                                               IDX feed for the active side) + state
 *                                               appraiser-guideline adjustments,
 *                                               with investor_arv mode for repair-budget
 *                                               + max-offer formulas
 *
 * NOTE on avm_data_source for a CMA: it no longer selects the comp provider —
 * runAiCma has ONE provider-backed sourcing path for every mode. It still selects
 * the mode label recorded on the document, and it still routes the AVM path below.
 *   - lib/avm/provider-chain.getCurrentAvm()  — Cached → Perplexity → HouseCanary →
 *                                               BatchData → ZenRows/Zillow → fallback
 *
 * Step config:
 *   avm_data_source: 'perplexity' | 'housecannary' | 'batchdata'
 *   avm_report_type: 'avm' | 'cma' | 'market_report'
 *   avm_include_investor_adj: when true on a CMA → mode='investor_arv'
 *
 * Output exposed for downstream {{step_N.*}} references:
 *   document_id, report_type, estimated_value_low/mid/high, confidence_score, arv
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const avmCmaAdapter: ChannelAdapter = {
  channel: "avm_cma",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, brokerageId, contact, agentUserId, supabase } = ctx

    const dataSource: "perplexity" | "housecannary" | "batchdata" =
      (step.avm_data_source as "perplexity" | "housecannary" | "batchdata") ?? "perplexity"
    const reportType: "avm" | "cma" | "market_report" =
      (step.avm_report_type as "avm" | "cma" | "market_report") ?? "avm"
    const includeInvestorAdj = step.avm_include_investor_adj ?? false

    // Resolve property context — try contact's saved address first
    let propertyContext: {
      address: string
      city?: string | null
      state: string
      zip?: string | null
    } | null = null

    if (contact?.id) {
      const { data: contactRow } = await supabase
        .from("contacts")
        .select("city, state, zip_code")
        .eq("id", contact.id)
        .maybeSingle()
      const cr = contactRow as { city: string | null; state: string | null; zip_code: string | null } | null
      if (cr?.state) {
        propertyContext = {
          address: (contact.address as string | undefined) ?? "Property",
          city: cr.city,
          state: cr.state,
          zip: cr.zip_code,
        }
      }
    }

    // Pending documents record so the variable graph can reference document_id
    const { data: doc } = await supabase
      .from("documents")
      .insert({
        brokerage_id: brokerageId,
        contact_id: contact?.id ?? null,
        document_type: reportType,
        status: "generating",
        metadata: { data_source: dataSource, include_investor_adj: includeInvestorAdj },
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    const docId = doc?.id

    if (!propertyContext) {
      if (docId) {
        await supabase.from("documents")
          .update({ status: "complete", content: "Insufficient property context to generate report." })
          .eq("id", docId)
      }
      return {
        status: "sent",
        providerKey: `avm-${dataSource}`,
        messageId: docId,
        output: { document_id: docId, report_type: reportType, note: "no property context" },
      }
    }

    try {
      // ── CMA path — runAiCma() ───────────────────────────────────────────
      if (reportType === "cma") {
        const { runAiCma, describeCompProvenance } = await import("@/lib/cma/ai-cma-orchestrator")
        const cmaMode: "standard" | "premium" | "investor_arv" = includeInvestorAdj
          ? "investor_arv"
          : dataSource === "housecannary" || dataSource === "batchdata"
          ? "premium"
          : "standard"

        const result = await runAiCma({
          mode: cmaMode,
          brokerageId,
          agentUserId: agentUserId ?? null,
          contactId: contact?.id ?? null,
          subject: {
            address: propertyContext.address,
            city: propertyContext.city ?? null,
            state: propertyContext.state,
            zip: propertyContext.zip ?? null,
            propertyType: "single_family",
          } as any,
        })

        if (docId) {
          const cmaDocUpdate = {
            status: "complete",
            content: result.aiNarrative,
            metadata: {
              mode: cmaMode,
              data_source: dataSource,
              estimated_value_low:  result.estimatedValueLow,
              estimated_value_mid:  result.estimatedValueMid,
              estimated_value_high: result.estimatedValueHigh,
              confidence_score:     result.confidenceScore,
              arv: result.arv ?? null,
              comp_count: result.adjustedComps.length,
              state_guidelines_used: result.stateGuidelinesUsed,
              citations: result.citations,
              // WHERE the comps came from and how fresh they are, stored with the
              // document so a CMA on file can be audited later without re-running it —
              // the structured record plus the one-line human read of it.
              comp_provenance: result.compProvenance,
              comp_provenance_summary: describeCompProvenance(result.compProvenance),
            },
          }
          // tenant anchor (scope burn-down): pinned to the doc this run created
          // AND the workflow's brokerage.
          await supabase.from("documents")
            .update(cmaDocUpdate)
            .eq("id", docId)
            .eq("brokerage_id", brokerageId)
        }

        return {
          status: "sent",
          providerKey: `cma-${cmaMode}`,
          messageId: docId,
          output: {
            document_id: docId,
            report_type: "cma",
            estimated_value_low:  result.estimatedValueLow,
            estimated_value_mid:  result.estimatedValueMid,
            estimated_value_high: result.estimatedValueHigh,
            confidence_score: result.confidenceScore,
            arv: result.arv ?? null,
          },
        }
      }

      // ── AVM path — getCurrentAvm() ──────────────────────────────────────
      if (reportType === "avm") {
        const { getCurrentAvm } = await import("@/lib/avm/provider-chain")
        // Skip non-preferred providers when an explicit source is set
        const skipProviders =
          dataSource === "housecannary" ? ["batchdata" as const]
          : dataSource === "batchdata"  ? ["rentcast" as const]
          : []
        const avm = await getCurrentAvm({
          address: propertyContext.address,
          city: propertyContext.city ?? null,
          state: propertyContext.state,
          zipCode: propertyContext.zip ?? null,
          brokerageId,
          usePaidProviders: dataSource !== "perplexity",
          skipProviders,
        } as any)

        if (docId) {
          await supabase.from("documents")
            .update({
              status: "complete",
              content: avm
                ? `Estimated value: $${avm.value.toLocaleString()} (source: ${avm.source})`
                : "AVM unavailable for this property.",
              metadata: avm
                ? { source: avm.source, value: avm.value, confidence: avm.confidence }
                : { error: "no avm result" },
            })
            .eq("id", docId)
        }

        return {
          status: "sent",
          providerKey: `avm-${avm?.source ?? "fallback"}`,
          messageId: docId,
          output: {
            document_id: docId,
            report_type: "avm",
            value: avm?.value ?? null,
            source: avm?.source ?? null,
            confidence: avm?.confidence ?? null,
          },
        }
      }

      // ── Market report path ──────────────────────────────────────────────
      const m = await import("@/app/actions/ai-market-intelligence")
      if (typeof (m as any).generateMarketReport === "function") {
        const result = await (m as any).generateMarketReport({
          brokerageId,
          contactId: contact?.id,
          agentUserId,
          documentId: docId,
          location: {
            city: propertyContext.city,
            state: propertyContext.state,
            zip: propertyContext.zip,
          },
        })
        return {
          status: "sent",
          providerKey: "market-report",
          messageId: docId,
          output: {
            document_id: docId,
            report_type: "market_report",
            report_url: result?.reportUrl ?? null,
          },
        }
      }

      if (docId) {
        await supabase.from("documents").update({ status: "complete" }).eq("id", docId)
      }
      return {
        status: "sent",
        providerKey: "market-report",
        messageId: docId,
        output: { document_id: docId, report_type: "market_report" },
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (docId) {
        await supabase.from("documents")
          .update({ status: "review", metadata: { error: msg } })
          .eq("id", docId)
      }
      return { status: "error", providerKey: "avm", error: msg }
    }
  },
}
