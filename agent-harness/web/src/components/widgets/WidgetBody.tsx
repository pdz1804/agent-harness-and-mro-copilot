import type { DashboardWidget } from '../../lib/api-types'
import { ChartWidget } from './ChartWidget'
import { ListWidget } from './ListWidget'
import { StatWidget } from './StatWidget'
import { TableWidget } from './TableWidget'

/** The body of one widget by kind — shared by the dashboard grid, the
 * approval-state live preview and the session Workspace. */
export function WidgetBody({ widget }: { widget: DashboardWidget }) {
  switch (widget.kind) {
    case 'stat':
      return <StatWidget widget={widget} />
    case 'line':
    case 'bar':
    case 'area':
    case 'pie':
      return <ChartWidget widget={widget} />
    case 'table':
      return <TableWidget widget={widget} />
    case 'list':
      return <ListWidget widget={widget} />
    default:
      return null
  }
}
