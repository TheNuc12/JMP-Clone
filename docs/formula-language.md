# Formula language

Formula columns compute their values from other columns, row by row. The syntax is close to
JMP's formula language.

## Values

| Syntax | Meaning |
|---|---|
| `12`, `1.5`, `2e-3` | numbers |
| `"text"` | strings (`\"` and `\\` escape) |
| `.` | missing value (a lone dot, not followed by a digit) |
| `:height` | the current row's value of column `height` |
| `:"Body mass index"` | column reference for names that are not plain identifiers (`[A-Za-z_][A-Za-z0-9_]*`) |

## Operators (highest precedence first)

| Operator | Meaning |
|---|---|
| `( )` | grouping |
| `^` | power (right associative) |
| `-x`, `!x` | negation, logical not |
| `*` `/` | multiply, divide |
| `+` `-` | add, subtract |
| `\|\|` | string concatenation |
| `==` `!=` `<` `<=` `>` `>=` | comparisons (return 1 or 0) |
| `&` | logical and |
| `\|` | logical or |

Arithmetic and comparisons with a missing operand give missing, as do results that aren't
finite numbers (`1 / 0`, `Sqrt(-1)`). Arithmetic on text gives missing.

- **Comparisons** work between two numbers or two strings (strings compare
  lexicographically). A number never equals a string: `==` gives 0 and `!=` gives 1, and
  ordering comparisons between them give missing.
- **Logical operators** treat non-zero numbers as true and use three-valued logic:
  `. & 0` is 0, `. & 1` is missing, `. | 1` is 1, `. | 0` is missing, and `!.` is missing.
- **`||`** joins text forms, treating a missing side as empty. Both sides missing gives
  missing. Numbers print without floating point noise, so `0.1 + 0.2 || ""` is `"0.3"`.
- An **empty string result** counts as missing.

## Functions

Function names ignore case and spaces: `Col Mean(:x)`, `colmean(:x)` and `ColMean(:x)` are
the same function.

- **Math**: `Abs`, `Sqrt`, `Exp`, `Log(x, base = e)`, `Log10`, `Power(x, y)`,
  `Round(x, digits = 0)`, `Floor`, `Ceiling`, `Modulo(a, b)`, `Pi()`.
  - `Round` rounds half away from zero; negative `digits` round to tens, hundreds, and so on.
  - `Modulo` takes the sign of `a`, so `Modulo(-7, 3)` is -1; `Modulo(x, 0)` is missing.
- **Across arguments**: `Min(...)`, `Max(...)`, `Sum(...)`, `Mean(...)`. These ignore
  missing values.
- **Conditionals**:
  - `If(cond1, value1, cond2, value2, ..., else)`: the first true condition wins. A missing
    condition counts as false, and the result is missing when there is no `else`.
  - `Match(x, v1, r1, v2, r2, ..., else)`: compares `x` with each `v` (a missing `x`
    matches a `.` value), and is missing when nothing matches and there is no `else`.
  - Only the chosen branch of `If` and `Match` is evaluated.
  - `Is Missing(x)`: returns 1 or 0.
- **Rows**: `Row()` (1-based), `N Rows()`, and `Lag(x, n = 1)`, the value of `x` evaluated
  `n` rows earlier (missing before the first row). A negative `n` looks ahead.
- **Column statistics** are computed over all rows. An optional by-column computes the
  statistic within groups, e.g. `Col Mean(:weight, :sex)`. The functions are `Col Mean`,
  `Col Std Dev`, `Col Sum`, `Col Min`, `Col Max`, `Col Median`, `Col N` (non-missing count).
  - Rows with a missing by-value form their own group.
  - Row states (selected, excluded) don't affect these statistics.
  - `Col Std Dev` is the sample standard deviation.
- **Strings**:
  - `Concat(...)`, `Uppercase`, `Lowercase`, `Trim`, `Length`.
  - `Substr(s, start, length)` is 1-based.
  - `Contains(s, part)` returns the 1-based position, or 0 when not found.
  - `Word(n, s, separators = " ")`.
  - `Char(x)` converts a number to a string; `Num(s)` converts a string to a number
    (missing if it doesn't parse).
- **Random**: `Random Uniform(min = 0, max = 1)`, `Random Normal(mean = 0, sd = 1)`,
  `Random Integer(min, max)`. Values are seeded per row and per formula, so they stay the
  same across recalculations.

## Result type

A formula column is numeric when every non-missing result is a number, and character
otherwise. A formula column that turns character becomes nominal if it was continuous.

## Errors

- A parse error, an unknown column or function, a wrong argument count, or a circular
  reference between formula columns sets the column's `formulaError`, and all its values
  become missing.
- Formula columns may use other formula columns; they are evaluated in dependency order.
- A formula can't refer to its own column, even inside `Lag`.
- Renaming a column rewrites references to it in every formula.

## Building formulas in code

`formulaRef(name)` in `frontend/src/lib/formula` returns the reference syntax for a column
name. The same module exports:
- `checkFormula`, which validates a formula and returns a preview, for editors.
- `evaluateFormula`, which evaluates against a set of columns.
- `FUNCTIONS`, the function catalog.

Fit Model's *Save Prediction Formula* uses `formulaRef` with `Match` to write effect-coded
predictions, for example:

```
120.3 + 3.71 * (:height - 62.55) + -4.2 * Match(:sex, "F", 1, "M", -1, 0)
```
