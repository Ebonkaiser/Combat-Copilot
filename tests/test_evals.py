"""
Module 5: Evaluation & Guardrails -- test suite.

Two groups of tests:

1. Eval-harness unit tests (no network): exercise judge_narration's JSON
   parsing and EvalResult logic against a stub LLM object, plus a
   regression suite of hand-authored (state_delta, narration) fixtures run
   through a pure-Python stub judge -- so this file is CI-safe and doesn't
   require GOOGLE_API_KEY or network access.

2. Offline-resilience tests (no network): verify with_llm_fallback degrades
   to a deterministic, LLM-free narration when the wrapped node raises, and
   that the fallback never invents numbers not present in the state.

3. An optional live-model sanity check, skipped automatically unless
   GOOGLE_API_KEY is set -- for running on a real workstation, not CI.
"""

from __future__ import annotations

import os
import re

import pytest
from dotenv import load_dotenv
load_dotenv()

from eval_harness import (
    EvalCase,
    EvalResult,
    JudgeParseError,
    _coerce_content_to_text,
    _extract_json,
    build_judge_input,
    judge_narration,
    run_regression_suite,
    summarize,
)
from resilience import fallback_narration, with_llm_fallback


# ---------------------------------------------------------------------------
# 1a. _extract_json robustness
# ---------------------------------------------------------------------------

def test_extract_json_bare():
    text = '{"invented_numbers": false, "state_contradiction": false, "verdict": "pass", "reasoning": "fine"}'
    parsed = _extract_json(text)
    assert parsed["verdict"] == "pass"


def test_extract_json_fenced():
    text = (
        "Here is my answer:\n```json\n"
        '{"invented_numbers": true, "state_contradiction": false, "verdict": "fail", "reasoning": "made up HP"}'
        "\n```"
    )
    parsed = _extract_json(text)
    assert parsed["invented_numbers"] is True
    assert parsed["verdict"] == "fail"


def test_extract_json_garbage_raises():
    with pytest.raises(JudgeParseError):
        _extract_json("The narration looks fine to me, no JSON here.")


# ---------------------------------------------------------------------------
# 1b. judge_narration against a stub LLM (no network)
# ---------------------------------------------------------------------------

class _StubResponse:
    def __init__(self, content: str):
        self.content = content


class _StubLLM:
    """Mimics the LangChain ChatModel interface (`.invoke(messages) -> response.content`)
    just enough for judge_narration to exercise its parsing path without a
    real API call."""

    def __init__(self, canned_content: str):
        self._canned_content = canned_content
        self.last_messages = None

    def invoke(self, messages):
        self.last_messages = messages
        return _StubResponse(self._canned_content)


def test_judge_narration_pass_case():
    stub = _StubLLM(
        '{"invented_numbers": false, "state_contradiction": false, '
        '"verdict": "pass", "reasoning": "Matches the delta."}'
    )
    delta = {"target_name": "Iron Silk Guard", "damage_taken": 8, "current_hp": 12, "is_down": False}
    result = judge_narration(delta, "The blade bites deep, but the guard holds his footing.", stub)

    assert isinstance(result, EvalResult)
    assert result.passed
    assert result.verdict == "pass"
    # Confirm the state delta was actually passed to the judge, not dropped.
    assert "Iron Silk Guard" in build_judge_input(delta, "irrelevant")


def test_judge_narration_fail_case_invented_numbers():
    stub = _StubLLM(
        '{"invented_numbers": true, "state_contradiction": false, '
        '"verdict": "fail", "reasoning": "Narration claims 47 damage but delta says 8."}'
    )
    delta = {"target_name": "Iron Silk Guard", "damage_taken": 8, "current_hp": 12, "is_down": False}
    result = judge_narration(delta, "The blow lands for a brutal 47 damage!", stub)

    assert not result.passed
    assert result.invented_numbers is True


def test_judge_narration_missing_keys_raises():
    stub = _StubLLM('{"verdict": "pass"}')  # missing required keys
    with pytest.raises(JudgeParseError):
        judge_narration({"target_name": "X"}, "Some narration.", stub)


# ---------------------------------------------------------------------------
# 1b-bonus. Regression coverage for the list-content bug: some providers
# (langchain-google-genai included, depending on response shape) return
# response.content as a list of content-block dicts instead of a plain
# string. judge_narration must flatten that before parsing, not crash.
# ---------------------------------------------------------------------------

