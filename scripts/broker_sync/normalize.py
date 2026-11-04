"""Cross-broker normalisation helpers.

Angel One, Dhan and Groww each spell status, side and timestamps differently.
Everything the sync writes goes through here so the website can query one
vocabulary regardless of which broker produced the row.
"""

from __future__ import annotations

import hashlib
import math
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sync_config import INDIA_TZ


# ---------------------------------------------------------------- status ----
# Normalised order statuses used everywhere downstream.
COMPLETE = "COMPLETE"
PARTIAL = "PARTIAL"
OPEN = "OPEN"
PENDING = "PENDING"
REJECTED = "REJECTED"
CANCELLED = "CANCELLED"
EXPIRED = "EXPIRED"
UNKNOWN = "UNKNOWN"

# Statuses that still have live exposure at the exchange.
LIVE_STATUSES = {OPEN, PENDING, PARTIAL}

_STATUS_MAP = {
    # Angel One
    "complete": COMPLETE,
    "rejected": REJECTED,
    "cancelled": CANCELLED,
    "canceled": CANCELLED,
    "cancelled after market order": CANCELLED,
    "open": OPEN,
    "open pending": PENDING,
    "modified": OPEN,
    "modify pending": PENDING,
    "modify validation pending": PENDING,
    "trigger pending": PENDING,
    "validation pending": PENDING,
    "put order req received": PENDING,
    "after market order req received": PENDING,
    # Dhan
    "transit": PENDING,
    "pending": PENDING,
    "confirm": OPEN,
    "part_traded": PARTIAL,
    "part traded": PARTIAL,
    "traded": COMPLETE,
    "expired": EXPIRED,
    "closed": COMPLETE,
    # Groww
    "new": PENDING,
    "acked": OPEN,
    "ack": OPEN,
    "approved": OPEN,
    "open_pending": PENDING,
    "trigger_pending": PENDING,
    "executed": COMPLETE,
    "completed": COMPLETE,
    "filled": COMPLETE,
    "cancellation_requested": PENDING,
    "modification_requested": PENDING,
    "cancelled_after_market_order": CANCELLED,
    "failed": REJECTED,
    "delivery_awaited": OPEN,
}


def normalise_status(value: Any) -> str:
    text = str(value or "").strip().lower().replace("-", "_")
    if not text:
        return UNKNOWN
    if text in _STATUS_MAP:
        return _STATUS_MAP[text]
    spaced = text.replace("_", " ")
    if spaced in _STATUS_MAP:
        return _STATUS_MAP[spaced]
    # Substring fallbacks keep an unseen broker spelling out of UNKNOWN.
    if "reject" in text or "fail" in text:
        return REJECTED
    if "cancel" in text:
        return CANCELLED
    if "expire" in text or "lapse" in text:
        return EXPIRED
    if "part" in text:
        return PARTIAL
    if "complete" in text or "execut" in text or "trade" in text or "fill" in text:
        return COMPLETE
    if "pending" in text or "transit" in text or "trigger" in text:
        return PENDING
    if "open" in text or "ack" in text or "confirm" in text:
        return OPEN
    return UNKNOWN


def normalise_side(value: Any) -> str | None:
    text = str(value or "").strip().upper()
    if not text:
        return None
    if text.startswith("B"):
        return "BUY"
    if text.startswith("S"):
        return "SELL"
    return text


def normalise_product(value: Any) -> str | None:
    text = str(value or "").strip().upper()
    if not text:
        return None
    # Carry-forward F&O has three names across the three brokers.
    if text in {"CARRYFORWARD", "NRML", "MARGIN", "NORMAL"}:
        return "NRML"
    if text in {"INTRADAY", "MIS"}:
        return "MIS"
    if text in {"DELIVERY", "CNC", "LONGTERM"}:
        return "CNC"
    return text


# ---------------------------------------------------------------- values ----
def to_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return None if isinstance(value, float) and not math.isfinite(value) else float(value)
    text = str(value).strip().replace(",", "")
    if not text or text.lower() in {"none", "null", "nan", "-", "na"}:
        return None
    try:
        parsed = float(text)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def to_int(value: Any) -> int | None:
    parsed = to_float(value)
    return None if parsed is None else int(round(parsed))


def first(payload: dict[str, Any], *keys: str) -> Any:
    """Return the first key present and non-empty. Broker payloads vary by field."""
    for key in keys:
        if key in payload:
            value = payload[key]
            if value not in (None, "", [], {}):
                return value
    return None


def first_float(payload: dict[str, Any], *keys: str) -> float | None:
    return to_float(first(payload, *keys))


def first_int(payload: dict[str, Any], *keys: str) -> int | None:
    return to_int(first(payload, *keys))


def first_text(payload: dict[str, Any], *keys: str) -> str | None:
    value = first(payload, *keys)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


