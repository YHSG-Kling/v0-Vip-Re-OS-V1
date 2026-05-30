"use client"

import type React from "react"
import { useState } from "react"
import {
  Sparkles,
  MapPin,
  Home,
  BarChart3,
  Megaphone,
  ArrowRight,
  Printer,
  RefreshCw,
  Layout,
  Mail,
  Download,
  Bot,
  Users,
  Share2,
  Globe,
  Send,
} from "lucide-react"
import { VideoGenerationButtons } from "@/components/video/VideoGenerationButtons"
import { generateAICMA } from "@/app/actions/ai-cma"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"

interface CMAPackageInputs {
  address: string
  city: string
  zip: string
  type: string
  beds: string
  baths: string
  sqft: string
  lotSize: string
  yearBuilt: string
  condition: string
  upgrades: string
  sellerName: string
  sellerEmail: string
  timing: string
  motivation: string
  priceExpectation: string
  agentName: string
  brokerage: string
}

const SmartCMA: React.FC = () => {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1) // 1: Subject, 2: Seller/Context, 3: Generating, 4: Package
  const [loadingStep, setLoadingStep] = useState<string>("")
  const [activeDocTab, setActiveDocTab] = useState<"cma" | "marketing" | "presentation" | "email">("cma")

  const [inputs, setInputs] = useState<CMAPackageInputs>({
    address: "",
    city: "Austin",
    zip: "78704",
    type: "Single Family",
    beds: "4",
    baths: "3",
    sqft: "2450",
    lotSize: "0.25",
    yearBuilt: "2015",
    condition: "C3 (Average)",
    upgrades: "New HVAC 2022, Kitchen remodel 2021",
    sellerName: "John Doe",
    sellerEmail: "john@example.com",
    timing: "1-3 months",
    motivation: "Relocating for work",
    priceExpectation: "$850k",
    agentName: "Sarah Smith",
    brokerage: "Nexus Realty",
  })

  const [packageResult, setPackageResult] = useState<any>(null)

  const handleGeneratePackage = async () => {
    setStep(3)
    setLoadingStep("Fetching Comps & Market Data...")

    try {
      // Resolve agentId from session
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error("Not authenticated")

      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle()

      if (!agentRow?.id) throw new Error("Agent record not found")

      setLoadingStep("AI Analyzing Market Dynamics...")

      const res = await generateAICMA({
        agentId: agentRow.id,
        propertyAddress: inputs.address,
        propertyCity: inputs.city,
        propertyState: "TX",
        propertyZip: inputs.zip,
        propertyType: inputs.type as any,
        bedrooms: Number(inputs.beds) || 0,
        bathrooms: Number(inputs.baths) || 0,
        squareFeet: Number(inputs.sqft) || 0,
        lotSize: Number(inputs.lotSize) || undefined,
        yearBuilt: Number(inputs.yearBuilt) || undefined,
        condition: (inputs.condition as "excellent" | "good" | "fair" | "poor" | undefined) || undefined,
        features: inputs.upgrades ? [inputs.upgrades] : undefined,
        listingType: "seller",
      })

      if (!res.success) throw new Error((res as any).error ?? "CMA generation failed")

      setLoadingStep("Assembling Report...")

      // Map the real CMA result to the display shape
      setPackageResult({
        cmaId: res.id,
        marketSnapshot: (res.marketTrends as any)?.summary ?? "",
        pricing: {
          aggressive: res.pricingStrategy?.priceRangeHigh
            ? `$${Number(res.pricingStrategy.priceRangeHigh).toLocaleString()}`
            : "—",
          market: res.pricingStrategy?.recommendedListPrice
            ? `$${Number(res.pricingStrategy.recommendedListPrice).toLocaleString()}`
            : "—",
          speed: res.pricingStrategy?.priceRangeLow
            ? `$${Number(res.pricingStrategy.priceRangeLow).toLocaleString()}`
            : "—",
        },
        comparables: res.comparables ?? [],
        rationale: res.pricingStrategy?.rationale ?? "",
        presentation: res.presentation ?? null,
        marketing: res.presentation?.marketingStrategy ?? null,
      })

      setStep(4)
    } catch (error) {
      console.error(error)
      toast.error("CMA generation failed — try again")
      setStep(2)
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-fade-in-up pb-20">
      {/* Header */}
      <div className="flex justify-between items-end border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-2xl font-black text-slate-800 uppercase italic tracking-tighter">
            CMA & Listing Architect.
          </h2>
          <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-1">
            WF-CMA-01: Unified Presentation Engine
          </p>
        </div>
        {step === 4 && (
          <div className="flex gap-2">
            <button className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg hover:bg-indigo-700 transition-all">
              <Download size={14} /> Download Entire Package
            </button>
          </div>
        )}
      </div>

      {/* STEP 1: Property Details */}
      {step === 1 && (
        <div className="max-w-3xl mx-auto bg-white rounded-[2.5rem] shadow-xl border border-slate-200 overflow-hidden animate-fade-in">
          <div className="bg-slate-900 p-8 text-white relative overflow-hidden">
            <div className="absolute right-0 top-0 p-8 opacity-10 rotate-12">
              <Home size={150} />
            </div>
            <div className="relative z-10">
              <h3 className="text-2xl font-black italic tracking-tighter uppercase mb-2">Subject Property Ingest.</h3>
              <p className="text-indigo-300 text-sm font-medium">
                Verify the physical attributes to calibrate the sales comparison logic.
              </p>
            </div>
          </div>
          <div className="p-8 space-y-6">
            <div className="grid grid-cols-1 gap-6">
              <div className="space-y-1">
                <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">
                  Street Address
                </label>
                <input
                  type="text"
                  className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl font-bold focus:ring-1 focus:ring-indigo-500 outline-none shadow-sm"
                  value={inputs.address}
                  onChange={(e) => setInputs({ ...inputs, address: e.target.value })}
                  placeholder="1234 Skyline Dr..."
                />
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {["beds", "baths", "sqft", "yearBuilt"].map((field) => (
                <div key={field} className="space-y-1">
                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">{field}</label>
                  <input
                    type="text"
                    className="w-full p-3 bg-slate-50 border border-slate-100 rounded-xl font-bold focus:ring-1 focus:ring-indigo-500 outline-none"
                    value={(inputs as any)[field]}
                    onChange={(e) => setInputs({ ...inputs, [field]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">
                Significant Upgrades
              </label>
              <textarea
                className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl font-medium focus:ring-1 focus:ring-indigo-500 outline-none resize-none h-24"
                value={inputs.upgrades}
                onChange={(e) => setInputs({ ...inputs, upgrades: e.target.value })}
              />
            </div>
            <button
              onClick={() => setStep(2)}
              disabled={!inputs.address}
              className="w-full bg-slate-900 text-white py-5 rounded-3xl font-black uppercase text-xs tracking-[0.25em] shadow-2xl hover:bg-black transition-all active:scale-95 border-b-4 border-indigo-600 disabled:opacity-50"
            >
              Configure Seller Context <ArrowRight size={18} className="inline ml-2" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 2: Seller Context */}
      {step === 2 && (
        <div className="max-w-3xl mx-auto bg-white rounded-[2.5rem] shadow-xl border border-slate-200 overflow-hidden animate-fade-in-up">
          <div className="bg-indigo-600 p-8 text-white relative overflow-hidden">
            {/* Fixed: Added Users to icon imports */}
            <div className="absolute right-0 top-0 p-8 opacity-10 rotate-12">
              <Users size={150} />
            </div>
            <div className="relative z-10">
              <h3 className="text-2xl font-black italic tracking-tighter uppercase mb-2">
                Seller Psychological Profile.
              </h3>
              <p className="text-indigo-100 text-sm font-medium">
                Timing and motivation data allows AI to recommend the optimal pricing strategy.
              </p>
            </div>
          </div>
          <div className="p-8 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-1">
                <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">
                  Seller Name
                </label>
                <input
                  type="text"
                  className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl font-bold"
                  value={inputs.sellerName}
                  onChange={(e) => setInputs({ ...inputs, sellerName: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">
                  Target Timing
                </label>
                <select
                  className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl font-bold outline-none"
                  value={inputs.timing}
                  onChange={(e) => setInputs({ ...inputs, timing: e.target.value })}
                >
                  <option>ASAP</option>
                  <option>1-3 months</option>
                  <option>3-6 months</option>
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">
                Primary Motivation / Pain Points
              </label>
              <textarea
                className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl font-medium resize-none h-24"
                value={inputs.motivation}
                onChange={(e) => setInputs({ ...inputs, motivation: e.target.value })}
                placeholder="e.g. Needs larger yard for dogs, moving closer to parents..."
              />
            </div>
            <div className="flex gap-4">
              <button
                onClick={() => setStep(1)}
                className="flex-1 py-4 text-[10px] font-black uppercase text-slate-400 hover:text-slate-600 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleGeneratePackage}
                className="flex-[2] bg-indigo-600 text-white py-5 rounded-3xl font-black uppercase text-xs tracking-widest shadow-xl hover:bg-indigo-700 transition-all border-b-4 border-indigo-900"
              >
                Generate Listing Package
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 3: Generating Screen */}
      {step === 3 && (
        <div className="flex-1 flex flex-col items-center justify-center py-32 space-y-8 animate-pulse">
          <div className="relative">
            <div className="w-24 h-24 bg-indigo-50 rounded-[2.5rem] flex items-center justify-center text-indigo-600 shadow-xl border border-indigo-100">
              <RefreshCw size={40} className="animate-spin-slow" />
            </div>
            <div className="absolute -top-2 -right-2 w-10 h-10 bg-slate-900 rounded-2xl flex items-center justify-center shadow-lg border-2 border-white">
              <Bot size={20} className="text-indigo-400" />
            </div>
          </div>
          <div className="text-center">
            <h3 className="text-2xl font-black uppercase tracking-tight italic mb-2">Nexus Engine Processing...</h3>
            <p className="text-slate-500 font-bold uppercase tracking-widest text-xs">{loadingStep}</p>
          </div>
          <div className="w-64 h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-indigo-600 animate-shimmer" style={{ width: "60%" }} />
          </div>
        </div>
      )}

      {/* STEP 4: Package Results */}
      {step === 4 && packageResult && (
        <div className="space-y-8 animate-fade-in-up">
          {/* Doc Tabs */}
          <div className="flex bg-white rounded-2xl p-1 border border-slate-200 w-full md:w-fit shadow-lg overflow-x-auto scrollbar-hide">
            {[
              { id: "cma", label: "CMA Report", icon: BarChart3 },
              { id: "marketing", label: "Marketing Plan", icon: Megaphone },
              { id: "presentation", label: "Presentation", icon: Layout },
              { id: "email", label: "Email Draft", icon: Mail },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveDocTab(tab.id as any)}
                className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 whitespace-nowrap transition-all ${activeDocTab === tab.id ? "bg-indigo-600 text-white shadow-xl" : "text-slate-500 hover:bg-slate-50"}`}
              >
                <tab.icon size={16} /> {tab.label}
              </button>
            ))}
          </div>

          <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-2xl overflow-hidden min-h-[600px] flex flex-col">
            <div className="bg-slate-900 p-10 text-white flex justify-between items-center shrink-0 border-b-8 border-indigo-600">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <span className="bg-indigo-600 text-white text-[8px] font-black px-2 py-0.5 rounded-full tracking-widest uppercase shadow-sm">
                    AI Synthesized
                  </span>
                  <p className="text-[10px] font-black text-indigo-400 uppercase tracking-[0.3em]">
                    PACKAGE FOR: {inputs.address.toUpperCase()}
                  </p>
                </div>
                <h3 className="text-3xl font-black italic tracking-tighter uppercase">
                  {activeDocTab.replace("_", " ")}
                </h3>
              </div>
              <div className="flex gap-3">
                <button className="p-4 bg-white/10 rounded-2xl text-white hover:bg-white/20 transition-all border border-white/10">
                  <Printer size={20} />
                </button>
                {/* Fixed: Added Share2 to icon imports */}
                <button className="p-4 bg-indigo-600 rounded-2xl text-white hover:bg-indigo-500 transition-all shadow-xl">
                  <Share2 size={20} />
                </button>
              </div>
            </div>

            <div className="flex-1 p-12 bg-slate-50 overflow-y-auto scrollbar-hide">
              {activeDocTab === "cma" && (
                <div className="max-w-4xl mx-auto space-y-10 animate-fade-in">
                  <div className="bg-white p-10 rounded-[3rem] shadow-xl border border-slate-100 space-y-8">
                    <section>
                      <h4 className="text-xs font-black text-indigo-600 uppercase tracking-[0.3em] mb-4">
                        Market Snapshot
                      </h4>
                      <p className="text-lg font-bold text-slate-700 leading-relaxed italic border-l-4 border-indigo-500 pl-6">
                        "{packageResult.marketSnapshot}"
                      </p>
                    </section>

                    <section>
                      <h4 className="text-xs font-black text-slate-400 uppercase tracking-[0.3em] mb-6">
                        Strategic Pricing spectrum
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {[
                          {
                            l: "Aggressive",
                            v: packageResult.pricing.aggressive,
                            c: "text-emerald-600",
                            b: "bg-emerald-50",
                          },
                          {
                            l: "Market Aligned",
                            v: packageResult.pricing.market,
                            c: "text-indigo-600",
                            b: "bg-indigo-50",
                          },
                          {
                            l: "Speed to Sell",
                            v: packageResult.pricing.speed,
                            c: "text-orange-600",
                            b: "bg-orange-50",
                          },
                        ].map((item) => (
                          <div
                            key={item.l}
                            className={`${item.b} p-6 rounded-3xl border border-slate-100 flex flex-col justify-center text-center shadow-sm`}
                          >
                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">
                              {item.l}
                            </p>
                            <p className={`text-2xl font-black ${item.c} tracking-tighter`}>{item.v}</p>
                          </div>
                        ))}
                      </div>
                    </section>

                    {/* Insufficient comps warning — shown when no real MLS data was found */}
                    {(!packageResult.comparables || packageResult.comparables.length === 0) && (
                      <section className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-3 text-sm text-amber-800">
                        Comp data insufficient for this search. Manual MLS review recommended.
                      </section>
                    )}

                    {/* Real comparables from ai-cma.ts */}
                    {packageResult.comparables?.length > 0 && (
                      <section>
                        <h4 className="text-xs font-black text-slate-400 uppercase tracking-[0.3em] mb-4">
                          Comparable Sales ({packageResult.comparables.length})
                        </h4>
                        <div className="space-y-2">
                          {packageResult.comparables.slice(0, 5).map((c: any, i: number) => (
                            <div key={i} className="flex items-center justify-between bg-slate-50 rounded-2xl px-5 py-3 text-sm">
                              <span className="font-medium text-slate-700 truncate mr-4">{c.address}</span>
                              <span className="font-black text-slate-900 shrink-0">
                                ${Number(c.soldPrice ?? c.adjustedValue ?? c.salePrice ?? 0).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}

                    {packageResult.rationale && (
                      <section>
                        <h4 className="text-xs font-black text-slate-400 uppercase tracking-[0.3em] mb-3">
                          Pricing Rationale
                        </h4>
                        <p className="text-sm text-slate-600 leading-relaxed italic border-l-4 border-indigo-400 pl-5">
                          {packageResult.rationale}
                        </p>
                      </section>
                    )}

                    <div className="pt-10 border-t border-slate-100">
                      <p className="text-[9px] text-slate-400 font-bold leading-relaxed uppercase tracking-widest opacity-60">
                        COMPLIANCE DISCLAIMER: This report is a Comparative Market Analysis (CMA) prepared by a real
                        estate licensee for marketing and pricing guidance. It is not an appraisal and may not meet
                        USPAP or state appraisal standards. For a formal valuation, consult a licensed or certified
                        appraiser.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {activeDocTab === "marketing" && (
                <div className="max-w-4xl mx-auto space-y-8 animate-fade-in">
                  {!packageResult.marketing ? (
                    <div className="bg-white rounded-[2rem] p-10 text-center text-slate-400 border border-slate-200">
                      <p className="font-bold text-sm">Marketing plan generated with CMA.</p>
                      <p className="text-xs mt-1">Full marketing strategy available in the listing workbench.</p>
                    </div>
                  ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {[
                      { l: "Target Buyer Profile", v: packageResult.marketing?.buyerProfile ?? "—", i: Users },
                      { l: "Pre-List Prep Strategy", v: packageResult.marketing?.preList ?? "—", i: Sparkles },
                      { l: "Omnichannel Launch", v: packageResult.marketing?.online ?? "—", i: Globe },
                      { l: "Local Geo-Targeting", v: packageResult.marketing?.offline ?? "—", i: MapPin },
                    ].map((box) => (
                      <div
                        key={box.l}
                        className="bg-white p-8 rounded-[2rem] shadow-lg border border-slate-100 group hover:border-indigo-400 transition-all"
                      >
                        <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-indigo-600 mb-6 group-hover:scale-110 transition-transform shadow-inner">
                          <box.i size={20} />
                        </div>
                        <h4 className="font-black text-slate-900 uppercase tracking-tight text-sm mb-4">{box.l}</h4>
                        <p className="text-xs text-slate-500 leading-relaxed font-medium">"{box.v}"</p>
                      </div>
                    ))}
                  </div>
                  )}
                  {packageResult?.marketingLetter && (
                    <div className="mt-4 pt-4 border-t">
                      <h4 className="text-sm font-semibold mb-3 text-muted-foreground">Convert to Video</h4>
                      <VideoGenerationButtons
                        script={packageResult.marketingLetter}
                        title={`CMA Presentation - ${inputs.address}`}
                        size="sm"
                      />
                    </div>
                  )}
                </div>
              )}

              {activeDocTab === "presentation" && (
                <div className="max-w-3xl mx-auto bg-white p-12 rounded-[2.5rem] shadow-2xl border border-slate-100 space-y-12 animate-fade-in">
                  <div className="text-center space-y-2">
                    <h3 className="text-4xl font-black italic tracking-tighter uppercase text-slate-900">
                      Listing Presentation
                    </h3>
                    <p className="text-indigo-600 font-black uppercase text-xs tracking-[0.25em]">
                      Strategic Client Review Packet
                    </p>
                  </div>
                  <div className="space-y-8">
                    <div>
                      <h4 className="font-black text-[10px] text-slate-400 uppercase tracking-[0.3em] mb-4">
                        Market Overview & Highlights
                      </h4>
                      <p className="text-sm font-medium text-slate-700 leading-relaxed italic bg-slate-50 p-6 rounded-3xl border border-slate-100">
                        "{packageResult.presentation.overview}"
                      </p>
                    </div>
                    <div>
                      <h4 className="font-black text-[10px] text-slate-400 uppercase tracking-[0.3em] mb-4">
                        Our Sales Logic & Process
                      </h4>
                      <p className="text-sm font-medium text-slate-700 leading-relaxed italic bg-slate-50 p-6 rounded-3xl border border-slate-100">
                        "{packageResult.presentation.process}"
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {activeDocTab === "email" && (
                <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
                  <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
                    <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center gap-4">
                      <div className="flex gap-1.5">
                        <div className="w-3 h-3 rounded-full bg-red-400" />
                        <div className="w-3 h-3 rounded-full bg-amber-400" />
                        <div className="w-3 h-3 rounded-full bg-emerald-400" />
                      </div>
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                        Email Draft: {inputs.sellerName}
                      </span>
                    </div>
                    <div className="p-10">
                      <textarea
                        className="w-full h-[400px] p-0 text-sm font-medium text-slate-700 leading-relaxed border-none focus:ring-0 resize-none outline-none"
                        defaultValue={packageResult.email}
                      />
                      <div className="mt-8 pt-8 border-t border-slate-100 flex justify-between items-center">
                        <p className="text-[9px] font-black text-slate-300 uppercase tracking-widest italic">
                          Compliance Disclaimer included at footer.
                        </p>
                        {/* Fixed: Added Send to icon imports */}
                        <button className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-black uppercase text-[10px] tracking-widest shadow-xl flex items-center gap-2 hover:scale-105 transition-all">
                          <Send size={14} /> Dispatch Email
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-center gap-6">
            <button
              onClick={() => setStep(2)}
              className="bg-slate-200 text-slate-700 px-10 py-4 rounded-3xl font-black uppercase text-xs tracking-widest hover:bg-slate-300 transition-all"
            >
              Start Over
            </button>
            <button className="bg-slate-900 text-white px-10 py-4 rounded-3xl font-black uppercase text-xs tracking-widest hover:bg-black transition-all flex items-center gap-3 shadow-2xl">
              <Download size={18} /> Push to Marketing Cloud
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default SmartCMA
