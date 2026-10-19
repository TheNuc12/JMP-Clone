import { Modal } from './Modal'

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="About Sift"
      onClose={onClose}
      className="about"
      footer={
        <button className="primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="about-body">
        <p>Sift is an open-source tool for exploring data interactively, inspired by desktop statistical discovery software.</p>
        <ul>
          <li>
            <strong>Analyze</strong>: Distribution, Fit Y by X, Fit Model, Control Chart, Process Capability.
          </li>
          <li>
            <strong>DOE</strong>: full factorial, screening, response surface and custom (D-optimal) designs.
          </li>
          <li>
            <strong>Graph › Graph Builder</strong>: drag columns onto X, Y, Overlay and Group zones.
          </li>
          <li>Click or drag across points, bars or rows to select; shift adds, ctrl/cmd toggles, Esc clears.</li>
          <li>Rows › Exclude / Unexclude removes the selected rows from every analysis.</li>
          <li>Double-click a cell to edit it, or a column header for Column Info (formulas, value order, spec limits).</li>
          <li>File › Save Session keeps tables, row states and reports in a .sift file.</li>
        </ul>
      </div>
    </Modal>
  )
}
