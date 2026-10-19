"""Design construction and evaluation for DOE, all in coded units.

Continuous factors are coded so the low/high settings are -1/+1. Categorical factors are
stored as level indices (0, 1, ...). Model matrices use orthonormal contrasts for
categorical factors (balanced designs give X'X = nI), so efficiencies read like JMP's:
a full factorial scores 100.
"""

from __future__ import annotations

import itertools
import math
from collections import Counter
from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np


@dataclass(frozen=True)
class Factor:
    name: str
    kind: str  # "continuous" | "categorical"
    low: float = -1.0
    high: float = 1.0
    levels: tuple[str, ...] = ()

    @property
    def continuous(self) -> bool:
        return self.kind == "continuous"

    @property
    def n_levels(self) -> int:
        return 2 if self.continuous else len(self.levels)


@dataclass
class Runs:
    """Design runs in coded units plus a per-run pattern string."""

    coded: np.ndarray  # (n, k); categorical columns hold level indices
    patterns: list[str] = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.coded)

    def extend(self, other: Runs) -> Runs:
        return Runs(np.vstack([self.coded, other.coded]), self.patterns + other.patterns)

    def repeat(self, times: int) -> Runs:
        return Runs(np.vstack([self.coded] * times), self.patterns * times)


# ------------------------------------------------------------------------- patterns


def level_symbol(index: int) -> str:
    """Pattern symbol for a categorical level: 1-9, then A-Z."""
    digits = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return digits[index] if index < len(digits) else "?"


def pattern_of(row: np.ndarray, factors: list[Factor], alpha: float | None = None) -> str:
    """'-'/'+' for low/high, '0' for center, level symbols for categorical.

    Pass ``alpha`` for axial runs: their nonzero coordinate is written 'a'/'A'.
    """
    out = []
    for value, f in zip(row, factors):
        if not f.continuous:
            out.append(level_symbol(int(value)))
        elif abs(value) < 1e-9:
            out.append("0")
        elif alpha is not None and abs(abs(value) - alpha) < 1e-9:
            out.append("a" if value < 0 else "A")
        else:
            out.append("-" if value < 0 else "+")
    return "".join(out)


def make_runs(rows: list[list[float]] | np.ndarray, factors: list[Factor], alpha: float | None = None) -> Runs:
    coded = np.asarray(rows, dtype=float).reshape(-1, len(factors))
    return Runs(coded, [pattern_of(r, factors, alpha) for r in coded])


# ------------------------------------------------------------------- full factorial


def full_factorial(factors: list[Factor]) -> Runs:
    """Every combination; continuous factors at -1/+1, categorical at every level."""
    axes = [[-1.0, 1.0] if f.continuous else list(range(len(f.levels))) for f in factors]
    return make_runs([list(c) for c in itertools.product(*axes)], factors)


def center_points(factors: list[Factor], count: int) -> Runs:
    """Continuous factors at 0; categorical factors cycle through their level combinations."""
    cat_axes = [range(len(f.levels)) for f in factors if not f.continuous]
    combos = list(itertools.product(*cat_axes)) or [()]
    rows = []
    for i in range(count):
        combo = iter(combos[i % len(combos)])
        rows.append([0.0 if f.continuous else float(next(combo)) for f in factors])
    return make_runs(rows, factors) if rows else Runs(np.zeros((0, len(factors))), [])


# --------------------------------------------------------------- fractional factorial

