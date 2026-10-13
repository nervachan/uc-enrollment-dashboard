"""Application settings, read from the environment (see .env.example)."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://uc:ucdash@localhost:5432/uc_enrollment"
    cors_origins: str = "http://localhost:5173"
    # Guards the ingest endpoint. Blank disables ingest over HTTP entirely, which is the
    # correct setting until the upload screen exists and has a real auth story.
    ingest_api_key: str = ""
    # Largest upload accepted by /api/ingest, in megabytes.
    max_upload_mb: int = 128
    # Simplification tolerance in degrees for /api/geo responses.
    geojson_tolerance: float = 0.005

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
