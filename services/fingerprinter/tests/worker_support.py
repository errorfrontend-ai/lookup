"""Connection settings for the worker tests: the compose Valkey and Postgres, with the worker's own
database role. Values come from the environment, or else from the API's development settings file
(apps/api/.env), so the tests use exactly what a local worker would. Nothing here is skipped: with
the services down, these tests fail.
"""

from __future__ import annotations

import json
import os
import re
from functools import cache
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_SCHEMAS = REPOSITORY_ROOT / "packages" / "contracts" / "schemas"
CONTRACT_FIXTURES = REPOSITORY_ROOT / "packages" / "contracts" / "fixtures"


@cache
def api_development_settings() -> dict[str, str]:
    settings_file = REPOSITORY_ROOT / "apps" / "api" / ".env"
    settings: dict[str, str] = {}
    if settings_file.exists():
        for line in settings_file.read_text(encoding="utf-8").splitlines():
            name, separator, value = line.partition("=")
            if separator and not name.lstrip().startswith("#"):
                settings[name.strip()] = value.strip().strip('"').strip("'")
    return settings


def setting(name: str) -> str:
    value = os.environ.get(name) or api_development_settings().get(name)
    if not value:
        raise RuntimeError(f"{name} is not set (set it, or create apps/api/.env from apps/api/.env.example)")
    return value


def key_value_store_url() -> str:
    return setting("KEY_VALUE_STORE_URL")


def setup_database_url() -> str:
    """The local superuser connection the API's tests use to create and remove test data."""
    return setting("DATABASE_SETUP_URL")


def fingerprint_worker_database_url() -> str:
    address = urlsplit(setting("DATABASE_URL"))
    password = quote(setting("LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD"), safe="")
    host = address.hostname + (f":{address.port}" if address.port else "")
    return urlunsplit((address.scheme, f"lookup_fingerprint_worker:{password}@{host}", address.path, "", ""))


def contract_schema(file_name: str) -> dict:
    return json.loads((CONTRACT_SCHEMAS / file_name).read_text(encoding="utf-8"))


PYTHON_TYPES = {"string": (str,), "integer": (int,), "number": (int, float), "boolean": (bool,), "null": (type(None),)}


def _satisfies(field_value, declared: dict) -> bool:
    """One field against its declaration: the type (a yes/no value is never a number), the allowed
    values, and the lengths, bounds and pattern the contract sets."""
    if "anyOf" in declared:
        return any(_satisfies(field_value, option) for option in declared["anyOf"])
    if "type" in declared:
        if isinstance(field_value, bool) != (declared["type"] == "boolean"):
            return False
        if not isinstance(field_value, PYTHON_TYPES[declared["type"]]):
            return False
    if "enum" in declared and field_value not in declared["enum"]:
        return False
    if isinstance(field_value, str):
        return (declared.get("minLength", 0) <= len(field_value) <= declared.get("maxLength", len(field_value))
                and ("pattern" not in declared or re.search(declared["pattern"], field_value) is not None))
    if isinstance(field_value, (int, float)) and not isinstance(field_value, bool):
        return (field_value >= declared.get("minimum", field_value) and field_value <= declared.get("maximum", field_value)
                and ("exclusiveMinimum" not in declared or field_value > declared["exclusiveMinimum"]))
    return True


def assert_matches_contract(value: dict, file_name: str) -> None:
    """A small JSON Schema check for the job shapes (objects of plain fields): exactly the declared
    fields, the required ones present, each of its declared type, within its declared values, lengths,
    bounds and pattern. Formats are not checked. The full schema is checked on the Node side; this
    keeps the Python side from drifting from it."""
    schema = contract_schema(file_name)
    if "$ref" in schema:
        schema = schema["$defs"][schema["$ref"].rsplit("/", 1)[-1]]
    properties = schema["properties"]
    assert set(value) <= set(properties), f"fields the contract does not have: {set(value) - set(properties)}"
    assert set(schema.get("required", [])) <= set(value), f"missing fields: {set(schema.get('required', [])) - set(value)}"
    for name, field_value in value.items():
        assert _satisfies(field_value, properties[name]), f"{name}={field_value!r} does not fit {properties[name]}"


def contract_fixtures(folder: str) -> list[tuple[str, dict]]:
    """The shared fixture files in packages/contracts/fixtures/<folder>, as (name, contents), by name."""
    return [(path.stem, json.loads(path.read_text(encoding="utf-8"))) for path in sorted((CONTRACT_FIXTURES / folder).glob("*.json"))]
