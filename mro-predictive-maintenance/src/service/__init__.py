"""FastAPI inference service for the MRO predictive-maintenance model.

Loads the artifacts written by ``python -m src.pipeline`` (``models/*.joblib``,
``reports/model_card.json``, ``data/processed/model_table.csv``) -- nothing
here retrains or recomputes a metric; it only serves what training already
produced, live. See ``src/service/app.py`` for the endpoints.
"""
