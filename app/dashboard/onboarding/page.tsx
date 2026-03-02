import { fetchMyOnboardingDashboard, completeMyOnboardingStep } from "@/app/actions/onboarding/agent-onboarding-actions"
import type { OnboardingStepRow } from "@/lib/kernel"
import { OnboardingQuizClient } from "./OnboardingQuizClient"

export default async function OnboardingPage() {
  let dashboard
  try {
    dashboard = await fetchMyOnboardingDashboard()
  } catch {
    return <div className="text-red-600">Failed to load onboarding. Please try again.</div>
  }

  const completionMap = new Map(
    dashboard.completions.map(c => [c.step_id, c])
  )

  const stepsByDay = new Map<number, OnboardingStepRow[]>()
  dashboard.steps.forEach(step => {
    if (!stepsByDay.has(step.day_number)) {
      stepsByDay.set(step.day_number, [])
    }
    stepsByDay.get(step.day_number)!.push(step)
  })

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Agent Onboarding</h1>
        <p className="text-gray-600 mt-2">Complete your onboarding journey to unlock full platform access</p>
      </div>

      {/* Progress Bar */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-medium text-gray-700">Progress</span>
          <span className="text-sm font-bold text-gray-900">{dashboard.onboarding.completion_percentage}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-3">
          <div
            className="bg-blue-600 h-3 rounded-full transition-all"
            style={{ width: `${dashboard.onboarding.completion_percentage}%` }}
          />
        </div>
        <p className="text-xs text-gray-500 mt-2">Day {dashboard.onboarding.current_day} of 7</p>
      </div>

      {/* Certification Status */}
      {dashboard.onboarding.certification_achieved && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-green-900 font-medium">You are certified! ({dashboard.onboarding.certified_at})</p>
        </div>
      )}

      {/* Steps by Day */}
      <div className="space-y-6">
        {Array.from(stepsByDay.entries())
          .sort(([dayA], [dayB]) => dayA - dayB)
          .map(([day, steps]) => (
            <div key={day} className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Day {day}</h2>
              <div className="space-y-4">
                {steps
                  .sort((a, b) => a.step_order - b.step_order)
                  .map(step => {
                    const completion = completionMap.get(step.id)
                    const isCompleted = completion?.completed ?? false
                    const hasQuiz = typeof step.success_criteria?.quiz_key === 'string'

                    return (
                      <div
                        key={step.id}
                        className={`border rounded-lg p-4 ${isCompleted ? 'bg-gray-50 border-gray-200' : 'border-gray-300'}`}
                      >
                        <div className="flex justify-between items-start mb-2">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="font-medium text-gray-900">{step.step_name}</h3>
                              {step.required && (
                                <span className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded">Required</span>
                              )}
                              {isCompleted && (
                                <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">Complete</span>
                              )}
                              {hasQuiz && !isCompleted && (
                                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">Has Quiz</span>
                              )}
                            </div>
                            <p className="text-sm text-gray-600 mt-1">{step.category}</p>
                            {step.estimated_minutes && (
                              <p className="text-xs text-gray-500 mt-1">{step.estimated_minutes} min</p>
                            )}
                          </div>
                        </div>

                        {step.instructions && (
                          <p className="text-sm text-gray-700 mt-2">{step.instructions}</p>
                        )}

                        {step.video_url && (
                          <a
                            href={step.video_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-blue-600 hover:underline mt-2 inline-block"
                          >
                            Watch Video
                          </a>
                        )}

                        {!isCompleted && hasQuiz && (
                          <OnboardingQuizClient
                            stepId={step.id}
                            onPassAndComplete={async () => {
                              "use server"
                              await completeMyOnboardingStep(step.id)
                            }}
                          />
                        )}

                        {!isCompleted && !hasQuiz && (
                          <form
                            action={async () => {
                              "use server"
                              await completeMyOnboardingStep(step.id)
                            }}
                            className="mt-4"
                          >
                            <button
                              type="submit"
                              className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 px-4 rounded-lg"
                            >
                              Mark Complete
                            </button>
                          </form>
                        )}
                      </div>
                    )
                  })}
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}
