"""Tests for the HyperXO minimax AI."""

from hyperxo.ai import MinimaxAI
from hyperxo.game import HyperXOGame


def test_ai_takes_immediate_win():
    game = HyperXOGame()
    board = game.boards[0]
    board.cells[0] = "X"
    board.cells[1] = "X"
    game.current_player = "X"
    game.next_board_index = 0

    ai = MinimaxAI(player="X", depth=1)
    move = ai.choose(game)

    assert move == (0, 2)


def test_ai_respects_forced_board():
    game = HyperXOGame()
    game.play_move(0, 4)  # X sends O to board 4

    ai = MinimaxAI(player="O", depth=1)
    move = ai.choose(game)

    assert move in game.available_moves()
    assert move[0] == 4
