"""Minimax AI implementation for HyperXO."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

from .game import HyperXOGame, Player, WINNING_LINES


@dataclass
class MinimaxAI:
    """AI player that uses depth-limited minimax search."""

    player: Player
    depth: int = 3

    def choose(self, game: HyperXOGame) -> Tuple[int, int]:
        if game.current_player != self.player:
            raise ValueError("It is not this AI player's turn")
        _, move = self._minimax(game, self.depth, float("-inf"), float("inf"), True)
        if move is None:
            raise RuntimeError("No valid moves available")
        return move

    def _minimax(
        self,
        game: HyperXOGame,
        depth: int,
        alpha: float,
        beta: float,
        maximizing: bool,
    ) -> Tuple[float, Optional[Tuple[int, int]]]:
        if depth == 0 or game.winner or game.drawn:
            return self._evaluate(game), None

        best_move: Optional[Tuple[int, int]] = None
        if maximizing:
            value = float("-inf")
            for move in game.available_moves():
                next_state = game.clone()
                next_state.play_move(*move)
                score, _ = self._minimax(next_state, depth - 1, alpha, beta, False)
                if score > value:
                    value = score
                    best_move = move
                alpha = max(alpha, value)
                if beta <= alpha:
                    break
            return value, best_move

        value = float("inf")
        for move in game.available_moves():
            next_state = game.clone()
            next_state.play_move(*move)
            score, _ = self._minimax(next_state, depth - 1, alpha, beta, True)
            if score < value:
                value = score
                best_move = move
            beta = min(beta, value)
            if beta <= alpha:
                break
        return value, best_move

    def _evaluate(self, game: HyperXOGame) -> float:
        opponent = "O" if self.player == "X" else "X"
        if game.winner == self.player:
            return 100.0
        if game.winner == opponent:
            return -100.0
        if game.drawn:
            return 0.0

        score = 0.0
        board_winners = game.big_board_state()
        for line in WINNING_LINES:
            player_count = sum(1 for idx in line if board_winners[idx] == self.player)
            opponent_count = sum(1 for idx in line if board_winners[idx] == opponent)
            if opponent_count and player_count:
                continue
            if player_count:
                score += 4 ** player_count
            if opponent_count:
                score -= 4 ** opponent_count

        for board in game.boards:
            if board.winner == self.player:
                score += 2.0
            elif board.winner == opponent:
                score -= 2.0
            elif not board.drawn:
                player_cells = board.cells.count(self.player)
                opponent_cells = board.cells.count(opponent)
                score += 0.1 * (player_cells - opponent_cells)
        return score
