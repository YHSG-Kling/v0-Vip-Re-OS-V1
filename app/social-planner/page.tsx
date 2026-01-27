import { Suspense } from "react"
import SocialPlannerContent from "./social-planner-content"

interface SocialPlannerPageProps {
  userId?: string
  userRole?: string
}

export default function SocialPlannerPage({ userId, userRole }: SocialPlannerPageProps) {
  return (
    <Suspense fallback={<div className="p-8">Loading Social Planner...</div>}>
      <SocialPlannerContent userId={userId} userRole={userRole} />
    </Suspense>
  )
}
