"""Class breaks for the choropleth.

The numbers in these cases are the real ones from the SY2023–SY2026 extract, so a
regression here is a regression against data that actually exists.
"""

from __future__ import annotations

import pytest

from app.routers.geo import _log_breaks, _quantiles_are_degenerate


def test_country_level_quantiles_are_recognised_as_degenerate():
    # 32 countries have students; all but the Philippines (35,562) are in single or
    # double digits, so percentile_cont returns [1, 2, 4, 7].
    assert _quantiles_are_degenerate([1, 2, 4, 7], maximum=35562, classes=5) is True


def test_municipal_quantiles_are_kept():
    # 752 municipalities with students, Baguio City highest at 14,070. The quantiles
    # separate the data perfectly well and must not be thrown away.
    assert _quantiles_are_degenerate([160, 394, 785, 1100], maximum=14070, classes=5) is False


def test_collapsed_ties_disqualify_quantiles():
    """Repeated quantiles mean fewer classes than asked for."""
    assert _quantiles_are_degenerate([1, 2], maximum=900, classes=5) is True


def test_no_data_is_not_degenerate():
    assert _quantiles_are_degenerate([], maximum=0, classes=5) is False


def test_log_breaks_are_increasing_and_inside_the_range():
    breaks = _log_breaks(1, 35562, 5)
    assert breaks == sorted(set(breaks))
    assert all(0 < b <= 35562 for b in breaks)
    assert len(breaks) == 4


def test_log_breaks_separate_a_dominant_value():
    """The Philippines must end up alone in the top class, above China's 326."""
    breaks = _log_breaks(1, 35562, 5)
    assert breaks[-1] > 326
    assert breaks[-1] < 35562


@pytest.mark.parametrize("maximum", [1, 5, 10, 1000, 10_000_000])
def test_log_breaks_never_produce_a_zero_or_duplicate_stop(maximum):
    breaks = _log_breaks(1, maximum, 5)
    assert all(b > 0 for b in breaks)
    assert len(breaks) == len(set(breaks))
