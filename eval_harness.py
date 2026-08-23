"""
Module 5: Evaluation & Guardrails

LLM-as-a-judge harness that checks generated combat narration against the
deterministic state delta it was supposed to describe. Catches two failure
classes:

  1. INVENTED_NUMBERS   -- narration states a specific numeric game fact
     (an HP total, a damage number, a dice roll, a duration) that is not
     present in, or contradicts, the state delta it was given.
  2. STATE_CONTRADICTION -- narration describes the target as still able to
     act/fight when the delta says is_down is true (or the reverse), or
     misrepresents which conditions were applied.

This module is deliberately decoupled from the LangGraph nodes in
combat_graph.py so it can be:
  - unit tested without a live model (see tests/test_evals.py, which uses a
    pure-Python stub judge for CI), and
  - run as a standalone regression suite against recorded transcripts using
    a real judge model when an API key + network are available.

Design note: the judge is intentionally a *second, independent* model call
(or stub) rather than the same chain that produced the narration -- grading
your own homework defeats the point of the check.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


JUDGE_SYSTEM_PROMPT = """You are a strict fact-checking judge for a tabletop \
combat narration system. You will be given (a) a verified state delta \
describing exactly what happened in deterministic game terms, and (b) a \
narration a different AI generated to describe that delta in-fiction.

Your only job is to check the narration for two kinds of failure:

1. INVENTED_NUMBERS: the narration states a specific numeric game fact (an \
HP total, a damage number, a dice roll, a distance, a duration) that is not \
present in or contradicts the state delta. Flavor text with no numbers is \
fine. Vague descriptions ("badly wounded", "reeling") are fine.

2. STATE_CONTRADICTION: the narration describes the target as still able to \
act/fight when the delta says is_down is true, or describes the target as \
down/dead/incapacitated when is_down is false, or omits/reverses which \
conditions were applied.

Respond with ONLY a JSON object, no other text, matching this schema:
{"invented_numbers": bool, "state_contradiction": bool, "verdict": "pass" | "fail", "reasoning": "<one sentence>"}

verdict is "pass" only if both invented_numbers and state_contradiction are false.
"""


@dataclass
class EvalResult:
    invented_numbers: bool
    state_contradiction: bool
    verdict: str
    reasoning: str
    raw_response: str = field(repr=False, default="")

    @property
    def passed(self) -> bool:
        return self.verdict == "pass" and not self.invented_numbers and not self.state_contradiction


class JudgeParseError(ValueError):
    """Raised when the judge's response isn't valid JSON matching the expected schema."""


def _coerce_content_to_text(content: Any) -> str:
    """
    LangChain chat models type `.content` as `str | list[str | dict]` --
    some providers (langchain-google-genai included, depending on response
    shape) return a list of content blocks instead of a plain string, e.g.
    `[{"type": "text", "text": "..."}]`. Flatten whatever comes back into a
    single string before it hits _extract_json, which expects text.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(item.get("text", ""))
            else:
                parts.append(str(item))
        return "".join(parts)
    return str(content)


def _extract_json(text: str) -> dict:
    """
    Judges occasionally wrap JSON in markdown fences despite instructions not
    to. Strip those defensively rather than trusting the system prompt alone
    -- this is the same class of bug that bit the knowledge_engine ingestion
    fixes earlier in this project (don't assume the model's output format is
    exactly what you asked for; verify and unwrap it).
    """
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else text.strip()
    try:
        return json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise JudgeParseError(f"Judge response was not valid JSON: {text!r}") from exc


def build_judge_input(state_delta: dict[str, Any], narration: str) -> str:
    return (
        f"STATE DELTA:\n{json.dumps(state_delta, indent=2)}\n\n"
        f"NARRATION:\n{narration}"
    )


def judge_narration(state_delta: dict[str, Any], narration: str, llm) -> EvalResult:
    """
    Runs the LLM-as-a-judge check.

    `llm` is any object exposing `.invoke(prompt) -> response` where the
    response has a `.content` attribute -- this matches the LangChain
    ChatModel interface used elsewhere in the project (e.g.
    ChatGoogleGenerativeAI.invoke(str)), so the same function works against
    a real model or a test double, with no import-time dependency on
    langchain_core itself. Pass temperature=0 (or as close to it as the
    provider allows) on the judge model -- consistency matters more than
    creativity for a fact-checker.

    A single combined string is sent (system instructions + delta +
    narration) rather than separate system/human message objects, since
    LangChain chat models accept a plain string via .invoke() and this keeps
    the harness testable without requiring langchain_core to be installed.
    """
    prompt = f"{JUDGE_SYSTEM_PROMPT}\n\n{build_judge_input(state_delta, narration)}"
    response = llm.invoke(prompt)
    raw_content = getattr(response, "content", str(response))
    content = _coerce_content_to_text(raw_content)
    parsed = _extract_json(content)

    required = {"invented_numbers", "state_contradiction", "verdict", "reasoning"}
    missing = required - parsed.keys()
    if missing:
        raise JudgeParseError(f"Judge response missing keys {missing}: {parsed}")

    return EvalResult(
        invented_numbers=bool(parsed["invented_numbers"]),
        state_contradiction=bool(parsed["state_contradiction"]),
        verdict=parsed["verdict"],
        reasoning=parsed["reasoning"],
        raw_response=content,
    )


__all__ = [
    "EvalCase",
    "EvalResult",
    "JudgeParseError",
    "build_judge_input",
    "judge_narration",
    "run_regression_suite",
    "summarize",
]


# ---------------------------------------------------------------------------
# Regression harness
# ---------------------------------------------------------------------------

@dataclass
class EvalCase:
    """One recorded (or hand-authored) state-delta / narration pair to check."""
    name: str
    state_delta: dict[str, Any]
    narration: str
    expect_pass: bool = True  # set False for intentionally-bad fixtures


def run_regression_suite(
    cases: list[EvalCase],
    judge: Callable[[dict[str, Any], str], EvalResult],
) -> list[tuple[EvalCase, EvalResult, bool]]:
    """
    Runs every case through `judge` (a partially-applied judge_narration, or
    the pure-Python stub in tests/test_evals.py) and reports whether the
    judge's verdict matched what the fixture expected.

    Returns a list of (case, result, matched_expectation) tuples so callers
    can build a pass-rate report or fail CI on any mismatch.
    """
    report = []
    for case in cases:
        result = judge(case.state_delta, case.narration)
        matched = result.passed == case.expect_pass
        report.append((case, result, matched))
    return report


def summarize(report: list[tuple[EvalCase, EvalResult, bool]]) -> str:
    total = len(report)
    correct = sum(1 for _, _, matched in report if matched)
    lines = [f"Eval regression: {correct}/{total} cases matched expectation."]
    for case, result, matched in report:
        flag = "OK" if matched else "MISMATCH"
        lines.append(
            f"  [{flag}] {case.name}: verdict={result.verdict} "
            f"invented_numbers={result.invented_numbers} "
            f"state_contradiction={result.state_contradiction} "
            f"-- {result.reasoning}"
        )
    return "\n".join(lines)
