import { DownloadSimple } from '@phosphor-icons/react'
import type { RunSnapshot } from '../../lib/api-types'
import { JsonTree } from '../ui/JsonTree'

export function RawTab({ snapshot }: { snapshot: RunSnapshot }) {
  const download = () => {
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${snapshot.run_id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={download}
        className="ui-btn ui-btn-secondary ui-btn-sm"
      >
        <DownloadSimple size={13} weight="bold" />
        Download JSON
      </button>
      <JsonTree value={snapshot.history} />
    </div>
  )
}
