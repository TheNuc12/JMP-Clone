"""Built-in sample data tables, generated deterministically from fixed random seeds."""

from __future__ import annotations

from functools import lru_cache
from typing import Callable

import numpy as np
import pandas as pd
from scipy.special import expit

from .io import dataframe_to_payload
from .schemas import DataTablePayload, ModelingType, SampleInfo

FIRST_NAMES = [
    "Ada", "Bryn", "Cal", "Dara", "Ezra", "Fen", "Gil", "Hana", "Ivo", "Juno",
    "Kai", "Lior", "Mila", "Nico", "Odette", "Pax", "Quin", "Rhea", "Soren", "Tova",
    "Uma", "Vance", "Wren", "Xavi", "Yara", "Zev", "Alba", "Bodhi", "Cleo", "Dov",
    "Elio", "Faye", "Grey", "Hollis", "Isla", "Jory", "Kit", "Lark", "Moss", "Nell",
]


def _students() -> tuple[pd.DataFrame, dict[str, ModelingType]]:
    rng = np.random.default_rng(1201)
    n = 40
    age = rng.integers(12, 18, size=n)
    sex = rng.choice(["F", "M"], size=n)
    male = sex == "M"
    growth = np.where(male, 2.3, 1.6)
    height = 56.5 + growth * (age - 12) + rng.normal(0, 2.6, size=n)
    weight = -125 + 3.75 * height + 5 * male + rng.normal(0, 11, size=n)
    df = pd.DataFrame(
        {
            "name": FIRST_NAMES[:n],
            "age": age,
            "sex": sex,
            "height": np.round(height, 1),
            "weight": np.round(weight, 1),
        }
    )
    return df, {"age": "ordinal"}


def _process() -> tuple[pd.DataFrame, dict[str, ModelingType]]:
    rng = np.random.default_rng(2024)
    n = 200
    machine = rng.choice(["A", "B", "C"], size=n)
    temperature = rng.normal(180, 8, size=n)
    pressure = rng.normal(30, 3, size=n)
    speed = rng.normal(120, 10, size=n)
    machine_effect = np.select([machine == "A", machine == "B"], [0.0, -2.5], default=1.5)
    yield_pct = (
        82
        + 0.3 * (temperature - 180)
        + 0.8 * (pressure - 30)
        - 0.05 * (speed - 120)
        + machine_effect
        + rng.normal(0, 2, size=n)
    )
    yield_pct = np.minimum(yield_pct, 100)
    p_fail = expit(-2.2 + 0.18 * (temperature - 180))
    defect = np.where(rng.random(size=n) < p_fail, "Fail", "Pass")
    df = pd.DataFrame(
        {
            "batch": np.repeat(np.arange(1, 21), 10),
            "machine": machine,
            "operator": rng.choice(["Dana", "Eli", "Fran", "Gus"], size=n),
            "shift": rng.choice(["Day", "Night"], size=n, p=[0.6, 0.4]),
            "temperature": np.round(temperature, 1),
            "pressure": np.round(pressure, 2),
            "speed": np.round(speed, 1),
            "yield_pct": np.round(yield_pct, 2),
            "defect": defect,
        }
    )
    # A few missing measurements, as in real process data.
    df.loc[rng.choice(n, size=4, replace=False), "yield_pct"] = np.nan
    return df, {"batch": "ordinal"}


def _trial() -> tuple[pd.DataFrame, dict[str, ModelingType]]:
    rng = np.random.default_rng(77)
    n = 120
    treatment = np.repeat(["Placebo", "Low Dose", "High Dose"], n // 3)
    effect = np.select([treatment == "Placebo", treatment == "Low Dose"], [-2.0, -8.0], default=-14.0)
    bp_change = effect + rng.normal(0, 8, size=n)
    latent = -bp_change + rng.normal(0, 6, size=n)
    response = np.where(latent > 10, "Improved", np.where(latent < 0, "Worse", "Same"))
    df = pd.DataFrame(
        {
            "patient_id": [f"P{i:03d}" for i in range(1, n + 1)],
            "treatment": treatment,
            "age": rng.integers(35, 76, size=n),
            "sex": rng.choice(["F", "M"], size=n),
            "baseline_bp": np.round(rng.normal(150, 12, size=n), 1),
            "bp_change": np.round(bp_change, 1),
            "response": response,
        }
    )
    return df, {"response": "ordinal"}


SAMPLES: dict[str, tuple[str, str, Callable[[], tuple[pd.DataFrame, dict[str, ModelingType]]]]] = {
    "students": (
        "Students",
        "Age, sex, height and weight of 40 students. Try Fit Y by X of weight by height or sex.",
        _students,
    ),
    "process": (
        "Process",
        "200 production runs across three machines with temperature, pressure, speed, yield and defects.",
        _process,
    ),
    "trial": (
        "Trial",
        "Blood pressure change and response for 120 patients in a three-arm dose trial.",
        _trial,
    ),
}


@lru_cache(maxsize=None)
def get_sample(sample_id: str) -> DataTablePayload:
    name, _, build = SAMPLES[sample_id]
    df, overrides = build()
    return dataframe_to_payload(name, df, overrides)


def list_samples() -> list[SampleInfo]:
    out = []
    for sample_id, (name, description, _) in SAMPLES.items():
        payload = get_sample(sample_id)
        out.append(
            SampleInfo(
                id=sample_id,
                name=name,
                description=description,
                n_rows=payload.n_rows,
                n_cols=len(payload.columns),
            )
        )
    return out
