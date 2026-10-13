"""Upload endpoints.

The upload *screen* is a later phase; the endpoints exist now so the CLI loader and the
future form share one validation path instead of growing two. Two routes:

    POST /api/ingest/validate   dry run — parses, validates, writes nothing
    POST /api/ingest            validates and loads, inside one transaction

Both require X-API-Key. With INGEST_API_KEY unset the routes return 503, which is the
right default for a deployment whose auth story is not finished.
"""

from __future__ import annotations

import hashlib
import io
from typing import Annotated

from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile
from psycopg import Connection

from ..config import get_settings
from ..db import get_conn
from ..etl.enrollments import load_stream, validate_stream
from ..validate import HeaderError

router = APIRouter(prefix="/api/ingest", tags=["ingest"])

Conn = Annotated[Connection, Depends(get_conn)]


def require_api_key(x_api_key: Annotated[str | None, Header()] = None) -> None:
    configured = get_settings().ingest_api_key
    if not configured:
        raise HTTPException(503, "ingest is disabled: INGEST_API_KEY is not set")
    if x_api_key != configured:
        raise HTTPException(401, "invalid or missing X-API-Key")


async def _read_upload(file: UploadFile) -> tuple[str, str]:
    limit = get_settings().max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"file exceeds {get_settings().max_upload_mb} MB")
    if not data:
        raise HTTPException(400, "file is empty")
    return data.decode("utf-8-sig", errors="replace"), hashlib.sha256(data).hexdigest()


@router.post("/validate", dependencies=[Depends(require_api_key)])
async def validate_upload(file: Annotated[UploadFile, File()]) -> dict:
    """Parse and check a file without touching the database."""
    text, _ = await _read_upload(file)
    try:
        rows, report = validate_stream(io.StringIO(text))
    except HeaderError as exc:
        raise HTTPException(422, str(exc)) from exc
    for _ in rows:
        pass
    return {
        "filename": file.filename,
        "rows_read": report.rows_read,
        "rows_valid": report.rows_valid,
        "rows_rejected": report.rows_rejected,
        "ignored_columns": report.ignored_columns,
        "rejections": [
            {"row": r.row_number, "reason": r.reason} for r in report.rejections[:100]
        ],
    }


@router.post("", dependencies=[Depends(require_api_key)])
async def ingest(
    conn: Conn,
    file: Annotated[UploadFile, File()],
    note: Annotated[str | None, Header()] = None,
) -> dict:
    """Validate and load. Rows that already exist are skipped, not duplicated."""
    text, digest = await _read_upload(file)
    try:
        result = load_stream(
            conn, io.StringIO(text), filename=file.filename or "upload.csv",
            sha256=digest, note=note,
        )
    except HeaderError as exc:
        conn.rollback()
        raise HTTPException(422, str(exc)) from exc
    return {
        "batch_id": result.batch_id,
        "rows_read": result.report.rows_read,
        "rows_inserted": result.rows_inserted,
        "rows_duplicate": result.rows_duplicate,
        "rows_rejected": result.report.rows_rejected,
        "unmatched_municipalities": [
            {"municity": m, "province": p, "rows": n}
            for m, p, n in result.unmatched_municipality[:25]
        ],
    }
