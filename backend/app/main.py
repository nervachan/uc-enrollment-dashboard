"""UC Enrollment Geography Dashboard — API.

Serves aggregates and map geometry for University of the Cordilleras enrollment data.
Counts are recomputed from the enrollment extract, never read from the pre-joined
columns in the source GeoPackages; docs/DATA-AUDIT.md explains why.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import apply_schema, close_pool, get_pool
from .routers import geo, ingest, meta, summary

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail fast if the database is unreachable, and create the schema so a fresh
    # deployment answers /api/health with zero rows instead of a missing-table error.
    with get_pool().connection() as conn:
        apply_schema(conn)
    yield
    close_pool()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="UC Enrollment Geography Dashboard API",
        version="1.0.0",
        description=__doc__,
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    app.include_router(meta.router)
    app.include_router(summary.router)
    app.include_router(geo.router)
    app.include_router(ingest.router)
    return app


app = create_app()
