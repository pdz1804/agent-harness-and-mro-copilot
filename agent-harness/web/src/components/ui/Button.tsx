import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid' | 'success' | 'link'
export type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonLook {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Leading icon (a Phosphor icon element). Replaced by a spinner while `loading`. */
  icon?: ReactNode
  /** Square, icon-only button: requires `aria-label`. */
  iconOnly?: boolean
  /** Keyboard hint shown after the label, e.g. "A" or "N". */
  kbd?: string
}

/** The class list for one button look. Exported so the rare non-button
 * element that must look like a button (a file input label) stays on-system. */
export function buttonClass({ variant = 'secondary', size = 'md', iconOnly = false }: ButtonLook, extra = ''): string {
  return [
    variant === 'link' ? 'ui-btn-link inline-flex items-center gap-1' : 'ui-btn',
    variant !== 'link' && `ui-btn-${variant}`,
    size === 'sm' && 'ui-btn-sm',
    size === 'lg' && 'ui-btn-lg',
    iconOnly && 'ui-btn-icon',
    extra,
  ]
    .filter(Boolean)
    .join(' ')
}

function Content({ icon, loading, kbd, children }: { icon?: ReactNode; loading?: boolean; kbd?: string; children?: ReactNode }) {
  return (
    <>
      {loading ? <Spinner /> : icon}
      {children}
      {kbd && (
        <kbd aria-hidden="true" className="ui-kbd ml-0.5 !h-[1.125rem] bg-transparent !text-[10px] text-current opacity-70">
          {kbd}
        </kbd>
      )}
    </>
  )
}

export interface ButtonProps extends ButtonLook, ButtonHTMLAttributes<HTMLButtonElement> {
  /** Shows a spinner in place of the icon, sets `aria-busy` and blocks clicks. */
  loading?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** The one button. Six variants (primary once per view, secondary, ghost,
 * danger, danger-solid, success), three sizes (28 / 32 / 44px), press scale on
 * a snappy spring, focus ring from the global :focus-visible rule. */
export function Button({ variant, size, icon, iconOnly, kbd, loading = false, className = '', type = 'button', disabled, children, ref, ...rest }: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass({ variant, size, iconOnly }, className)}
      {...rest}
    >
      <Content icon={icon} loading={loading} kbd={kbd}>
        {children}
      </Content>
    </button>
  )
}

/** A router link with the button look (navigation, not an action). */
export function LinkButton({ variant, size, icon, iconOnly, kbd, className = '', children, ...rest }: ButtonLook & LinkProps) {
  return (
    <Link className={buttonClass({ variant, size, iconOnly }, className)} {...rest}>
      <Content icon={icon} kbd={kbd}>
        {children}
      </Content>
    </Link>
  )
}

/** An external / download anchor with the button look. */
export function AnchorButton({ variant, size, icon, iconOnly, kbd, className = '', children, ...rest }: ButtonLook & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={buttonClass({ variant, size, iconOnly }, className)} {...rest}>
      <Content icon={icon} kbd={kbd}>
        {children}
      </Content>
    </a>
  )
}
