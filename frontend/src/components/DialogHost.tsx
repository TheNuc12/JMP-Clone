import { FitModelDialog } from '../platforms/fitModel/FitModelDialog'
import { DoeDialog } from '../platforms/doe/DoeDialog'
import { DistributionLaunch, FitYByXLaunch } from '../platforms/launchers'
import { CapabilityDialog } from '../platforms/quality/CapabilityDialog'
import { ControlChartDialog } from '../platforms/quality/ControlChartDialog'
import { useStore } from '../state/store'
import { AboutDialog } from './AboutDialog'
import { AddRowsDialog } from './AddRowsDialog'
import { ColumnInfoDialog } from './ColumnInfoDialog'
import { NewColumnDialog } from './NewColumnDialog'

/** Renders whichever dialog the store says is open. */
export function DialogHost() {
  const dialog = useStore((s) => s.dialog)
  const close = useStore((s) => s.closeDialog)
  const hasTable = useStore((s) => s.activeTableId !== null)
  if (!dialog) return null
  // Dialogs other than DOE and About work on the active table.
  if (!hasTable && dialog.kind !== 'doe' && dialog.kind !== 'about') return null
  switch (dialog.kind) {
    case 'distribution':
      return <DistributionLaunch onClose={close} />
    case 'fit_y_by_x':
      return <FitYByXLaunch onClose={close} />
    case 'fit_model':
      return <FitModelDialog onClose={close} />
    case 'control_chart':
      return <ControlChartDialog onClose={close} />
    case 'capability':
      return <CapabilityDialog onClose={close} />
    case 'doe':
      return <DoeDialog key={dialog.design} design={dialog.design} onClose={close} />
    case 'new_column':
      return <NewColumnDialog onClose={close} />
    case 'column_info':
      return <ColumnInfoDialog key={dialog.columnId} columnId={dialog.columnId} onClose={close} />
    case 'add_rows':
      return <AddRowsDialog onClose={close} />
    case 'about':
      return <AboutDialog onClose={close} />
  }
}
