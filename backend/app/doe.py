"""Design of experiments: full factorial, fractional factorial, response surface and custom designs."""

from __future__ import annotations

from .schemas import DoeRequest, DoeResult


class DoeError(ValueError):
    """The design request cannot be satisfied (bad factors, too few runs, ...)."""


def make_design(req: DoeRequest) -> DoeResult:
    raise DoeError("Design of experiments is not implemented yet.")
