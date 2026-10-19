import { NotBuilt } from './Modal'

export function ColumnInfoDialog({ columnId, onClose }: { columnId: string; onClose: () => void }) {
  void columnId
  return <NotBuilt title="Column Info" onClose={onClose} />
}
