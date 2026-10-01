"""Recorded-transcript regression suite for the agent loop (phase 11c).

`capture_transcripts.py` runs real objectives against the real OpenAI API
and saves each resulting `RunResult` + expected outcome as a JSON fixture
under `eval/transcripts/`. `scorers.py` derives a compact outcome summary
from a saved transcript and compares it against the expected outcome.
`run_eval.py` loads the fixtures and scores them via `mlflow.genai.evaluate`,
producing a real MLflow evaluation run with real pass/fail results.
"""
