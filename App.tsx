"use client"

import type React from "react"
import { useState, useCallback, useEffect } from "react"
import Sidebar from "./components/Sidebar"
import AgentDashboard from "./pages/agent/AgentDashboard"
import BrokerDashboard from "./pages/admin/BrokerDashboard"
import UserManagement from "./pages/admin/UserManagement"
import ListingApprovals from "./pages/admin/ListingApprovals"
import ListingDistribution from "./pages/admin/ListingDistribution"
import OpenHouseManager from "./pages/agent/OpenHouseManager"
import ShowingsDesk from "./pages/agent/ShowingsDesk"
import FeedbackDesk from "./pages/agent/FeedbackDesk"
import CalendarDashboard from "./pages/common/CalendarDashboard"
import SegmentationDesk from "./pages/admin/SegmentationDesk"
import LeadDistribution from "./pages/admin/LeadDistribution"
import NotificationSettings from "./pages/agent/NotificationSettings"
import DataHealth from "./pages/admin/DataHealth"
import ComplianceManager from "./pages/admin/ComplianceManager"
import RiskManagement from "./pages/admin/RiskManagement"
import BuyerPortal from "./pages/client/BuyerPortal"
import ClientPlaybook from "./pages/client/ClientPlaybook"
import SmartCMA from "./components/AI/CMAGenerator"
import MarketingStudio from "./pages/agent/MarketingStudio"
import SmartGuide from "./components/AI/SmartGuide"
import CRM from "./pages/agent/CRM"
import TransactionManager from "./pages/agent/TransactionManager"
import PartnersManager from "./pages/admin/PartnersManager"
import VendorMarketplace from "./pages/client/VendorMarketplace"
import VendorCompliance from "./pages/admin/VendorCompliance"
import SystemConfig from "./pages/admin/SystemConfig"
import UnifiedInbox from "./pages/agent/UnifiedInbox"
import SellerDashboard from "./pages/seller/SellerDashboard"
import ListingJourney from "./pages/seller/ListingJourney"
import Financials from "./pages/admin/Financials"
import FinancialsView from "./pages/agent/FinancialsView"
import AgentRoster from "./pages/admin/AgentRoster"
import SmartMatches from "./pages/client/SmartMatches"
import Documents from "./pages/common/Documents"
import ListingIntake from "./pages/agent/ListingIntake"
import SphereManager from "./pages/agent/SphereManager"
import SystemHealth from "./pages/admin/SystemHealth"
import MapIntelligence from "./pages/agent/MapIntelligence"
import KnowledgeBase from "./pages/agent/KnowledgeBase"
import AIAudit from "./pages/admin/AIAudit"
import OpenHouseKiosk from "./pages/public/OpenHouseKiosk"
import LoginPage from "./pages/auth/LoginPage"
import ListingReports from "./pages/agent/ListingReports"
import QuickActionsFAB from "./components/mobile/QuickActionsFAB"
import SmartListingLanding from "./pages/public/SmartListingLanding"
import Events from "./pages/common/Events"
import ReferralPartnerPortal from "./pages/public/ReferralPartnerPortal"
import ClosingDashboard from "./pages/agent/ClosingDashboard"
import HomeValuePortal from "./pages/client/HomeValuePortal"
import SocialScheduler from "./pages/common/SocialScheduler"
import ShareableAssets from "./pages/seller/ShareableAssets"
import BuyerTours from "./pages/agent/BuyerTours"
import OfferLab from "./pages/agent/OfferLab"
import RecruitingHub from "./pages/admin/RecruitingHub"
import AIToolsHub from "./pages/agent/AIToolsHub"
import ContactManagement from "./pages/admin/ContactManagement"
import BuyerHomeDashboard from "./pages/buyer/BuyerHomeDashboard"
import InvestorDashboard from "./pages/investor/InvestorDashboard"
import LandlordDashboard from "./pages/landlord/LandlordDashboard"
import RenterDashboard from "./pages/renter/RenterDashboard"
import FSBODashboard from "./pages/contact/FSBODashboard"
import MotivatedSellerDashboard from "./pages/contact/MotivatedSellerDashboard"
import FirstTimeBuyerDashboard from "./pages/contact/FirstTimeBuyerDashboard"
import LuxuryBuyerDashboard from "./pages/contact/LuxuryBuyerDashboard"
import LuxurySellerDashboard from "./pages/contact/LuxurySellerDashboard"
import RelocatingDashboard from "./pages/contact/RelocatingDashboard"
import ProbateDashboard from "./pages/contact/ProbateDashboard"
import DivorceDashboard from "./pages/contact/DivorceDashboard"
import SeniorDashboard from "./pages/contact/SeniorDashboard"
import RemoteSellerDashboard from "./pages/contact/RemoteSellerDashboard"
import ExpiredListingDashboard from "./pages/contact/ExpiredListingDashboard"
import DefaultContactDashboard from "./pages/contact/DefaultContactDashboard"
import TCDashboard from "./pages/tc/TCDashboard"
import { FloatingAIAssistant } from "./components/AI/FloatingAIAssistant"
import { VoiceCommandButton } from "./components/AI/VoiceCommandButton"
import { ToastContainer, type ToastMessage } from "./components/ui/Toast"
import { UserRole, type Listing, type UserContext } from "./types"
import { AuthProvider, useAuth } from "./contexts/AuthContext"
import { LayoutDashboard, MessageSquare, Briefcase, Bell, Navigation, Calendar, AlertCircle } from "lucide-react"

