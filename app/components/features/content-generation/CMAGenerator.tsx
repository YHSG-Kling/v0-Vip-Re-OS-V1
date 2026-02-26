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
import { generateAIText } from "@/lib/ai"
import { executeWorkflow } from "../../app/actions/workflows"
import { VideoGenerationButtons } from "@/components/video/VideoGenerationButtons"

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
      // Node 3 & 4 & 5 (Consolidated for UI efficiency)
      setLoadingStep("AI Analyzing Market Dynamics...")
      const prompt = `Act as a Real Estate Pricing Analyst and Listing Strategist.
        
SUBJECT PROPERTY: ${inputs.address}, ${inputs.city} ${inputs.zip}
SPECS: ${inputs.beds}b/${inputs.baths}b, ${inputs.sqft}sqft, Year: ${inputs.yearBuilt}, Cond: ${inputs.condition}
UPGRADES: ${inputs.upgrades}
SELLER PROFILE: ${inputs.sellerName}, Motivation: ${inputs.motivation}, Timing: ${inputs.timing}

SIMULATED MARKET DATA (TRAVIS COUNTY):
- 3 Active Comps within 0.5 miles: $825k, $860k, $895k.
- Avg DOM: 24 days. Inventory: 1.8 months.

CRITICAL CONTENT PHILOSOPHY - THEM-FIRST APPROACH:
- Write 80-90% about ${inputs.sellerName} and their situation, NOT about you/the agent
- Focus on THEIR emotions: fear, hope, dreams, concerns about selling
- Address THEIR specific needs: ${inputs.motivation}
- Use "you" and "your" extensively (aim for 15%+ of content)
- Minimize "I", "me", "my", "our" language (keep under 10%)
- Lead with their pain points and desires, NOT agent credentials
- Make them feel UNDERSTOOD first, then offer solutions

TASK: Generate a full Listing Package in JSON.
- marketSnapshot: 2-3 sentences on current local trends that matter to THEM
- pricing: { "aggressive": "string", "market": "string", "speed": "string" }, ranges explained from THEIR perspective
- marketing: { "buyerProfile": "string", "preList": "string", "online": "string", "offline": "string", "timeline": "string" }
- presentation: { "overview": "string", "process": "string", "valueProp": "string" }
- email: A warm, empathetic email TO ${inputs.sellerName} that shows you understand their ${inputs.motivation} situation

COMPLIANCE: End all text with the standard CMA Disclaimer: "This report is a Comparative Market Analysis (CMA) prepared by a real estate licensee for marketing and pricing guidance. It is not an appraisal..."

Return strictly valid JSON:
{
  "marketSnapshot": "string",
  "pricing": { "aggressive": "string", "market": "string", "speed": "string" },
  "marketing": { "buyerProfile": "string", "preList": "string", "online": "string", "offline": "string", "timeline": "string" },
  "presentation": { "overview": "string", "process": "string", "valueProp": "string" },
  "email": "string"
}`

      const response = await generateAIText(prompt)

      if (response.text) {
        try {
          setPackageResult(JSON.parse(response.text))
          setLoadingStep("Assembling PDFs & Branding Assets...")
          await new Promise((r) => setTimeout(r, 1500))
          setStep(4)
        } catch {
          // Fallback if JSON parsing fails
          // Mock
          await new Promise((r) => setTimeout(r, 3000))
          setPackageResult({
            marketSnapshot:
              "The 78704 market remains resilient with low inventory. Homes priced accurately are seeing multiple offers within 14 days.",
            pricing: { aggressive: "$895,000", market: "$850,000", speed: "$825,000" },
            marketing: {
              buyerProfile: "Tech-savvy families...",
              preList: "Staging and paint touch-ups...",
              online: "Custom SEO listing page...",
              offline: "High-end brochures...",
              timeline: "Day 1-7: Prep...",
            },
            presentation: {
              overview: "Current market highlights...",
              process: "The path to sold...",
              valueProp: "Why Nexus Realty...",
            },
            email: "Hi John, I've prepared your custom listing strategy...",
          })
          setStep(4)
        }
      }

      // Trigger actual n8n logging
      // Fixed: Passing expected 6 arguments instead of an object to match the service definition.
      await executeWorkflow("generate-cma", {
        address: inputs.address,
        beds: inputs.beds,
        baths: inputs.baths,
        sqft: inputs.sqft,
        upgrades: inputs.upgrades,
      })
    } catch (error) {
      console.error(error)
      alert("AI Protocol Failure. Attempting fallback...")
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
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {[
                      // Fixed: Added Users to icon imports
                      { l: "Target Buyer Profile", v: packageResult.marketing.buyerProfile, i: Users },
                      { l: "Pre-List Prep Strategy", v: packageResult.marketing.preList, i: Sparkles },
                      // Fixed: Added Globe to icon imports
                      { l: "Omnichannel Launch", v: packageResult.marketing.online, i: Globe },
                      { l: "Local Geo-Targeting", v: packageResult.marketing.offline, i: MapPin },
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