# Minimum aberration generators (Montgomery, Design and Analysis of Experiments, Table 8.14).
# Base factors are the first letters; each generator defines one added factor.
_GENERATORS: dict[int, dict[int, list[str]]] = {
    3: {4: ["AB"]},
    4: {8: ["ABC"]},
    5: {8: ["AB", "AC"], 16: ["ABCD"]},
    6: {8: ["AB", "AC", "BC"], 16: ["ABC", "BCD"], 32: ["ABCDE"]},
    7: {8: ["AB", "AC", "BC", "ABC"], 16: ["ABC", "BCD", "ACD"], 32: ["ABCD", "ABDE"], 64: ["ABCDEF"]},
    8: {16: ["BCD", "ACD", "ABC", "ABD"], 32: ["ABC", "ABD", "BCDE"], 64: ["ABCD", "ABEF"], 128: ["ABCDEFG"]},
    9: {
        16: ["ABC", "BCD", "ACD", "ABD", "ABCD"],
        32: ["BCDE", "ACDE", "ABDE", "ABCE"],
        64: ["ABCD", "ACEF", "CDEF"],
        128: ["ACDFG", "BCEFG"],
    },
    10: {
        16: ["ABC", "BCD", "ACD", "ABD", "ABCD", "AB"],
        32: ["ABCD", "ABCE", "ABDE", "ACDE", "BCDE"],
        64: ["BCDF", "ACDF", "ABDE", "ABCE"],
        128: ["ABCG", "BCDE", "ACDF"],
    },
    11: {
        16: ["ABC", "BCD", "ACD", "ABD", "ABCD", "AB", "AC"],
        32: ["ABC", "BCD", "CDE", "ACD", "ADE", "BDE"],
        64: ["CDE", "ABCD", "ABF", "BDEF", "ADEF"],
        128: ["ABCG", "BCDE", "ACDF", "ABCDEFG"],
    },
}

MAX_FRACTIONAL_FACTORS = 15
FULL_RESOLUTION = 99  # stands in for "no aliasing"


def _word_mask(word: str) -> int:
    return sum(1 << (ord(ch) - ord("A")) for ch in word)


def _odd_words(m: int) -> list[int]:
    """Words of odd length >= 3 in m base factors; any subset gives a resolution IV design."""
    words = [mask for mask in range(1, 1 << m) if bin(mask).count("1") % 2 == 1 and bin(mask).count("1") >= 3]
    return sorted(words, key=lambda w: (bin(w).count("1"), w))


def _interaction_words(m: int) -> list[int]:
    """All interactions of m base factors, shortest first (saturated resolution III designs)."""
    words = [mask for mask in range(1, 1 << m) if bin(mask).count("1") >= 2]
    return sorted(words, key=lambda w: (bin(w).count("1"), w))


@dataclass(frozen=True)
class Fraction:
    k: int
    runs: int
    generators: tuple[int, ...]  # base-factor masks, one per added factor

    @property
    def m(self) -> int:
        return self.runs.bit_length() - 1

    @property
    def defining_words(self) -> list[int]:
        """All words of the defining relation, as factor bit masks."""
        gens = [g | (1 << (self.m + i)) for i, g in enumerate(self.generators)]
        words = []
        for r in range(1, len(gens) + 1):
            for combo in itertools.combinations(gens, r):
                w = 0
                for g in combo:
                    w ^= g
                words.append(w)
        return words

    @property
    def resolution(self) -> int:
        """Shortest word length of the defining relation; a full factorial aliases nothing."""
        words = self.defining_words
        return min(bin(w).count("1") for w in words) if words else FULL_RESOLUTION


@lru_cache(maxsize=None)
def fractions_for(k: int) -> tuple[Fraction, ...]:
    """Available 2-level designs for k factors, smallest first; the last is the full factorial."""
    out: list[Fraction] = []
    for runs, gens in sorted(_GENERATORS.get(k, {}).items()):
        out.append(Fraction(k, runs, tuple(_word_mask(g) for g in gens)))
    if k > 11:
        # Saturated 16-run resolution III and odd-word resolution IV designs.
        for m, pool in ((4, _interaction_words(4)), (5, _odd_words(5)), (6, _odd_words(6)), (7, _odd_words(7))):
            if len(pool) >= k - m:
                out.append(Fraction(k, 1 << m, tuple(pool[: k - m])))
    if k <= 12:
        out.append(Fraction(k, 1 << k, ()))
    return tuple(sorted(out, key=lambda f: f.runs))


