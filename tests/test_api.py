"""Tests for the FastAPI HyperXO interface."""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from hyperxo import ui
from hyperxo.ui import app


client = TestClient(app)
ui.AI_THINK_DELAY = (0.0, 0.0)


def test_create_game_and_first_move():
    response = client.post("/api/game", json={"depth": 3})
    assert response.status_code == 200
    payload = response.json()
    assert payload["currentPlayer"] == "X"
    assert payload["moveLog"] == []

    game_id = payload["id"]
    move_response = client.post(
        f"/api/game/{game_id}/move",
        json={"boardIndex": 0, "cellIndex": 0},
    )
    assert move_response.status_code == 200
    state = move_response.json()
    assert state["moveLog"], "Move log should include at least one move"
    assert state["moveLog"][0]["player"] == "X"
    assert state["boards"][0]["cells"][0] == "X"
    assert state["currentPlayer"] == "O"
    assert state["aiPending"] is True

    time.sleep(0.01)
    follow_up = client.get(f"/api/game/{game_id}")
    assert follow_up.status_code == 200
    final_state = follow_up.json()
    assert final_state["currentPlayer"] == "X"
    assert final_state["moveLog"][-1]["player"] == "O"


def test_invalid_move_rejected():
    response = client.post("/api/game", json={"depth": 1})
    assert response.status_code == 200
    game_id = response.json()["id"]

    first_move = client.post(
        f"/api/game/{game_id}/move",
        json={"boardIndex": 0, "cellIndex": 0},
    )
    assert first_move.status_code == 200

    # Attempting to play the same cell should fail.
    duplicate_move = client.post(
        f"/api/game/{game_id}/move",
        json={"boardIndex": 0, "cellIndex": 0},
    )
    assert duplicate_move.status_code == 400
    assert duplicate_move.json()["detail"]


def test_rejects_unsupported_depth():
    response = client.post("/api/game", json={"depth": 2})
    assert response.status_code == 422


def test_create_room_and_inspect():
    origin = "https://play.hyperxo.test"
    response = client.post("/api/room", headers={"origin": origin})
    assert response.status_code == 200
    payload = response.json()
    room_id = payload["roomId"]
    assert isinstance(room_id, str)
    assert len(room_id) == 6
    assert payload["joinUrl"] == f"{origin}/?room={room_id}"

    inspect = client.get(f"/api/room/{room_id}")
    assert inspect.status_code == 200
    details = inspect.json()
    assert details["roomId"] == room_id
    assert details["available"] is True
    assert "host" in details["availableSlots"] or "guest" in details["availableSlots"]


def test_room_join_url_respects_forwarded_headers():
    response = client.post(
        "/api/room",
        headers={
            "x-forwarded-host": "hyperxo.example:8443",
            "x-forwarded-proto": "https",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["joinUrl"].startswith("https://hyperxo.example:8443/?room=")

    
def test_inspect_missing_room_returns_404():
    missing = client.get("/api/room/INVALID")
    assert missing.status_code == 404
