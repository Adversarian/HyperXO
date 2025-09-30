"""Unit tests for HyperXO game logic."""

from hyperxo.game import HyperXOGame


def test_initial_state_allows_any_board():
    game = HyperXOGame()
    moves = game.available_moves()
    assert len(moves) == 9 * 9


def test_directed_move_after_play():
    game = HyperXOGame()
    game.play_move(0, 4)
    moves = game.available_moves()
    assert all(board == 4 for board, _ in moves)


def test_small_board_win_detection():
    game = HyperXOGame()
    board = game.boards[0]
    board.play(0, "X")
    board.play(1, "X")
    board.play(2, "X")
    game._update_overall_state()
    assert board.winner == "X"


def test_big_board_win_detection():
    game = HyperXOGame()
    for index in (0, 1, 2):
        board = game.boards[index]
        board.winner = "X"
    game._update_overall_state()
    assert game.winner == "X"


def test_unavailable_board_redirects():
    game = HyperXOGame()
    # Fill board 4 so it is unavailable
    for i in range(9):
        game.boards[4].cells[i] = "X" if i % 2 == 0 else "O"
    game.boards[4].drawn = True
    game.play_move(0, 4)
    assert game.next_board_index is None
    moves = game.available_moves()
    assert all(board != 4 for board, _ in moves)