# ------------------------------------------------------------ timestamps ----
_TS_FORMATS = (
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S.%f",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%d-%b-%Y %H:%M:%S",
    "%d-%b-%Y %H:%M",
    "%d-%m-%Y %H:%M:%S",
    "%d/%m/%Y %H:%M:%S",
    "%d%b%Y %H:%M:%S",
    "%H:%M:%S",
)

_DATE_FORMATS = (
    "%Y-%m-%d",
    "%d-%b-%Y",
    "%d%b%Y",
    "%d-%m-%Y",
    "%d/%m/%Y",
    "%Y%m%d",
    "%d-%b-%y",
    "%d%b%y",
)


def to_timestamp(value: Any, *, day: date | None = None) -> datetime | None:
    """Parse a broker timestamp into an aware IST datetime.

    Broker payloads mix ISO strings, ``dd-Mon-yyyy HH:MM:SS``, bare clock times
    (Angel One order book) and epoch milliseconds (Groww). A bare clock time is
    combined with ``day`` so an order still lands on the right trading date.
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=INDIA_TZ)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=INDIA_TZ)
    if isinstance(value, (int, float)):
        seconds = float(value)
        if seconds > 1e12:      # milliseconds
            seconds /= 1000.0
        elif seconds > 1e15:    # microseconds
            seconds /= 1_000_000.0
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc).astimezone(INDIA_TZ)
        except (OSError, OverflowError, ValueError):
            return None

    text = str(value).strip()
    if not text:
        return None
    if text.isdigit() and len(text) >= 10:
        return to_timestamp(int(text), day=day)

    iso_text = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(iso_text)
        return parsed.astimezone(INDIA_TZ) if parsed.tzinfo else parsed.replace(tzinfo=INDIA_TZ)
    except ValueError:
        pass

    for fmt in _TS_FORMATS:
        try:
            parsed = datetime.strptime(text, fmt)
        except ValueError:
            continue
        if fmt == "%H:%M:%S":
            base = day or datetime.now(tz=INDIA_TZ).date()
            parsed = datetime.combine(base, parsed.time())
        return parsed.replace(tzinfo=INDIA_TZ)
    return None


def to_date(value: Any) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.astimezone(INDIA_TZ).date() if value.tzinfo else value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text[:10] if fmt == "%Y-%m-%d" else text, fmt).date()
        except ValueError:
            continue
    parsed = to_timestamp(text)
    return parsed.date() if parsed else None


def today_ist() -> date:
    return datetime.now(tz=INDIA_TZ).date()


def trading_date(*candidates: Any, default: date | None = None) -> date:
    """Pick the first parseable date from a row, else today (IST)."""
    for candidate in candidates:
        parsed = to_date(candidate) if not isinstance(candidate, datetime) else candidate.date()
        if parsed:
            return parsed
    return default or today_ist()


def day_range(start: date, end: date, chunk_days: int):
    """Yield inclusive (from, to) date chunks so range requests stay small."""
    cursor = start
    step = timedelta(days=max(1, chunk_days) - 1)
    one_day = timedelta(days=1)
    while cursor <= end:
        stop = min(cursor + step, end)
        yield cursor, stop
        cursor = stop + one_day


# --------------------------------------------------------------- symbols ----
_MONTHS = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC"

# Brokers spell the same right in three ways: Angel One "CE"/"PE", Dhan
# "CALL"/"PUT" (and "NA" on non-derivative rows), Groww "CE"/"PE".
_OPTION_TYPE_MAP = {"CE": "CE", "C": "CE", "CALL": "CE", "PE": "PE", "P": "PE", "PUT": "PE"}


def normalise_option_type(value: Any) -> str | None:
    """Return CE, PE, or None. Dhan's "NA" filler must not survive as a value."""
    text = str(value or "").strip().upper()
    return _OPTION_TYPE_MAP.get(text)


# Angel One / Groww compact NSE form: RELIANCE28AUG253000CE.
# The year has to be pinned to two digits: a greedy \d{2,4} would swallow
# "2530" as the year and leave "00" as the strike.
_COMPACT_OPTION_RE = re.compile(
    rf"^(?P<underlying>[A-Z&\-]+?)"
    rf"(?P<day>\d{{1,2}})(?P<month>{_MONTHS})(?P<year>\d{{2}})"
    rf"(?P<strike>\d+(?:\.\d+)?)(?P<option_type>CE|PE)$"
)
_COMPACT_FUT_RE = re.compile(
    rf"^(?P<underlying>[A-Z&\-]+?)"
    rf"(?P<day>\d{{1,2}})(?P<month>{_MONTHS})(?P<year>\d{{2,4}})FUT$"
)

# Dhan tradingSymbol: DRREDDY-Aug2026-1170-CE / DRREDDY-Aug2026-FUT.
_HYPHEN_OPTION_RE = re.compile(
    rf"^(?P<underlying>[A-Z0-9&]+)-(?P<month>{_MONTHS})(?P<year>\d{{4}})"
    rf"-(?P<strike>\d+(?:\.\d+)?)-(?P<option_type>CE|PE|CALL|PUT)$"
)
_HYPHEN_FUT_RE = re.compile(rf"^(?P<underlying>[A-Z0-9&]+)-(?P<month>{_MONTHS})(?P<year>\d{{4}})-FUT$")