def test_coerce_content_to_text_handles_plain_string():
    assert _coerce_content_to_text("hello") == "hello"


def test_coerce_content_to_text_handles_list_of_dicts():
    content = [{"type": "text", "text": '{"verdict": "pass", '}, {"type": "text", "text": '"invented_numbers": false, "state_contradiction": false, "reasoning": "ok"}'}]
    text = _coerce_content_to_text(content)
    parsed = _extract_json(text)
    assert parsed["verdict"] == "pass"


def test_coerce_content_to_text_handles_list_of_strings():
    content = ['{"verdict": "pass", "invented_numbers": false, ', '"state_contradiction": false, "reasoning": "ok"}']
    text = _coerce_content_to_text(content)
    parsed = _extract_json(text)
    assert parsed["verdict"] == "pass"


class _StubListContentResponse:
    """Simulates a langchain-google-genai response where .content is a list
    of content-block dicts rather than a plain string -- the shape that
    previously crashed judge_narration with
    'TypeError: expected string or bytes-like object, got list'."""
    def __init__(self, blocks):
        self.content = blocks


class _StubLLMReturningListContent:
    def invoke(self, prompt):
        return _StubListContentResponse([
            {"type": "text", "text": '{"invented_numbers": false, "state_contradiction": false, '},
            {"type": "text", "text": '"verdict": "pass", "reasoning": "Matches the delta."}'},
        ])


def test_judge_narration_handles_list_content_response():
    stub = _StubLLMReturningListContent()
    delta = {"target_name": "Iron Silk Guard", "damage_taken": 8, "current_hp": 12, "is_down": False}
    result = judge_narration(delta, "The blade bites deep, but the guard holds his footing.", stub)
    assert result.passed


# ---------------------------------------------------------------------------
# 1c. Regression suite against a pure-Python stub judge (deterministic, CI-safe)
# ---------------------------------------------------------------------------

_NUMBER_RE = re.compile(r"\b\d+\b")


def _pure_python_stub_judge(state_delta: dict, narration: str) -> EvalResult:
    """
    A fast, dependency-free approximation of the LLM judge, used to validate
    the regression-harness plumbing (run_regression_suite/summarize) without
    any model call. Not a substitute for the real judge in production --
    just enough heuristic to keep this test file meaningful and network-free.
    """
    known_numbers = {str(v) for v in state_delta.values() if isinstance(v, int)}
    found_numbers = set(_NUMBER_RE.findall(narration))
    invented = bool(found_numbers - known_numbers)

    is_down = bool(state_delta.get("is_down"))
    lower = narration.lower()
    says_down = any(kw in lower for kw in ("is down", "falls", "collapses", "defeated"))
    says_still_fighting = any(kw in lower for kw in ("still fighting", "presses the attack", "holds his footing", "holds her footing"))

    contradiction = (is_down and says_still_fighting) or (not is_down and says_down)

    verdict = "fail" if (invented or contradiction) else "pass"
    return EvalResult(
        invented_numbers=invented,
        state_contradiction=contradiction,
        verdict=verdict,
        reasoning="stub heuristic check",
    )


GOLDEN_CASES = [
    EvalCase(
        name="clean_hit_no_numbers",
        state_delta={"target_name": "Iron Silk Guard", "damage_taken": 8, "current_hp": 12, "is_down": False},
        narration="The blade bites deep, but the guard holds his footing.",
        expect_pass=True,
    ),
    EvalCase(
        name="invented_damage_number",
        state_delta={"target_name": "Iron Silk Guard", "damage_taken": 8, "current_hp": 12, "is_down": False},
        narration="The blow lands for a brutal 47 damage!",
        expect_pass=False,
    ),
    EvalCase(
        name="contradicts_defeat",
        state_delta={"target_name": "Bandit", "damage_taken": 14, "current_hp": 0, "is_down": True},
        narration="The bandit staggers but still presses the attack.",
        expect_pass=False,
    ),
    EvalCase(
        name="correctly_narrates_defeat",
        state_delta={"target_name": "Bandit", "damage_taken": 14, "current_hp": 0, "is_down": True},
        narration="The bandit collapses, the fight gone out of him.",
        expect_pass=True,
    ),
]


