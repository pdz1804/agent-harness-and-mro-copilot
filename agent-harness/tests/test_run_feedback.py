"""Human feedback on runs (thumbs up/down + note) shown next to the LLM judge's
score, and the judge-vs-human agreement metric."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Optional

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import db  # noqa: E402
from agent_harness.repos import evals as evals_repo  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

ADMIN = {"X-User-Id": "u_admin"}
EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
VIEWER = {"X-User-Id": "u_viewer"}


def _run(run_id: str, owner: str = "u_editor") -> str:
    session_id = f"s-{run_id}"
    db.create_session(session_id, run_id, "2026-09-01T00:00:00+00:00", owner_id=owner)
    db.upsert_run(
        {
            "run_id": run_id,
            "objective": f"objective of {run_id}",
            "status": "completed",
            "started_at": time.time(),
            "finished_at": time.time(),
            "final_answer": "answer",
            "steps_taken": 1,
            "trace_path": "",
            "error": None,
            "session_id": session_id,
            "owner_id": owner,
        }
    )
    return run_id


def _judge(run_id: str, score: Optional[float], passed: Optional[bool], rationale: str = "judge says so") -> None:
    eval_run = evals_repo.create_eval_run(
        triggered_by="u_admin", scope="all", judge_version="jv", judge_model="m", total=1
    )
    evals_repo.insert_results(
        eval_run["id"],
        [
            {
                "run_id": run_id,
                "metric": "task_success",
                "score": score,
                "passed": passed,
                "rationale": rationale,
                "judge_version": "jv",
                "agent_id": None,
            }
        ],
    )


def _vote(run_id: str, rating: str, headers: dict = EDITOR, note: str = "") -> dict:
    response = client.put(f"/api/v1/runs/{run_id}/feedback", json={"rating": rating, "note": note}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_vote_and_note_are_stored_and_replaced_by_a_second_vote() -> None:
    run_id = _run("r1")
    first = _vote(run_id, "down", note="  missed the runbook  ")
    assert first["mine"]["rating"] == "down" and first["mine"]["note"] == "missed the runbook"
    second = _vote(run_id, "up", note="actually fine")
    assert second["mine"]["rating"] == "up" and second["mine"]["note"] == "actually fine"
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM run_feedback").fetchone()["n"] == 1


def test_judge_score_is_shown_next_to_the_human_vote() -> None:
    run_id = _run("r2")
    _judge(run_id, 0.25, False, "answer ignored the tool result")
    body = _vote(run_id, "up")
    assert body["judge_score"] == 0.25 and body["judge_passed"] is False
    assert body["judge_rationale"] == "answer ignored the tool result"
    assert client.get(f"/api/v1/runs/{run_id}/feedback", headers=EDITOR).json()["judge_passed"] is False


def test_no_judge_row_means_null_judge_fields() -> None:
    body = _vote(_run("r3"), "up")
    assert body["judge_score"] is None and body["judge_passed"] is None


def test_delete_removes_only_my_vote() -> None:
    run_id = _run("r4")
    _vote(run_id, "up")
    _vote(run_id, "down", headers=ADMIN)
    after = client.delete(f"/api/v1/runs/{run_id}/feedback", headers=EDITOR).json()
    assert after["mine"] is None
    assert [o["rating"] for o in after["others"]] == ["down"]  # editor owns the run, so sees the admin's vote


def test_validation() -> None:
    run_id = _run("r5")
    assert client.put(f"/api/v1/runs/{run_id}/feedback", json={"rating": "meh"}, headers=EDITOR).status_code == 422
    assert client.put(f"/api/v1/runs/{run_id}/feedback", json={"rating": "up", "note": "x" * 1001}, headers=EDITOR).status_code == 422


def test_rbac_only_people_who_can_read_the_run_can_vote_or_see_votes() -> None:
    run_id = _run("r6")
    assert client.put(f"/api/v1/runs/{run_id}/feedback", json={"rating": "up"}, headers=EDITOR2).status_code == 404
    assert client.get(f"/api/v1/runs/{run_id}/feedback", headers=EDITOR2).status_code == 404
    assert client.put("/api/v1/runs/ghost/feedback", json={"rating": "up"}, headers=ADMIN).status_code == 404
    _vote(run_id, "up", headers=EDITOR)
    admin_view = _vote(run_id, "down", headers=ADMIN)
    assert admin_view["mine"]["rating"] == "down" and [o["user_id"] for o in admin_view["others"]] == ["u_editor"]


def test_a_viewer_can_vote_on_their_own_run() -> None:
    run_id = _run("r7", owner="u_viewer")
    assert _vote(run_id, "up", headers=VIEWER)["mine"]["rating"] == "up"


# --- agreement -------------------------------------------------------------------------


def _agreement(headers: dict = ADMIN) -> dict:
    response = client.get("/api/v1/eval-metrics/agreement", headers=headers)
    assert response.status_code == 200
    return response.json()


def test_agreement_is_empty_with_no_votes() -> None:
    body = _agreement()
    assert body["human_votes"] == 0 and body["compared"] == 0 and body["agreement_rate"] is None


def test_agreement_counts_matches_and_both_kinds_of_disagreement() -> None:
    cases = [
        ("a1", 0.9, True, "up"),  # both up
        ("a2", 0.8, True, "up"),  # both up
        ("a3", 0.1, False, "down"),  # both down
        ("a4", 0.9, True, "down"),  # judge up, human down
        ("a5", 0.2, False, "up"),  # judge down, human up
    ]
    for run_id, score, passed, rating in cases:
        _run(run_id)
        _judge(run_id, score, passed)
        _vote(run_id, rating)
    _run("a6")  # a vote with no judge verdict is not comparable
    _vote("a6", "up")
    body = _agreement()
    assert body["human_votes"] == 6 and body["compared"] == 5 and body["agree"] == 3
    assert body["both_up"] == 2 and body["both_down"] == 1
    assert body["judge_up_human_down"] == 1 and body["judge_down_human_up"] == 1
    assert body["agreement_rate"] == pytest.approx(0.6)


def test_judge_pass_falls_back_to_the_score_when_the_flag_is_null() -> None:
    _run("b1")
    _judge("b1", 0.9, None)
    _vote("b1", "up")
    _run("b2")
    _judge("b2", 0.2, None)
    _vote("b2", "up")
    body = _agreement()
    assert body["both_up"] == 1 and body["judge_down_human_up"] == 1


def test_majority_of_several_voters_counts_once() -> None:
    _run("c1")
    _judge("c1", 0.9, True)
    _vote("c1", "up", headers=EDITOR)
    _vote("c1", "down", headers=ADMIN)  # 1 up + 1 down: a tie counts as down
    body = _agreement()
    assert body["human_votes"] == 1 and body["judge_up_human_down"] == 1


def test_agreement_is_scoped_to_the_callers_own_runs_unless_admin() -> None:
    _run("d1", owner="u_editor")
    _judge("d1", 0.9, True)
    _vote("d1", "up", headers=EDITOR)
    _run("d2", owner="u_editor2")
    _judge("d2", 0.9, True)
    _vote("d2", "down", headers=EDITOR2)
    assert _agreement(EDITOR)["compared"] == 1 and _agreement(EDITOR)["agreement_rate"] == 1.0
    assert _agreement(EDITOR2)["agreement_rate"] == 0.0
    assert _agreement(ADMIN)["compared"] == 2
