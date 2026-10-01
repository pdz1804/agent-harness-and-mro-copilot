"""`agent_harness.eval.scoring.score_runs` tests — real isolated Postgres
(via `conftest.py`'s per-test DB), no network (model=None or a
`FunctionModel` double throughout)."""

from __future__ import annotations

from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from agent_harness import db
from agent_harness.eval import scoring
from agent_harness.repos import evals as evals_repo


def _seed_run(run_id: str, *, owner_id: str = "u_admin", with_tool_error: bool = False) -> None:
    db.upsert_run(
        {
            "run_id": run_id,
            "objective": "check auth-service status",
            "status": "completed",
            "started_at": 1790000000.0,
            "finished_at": 1790000005.0,
            "final_answer": "auth-service is operational.",
            "steps_taken": 2,
            "trace_path": None,
            "error": None,
            "owner_id": owner_id,
        }
    )
    db.append_event(
        run_id, 0, "tool_call_started", 1.0, None, {"tool_name": "get_service_status", "tool_args": {}}
    )
    if with_tool_error:
        db.append_event(run_id, 0, "tool_call_error", 1.1, None, {"tool_name": "get_service_status", "error": "boom"})
    else:
        db.append_event(
            run_id, 0, "tool_call_result", 1.1, None, {"tool_name": "get_service_status", "result": {"status": "operational"}}
        )
    db.append_event(run_id, 1, "final_answer", 1.2, None, {"final_answer": "auth-service is operational."})


def _verdict_model() -> FunctionModel:
    def _fn(messages, info: AgentInfo) -> ModelResponse:
        output_tools = getattr(info, "output_tools", None) or []
        tool_name = output_tools[0].name if output_tools else "final_result"
        return ModelResponse(
            parts=[
                ToolCallPart(
                    tool_name=tool_name,
                    args={
                        "task_success": 5,
                        "task_success_rationale": "resolved",
                        "groundedness": 5,
                        "groundedness_rationale": "supported",
                        "tool_choice": 5,
                        "tool_choice_rationale": "correct",
                        "safety_ok": True,
                        "safety_rationale": "fine",
                    },
                )
            ]
        )

    return FunctionModel(_fn, model_name="judge-double")


def test_score_runs_with_explicit_run_ids_no_model_persists_deterministic_and_unavailable_rows():
    _seed_run("run-a")
    result = scoring.score_runs(
        run_ids=["run-a"], triggered_by="u_admin", model=None, judge_model_name="gpt-4o-mini"
    )
    assert result["status"] == "completed"
    assert result["scored"] == 1
    assert result["skipped_already_scored"] == 0
    assert result["errors"] == []

    rows = evals_repo.list_results_for_run("run-a")
    by_metric = {r["metric"]: r for r in rows}
    assert by_metric["task_success"]["score"] is None  # honest: no judge configured
    assert by_metric["total_tokens"]["score"] == 0.0  # no llm_meta in this fixture
    assert by_metric["tool_use_correctness"]["score"] == 1.0  # rule-only, zero tool errors
    assert by_metric["safety"]["score"] == 1.0


def test_score_runs_all_for_user_filters_by_owner_id():
    _seed_run("run-owner-a", owner_id="u_editor")
    _seed_run("run-owner-b", owner_id="u_admin")
    result = scoring.score_runs(owner_id="u_editor", triggered_by="u_editor", model=None, judge_model_name="gpt-4o-mini")
    assert result["scored"] == 1
    rows = evals_repo.list_results_for_run("run-owner-a")
    assert rows
    assert evals_repo.list_results_for_run("run-owner-b") == []


def test_score_runs_is_idempotent_second_call_skips_already_scored():
    _seed_run("run-b")
    first = scoring.score_runs(run_ids=["run-b"], triggered_by="u_admin", model=None, judge_model_name="gpt-4o-mini")
    assert first["scored"] == 1

    rows_after_first = evals_repo.list_results_for_run("run-b")

    second = scoring.score_runs(run_ids=["run-b"], triggered_by="u_admin", model=None, judge_model_name="gpt-4o-mini")
    assert second["scored"] == 0
    assert second["skipped_already_scored"] == 1

    rows_after_second = evals_repo.list_results_for_run("run-b")
    assert len(rows_after_first) == len(rows_after_second)


def test_score_runs_force_true_rescopes_even_when_already_scored():
    _seed_run("run-c")
    first = scoring.score_runs(run_ids=["run-c"], triggered_by="u_admin", model=None, judge_model_name="gpt-4o-mini")
    assert first["scored"] == 1

    forced = scoring.score_runs(
        run_ids=["run-c"], triggered_by="u_admin", model=None, judge_model_name="gpt-4o-mini", force=True
    )
    # force=True re-attempts scoring, but the DB-level unique constraint
    # (run_id, metric, judge_version) still no-ops the actual insert since
    # nothing about the judge_version changed between calls -- the eval_runs
    # job itself still reports it as "scored" (attempted), matching the
    # phase file's "re-score only when judge_version changed or force=True".
    assert forced["scored"] == 1
    assert forced["skipped_already_scored"] == 0


def test_score_runs_rescoring_under_a_new_judge_version_is_not_skipped():
    _seed_run("run-d")
    scoring.score_runs(run_ids=["run-d"], triggered_by="u_admin", model=None, judge_model_name="gpt-4o-mini")
    second = scoring.score_runs(run_ids=["run-d"], triggered_by="u_admin", model=None, judge_model_name="gpt-4o")
    assert second["scored"] == 1
    assert second["skipped_already_scored"] == 0
    # Both judge_versions' rows now coexist (insert-only, never overwritten).
    rows = evals_repo.list_results_for_run("run-d")
    judge_versions = {r["judge_version"] for r in rows}
    assert len(judge_versions) == 2


def test_score_runs_with_function_model_persists_real_judge_scores():
    _seed_run("run-e")
    model = _verdict_model()
    result = scoring.score_runs(run_ids=["run-e"], triggered_by="u_admin", model=model, judge_model_name="gpt-4o-mini")
    assert result["scored"] == 1
    rows = evals_repo.list_results_for_run("run-e")
    by_metric = {r["metric"]: r for r in rows}
    assert by_metric["task_success"]["score"] == 1.0
    assert by_metric["tool_use_correctness"]["score"] == 1.0  # hybrid: rule=1.0, judge=1.0


def test_score_runs_one_bad_run_id_does_not_abort_the_batch():
    _seed_run("run-f")
    result = scoring.score_runs(
        run_ids=["run-f", "does-not-exist"], triggered_by="u_admin", model=None, judge_model_name="gpt-4o-mini"
    )
    assert result["scored"] == 1
    assert len(result["errors"]) == 1
    assert "does-not-exist" in result["errors"][0]
    eval_run = evals_repo.get_eval_run(result["eval_run_id"])
    assert eval_run["status"] == "completed"  # at least one run scored -> not a full failure
    assert eval_run["done"] == 2


def test_score_runs_creates_a_terminal_eval_run_row_never_left_running():
    _seed_run("run-g")
    result = scoring.score_runs(run_ids=["run-g"], triggered_by="u_admin", model=None, judge_model_name="gpt-4o-mini")
    eval_run = evals_repo.get_eval_run(result["eval_run_id"])
    assert eval_run["status"] in ("completed", "failed")
    assert eval_run["finished_at"] is not None
    assert eval_run["total"] == 1
    assert eval_run["done"] == 1
