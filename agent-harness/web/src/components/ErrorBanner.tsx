import { WarningCircle } from '@phosphor-icons/react'

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="flex animate-rise items-start gap-3 rounded-xl bg-rose-50/80 px-4 py-3 text-sm text-rose-900 ring-1 ring-rose-200 ring-inset"
      role="alert"
    >
      <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0 text-rose-600" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <p>{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 text-sm font-medium text-rose-700 underline decoration-rose-300 underline-offset-2 hover:text-rose-900"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  )
}
