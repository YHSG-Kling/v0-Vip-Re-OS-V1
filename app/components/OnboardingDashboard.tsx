"use client"

import React, { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card"
import { Button } from "./ui/button"
import { Progress } from "./ui/progress"
import { Badge } from "./ui/badge"
import {
  CheckCircle2,
  Circle,
  User,
  MapPin,
  Briefcase,
  MessageSquare,
  Calendar,
  BookOpen,
  Sparkles,
  ArrowRight,
} from "lucide-react"

interface OnboardingStep {
  id: string
  title: string
  description: string
  icon: React.ElementType
  completed: boolean
  action: string
}

const OnboardingDashboard: React.FC = () => {
  const [steps, setSteps] = useState<OnboardingStep[]>([
    {
      id: "profile",
      title: "Complete Your Profile",
      description: "Add your photo, bio, and contact information",
      icon: User,
      completed: false,
      action: "Complete Profile",
    },
    {
      id: "territory",
      title: "Set Your Territory",
      description: "Define the areas where you work",
      icon: MapPin,
      completed: false,
      action: "Set Territory",
    },
    {
      id: "listings",
      title: "Add Your First Listing",
      description: "Get started by adding a property listing",
      icon: Briefcase,
      completed: false,
      action: "Add Listing",
    },
    {
      id: "contacts",
      title: "Import Your Contacts",
      description: "Bring in your existing client database",
      icon: MessageSquare,
      completed: false,
      action: "Import Contacts",
    },
    {
      id: "calendar",
      title: "Connect Your Calendar",
      description: "Sync your calendar for appointments and showings",
      icon: Calendar,
      completed: false,
      action: "Connect Calendar",
    },
    {
      id: "training",
      title: "Complete Training Modules",
      description: "Learn how to use the platform effectively",
      icon: BookOpen,
      completed: false,
      action: "Start Training",
    },
  ])

  const completedCount = steps.filter((step) => step.completed).length
  const progress = (completedCount / steps.length) * 100

  const toggleStepCompletion = (stepId: string) => {
    setSteps((prevSteps) =>
      prevSteps.map((step) => (step.id === stepId ? { ...step, completed: !step.completed } : step)),
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-indigo-600" />
          <h1 className="text-3xl font-bold text-slate-900">Welcome to Smart Engine!</h1>
        </div>
        <p className="text-slate-600">
          Let's get you set up and ready to close more deals. Complete these steps to unlock the full power of the
          platform.
        </p>
      </div>

      {/* Progress Card */}
      <Card className="border-indigo-200 bg-gradient-to-br from-indigo-50 to-white">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-xl">Your Onboarding Progress</CardTitle>
              <CardDescription className="mt-1">
                {completedCount} of {steps.length} steps completed
              </CardDescription>
            </div>
            <Badge variant={progress === 100 ? "default" : "secondary"} className="text-lg px-4 py-2">
              {Math.round(progress)}%
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Progress value={progress} className="h-3" />
        </CardContent>
      </Card>

      {/* Onboarding Steps */}
      <div className="grid gap-4">
        {steps.map((step, index) => {
          const Icon = step.icon
          return (
            <Card
              key={step.id}
              className={`transition-all duration-200 ${
                step.completed
                  ? "border-green-200 bg-green-50/50"
                  : "border-slate-200 hover:border-indigo-300 hover:shadow-md"
              }`}
            >
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  {/* Step Number/Icon */}
                  <div
                    className={`flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center ${
                      step.completed ? "bg-green-500 text-white" : "bg-slate-100 text-slate-400"
                    }`}
                  >
                    {step.completed ? <CheckCircle2 className="w-6 h-6" /> : <Icon className="w-6 h-6" />}
                  </div>

                  {/* Step Content */}
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-lg text-slate-900">{step.title}</h3>
                      {step.completed && (
                        <Badge variant="default" className="bg-green-500">
                          Complete
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-slate-600">{step.description}</p>
                  </div>

                  {/* Action Button */}
                  <Button
                    onClick={() => toggleStepCompletion(step.id)}
                    variant={step.completed ? "outline" : "default"}
                    className={step.completed ? "border-green-500 text-green-600 hover:bg-green-50" : ""}
                  >
                    {step.completed ? "Undo" : step.action}
                    {!step.completed && <ArrowRight className="w-4 h-4 ml-2" />}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Completion Message */}
      {progress === 100 && (
        <Card className="border-green-200 bg-gradient-to-br from-green-50 to-white">
          <CardContent className="p-6 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-500 text-white mb-4">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h3 className="text-2xl font-bold text-slate-900 mb-2">Congratulations!</h3>
            <p className="text-slate-600 mb-4">
              You've completed your onboarding. You're now ready to take full advantage of Smart Engine.
            </p>
            <Button size="lg" className="bg-indigo-600 hover:bg-indigo-700">
              Go to Dashboard
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export default OnboardingDashboard
