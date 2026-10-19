# Sift

Interactive statistical discovery in the browser, inspired by desktop tools like JMP.
Sift is an independent project and is not affiliated with SAS Institute or JMP.

Open a data table, run analyses, and explore: **every graph and table is linked**, so
selecting rows anywhere (a histogram bar, a brushed region of a scatter plot, a mosaic cell,
rows in the data grid) highlights them everywhere.

## Features

### Data
- **Tables**: open CSV / TSV / Excel files, start a new empty table, or load a built-in
  sample. Several tables can be open at once, each in its own tab (double-click a tab to
  rename it). A virtualized grid handles large tables.
- **Editing**: double-click or start typing in a cell.
  - Enter, Tab and the arrow keys move between cells; Escape cancels an edit.
  - Copy and paste work with tab-separated text, so blocks from a spreadsheet paste in.
  - Add or delete rows and columns.
  - Undo and redo with Ctrl+Z / Ctrl+Shift+Z.
- **Column Info** (double-click a column header):
  - Rename the column, or change its data type or modeling type.
  - **Value Order** sets the order of categorical levels for every analysis and graph.
  - **Spec Limits** (LSL, Target, USL) are read by the capability tools.
- **Formula columns**: compute a column from others with a JMP-like formula language,
  e.g. `:weight / (:height ^ 2) * 703`.
  - The formula editor has a column list, a searchable function list, live errors and a
    preview of the results.
  - Formulas recalculate whenever the data changes.
  - The language is described in [docs/formula-language.md](docs/formula-language.md).
- **Row states**: select rows by clicking, shift-clicking or dragging, then exclude them
  from every analysis with *Rows › Exclude / Unexclude*.
- **Sessions**:
  - *File › Save Session* writes everything to a `.sift` file: tables, formulas, row
    states and open reports. *File › Open* restores it.
  - The workspace is also autosaved in the browser, so after a reload you can resume
    where you left off.
  - *File › Export Table as CSV* saves the current table.

### Analysis
Every graph and table is linked: selecting rows anywhere (a histogram bar, a brushed region
of a scatter plot, a mosaic cell, a control chart point, rows in the grid) highlights them
everywhere. Red-triangle menus on each report toggle extra output.

- **Distribution**: for continuous columns, a histogram with outlier box plot and mean
  diamond, quantiles, summary statistics, and a fitted normal with a goodness-of-fit test.
  Categorical columns get bar charts and frequency tables.
- **Fit Y by X**: the analysis follows the modeling types:

  | Y \ X       | Continuous   | Categorical |
  |-------------|--------------|-------------|
  | Continuous  | Bivariate    | Oneway      |
  | Categorical | Logistic     | Contingency |

  - **Bivariate**: linear and quadratic fits with confidence bands, ANOVA, parameter
    estimates and correlation.
  - **Oneway**: ANOVA with means diamonds, Welch t test, box plots, unequal-variance tests,
    Kruskal-Wallis, and Tukey HSD.
  - **Contingency**: mosaic plot, crosstab, likelihood-ratio and Pearson χ², and Fisher's
    exact test.
  - **Logistic**: binary, nominal or ordinal. Shows the logistic plot, the whole-model
    test, parameter estimates and odds ratios.
- **Fit Model**: models with several effects (main effects, crosses, polynomial terms and
  macros such as Response Surface).
  - **Standard least squares**:
    - Actual by predicted plot, summary of fit, ANOVA, lack of fit, parameter estimates
      and effect tests.
    - Residual plot, LS means and an interactive **prediction profiler**.
    - Aliased terms are detected and reported instead of failing.
  - **Stepwise**: forward, backward or mixed selection.
  - **Logistic**: used for categorical responses, with effect likelihood-ratio tests.
  - **Saving results**: save predicted values, residuals, or the prediction formula as
    new columns.
- **Control Chart**: I-MR, X̄-R, X̄-S, P, NP, C and U charts.
  - Subgroups come from a column or a fixed size.
  - Limits vary per point when subgroup or sample sizes vary.
  - Nelson tests 1–8 flag points; zone lines are optional.
  - A limit summary table is included.
- **Process Capability**: Cp, Cpk, Cpm, Pp and Ppk with confidence intervals, within and
  overall sigma, a stability index, observed and expected nonconformance, and a histogram
  with the spec limits drawn on it.

