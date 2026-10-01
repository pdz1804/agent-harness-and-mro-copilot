import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

/** Every text control shares one height, border, radius (10) and focus halo,
 * so mixed toolbars align. `invalid` paints the error state and sets
 * `aria-invalid`; pair it with `<Field error>` for the message. */
export function Input({ className = '', invalid, ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={`ui-input ${invalid ? '!border-rose-400' : ''} ${className}`} {...rest} />
}

export function Textarea({ className = '', invalid, ref, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} aria-invalid={invalid || undefined} className={`ui-input ${invalid ? '!border-rose-400' : ''} ${className}`} {...rest} />
}

export function Select({ className = '', children, ref, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <select ref={ref} className={`ui-input ${className}`} {...rest}>
      {children}
    </select>
  )
}

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: string
  onValueChange: (value: string) => void
  /** Accessible name; also the placeholder when none is given. */
  label: string
}

/** Search box with a leading glass icon and a clear button once it has text.
 * Escape clears it. */
export function SearchInput({ value, onValueChange, label, placeholder, className = '', ...rest }: SearchInputProps) {
  return (
    <div className={`relative min-w-0 ${className}`}>
      <MagnifyingGlass size={14} weight="bold" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-zinc-400" />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation()
            onValueChange('')
          }
        }}
        className="ui-input w-full pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
        {...rest}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onValueChange('')}
          className="absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-950/5 hover:text-zinc-700"
        >
          <X size={12} weight="bold" />
        </button>
      )}
    </div>
  )
}

interface FieldProps {
  label: ReactNode
  /** Rendered as a child function so the control gets the generated id and
   * the describedby wiring for its hint / error. */
  children: (props: { id: string; 'aria-describedby'?: string; invalid: boolean }) => ReactNode
  hint?: ReactNode
  error?: string | null
  optional?: boolean
  className?: string
}

/** Label + control + hint/error, with the a11y wiring done once. */
export function Field({ label, children, hint, error, optional, className = '' }: FieldProps) {
  const id = useId()
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={id} className="flex items-baseline gap-1.5 text-[13px] font-medium text-zinc-800">
        {label}
        {optional && <span className="text-xs font-normal text-zinc-500">optional</span>}
      </label>
      {children({ id, 'aria-describedby': describedBy, invalid: !!error })}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-rose-700">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-zinc-500">
            {hint}
          </p>
        )
      )}
    </div>
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
  /** Shows a spinner-like dimmed state while a toggle request is in flight. */
  pending?: boolean
}

/** On/off switch (role=switch); the thumb moves on the snappy spring. */
export function Switch({ checked, onChange, label, disabled, title, pending }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={pending || undefined}
      title={title}
      disabled={disabled || pending}
      onClick={() => onChange(!checked)}
      className={`ui-switch ${pending ? 'opacity-60' : ''}`}
    />
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  count?: number
}

interface SegmentedProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: SegmentedOption<T>[]
  label: string
  size?: 'sm' | 'md'
  className?: string
}

/** Tabs as a segmented control: a raised white pill marks the selected
 * option. Arrow keys move between options (roving tabindex). */
export function Segmented<T extends string>({ value, onChange, options, label, size = 'md', className = '' }: SegmentedProps<T>) {
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`ui-segmented max-w-full overflow-x-auto ${className}`}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
        e.preventDefault()
        const next = options[(index + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length]
        onChange(next.value)
        requestAnimationFrame(() => (e.currentTarget.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus())
      }}
    >
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-150 ${
              size === 'sm' ? 'h-6 text-xs' : 'h-7 text-[13px]'
            } ${selected ? 'bg-white text-zinc-950 shadow-[var(--shadow-sm)] ring-1 ring-[var(--color-line)]' : 'text-zinc-500 hover:text-zinc-800'}`}
          >
            {o.icon}
            {o.label}
            {o.count !== undefined && <span className={`tabular-nums ${selected ? 'text-zinc-500' : 'text-zinc-400'}`}>{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
