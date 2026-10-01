/** Client-side line diff (phase 02 prompt library) — no diff dependency:
 * a simple O(n*m) LCS over lines is more than fast enough for prompt-sized
 * text (a handful of KB at most), and keeps the bundle dependency-free per
 * the plan's "Charts: recharts / hand SVG" style tradeoff table (avoid a
 * dependency where a small hand-rolled algorithm is simpler to reason
 * about and test). */

interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
}

function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length

  // Longest common subsequence table (line-based).
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ kind: 'removed', text: a[i] })
      i++
    } else {
      result.push({ kind: 'added', text: b[j] })
      j++
    }
  }
  while (i < n) {
    result.push({ kind: 'removed', text: a[i] })
    i++
  }
  while (j < m) {
    result.push({ kind: 'added', text: b[j] })
    j++
  }
  return result
}

const KIND_STYLES: Record<DiffLine['kind'], string> = {
  same: 'text-zinc-600',
  added: 'bg-emerald-50 text-emerald-800',
  removed: 'bg-rose-50 text-rose-800 line-through decoration-rose-300',
}

const KIND_PREFIX: Record<DiffLine['kind'], string> = {
  same: '  ',
  added: '+ ',
  removed: '- ',
}

/** Renders a unified, line-by-line diff between `before` and `after`. Used
 * by the Prompt Library page to compare any two versions of a prompt. */
export function DiffView({ before, after }: { before: string; after: string }) {
  if (before === after) {
    return <p className="text-sm text-zinc-500">No changes between these versions.</p>
  }
  const lines = diffLines(before, after)
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-zinc-200 bg-white p-3 font-data text-xs leading-relaxed whitespace-pre-wrap">
      {lines.map((line, idx) => (
        <div key={idx} className={KIND_STYLES[line.kind]}>
          {KIND_PREFIX[line.kind]}
          {line.text}
        </div>
      ))}
    </pre>
  )
}