def test_regression_suite_matches_expectations():
    report = run_regression_suite(GOLDEN_CASES, _pure_python_stub_judge)
    mismatches = [case.name for case, _, matched in report if not matched]
    assert not mismatches, f"Golden cases failed to match expectation: {mismatches}\n{summarize(report)}"


def test_summarize_output_is_readable():
    report = run_regression_suite(GOLDEN_CASES, _pure_python_stub_judge)
    text = summarize(report)
    assert "Eval regression:" in text
    assert "clean_hit_no_numbers" in text


# ---------------------------------------------------------------------------
# 2. Offline resilience: with_llm_fallback / fallback_narration
# ---------------------------------------------------------------------------

def _sample_graph_state(current_hp: int, max_hp: int = 20, damage: int = 8, conditions=None):
    return {
        "last_event": {
            "target_id": "enemy_1",
            "damage_amount": damage,
            "damage_type": "Slashing",
            "applied_conditions": conditions or [],
        },
        "combatants": [
            {
                "id": "enemy_1",
                "name": "Iron Silk Guard",
                "current_hp": current_hp,
                "max_hp": max_hp,
                "conditions": conditions or [],
            }
        ],
        "retrieved_lore": "",
        "streamed_narration": "",
    }


def test_fallback_narration_no_invented_numbers():
    state = _sample_graph_state(current_hp=12, max_hp=20, damage=8)
    text = fallback_narration(state)
    assert "8" in text  # the actual damage dealt
    assert "12/20" in text  # actual current/max HP
    assert "Iron Silk Guard" in text
    # Every digit in the fallback must trace back to the state -- this is
    # the same invented-numbers bar the eval harness enforces on the LLM path.
    for number in _NUMBER_RE.findall(text):
        assert number in {"8", "12", "20"}


def test_fallback_narration_flags_down_state():
    state = _sample_graph_state(current_hp=0, max_hp=20, damage=20)
    text = fallback_narration(state)
    assert "is down" in text.lower()


def test_fallback_narration_includes_conditions():
    state = _sample_graph_state(current_hp=5, max_hp=20, damage=5, conditions=["Bleed"])
    text = fallback_narration(state)
    assert "Bleed" in text


def test_with_llm_fallback_catches_exception_and_degrades():
    def _always_fails(state):
        raise RuntimeError("simulated Gemini timeout")

    wrapped = with_llm_fallback(_always_fails)
    state = _sample_graph_state(current_hp=0, max_hp=20, damage=20)
    result = wrapped(state)

    assert "streamed_narration" in result
    assert "[Narration unavailable" in result["streamed_narration"]
    assert "is down" in result["streamed_narration"].lower()


def test_with_llm_fallback_passes_through_on_success():
    def _succeeds(state):
        return {"streamed_narration": "A clean hit lands."}

    wrapped = with_llm_fallback(_succeeds)
    state = _sample_graph_state(current_hp=12, max_hp=20, damage=8)
    result = wrapped(state)

    assert result == {"streamed_narration": "A clean hit lands."}


def test_with_llm_fallback_respects_custom_output_key():
    def _always_fails(state):
        raise ValueError("boom")

    wrapped = with_llm_fallback(_always_fails, output_key="retrieved_lore")
    state = _sample_graph_state(current_hp=12, max_hp=20, damage=8)
    result = wrapped(state)

    assert "retrieved_lore" in result
    assert "streamed_narration" not in result


# ---------------------------------------------------------------------------
# 3. Optional live-model sanity check (skipped without a real API key)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(
    not os.getenv("GOOGLE_API_KEY") and not os.getenv("GEMINI_API_KEY"),
    reason="No GOOGLE_API_KEY/GEMINI_API_KEY set -- skipping live Gemini judge check.",
)
def test_judge_narration_live_model_smoke_test():
    """
    Run only on a workstation with real credentials. Confirms the actual
    judge prompt + a real Gemini call round-trips into a valid EvalResult
    for an obviously-clean narration. Not part of the CI-safe suite above.
    """
    from langchain_google_genai import ChatGoogleGenerativeAI

    llm = ChatGoogleGenerativeAI(model="gemini-3.6-flash")
    delta = {"target_name": "Iron Silk Guard", "damage_taken": 8, "current_hp": 12, "is_down": False}
    result = judge_narration(delta, "The blade bites deep, but the guard holds his footing.", llm)
    assert result.passed