def choose_fraction(k: int, resolution: int | None) -> Fraction:
    """Smallest design with at least the requested resolution (default: IV when possible)."""
    options = fractions_for(k)
    if not options:
        raise ValueError(f"Screening designs support 2 to {MAX_FRACTIONAL_FACTORS} factors.")
    wanted = resolution if resolution is not None else 4
    for f in options:
        if f.resolution >= wanted:
            return f
    if resolution is None:
        return options[0]
    raise ValueError(f"No design with resolution {roman(resolution)} is available for {k} factors.")


def fraction_runs(fraction: Fraction, factors: list[Factor]) -> Runs:
    base = np.array(list(itertools.product([-1.0, 1.0], repeat=fraction.m)))
    cols = [base[:, i] for i in range(fraction.m)]
    for g in fraction.generators:
        col = np.ones(len(base))
        for i in range(fraction.m):
            if g >> i & 1:
                col = col * base[:, i]
        cols.append(col)
    coded = np.column_stack(cols)
    # Two-level categorical factors: -1/+1 become level indices 0/1.
    for j, f in enumerate(factors):
        if not f.continuous:
            coded[:, j] = (coded[:, j] > 0).astype(float)
    return make_runs(coded, factors)


def roman(n: int) -> str:
    return {3: "III", 4: "IV", 5: "V", 6: "VI", 7: "VII", 8: "VIII", 9: "IX", 10: "X"}.get(n, str(n))


def word_name(mask: int, names: list[str]) -> str:
    return "*".join(names[i] for i in range(len(names)) if mask >> i & 1)


def alias_structure(fraction: Fraction, names: list[str]) -> list[tuple[str, str]]:
    """Alias groups for main effects and two-factor interactions (aliases up to order 2)."""
    words = fraction.defining_words
    k = fraction.k
    effects = [1 << i for i in range(k)] + [(1 << i) | (1 << j) for i in range(k) for j in range(i + 1, k)]
    seen: set[int] = set()
    rows: list[tuple[str, str]] = []
    for e in effects:
        if e in seen:
            continue
        aliases = sorted({e ^ w for w in words if bin(e ^ w).count("1") <= 2}, key=lambda a: (bin(a).count("1"), a))
        seen.add(e)
        seen.update(aliases)
        is_main = bin(e).count("1") == 1
        if is_main or aliases:
            rows.append((word_name(e, names), " = ".join(word_name(a, names) for a in aliases)))
    return rows


def generator_text(fraction: Fraction, names: list[str]) -> list[str]:
    return [f"{names[fraction.m + i]} = {word_name(g, names)}" for i, g in enumerate(fraction.generators)]


# --------------------------------------------------------------- response surface


# Center points for uniform precision CCDs (Myers & Montgomery).
CCD_CENTER_DEFAULT = {2: 5, 3: 6, 4: 7, 5: 6, 6: 9, 7: 14, 8: 20}
MAX_CCD_FACTORS = 8


def ccd_alpha(kind: str, k: int, n_factorial: int, n_center: int) -> float:
    if kind == "face_centered":
        return 1.0
    if kind == "orthogonal":
        t = 2 * k + n_center
        q = (math.sqrt(n_factorial + t) - math.sqrt(n_factorial)) ** 2
        return (q * n_factorial / 4) ** 0.25
    return n_factorial**0.25  # rotatable


def ccd(factors: list[Factor], alpha_kind: str, n_center: int) -> tuple[Runs, Runs, float, Fraction]:
    """Central composite design: (cube + axial runs, center runs, alpha, cube fraction)."""
    k = len(factors)
    cube_design = choose_fraction(k, 5)
    cube = fraction_runs(cube_design, factors)
    alpha = ccd_alpha(alpha_kind, k, len(cube), n_center)
    axial = []
    for i in range(k):
        for sign in (-1.0, 1.0):
            row = [0.0] * k
            row[i] = sign * alpha
            axial.append(row)
    star = make_runs(axial, factors, alpha)
    centers = make_runs([[0.0] * k for _ in range(n_center)], factors) if n_center else Runs(np.zeros((0, k)), [])
    return cube.extend(star), centers, alpha, cube_design


