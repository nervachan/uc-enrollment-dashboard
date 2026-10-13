"""Loader settings, read from the environment (see .env.example)."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Supabase: the *session pooler* connection string (Connect -> Session pooler). It
    # works over IPv4; the direct connection is IPv6-only on the free plan.
    database_url: str = "postgresql://uc:ucdash@localhost:5432/uc_enrollment"
    # Simplification tolerance in degrees for the stored GeoJSON geometry.
    geojson_tolerance: float = 0.005


@lru_cache
def get_settings() -> Settings:
    return Settings()
