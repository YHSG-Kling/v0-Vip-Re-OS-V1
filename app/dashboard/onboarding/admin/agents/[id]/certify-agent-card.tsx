"use client"

// The door for app/actions/ai-agent-onboarding.ts:certifyAgent (restored by
// owner ruling, lane F2 2026-08-28) — exam-gated AGENT ACTIVATION.
//
// Admin-side on purpose: this page is already gated to broker/admin, and the
// action re-checks that gate plus the tenant itself. The certify button only
// renders ENABLED when the STORED exam record qualifies (best
// agent_quiz_attempts score on the certification quiz ≥ the 90% gate) — the
// score shown here is read server-side by getCertificationReadiness and the
// action re-reads it at certify time, so nothing the browser sends can move it.

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Award, Loader2, CheckCircle2 } from "lucide-react"
import { certifyAgent } from "@/app/actions/ai-agent-onboarding"

export interface CertificationReadiness {
  bestScore: number | null
  attemptCount: number
  passingScore: number
  eligible: boolean
  alreadyActive: boolean
  /** What the agent got WRONG on the attempt the gate is applied to, decoded
   *  from the STORED agent_quiz_attempts.answers. Optional so a caller built
   *  before this existed still type-checks; absent and empty both render nothing. */
  missed?: Array<{ question: string; given: string | null; correct: string }>
}

export function CertifyAgentCard({
  agentId,
  agentName,
  readiness,
}: {
  agentId: string
  agentName: string
  readiness: CertificationReadiness | { error: string }
}) {
  const router = useRouter()
  const [isCertifying, setIsCertifying] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if ("error" in readiness) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Award className="h-4 w-4" />
            Certification
          </CardTitle>
          <CardDescription>
            Certification readiness could not be read — not the same as &ldquo;not eligible&rdquo;.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-destructive">{readiness.error}</p>
        </CardContent>
      </Card>
    )
  }

  const handleCertify = async () => {
    setIsCertifying(true)
    setError(null)
    try {
      const res = await certifyAgent(agentId)
      if (!res.success) {
        setError(("error" in res && res.error) || "Certification failed")
        return
      }
      setResult(("message" in res && res.message) || "Certified.")
      router.refresh()
    } catch (err: any) {
      setError(err?.message ?? "Certification failed")
    } finally {
      setIsCertifying(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Award className="h-4 w-4" />
          Certify &amp; Activate
        </CardTitle>
        <CardDescription>
          Activates {agentName} (full platform access) once the stored certification exam score meets
          the {readiness.passingScore}% gate. The score is read from the exam record — it cannot be
          entered here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">Best stored exam score:</span>
          {readiness.bestScore !== null ? (
            <Badge variant={readiness.eligible ? "default" : "secondary"}>
              {readiness.bestScore}%
            </Badge>
          ) : (
            <span className="text-muted-foreground">
              no attempt on record ({readiness.attemptCount} attempts)
            </span>
          )}
        </div>

        {/* WHAT THEY MISSED — the exam responses the ledger has always stored
            (agent_quiz_attempts.answers) and no surface ever showed. A broker
            deciding whether to activate an agent, or which competency to coach
            before a retake, needs the misses and not only the number. */}
        {(readiness.missed?.length ?? 0) > 0 && (
          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-medium">
              Missed on the best attempt ({readiness.missed!.length}
              {readiness.missed!.length === 1 ? " question" : " questions"})
            </p>
            <ul className="space-y-1.5">
              {readiness.missed!.map((m, i) => (
                <li key={i} className="text-xs">
                  <span className="font-medium">{m.question}</span>
                  <span className="text-muted-foreground">
                    {" "}— answered {m.given === null ? "nothing" : `“${m.given}”`}; correct “{m.correct}”
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {readiness.alreadyActive ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            This agent is already certified and active.
          </p>
        ) : result ? (
          <p className="text-sm text-green-700 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            {result}
          </p>
        ) : (
          <Button onClick={handleCertify} disabled={isCertifying || !readiness.eligible} size="sm">
            {isCertifying ? (
              <>
                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                Certifying…
              </>
            ) : (
              <>
                <Award className="h-3 w-3 mr-2" />
                Certify &amp; activate agent
              </>
            )}
          </Button>
        )}

        {!readiness.alreadyActive && !readiness.eligible && !result && (
          <p className="text-xs text-muted-foreground">
            {readiness.bestScore === null
              ? "The agent has not taken the certification exam yet."
              : `The stored score is below the ${readiness.passingScore}% gate — the agent can retake the exam from their onboarding dashboard.`}
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}