# Factor groupings for Box-Behnken designs: pairs for 3-5 factors, balanced incomplete
# block designs of size 3 for 6 and 7 factors (Box & Behnken, 1960).
_BBD_BLOCKS = {
    6: [(0, 1, 3), (1, 2, 4), (2, 3, 5), (0, 3, 4), (1, 4, 5), (0, 2, 5)],
    7: [(0, 1, 3), (1, 2, 4), (2, 3, 5), (3, 4, 6), (0, 4, 5), (1, 5, 6), (0, 2, 6)],
}
BBD_FACTORS = range(3, 8)


def box_behnken(factors: list[Factor]) -> Runs:
    k = len(factors)
    blocks = _BBD_BLOCKS.get(k) or list(itertools.combinations(range(k), 2))
    rows = []
    for block in blocks:
        for signs in itertools.product([-1.0, 1.0], repeat=len(block)):
            row = [0.0] * k
            for i, s in zip(block, signs):
                row[i] = s
            rows.append(row)
    return make_runs(rows, factors)


# -------------------------------------------------------------------- model matrix

Effect = tuple[int, ...]  # factor indices; a repeated index is a power


@lru_cache(maxsize=None)
def contrasts(n_levels: int) -> np.ndarray:
    """(n_levels, n_levels - 1) orthonormal contrasts scaled so each column has mean square 1."""
    effect = np.vstack([np.eye(n_levels - 1), -np.ones(n_levels - 1)])
    centered = effect - effect.mean(axis=0)
    q, _ = np.linalg.qr(centered)
    return q[:, : n_levels - 1] * math.sqrt(n_levels)


def effect_label(effect: Effect, factors: list[Factor]) -> str:
    return "*".join(factors[i].name for i in effect)


class ModelPlan:
    """Precomputed layout of a model matrix: intercept plus one block of columns per effect.

    Effects of continuous factors only are single columns computed together as products of
    powers; effects with categorical factors expand into contrast products.
    """

    def __init__(self, factors: tuple[Factor, ...], effects: tuple[Effect, ...]):
        self.factors = factors
        self.labels = ["Intercept"]
        exponents: list[list[int]] = []
        self.power_positions: list[int] = []
        self.blocks: list[tuple[int, Effect]] = []  # (first column, effect)
        for effect in effects:
            counts = Counter(effect)
            if all(factors[i].continuous for i in counts):
                self.power_positions.append(len(self.labels))
                exponents.append([counts.get(i, 0) for i in range(len(factors))])
                self.labels.append("*".join(factors[i].name for i in effect))
            else:
                self.blocks.append((len(self.labels), effect))
                names = [""]
                for index in counts:
                    f = factors[index]
                    part = ["*".join([f.name] * counts[index])] if f.continuous else [f"{f.name}[{j + 1}]" for j in range(len(f.levels) - 1)]
                    names = [f"{a}*{b}" if a else b for a in names for b in part]
                self.labels.extend(names)
        self.exponents = np.array(exponents, dtype=float).reshape(-1, len(factors))
        self.p = len(self.labels)

    def matrix(self, coded: np.ndarray) -> np.ndarray:
        n = len(coded)
        out = np.empty((n, self.p))
        out[:, 0] = 1.0
        if self.power_positions:
            # Categorical columns have exponent 0, so their level indices drop out.
            out[:, self.power_positions] = np.prod(coded[:, None, :] ** self.exponents[None, :, :], axis=2)
        for start, effect in self.blocks:
            block = np.ones((n, 1))
            for index, power in Counter(effect).items():
                f = self.factors[index]
                part = coded[:, [index]] ** power if f.continuous else contrasts(len(f.levels))[coded[:, index].astype(int)]
                block = np.einsum("ni,nj->nij", block, part).reshape(n, -1)
            out[:, start : start + block.shape[1]] = block
        return out


@lru_cache(maxsize=64)
def _plan(factors: tuple[Factor, ...], effects: tuple[Effect, ...]) -> ModelPlan:
    return ModelPlan(factors, effects)