const MobileNavItem: React.FC<{ icon: any; active: boolean; onClick: () => void }> = ({
  icon: Icon,
  active,
  onClick,
}) => (
  <button
    onClick={onClick}
    className={`p-3 rounded-2xl transition-all ${active ? "bg-indigo-50 text-indigo-600 shadow-inner" : "text-slate-400 hover:text-slate-600"}`}
  >
    <Icon size={24} />
  </button>
)

const NexusApp: React.FC = () => {
  const { user, role, isLoading, signIn, signOut } = useAuth()
  const [currentView, setCurrentView] = useState("agent-dashboard")
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [activeListingForReport, setActiveListingForReport] = useState<Listing | null>(null)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const [userContext, setUserContext] = useState<UserContext | null>(null)
  const [initialDeepLink, setInitialDeepLink] = useState<{ action: string; id: string } | null>(null)
  const [isQRView, setIsQRView] = useState(false)
  const [isPartnerView, setIsPartnerView] = useState(false)
  const [userPersona, setUserPersona] = useState<string | null>(null)

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener("resize", handleResize)

    const handleNavigate = (e: any) => {
      setCurrentView(e.detail)
    }
    window.addEventListener("nexus-navigate", handleNavigate)

    return () => {
      window.removeEventListener("resize", handleResize)
      window.removeEventListener("nexus-navigate", handleNavigate)
    }
  }, [])

  const renderContent = () => {
    if (isQRView) return <SmartListingLanding />
    if (isPartnerView) return <ReferralPartnerPortal />

    const isAdminView = [
      "user-management",
      "system-health",
      "system-config",
      "ai-audit",
      "listing-approvals",
      "agent-roster",
      "contact-management",
    ].includes(currentView)
    const isBrokerOrAdmin = role === UserRole.BROKER || role === UserRole.ADMIN

    if (isAdminView && !isBrokerOrAdmin) {
      return (
        <div className="flex flex-col items-center justify-center h-[60vh] text-slate-400 p-12 text-center">
          <AlertCircle size={64} className="opacity-20 mb-6" />
          <h3 className="text-2xl font-black text-slate-800 uppercase italic">Access Restricted.</h3>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] mt-4">Authorized Brokerage Personnel Only.</p>
        </div>
      )
    }

    if (role === "contact") {
      const personaMap: { [key: string]: React.ReactNode } = {
        first_time_buyer: <FirstTimeBuyerDashboard />,
        luxury_buyer: <LuxuryBuyerDashboard />,
        luxury_seller: <LuxurySellerDashboard />,
        investor: <InvestorDashboard />,
        motivated_seller: <MotivatedSellerDashboard />,
        relocating: <RelocatingDashboard />,
        probate: <ProbateDashboard />,
        divorce: <DivorceDashboard />,
        empty_nester: <SeniorDashboard />,
        remote_seller: <RemoteSellerDashboard />,
        expired: <ExpiredListingDashboard />,
        fsbo: <FSBODashboard />,
      }

      return personaMap[userPersona || "default"] || <DefaultContactDashboard />
    }

    if (role === UserRole.TC) {
      return <TCDashboard />
    }

    switch (currentView) {
      case "agent-dashboard":
        return <AgentDashboard userContext={userContext} onNavigate={setCurrentView} />
      case "broker-dashboard":
        return <BrokerDashboard />
      case "financials":
        return role === UserRole.BROKER || role === UserRole.ADMIN ? <Financials /> : <FinancialsView />
      case "user-management":
        return <UserManagement />
      case "recruiting-hub":
        return <RecruitingHub />
      case "offer-lab":
        return <OfferLab initialLeadId={initialDeepLink?.id} />
      case "risk-management":
        return <RiskManagement />
      case "listing-approvals":
        return <ListingApprovals />
      case "listing-distribution":
        return <ListingDistribution />
      case "oh-manager":
        return <OpenHouseManager />
      case "showings":
        return <ShowingsDesk />
      case "buyer-tours":
        return <BuyerTours />
      case "feedback-log":
        return <FeedbackDesk />
      case "calendar":
        return <CalendarDashboard />
      case "segmentation":
        return <SegmentationDesk />
      case "data-health":
        return <DataHealth />
      case "lead-distribution":
        return <LeadDistribution />
      case "notifications":
        return <NotificationSettings />
      case "listing-intake":
        return <ListingIntake />
      case "crm":
        return (
          <CRM
            onGenerateOffer={(id) => {
              setInitialDeepLink({ action: "generate_offer", id })
              setCurrentView("offer-lab")
            }}
            onNavigate={setCurrentView}
          />
        )
      case "transactions":
        return <TransactionManager initialDealId={initialDeepLink?.id} />
      case "closing-dashboard":
        return <ClosingDashboard />
      case "sphere":
        return <SphereManager />
      case "documents":
        return <Documents />
      case "marketing":
        return <MarketingStudio />
      case "social-scheduler":
        return <SocialScheduler />
      case "shareable-assets":
        return <ShareableAssets />
      case "cma":
        return <SmartCMA />
      case "inbox":
        return <UnifiedInbox isMobile={isMobile} />
      case "partners":
        return <PartnersManager />
      case "map-intelligence":
        return <MapIntelligence />
      case "listing-reports":
        return activeListingForReport ? (
          <ListingReports listing={activeListingForReport} onBack={() => setCurrentView("agent-dashboard")} />
        ) : (
          <AgentDashboard userContext={userContext} />
        )
      case "compliance":
        return <ComplianceManager />
      case "agents":
        return <AgentRoster />
      case "system-health":
        return <SystemHealth />
      case "settings":
        return <SystemConfig />
      case "knowledge-base":
        return <KnowledgeBase />
      case "ai-audit":
        return <AIAudit />
      case "vendor-compliance":
        return <VendorCompliance />
      case "buyer-dashboard":
        return <BuyerPortal onNavigate={setCurrentView} isMobile={isMobile} />
      case "home-value":
        return <HomeValuePortal />
      case "playbook":
        return <ClientPlaybook />
      case "matches":
        return <SmartMatches />
      case "marketplace":
        return <VendorMarketplace />
      case "listing-journey":
        return <ListingJourney />
      case "seller-dashboard":
        return <SellerDashboard onNavigate={setCurrentView} initialAction={initialDeepLink?.action} />
      case "open-house":
        return <OpenHouseKiosk />
      case "events":
        return <Events />
      case "ai-tools":
        return <AIToolsHub />
      case "contact-management":
        return <ContactManagement />
      case "buyer-home-dashboard":
        return <BuyerHomeDashboard />
      case "investor-dashboard":
        return <InvestorDashboard />
      case "landlord-dashboard":
        return <LandlordDashboard />
      case "renter-dashboard":
        return <RenterDashboard />
      case "fsbo-dashboard":
        return <FSBODashboard />
      case "motivated-seller-dashboard":
        return <MotivatedSellerDashboard />
      case "first-time-buyer-dashboard":
        return <FirstTimeBuyerDashboard />
      case "luxury-buyer-dashboard":
        return <LuxuryBuyerDashboard />
      case "luxury-seller-dashboard":
        return <LuxurySellerDashboard />
      case "relocating-dashboard":
        return <RelocatingDashboard />
      case "probate-dashboard":
        return <ProbateDashboard />
      case "divorce-dashboard":
        return <DivorceDashboard />
      case "senior-dashboard":
        return <SeniorDashboard />
      case "remote-seller-dashboard":
        return <RemoteSellerDashboard />
      case "expired-listing-dashboard":
        return <ExpiredListingDashboard />
      case "default-contact-dashboard":
        return <DefaultContactDashboard />
      case "tc-dashboard":
        return <TCDashboard />
      default:
        return (
          <div className="flex items-center justify-center h-[50vh] text-slate-400 font-bold uppercase tracking-widest">
            Initializing: {currentView}
          </div>
        )
    }
  }

  if (isLoading)
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    )

  if (!user && !isQRView && !isPartnerView)
    return (
      <>
        <ToastContainer toasts={toasts} removeToast={removeToast} />
        <LoginPage
          onLogin={(r, email, persona) => {
            if (r === "contact" && persona) {
              setUserPersona(persona)
            }
            signIn(email, r as any)
          }}
        />
      </>
    )

  return (
    <div className={`flex min-h-screen bg-slate-50 ${isMobile ? "flex-col" : ""}`}>
      <ToastContainer toasts={toasts} removeToast={removeToast} />

      {!isMobile && !isQRView && !isPartnerView && (
        <Sidebar role={role} currentView={currentView} onChangeView={setCurrentView} onLogout={signOut} />
      )}

      <main
        className={`flex-1 overflow-y-auto h-screen relative ${
          isQRView || isPartnerView ? "" : isMobile ? "pb-24 pt-4 px-4" : "ml-64 p-8"
        }`}
      >
        {!isQRView && !isPartnerView && (
          <header className={`flex justify-between items-center ${isMobile ? "mb-4" : "mb-8"}`}>
            <div>
              <h1
                className={`${isMobile ? "text-lg" : "text-2xl"} font-black text-slate-900 uppercase italic tracking-tighter`}
              >
                {currentView
                  .split("-")
                  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                  .join(" ")}
              </h1>
              {!isMobile && (
                <p className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mt-1">
                  VIP AGENTS Smart Engine •{" "}
                  {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 md:gap-4">
              <button className="p-2.5 bg-white rounded-xl border border-slate-200 shadow-sm relative hover:bg-slate-50 transition-colors group">
                <Bell size={18} className="text-slate-400 group-hover:text-indigo-600" />
                <span className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full border-2 border-white"></span>
              </button>
              <div className="flex items-center gap-3">
                {!isMobile && (
                  <div className="text-right">
                    <p className="text-xs font-black text-slate-800 uppercase tracking-tight">{role}</p>
                    <p className="text-[10px] text-indigo-500 font-bold italic">{user?.email || "Authenticated"}</p>
                  </div>
                )}
                <div
                  onClick={() => isMobile && setCurrentView("settings")}
                  className="w-10 h-10 md:w-11 md:h-11 bg-indigo-600 rounded-2xl flex items-center justify-center text-white font-black shadow-lg border-2 border-white cursor-pointer active:scale-95 transition-transform"
                >
                  {role[0]}
                </div>
              </div>
            </div>
          </header>
        )}

        {renderContent()}

        {isMobile && role === UserRole.AGENT && !isQRView && !isPartnerView && <QuickActionsFAB />}

        {(role === UserRole.AGENT || role === UserRole.BROKER || role === UserRole.ADMIN) &&
          !isQRView &&
          !isPartnerView && (
            <>
              <VoiceCommandButton />
              <FloatingAIAssistant />
            </>
          )}
      </main>

      {isMobile && !isQRView && !isPartnerView && (
        <nav className="fixed bottom-0 left-0 right-0 h-20 bg-white border-t border-slate-200 z-[100] px-6 flex items-center justify-between shadow-[0_-10px_30px_rgba(0,0,0,0.05)]">
          <MobileNavItem
            icon={LayoutDashboard}
            active={currentView.includes("dashboard") || currentView === "listing-journey"}
            onClick={() =>
              setCurrentView(
                role === UserRole.AGENT
                  ? "agent-dashboard"
                  : role === UserRole.BUYER
                    ? "buyer-dashboard"
                    : "listing-journey",
              )
            }
          />
          <MobileNavItem icon={Calendar} active={currentView === "events"} onClick={() => setCurrentView("events")} />
          <MobileNavItem
            icon={MessageSquare}
            active={currentView === "inbox"}
            onClick={() => setCurrentView("inbox")}
          />
          <MobileNavItem
            icon={Briefcase}
            active={currentView === "transactions"}
            onClick={() => setCurrentView("transactions")}
          />
          <MobileNavItem
            icon={Navigation}
            active={currentView === "map-intelligence"}
            onClick={() => setCurrentView("map-intelligence")}
          />
        </nav>
      )}

      {!isMobile && !isQRView && !isPartnerView && <SmartGuide />}
    </div>
  )
}

const App: React.FC = () => (
  <AuthProvider>
    <NexusApp />
  </AuthProvider>
)

export default App
