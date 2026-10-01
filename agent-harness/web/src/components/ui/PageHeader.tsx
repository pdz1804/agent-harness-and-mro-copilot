import { ArrowLeft } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

interface PageHeaderProps {
  title: string
  /** One line saying what this page is for. */
  description?: ReactNode
  /** Primary / secondary actions, right-aligned (one `ui-btn-primary` at most). */
  actions?: ReactNode
  /** A back link above the title (detail pages). */
  back?: { to: string; label: string }
  /** Badges / metadata directly under the title. */
  meta?: ReactNode
}

/** The one page header every page uses: optional back link, title,
 * one-line description, metadata, and the page's actions on the right. */
export function PageHeader({ title, description, actions, back, meta }: PageHeaderProps) {
  return (
    <header className="ui-page-header">
      <div>
        {back && (
          <Link to={back.to} className="ui-btn-link mb-1 inline-flex items-center gap-1 text-xs">
            <ArrowLeft size={12} weight="bold" />
            {back.label}
          </Link>
        )}
        <h1 className="ui-page-title [overflow-wrap:anywhere]">{title}</h1>
        {description && <p className="mt-1 text-sm text-zinc-600">{description}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-600">{meta}</div>}
      </div>
      {actions && <div className="ui-page-actions">{actions}</div>}
    </header>
  )
}
