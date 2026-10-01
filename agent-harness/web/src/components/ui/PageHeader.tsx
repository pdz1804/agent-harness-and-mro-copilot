import { ArrowLeft } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useStuck } from '../../hooks/useStuck'

interface PageHeaderProps {
  title: ReactNode
  /** One line saying what this page is for (hidden once the header frosts). */
  description?: ReactNode
  /** Primary / secondary actions, right-aligned (one primary at most). */
  actions?: ReactNode
  /** A back link above the title (detail pages). */
  back?: { to: string; label: string }
  /** Badges / metadata directly under the title. */
  meta?: ReactNode
  /** Toolbar row under the title that stays with the sticky header (tabs,
   * search and filters), so filters are reachable while scrolled. */
  toolbar?: ReactNode
}

/** The one page header: sticky at the top of the page's scroll container.
 * Unscrolled it is transparent with the 26px title and lede; once content
 * scrolls under it, it frosts (glass, hairline) and the title steps down to
 * 18px. It bleeds to the panel edges by cancelling `main`'s padding, and its
 * negative `top` equals that padding because sticky offsets resolve against
 * the scroll container's content box. */
export function PageHeader({ title, description, actions, back, meta, toolbar }: PageHeaderProps) {
  const { sentinelRef, stuck } = useStuck()
  return (
    <>
      <div ref={sentinelRef} aria-hidden="true" className="h-0" />
      <header
        data-stuck={stuck ? '' : undefined}
        className="ui-sticky-header -top-6 -mx-4 -mt-6 mb-4 px-4 pt-4 pb-3 md:-top-8 md:-mx-8 md:-mt-8 md:px-8 md:pt-5 data-[stuck]:pt-3 md:data-[stuck]:pt-3"
      >
        <div className="ui-page-header !pb-0">
          <div>
            {back && (
              <Link to={back.to} className="ui-btn-link mb-1 inline-flex items-center gap-1 text-xs">
                <ArrowLeft size={12} weight="bold" />
                {back.label}
              </Link>
            )}
            <h1 className="ui-page-title [overflow-wrap:anywhere]">{title}</h1>
            {description && <p className="ui-page-lede mt-1 text-sm text-zinc-600">{description}</p>}
            {meta && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-600">{meta}</div>}
          </div>
          {actions && <div className="ui-page-actions">{actions}</div>}
        </div>
        {toolbar && <div className="mt-3 flex flex-wrap items-center gap-2">{toolbar}</div>}
      </header>
    </>
  )
}