def model_matrix(coded: np.ndarray, factors: list[Factor], effects: list[Effect]) -> tuple[np.ndarray, list[str]]:
    """Intercept plus one block of columns per effect (products of factor parts), with labels."""
    plan = _plan(tuple(factors), tuple(effects))
    return plan.matrix(np.asarray(coded, dtype=float).reshape(-1, len(factors))), plan.labels


def n_parameters(factors: list[Factor], effects: list[Effect]) -> int:
    total = 1
    for effect in effects:
        size = 1
        for index in set(effect):
            size *= 1 if factors[index].continuous else len(factors[index].levels) - 1
        total += size
    return total


# ------------------------------------------------------------------------ diagnostics


def _region_points(factors: list[Factor], continuous_levels: list[float], weights: list[float] | None, limit: int, rng: np.random.Generator):
    """Tensor grid over the design region (or a random sample when the grid is too big)."""
    axes = [continuous_levels if f.continuous else list(range(len(f.levels))) for f in factors]
    size = math.prod(len(a) for a in axes)
    if size <= limit:
        points = np.array(list(itertools.product(*axes)), dtype=float)
        if weights is None:
            return points, np.full(len(points), 1 / len(points))
        cont_w = dict(zip(continuous_levels, weights))
        w = np.ones(len(points))
        for j, f in enumerate(factors):
            w *= np.array([cont_w[v] for v in points[:, j]]) if f.continuous else 1 / len(f.levels)
        return points, w / w.sum()
    cols = []
    for f in factors:
        cols.append(rng.uniform(-1, 1, limit) if f.continuous else rng.integers(0, len(f.levels), limit).astype(float))
    return np.column_stack(cols), np.full(limit, 1 / limit)


@dataclass
class Diagnostics:
    d_efficiency: float
    a_efficiency: float
    g_efficiency: float
    average_variance: float


def diagnose(coded: np.ndarray, factors: list[Factor], effects: list[Effect]) -> Diagnostics | None:
    """JMP-style efficiencies over the cube [-1, 1]^k; None when the model is not estimable."""
    x, _ = model_matrix(coded, factors, effects)
    n, p = x.shape
    xtx = x.T @ x
    if n < p or np.linalg.matrix_rank(xtx) < p:
        return None
    inv = np.linalg.inv(xtx)
    sign, logdet = np.linalg.slogdet(xtx)
    d_eff = 100 * math.exp(logdet / p) / n
    a_eff = 100 * p / (n * np.trace(inv))
    rng = np.random.default_rng(0)
    # Moment matrix of the uniform region: 3-point Gauss-Legendre is exact for these degrees.
    nodes, gl_weights = np.polynomial.legendre.leggauss(3)
    grid, w = _region_points(factors, list(nodes), list(gl_weights), 20_000, rng)
    f, _ = model_matrix(grid, factors, effects)
    moments = f.T @ (f * w[:, None])
    avg_var = float(np.trace(moments @ inv))
    # Maximum prediction variance over a grid of the region plus the design points.
    grid, _ = _region_points(factors, [-1.0, -0.5, 0.0, 0.5, 1.0], None, 20_000, rng)
    grid = np.vstack([grid, coded])
    f, _ = model_matrix(grid, factors, effects)
    max_var = float(np.max(np.einsum("ij,jk,ik->i", f, inv, f)))
    g_eff = 100 * math.sqrt(p / n) / math.sqrt(max_var)
    return Diagnostics(d_eff, a_eff, min(g_eff, 100.0), avg_var)


def correlations(coded: np.ndarray, factors: list[Factor], effects: list[Effect]) -> tuple[list[str], np.ndarray]:
    """Absolute correlations between model terms (intercept excluded)."""
    x, labels = model_matrix(coded, factors, effects)
    x = x[:, 1:]
    with np.errstate(invalid="ignore", divide="ignore"):
        corr = np.corrcoef(x, rowvar=False) if x.shape[1] > 1 else np.ones((1, 1))
    # Round away floating point noise such as 2e-17.
    return labels[1:], np.round(np.abs(np.atleast_2d(corr)), 4) + 0.0


# ------------------------------------------------------------------ D-optimal design


