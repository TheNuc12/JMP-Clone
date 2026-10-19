import type { DesignType } from '../../api/types'
import { NotBuilt } from '../../components/Modal'

/** Design of experiments: define factors and responses, make the design, then open it as a table. */
export function DoeDialog({ design, onClose }: { design: DesignType; onClose: () => void }) {
  void design
  return <NotBuilt title="Design of Experiments" onClose={onClose} />
}