# Dhan customSymbol: "BAJFINANCE 25 AUG 1100 PUT".
_SPACED_OPTION_RE = re.compile(
    rf"^(?P<underlying>[A-Z0-9&]+)\s+(?P<day>\d{{1,2}})\s+(?P<month>{_MONTHS})"
    rf"\s+(?P<strike>\d+(?:\.\d+)?)\s+(?P<option_type>CE|PE|CALL|PUT)$"
)
_SPACED_FUT_RE = re.compile(
    rf"^(?P<underlying>[A-Z0-9&]+)\s+(?P<day>\d{{1,2}})\s+(?P<month>{_MONTHS})\s+FUT(?:URE)?$"
)

_BLANK_CONTRACT: dict[str, Any] = {
    "underlying": None, "instrument_type": None, "option_type": None,
    "strike": None, "expiry_date": None,
}


def parse_contract(tradingsymbol: Any) -> dict[str, Any]:
    """Best-effort split of a derivative trading symbol across broker formats.

    Only returns what the symbol actually proves. The hyphenated and spaced
    forms carry no full expiry date (month+year, or day+month, but never all
    three), so ``expiry_date`` stays None for those rather than being guessed --
    Dhan supplies ``drvExpiryDate`` explicitly and that is the value to trust.
    """
    raw = str(tradingsymbol or "").strip().upper()
    if not raw:
        return dict(_BLANK_CONTRACT)
    collapsed = " ".join(raw.split())
    compact = collapsed.replace(" ", "")

    match = _COMPACT_OPTION_RE.match(compact)
    if match:
        return {
            "underlying": match.group("underlying"),
            "instrument_type": "OPT",
            "option_type": normalise_option_type(match.group("option_type")),
            "strike": to_float(match.group("strike")),
            "expiry_date": _expiry_from_parts(match.group("day"), match.group("month"), match.group("year")),
        }

    match = _COMPACT_FUT_RE.match(compact)
    if match:
        return {
            **_BLANK_CONTRACT,
            "underlying": match.group("underlying"),
            "instrument_type": "FUT",
            "expiry_date": _expiry_from_parts(match.group("day"), match.group("month"), match.group("year")),
        }

    for pattern in (_HYPHEN_OPTION_RE, _SPACED_OPTION_RE):
        match = pattern.match(collapsed)
        if match:
            return {
                **_BLANK_CONTRACT,
                "underlying": match.group("underlying"),
                "instrument_type": "OPT",
                "option_type": normalise_option_type(match.group("option_type")),
                "strike": to_float(match.group("strike")),
            }

    for pattern in (_HYPHEN_FUT_RE, _SPACED_FUT_RE):
        match = pattern.match(collapsed)
        if match:
            return {**_BLANK_CONTRACT, "underlying": match.group("underlying"), "instrument_type": "FUT"}

    if compact.endswith("-EQ"):
        return {**_BLANK_CONTRACT, "underlying": compact[:-3], "instrument_type": "EQ"}

    # Unrecognised layout: take the leading alphabetic run as the underlying
    # rather than storing the whole decorated symbol as if it were one.
    leading = re.match(r"^[A-Z&]+", collapsed)
    return {**_BLANK_CONTRACT, "underlying": leading.group(0) if leading else None}


def _expiry_from_parts(day: str, month: str, year: str) -> date | None:
    full_year = int(year) if len(year) == 4 else 2000 + int(year)
    try:
        return datetime.strptime(f"{int(day):02d}{month}{full_year}", "%d%b%Y").date()
    except ValueError:
        return None


def enrich_contract(row: dict[str, Any], tradingsymbol: Any) -> dict[str, Any]:
    """Fill missing contract fields on ``row`` from the trading symbol.

    Explicit broker fields always win; this only fills gaps. It also normalises
    an option type the broker did supply, so "CALL" and "NA" never reach the
    database.
    """
    row["option_type"] = normalise_option_type(row.get("option_type"))
    parsed = parse_contract(tradingsymbol)
    for key, value in parsed.items():
        if row.get(key) in (None, ""):
            row[key] = value
    return row


# ------------------------------------------------------------------ uids ----
def stable_uid(*parts: Any) -> str:
    """Deterministic key so a re-sync updates rather than duplicates.

    Readable when the parts are short, hashed when they are not, so a primary
    key never blows past the index size limit on a long narration string.
    """
    cleaned = [str(part).strip() for part in parts if part not in (None, "")]
    joined = "|".join(cleaned)
    if len(joined) <= 160 and "\n" not in joined:
        return joined
    digest = hashlib.sha1(joined.encode("utf-8")).hexdigest()
    return f"{cleaned[0] if cleaned else 'row'}|{digest}"