def candidate_levels(factors: list[Factor], effects: list[Effect]) -> list[list[float]]:
    """{-1, 0, 1} for continuous factors in a power term, {-1, 1} otherwise; all levels for categorical."""
    squared = {i for e in effects for i, c in Counter(e).items() if c > 1}
    return [
        ([-1.0, 0.0, 1.0] if i in squared else [-1.0, 1.0]) if f.continuous else [float(j) for j in range(len(f.levels))]
        for i, f in enumerate(factors)
    ]


def _logdet(xtx: np.ndarray) -> float:
    sign, value = np.linalg.slogdet(xtx)
    return value if sign > 0 else -math.inf


def _random_start(levels: list[list[float]], n_runs: int, plan: ModelPlan, rng: np.random.Generator) -> np.ndarray:
    """A random design, preferring one whose information matrix is nonsingular."""
    design = np.column_stack([rng.choice(lv, size=n_runs) for lv in levels])
    for _ in range(20):
        x = plan.matrix(design)
        if np.linalg.matrix_rank(x) == plan.p:
            break
        design = np.column_stack([rng.choice(lv, size=n_runs) for lv in levels])
    return design


def coordinate_exchange(
    factors: list[Factor],
    effects: list[Effect],
    n_runs: int,
    rng: np.random.Generator,
    starts: int = 10,
    max_passes: int = 30,
) -> np.ndarray:
    """Maximize det(X'X) by changing one coordinate at a time, from several random starts.

    Each coordinate tries all of its candidate levels at once using Fedorov's delta,
    det(new) / det(old) = (1 + a)(1 - c) + b^2 with a = x_new' V x_new, c = x_old' V x_old,
    b = x_new' V x_old and V = (X'X)^-1, which is kept up to date with Sherman-Morrison.
    """
    plan = _plan(tuple(factors), tuple(effects))
    k, p = len(factors), plan.p
    levels = candidate_levels(factors, effects)
    # Big problems get fewer starts so the request stays interactive.
    work = n_runs * sum(len(lv) for lv in levels) * p * p
    budget = max(2, min(starts, int(2e7 / max(1, work))))
    best_design, best_value = None, -math.inf
    for _ in range(budget):
        design = _random_start(levels, n_runs, plan, rng)
        x = plan.matrix(design)
        xtx = x.T @ x
        # A small ridge keeps V finite if the start is singular; it fades once X'X is full rank.
        ridge = 0.0 if np.linalg.matrix_rank(xtx) == p else 1e-6 * max(1.0, np.trace(xtx) / p)
        v = np.linalg.inv(xtx + ridge * np.eye(p))
        for _ in range(max_passes):
            improved = False
            for i in range(n_runs):
                for j in range(k):
                    trial = np.repeat(design[i : i + 1], len(levels[j]), axis=0)
                    trial[:, j] = levels[j]
                    rows = plan.matrix(trial)
                    old = x[i]
                    v_old = v @ old
                    c = old @ v_old
                    v_rows = rows @ v
                    a = np.einsum("ij,ij->i", v_rows, rows)
                    b = v_rows @ old
                    delta = (1 + a) * (1 - c) + b * b
                    best = int(np.argmax(delta))
                    if delta[best] <= 1 + 1e-9 or trial[best, j] == design[i, j]:
                        continue
                    new = rows[best]
                    # V for X'X + new new' - old old' (two rank-one updates).
                    v_new = v @ new
                    v = v - np.outer(v_new, v_new) / (1 + new @ v_new)
                    v_old = v @ old
                    v = v + np.outer(v_old, v_old) / (1 - old @ v_old)
                    x[i] = new
                    design[i, j] = trial[best, j]
                    improved = True
            # Refresh V to keep rounding errors from accumulating.
            xtx = x.T @ x
            if ridge and np.linalg.matrix_rank(xtx) == p:
                ridge = 0.0
            v = np.linalg.inv(xtx + ridge * np.eye(p))
            if not improved:
                break
        value = _logdet(x.T @ x)
        if value > best_value:
            best_design, best_value = design.copy(), value
    assert best_design is not None
    return best_design
