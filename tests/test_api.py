"""Tests for the FastAPI HyperXO interface."""

from __future__ import annotations

from fastapi.testclient import TestClient

from hyperxo.ui import app


client = TestClient(app)


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
    assert state["currentPlayer"] == "X"


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
