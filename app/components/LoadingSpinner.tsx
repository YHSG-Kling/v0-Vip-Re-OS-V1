import { cn } from '@/lib/utils'

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  text?: string
  className?: string
  fullScreen?: boolean
}

export default function LoadingSpinner({
  size = 'md',
  text = 'Loading...',
  className,
  fullScreen = false,
}: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'h-6 w-6 border-2',
    md: 'h-10 w-10 border-4',
    lg: 'h-16 w-16 border-4',
  }

  const textSizeClasses = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  }

  const spinner = (
    <div className={cn('flex flex-col items-center justify-center gap-4', className)}>
      {/* Animated spinner */}
      <div
        className={cn(
          'animate-spin rounded-full border-blue-600 border-t-transparent',
          sizeClasses[size]
        )}
        role="status"
        aria-label="Loading"
      />
      
      {/* Loading text */}
      {text && (
        <p className={cn('font-medium text-slate-400', textSizeClasses[size])}>
          {text}
        </p>
      )}
    </div>
  )

  if (fullScreen) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        {spinner}
      </div>
    )
  }

  return spinner
}
