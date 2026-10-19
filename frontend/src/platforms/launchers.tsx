import { FitYByXGuide, LaunchDialog } from '../components/LaunchDialog'
import { useStore } from '../state/store'

export function DistributionLaunch({ onClose }: { onClose: () => void }) {
  const openReport = useStore((s) => s.openReport)
  return (
    <LaunchDialog
      title="Distribution"
      description="Histograms, quantiles and summary statistics for each column."
      roles={[{ key: 'y', label: 'Y, Columns', hint: 'One or more columns to describe' }]}
      onCancel={onClose}
      onLaunch={(a) => {
        openReport({ kind: 'distribution', roles: { y: a.y } })
        onClose()
      }}
    />
  )
}

export function FitYByXLaunch({ onClose }: { onClose: () => void }) {
  const openReport = useStore((s) => s.openReport)
  return (
    <LaunchDialog
      title="Fit Y by X"
      description="Relationship between two variables. The analysis depends on their modeling types."
      roles={[
        { key: 'y', label: 'Y, Response', hint: 'Response column(s)' },
        { key: 'x', label: 'X, Factor', hint: 'Factor column(s)' },
      ]}
      aside={<FitYByXGuide />}
      onCancel={onClose}
      onLaunch={(a) => {
        openReport({ kind: 'fit_y_by_x', roles: { y: a.y, x: a.x } })
        onClose()
      }}
    />
  )
}