### Design of experiments
- **Design types**: full factorial; screening (fractional factorial with generators and
  alias structure); response surface (central composite or Box-Behnken); and custom
  designs, which are D-optimal for a model you choose.
- **Run options**: replicates, center points, and randomized run order with an optional
  seed.
- **Diagnostics**: design efficiencies (D, A, G) and average prediction variance.
- **The design table**: *Make Table* opens the design as a new table, with a Pattern
  column and empty response columns. The design's model is saved with the table, so
  *Fit Model* opens with it already filled in.

### Graph Builder
- **Zones**: drag columns onto X, Y, Overlay, **Group X** and **Group Y** (faceted
  panels with shared axes).
- **Elements**: combine points, smoother, line of fit, line, bar, box plot and histogram.

## Running it

You need Python ≥ 3.11 with [uv](https://docs.astral.sh/uv/), and Node ≥ 20.

**Development** (two terminals, with hot reload):

```bash
cd backend && uv sync && uv run uvicorn app.main:app --reload --port 8000
cd frontend && npm install && npm run dev        # http://localhost:5173
```

**Single process** (FastAPI serves the built frontend):

```bash
cd frontend && npm install && npm run build
cd ../backend && uv sync && uv run uvicorn app.main:app --port 8000   # http://localhost:8000
```

## Tests

```bash
cd backend && uv run pytest          # API; numbers checked against scipy/statsmodels and textbook values; DOE; degenerate data
cd frontend && npm test              # store and undo, formulas, model evaluation, sessions, CSV, Graph Builder, client-side stats
cd frontend && npm run typecheck
```

## Architecture

```
frontend/ (React + TypeScript + Plotly)          backend/ (FastAPI + numpy/scipy/statsmodels)
  tables, row states, formulas, undo ── POST /api/analyze {y, x, roles, params, values} ──▶ analyses/
  plots drawn from local data        ◀── report: outlines, tables, plot specs ───────────   report.py
  DOE dialog                         ── POST /api/doe {factors, design, ...} ────────────▶ doe.py
```

- **The backend is stateless.** The browser owns the data tables, so editing, formulas,
  undo and sessions all live in the frontend. Each analysis request carries the values it
  needs (non-excluded rows only). Uploads are parsed server-side and returned as columns.
- **Reports are data.** An analysis returns a tree of generic nodes (outline, table,
  summary, text, crosstab, plot). The frontend renders any report without knowing which
  analysis produced it.
  - The contract is defined in `backend/app/schemas.py` and mirrored in
    `frontend/src/api/types.ts`.
  - The `AnalyzeRequest` docstring lists the roles and params each platform reads.
- **Plots are drawn from local data.** Plot specs carry only summary geometry: fitted
  curves, bins, limits, cell counts and model coefficients. Points that the backend
  computes (residuals, control chart statistics) carry indices back to table rows. This
  is what lets selection link every view without a round trip.
- **Columns have stable ids.** Reports refer to columns by id, so renaming a column never
  breaks an open report. Formulas refer to columns by name and are rewritten on rename.

```
backend/app/
  main.py                    routes; serves frontend/dist when built
  schemas.py                 API contract
  io.py, samples.py          upload parsing, synthetic sample data
  analyses/                  distribution, bivariate, oneway, contingency, logistic,
                             fit_model, control_chart, capability, spc (shared SPC helpers)
  doe.py, doe_designs.py     design construction, D-optimal search, diagnostics
frontend/src/
  state/store.ts             tables, row states, undo history, reports, dialogs (zustand)
  lib/formula/               formula parser, evaluator, dependency ordering
  lib/model.ts               evaluates fitted models (profiler, saved predictions)
  lib/session.ts, csv.ts     .sift sessions, autosave, CSV export
  components/                data grid, dialogs, report renderer, Plotly wrapper
  plots/                     linked plots for each report plot spec
  platforms/                 Distribution, Fit Y by X, Fit Model, quality, DOE, Graph Builder
```

## Not yet supported

- Maps in Graph Builder (these need geographic boundary data).
- Fit Model:
  - Nested effects.
  - JMP's ordinal factor coding; ordinal factors use the same coding as nominal ones.
  - Save actions for logistic models.
- DOE: blocking, and Box-Behnken designs for more than 7 factors.
