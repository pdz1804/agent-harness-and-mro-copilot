"""New-entity persistence modules (phase 01+). Each module reuses
`agent_harness.db.connect` rather than opening its own connections, so
every module still shares the same short-lived-connection-per-call
strategy documented in `db.py`."""
