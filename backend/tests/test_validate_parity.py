"""The CLI's validator against the cases the upload path's TypeScript port is tested on.

supabase/functions/_shared/validate.cases.json was generated from this validator; this
test fails if the Python side changes without the cases (and so the port) following.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.validate import HeaderError, check_header, normalise_row

CASES = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "supabase" / "functions" / "_shared" / "validate.cases.json"
    ).read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", CASES["rows"], ids=[c["name"] for c in CASES["rows"]])
def test_row_cases(case):
    row, rejection = normalise_row(case["raw"], case["row_number"], case["include_sensitive"])
    if "reason" in case["expect"]:
        assert row is None
        assert rejection.reason == case["expect"]["reason"]
    else:
        assert rejection is None
        assert row == case["expect"]["row"]


@pytest.mark.parametrize("case", CASES["headers"], ids=[c["name"] for c in CASES["headers"]])
def test_header_cases(case):
    if "error" in case["expect"]:
        with pytest.raises(HeaderError, match=re.escape(case["expect"]["error"])):
            check_header(case["header"])
    else:
        assert check_header(case["header"]) == case["expect"]["ignored"]
