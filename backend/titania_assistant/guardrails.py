"""Layered deterministic guardrails: input -> context -> output.

Input:  size, injection patterns, role validity, PII flags.
Output: protected-data leak scan, unsupported-info mapping, confidence gate,
        disclaimer enforcement on recommendation answers.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .config import settings
from .schemas import ChatRequest

# ---------------------------------------------------------------- input -----

_INJECTION_PATTERNS = [
    r"ignore (all|any|previous|prior|above) (instructions|rules|prompts)",
    r"disregard (your|the) (system|previous) (prompt|instructions)",
    r"you are now (dan|developer mode|jailbroken)",
    r"reveal (your|the) (system prompt|instructions|hidden rules)",
    r"print (your|the) (system|initial) prompt",
    r"act as if (you have|there are) no (rules|restrictions|guardrails)",
    r"pretend (the )?(rules|restrictions|guardrails) (don'?t|do not) apply",
    r"</?(system|assistant)>",
    r"\[/?INST\]",
]
_INJECTION_RE = [re.compile(p, re.IGNORECASE) for p in _INJECTION_PATTERNS]

# other users' data requests (cross-user confidential info)
_CROSS_USER_RE = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"(other|another|all) (users?|clients?|customers?)('|s)? (positions?|orders?|balances?|portfolios?|p&l|pnl|trades?)",
        r"show me (everyone|all accounts)",
        r"\b(show|list|dump|export|reveal)\b.*\b(every|all|other|another)\s+(client|customer|user)s?\s+(account|accounts|positions?|orders?|balances?|portfolios?|trades?)\b",
        r"(list|dump|export) (all )?(client|customer|user) (accounts?|data|details)",
        r"who (else|are the clients that) (holds?|owns?|trades?)",
    ]
]

_PII_RE = [
    re.compile(p)
    for p in [
        r"\b\d{3}-\d{2}-\d{4}\b",              # SSN-like
        r"\b(?:\d[ -]*?){13,19}\b",             # card-number-like
        r"\b[A-Z]{5}\d{4}[A-Z]\b",              # PAN (India)
    ]
]

_VALID_ROLES = {"external", "internal", "support"}


@dataclass
class InputVerdict:
    ok: bool
    reason: str = ""
    pii_detected: bool = False
    injection_detected: bool = False
    cross_user_request: bool = False


def check_input(req: ChatRequest) -> InputVerdict:
    msg = req.message or ""
    if not msg.strip():
        return InputVerdict(False, "empty_message")
    if len(msg) > settings.max_input_chars:
        return InputVerdict(False, f"input_too_large:{len(msg)}>{settings.max_input_chars}")
    if req.context.role not in _VALID_ROLES:
        return InputVerdict(False, "invalid_role")

    verdict = InputVerdict(True)
    for rx in _INJECTION_RE:
        if rx.search(msg):
            verdict.injection_detected = True
            verdict.ok = False
            verdict.reason = "prompt_injection"
            return verdict
    for rx in _CROSS_USER_RE:
        if rx.search(msg):
            verdict.cross_user_request = True  # handled as refusal downstream, not an error
    for rx in _PII_RE:
        if rx.search(msg):
            verdict.pii_detected = True
    return verdict


# --------------------------------------------------------------- output -----

# Patterns that must never appear in an answer (protected client / order-security data).
_LEAK_RE = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"api[_ -]?key\s*[:=]\s*\S+",
        r"password\s*[:=]\s*\S+",
        r"secret\s*[:=]\s*\S+",
        r"postgres(ql)?://\S+",
        r"bearer\s+[a-z0-9._-]{16,}",
        r"\b(account|acct)\s*(number|no\.?|#)\s*[:=]?\s*\d{6,}",
    ]
]

_HEDGE_RE = re.compile(
    r"\b(i'?m not (sure|certain)|i (don'?t|do not) (know|have)|cannot verify|might be wrong|as an ai)\b",
    re.IGNORECASE,
)


@dataclass
class OutputVerdict:
    ok: bool
    final_text: str
    reasons: list[str] = field(default_factory=list)
    unsupported: bool = False


def check_output(
    text: str,
    *,
    is_recommendation: bool,
    confidence: float,
) -> OutputVerdict:
    reasons: list[str] = []

    # A provider can return an empty completion after upstream safety filtering.
    # Never render that as if it were a grounded answer.
    if not text or not text.strip():
        return OutputVerdict(
            ok=False,
            final_text=settings.unsupported_message,
            reasons=["empty_provider_response"],
            unsupported=True,
        )

    # 1. leak scan — hard fail, replace entire answer
    for rx in _LEAK_RE:
        if rx.search(text):
            return OutputVerdict(
                ok=False,
                final_text=settings.unsupported_message,
                reasons=["protected_data_pattern"],
                unsupported=True,
            )

    # 2. confidence gate — below threshold maps to the approved unsupported message
    if confidence < settings.confidence_threshold:
        return OutputVerdict(
            ok=False,
            final_text=settings.unsupported_message,
            reasons=[f"low_confidence:{confidence:.2f}"],
            unsupported=True,
        )

    # 3. hedged/uncertain phrasing on a recommendation answer -> unsupported
    if is_recommendation and _HEDGE_RE.search(text):
        return OutputVerdict(
            ok=False,
            final_text=settings.unsupported_message,
            reasons=["hedged_recommendation"],
            unsupported=True,
        )

    # 4. disclaimer enforcement (appended by renderer; verified here)
    final = text.strip()
    if is_recommendation and settings.disclaimer not in final:
        final = f"{final}\n\n_{settings.disclaimer}_"
        reasons.append("disclaimer_appended")

    return OutputVerdict(ok=True, final_text=final, reasons=reasons)


REFUSAL_CROSS_USER = (
    "I can only discuss your own account and authorized platform data — "
    "protected client details for other users are never exposed. "
)
REFUSAL_INJECTION = (
    "I can't act on instructions that try to change my rules. "
    "Ask me about strategies, metrics, or your current trading context. "
)
