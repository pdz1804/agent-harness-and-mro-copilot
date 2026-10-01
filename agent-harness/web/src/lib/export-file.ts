/** Client-side exports of what a list currently shows (filters applied). */

type Cell = string | number | null | undefined

/** RFC 4180 CSV: fields with a comma, quote or newline are quoted, quotes doubled. */
export function toCsv(header: string[], rows: Cell[][]): string {
  const cell = (v: Cell) => {
    const s = v == null ? '' : String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

/** One JSON object per line. */
export function toJsonl(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '')
}

/** A dated file name: `sessions-2026-10-02.csv`. */
export function exportFileName(base: string, ext: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${base}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${ext}`
}

export function downloadText(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
