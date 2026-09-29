import { WarningCircle } from '@phosphor-icons/react'

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-200">
      <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0 text-rose-400" />
      <div className="flex-1">
        <p>{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 font-medium text-rose-100 underline underline-offset-2 hover:text-white"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  )
}
