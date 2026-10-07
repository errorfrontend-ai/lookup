"""The workers' settings, read once from the environment and checked before anything starts.

A problem stops the worker with a message that names the setting and never prints its value. The
worker refuses to start if it is given storage credentials: it must only ever download through the
short-lived address each ingest job carries.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit

WORKER_DATABASE_ROLE = "lookup_fingerprint_worker"
LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")
# Anything that looks like a storage or cloud credential (the API's names and the usual SDK ones).
STORAGE_CREDENTIAL_NAMES = re.compile(r"^(OBJECT_STORAGE_|AWS_|R2_|S3_|MINIO_)")


class SettingsError(Exception):
    """Names what is wrong with the settings, never their values."""


@dataclass(frozen=True)
class WorkerSettings:
    key_value_store_url: str
    fingerprint_database_url: str
    queue_key_prefix: str
    concurrency: int
    log_level: str


def load_settings(environment: Mapping[str, str] | None = None) -> WorkerSettings:
    environment = os.environ if environment is None else environment
    problems: list[str] = []

    def required(name: str) -> str:
        value = environment.get(name, "").strip()
        if not value:
            problems.append(f"{name} is missing")
        return value

    key_value_store_url = required("KEY_VALUE_STORE_URL")
    if key_value_store_url and urlsplit(key_value_store_url).scheme not in ("redis", "rediss"):
        problems.append("KEY_VALUE_STORE_URL must be a redis:// or rediss:// address")

    fingerprint_database_url = required("FINGERPRINT_DATABASE_URL")
    if fingerprint_database_url:
        address = urlsplit(fingerprint_database_url)
        if address.scheme not in ("postgresql", "postgres"):
            problems.append("FINGERPRINT_DATABASE_URL must be a postgresql:// address")
        elif address.username != WORKER_DATABASE_ROLE:
            problems.append(f"FINGERPRINT_DATABASE_URL must connect as {WORKER_DATABASE_ROLE}")

    queue_key_prefix = environment.get("QUEUE_KEY_PREFIX", "lookup").strip()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", queue_key_prefix):
        problems.append("QUEUE_KEY_PREFIX must be lowercase letters, digits and dashes")

    concurrency_text = environment.get("WORKER_CONCURRENCY", "2").strip()
    concurrency = int(concurrency_text) if concurrency_text.isdigit() else 0
    if not 1 <= concurrency <= 16:
        problems.append("WORKER_CONCURRENCY must be a whole number from 1 to 16")

    log_level = environment.get("LOG_LEVEL", "INFO").strip().upper()
    if log_level not in LOG_LEVELS:
        problems.append(f"LOG_LEVEL must be one of {', '.join(LOG_LEVELS)}")

    credential_names = sorted(name for name in environment if STORAGE_CREDENTIAL_NAMES.match(name))
    if credential_names:
        problems.append(f"the worker must not be given storage settings or credentials ({', '.join(credential_names)})")

    if problems:
        raise SettingsError("; ".join(problems))
    return WorkerSettings(key_value_store_url, fingerprint_database_url, queue_key_prefix, concurrency, log_level)
