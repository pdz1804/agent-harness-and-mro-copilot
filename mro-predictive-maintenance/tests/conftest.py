import pytest


@pytest.fixture(autouse=True)
def _offline_llm_unless_live(request, monkeypatch):
    # Non-live tests assert on the deterministic scripted model; a developer's
    # exported OPENAI_API_KEY must not silently swap in a real LLM.
    if request.node.get_closest_marker("live") is None:
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
