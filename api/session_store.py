# api/session_store.py -- file-backed session store
# Each session holds the current Music Sheet + chat history.
# Sessions are persisted to disk so they survive server restarts.

import json
import uuid
from pathlib import Path
from typing import Optional

_STORE_DIR = Path(__file__).resolve().parent.parent / "output" / "sessions"
_STORE_DIR.mkdir(parents=True, exist_ok=True)


def _path(session_id: str) -> Path:
    return _STORE_DIR / f"{session_id}.json"


def _load(session_id: str) -> Optional[dict]:
    p = _path(session_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save(session_id: str, data: dict) -> None:
    _path(session_id).write_text(
        json.dumps(data, ensure_ascii=False), encoding="utf-8"
    )


def create_session(sheet: dict) -> str:
    session_id = uuid.uuid4().hex[:8]
    _save(session_id, {"sheet": sheet, "history": []})
    return session_id


def get_session(session_id: str) -> Optional[dict]:
    return _load(session_id)


def update_sheet(session_id: str, sheet: dict) -> bool:
    data = _load(session_id)
    if data is None:
        return False
    data["sheet"] = sheet
    _save(session_id, data)
    return True


def append_history(session_id: str, message: dict) -> None:
    data = _load(session_id)
    if data is not None:
        data["history"].append(message)
        _save(session_id, data)
