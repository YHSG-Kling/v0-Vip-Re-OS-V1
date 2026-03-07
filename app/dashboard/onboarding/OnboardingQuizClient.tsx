'use client'

import { useState, useTransition } from 'react'
import { fetchQuiz, submitQuiz } from '@/app/actions/onboarding/onboarding-quiz-actions'

type QuizQuestion = {
  id: string
  question_text: string
  options: { label: string; value: string }[]
}

type QuizState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'loaded'; quizId: string; quizName: string; passingScore: number; questions: QuizQuestion[] }
  | { phase: 'submitting' }
  | { phase: 'result'; score: number; passed: boolean; passingScore: number }
  | { phase: 'error'; message: string }

type Props = {
  stepId: string
  onPassAndComplete: () => void
}

export function OnboardingQuizClient({ stepId, onPassAndComplete }: Props) {
  const [state, setState] = useState<QuizState>({ phase: 'idle' })
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [, startTransition] = useTransition()

  const handleLoadQuiz = () => {
    setState({ phase: 'loading' })
    startTransition(async () => {
      try {
        const quiz = await fetchQuiz(stepId)
        if (!quiz) {
          setState({ phase: 'error', message: 'No quiz found for this step.' })
          return
        }
        setState({
          phase: 'loaded',
          quizId: quiz.quizId,
          quizName: quiz.quizName,
          passingScore: quiz.passingScore,
          questions: quiz.questions as QuizQuestion[],
        })
      } catch {
        setState({ phase: 'error', message: 'Failed to load quiz. Please try again.' })
      }
    })
  }

  const handleSubmit = () => {
    if (state.phase !== 'loaded') return
    const { quizId, passingScore } = state
    setState({ phase: 'submitting' })
    startTransition(async () => {
      try {
        const result = await submitQuiz(quizId, answers as Record<string, unknown>)
        setState({ phase: 'result', score: result.score, passed: result.passed, passingScore })
      } catch {
        setState({ phase: 'error', message: 'Failed to submit quiz. Please try again.' })
      }
    })
  }

  const handleAnswer = (questionId: string, value: string) => {
    setAnswers(prev => ({ ...prev, [questionId]: value }))
  }

  if (state.phase === 'idle') {
    return (
      <button
        type="button"
        onClick={handleLoadQuiz}
        className="mt-3 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium py-2 px-4 rounded-lg"
      >
        Take Quiz
      </button>
    )
  }

  if (state.phase === 'loading') {
    return <p className="text-sm text-gray-500 mt-3">Loading quiz...</p>
  }

  if (state.phase === 'error') {
    return (
      <div className="mt-3 space-y-2">
        <p className="text-sm text-red-600">{state.message}</p>
        <button
          type="button"
          onClick={() => setState({ phase: 'idle' })}
          className="text-sm text-blue-600 hover:underline"
        >
          Try again
        </button>
      </div>
    )
  }

  if (state.phase === 'result') {
    return (
      <div className={`mt-3 rounded-lg p-4 ${state.passed ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
        <p className={`font-semibold ${state.passed ? 'text-green-800' : 'text-red-800'}`}>
          {state.passed ? 'Quiz passed!' : 'Quiz not passed'}
        </p>
        <p className="text-sm text-gray-700 mt-1">
          Score: {state.score}% (passing: {state.passingScore}%)
        </p>
        {state.passed ? (
          <button
            type="button"
            onClick={onPassAndComplete}
            className="mt-3 bg-green-600 hover:bg-green-700 text-white text-sm font-medium py-2 px-4 rounded-lg"
          >
            Mark Step Complete
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setAnswers({})
              setState({ phase: 'idle' })
            }}
            className="mt-3 bg-gray-600 hover:bg-gray-700 text-white text-sm font-medium py-2 px-4 rounded-lg"
          >
            Retry Quiz
          </button>
        )}
      </div>
    )
  }

  if (state.phase === 'loaded' || state.phase === 'submitting') {
    const questions = state.phase === 'loaded' ? state.questions : []
    const quizName = state.phase === 'loaded' ? state.quizName : ''

    return (
      <div className="mt-3 border border-gray-200 rounded-lg p-4 space-y-4">
        <h4 className="font-semibold text-gray-900">{quizName}</h4>
        {questions.map(q => (
          <div key={q.id} className="space-y-2">
            <p className="text-sm font-medium text-gray-800">{q.question_text}</p>
            <div className="space-y-1">
              {q.options.map(opt => (
                <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="radio"
                    name={`q-${q.id}`}
                    value={opt.value}
                    checked={answers[q.id] === opt.value}
                    onChange={() => handleAnswer(q.id, opt.value)}
                    disabled={state.phase === 'submitting'}
                    className="accent-purple-600"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={state.phase === 'submitting' || questions.some(q => !answers[q.id])}
          className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium py-2 px-4 rounded-lg"
        >
          {state.phase === 'submitting' ? 'Submitting...' : 'Submit Answers'}
        </button>
      </div>
    )
  }

  return null
}
