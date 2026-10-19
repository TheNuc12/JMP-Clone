# Sift

Interactive statistical discovery in the browser, inspired by desktop tools like JMP.
Sift is an independent project and is not affiliated with SAS Institute or JMP.

Open a data table, run analyses, and explore: **every graph and table is linked**, so
selecting rows anywhere (a histogram bar, a brushed region of a scatter plot, a mosaic cell,
rows in the data grid) highlights them everywhere.

## Features

- **Data table**: open CSV / TSV / Excel files or the built-in samples. A virtualized grid
  handles large tables. Columns have a *modeling type* (continuous, ordinal, nominal) that
  decides how they are analyzed. Click a column's icon to change it.
- **Row states**: select rows by clicking, shift-clicking or dragging, then exclude them
  from every analysis with *Rows › Exclude / Unexclude*.
- **Analyze › Distribution**: histogram with outlier box plot and mean diamond, quantiles,
  summary statistics, and a fitted normal with Shapiro-Wilk goodness of fit. Categorical
  columns get bar charts and frequency tables.
- **Analyze › Fit Y by X**: the analysis follows the modeling types:

  | Y \ X       | Continuous   | Categorical |
  |-------------|--------------|-------------|
  | Continuous  | Bivariate    | Oneway      |
  | Categorical | Logistic     | Contingency |

  - **Bivariate**: linear and quadratic fits with confidence bands, ANOVA, parameter
    estimates and correlation.
  - **Oneway**: ANOVA with means diamonds, Welch t test, box plots, unequal-variance tests
    (Levene, Brown-Forsythe, Bartlett, Welch), Kruskal-Wallis, and Tukey HSD.
  - **Contingency**: mosaic plot, crosstab with Total/Col/Row %, likelihood-ratio and
    Pearson χ², and Fisher's exact test for 2×2 tables.
  - **Logistic**: binary, nominal or ordinal (cumulative logit). Shows the logistic plot,
    the whole-model test, parameter estimates and odds ratios.

  Red-triangle menus on each report toggle extra output.
- **Graph › Graph Builder**: drag columns onto X, Y and Overlay, then combine elements
  (points, smoother, line of fit, line, bar, box plot, histogram).

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
cd backend && uv run pytest          # API, numerical checks against scipy/statsmodels, degenerate data
cd frontend && npm test              # level ordering, formatting, client-side stats, Graph Builder
cd frontend && npm run typecheck
```

## Architecture

```
frontend/ (React + TypeScript + Plotly)          backend/ (FastAPI + numpy/scipy/statsmodels)
  data table, row states, selection  ── POST /api/analyze {y, x, options, values} ──▶  analyses/
  plots drawn from local data        ◀── report: outlines, tables, plot specs ───────   report.py
```

- **The backend is stateless.** The browser owns the data table and sends the values an
  analysis needs (non-excluded rows only) with each request. Uploads are parsed server-side
  and returned as columns.
- **Reports are data.** An analysis returns a tree of generic nodes (outline, table, summary,
  text, crosstab, plot). The frontend renders any report without knowing which analysis
  produced it, so a new analysis is mostly backend work. The contract is defined in
  `backend/app/schemas.py` and mirrored in `frontend/src/api/types.ts`.
- **Plots are drawn from local data.** Plot specs carry only summary geometry: fitted curves,
  bins, box statistics and cell counts. The frontend draws the points itself, which is what
  lets selection link every view without a round trip.

```
backend/app/
  main.py              routes; serves frontend/dist when built
  schemas.py           API contract
  io.py, samples.py    upload parsing, synthetic sample data
  analyses/            distribution, bivariate, oneway, contingency, logistic
frontend/src/
  state/store.ts       data table, selected/excluded rows, open reports (zustand)
  components/          data grid, columns panel, launch dialog, report renderer, Plotly wrapper
  plots/               linked plots for each report plot spec
  platforms/           Distribution / Fit Y by X reports, Graph Builder
```

## Roadmap

- Fit Model (multiple regression, ANOVA with several factors, stepwise)
- Control charts and process capability
- Design of experiments (full factorial, custom/D-optimal designs)
- Column properties such as value ordering, formula columns, and data editing in the grid
- Saving and reopening a session (table + row states + reports)
- Graph Builder: Group X / Group Y faceting and maps
