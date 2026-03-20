import { useState, useEffect, useCallback, useRef } from 'react';
import type { Difficulty } from '../types';
import type { GameState } from '../types';
import {
  createGame as createEngine,
  availableMoves,
  applyMove,
  type HyperXOGame,
} from '../engine/game';
import { createAI, choose, DIFFICULTY_PRESETS } from '../engine/ai';
import type { MinimaxAI } from '../engine/ai';
import BigBoard from './BigBoard';
import GameStatus from './GameStatus';

interface Props {
  difficulty: Difficulty;
  playerSymbol: 'X' | 'O';
  aiName: string;
  onBack: () => void;
}

function engineToGameState(engine: HyperXOGame, lastMove?: { player: string; boardIndex: number; cellIndex: number }): GameState {
  const moves = availableMoves(engine);
  return {
    id: 'local',
    currentPlayer: engine.currentPlayer,
    nextBoardIndex: engine.nextBoardIndex,
    winner: engine.winner,
    drawn: engine.drawn,
    boards: engine.boards.map((b, i) => ({
      index: i,
      cells: b.cells.map(c => c === '' ? '' : c),
      winner: b.winner,
      drawn: b.drawn,
    })),
    availableMoves: moves.map(([board, cell]) => ({ board, cell })),
    availableBoards: [...new Set(moves.map(([b]) => b))].sort((a, b) => a - b),
    moveLog: [],
    lastMove,
    aiPending: false,
  };
}

export default function GameView({ difficulty, playerSymbol, aiName, onBack }: Props) {
  const [game, setGame] = useState<GameState | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const engineRef = useRef<HyperXOGame | null>(null);
  const aiRef = useRef<MinimaxAI | null>(null);

  const aiSymbol = playerSymbol === 'X' ? 'O' : 'X';

  const startNewGame = useCallback(() => {
    const engine = createEngine();
    const preset = DIFFICULTY_PRESETS[difficulty];
    const ai = createAI(aiSymbol, preset.depth, preset.blunderRate);
    engineRef.current = engine;
    aiRef.current = ai;

    // If AI goes first, make its move
    if (aiSymbol === 'X') {
      const move = choose(ai, engine);
      applyMove(engine, move[0], move[1]);
      setGame(engineToGameState(engine, { player: aiSymbol, boardIndex: move[0], cellIndex: move[1] }));
    } else {
      setGame(engineToGameState(engine));
    }
  }, [difficulty, aiSymbol]);

  useEffect(() => { startNewGame(); }, [startNewGame]);

  const handleCellClick = useCallback(
    (boardIndex: number, cellIndex: number) => {
      const engine = engineRef.current;
      const ai = aiRef.current;
      if (!engine || !ai || aiThinking || engine.winner || engine.drawn) return;
      if (engine.currentPlayer === aiSymbol) return;

      // Player move
      applyMove(engine, boardIndex, cellIndex);
      const afterPlayer = engineToGameState(engine, { player: playerSymbol, boardIndex, cellIndex });
      setGame(afterPlayer);

      // AI response (if game isn't over)
      if (!engine.winner && !engine.drawn) {
        setAiThinking(true);
        // Small delay so the UI updates before AI blocks
        setTimeout(() => {
          const move = choose(ai, engine);
          applyMove(engine, move[0], move[1]);
          setGame(engineToGameState(engine, { player: aiSymbol, boardIndex: move[0], cellIndex: move[1] }));
          setAiThinking(false);
        }, 50);
      }
    },
    [aiThinking, aiSymbol, playerSymbol]
  );

  if (!game) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-zinc-500 animate-pulse">Starting game...</div>
      </div>
    );
  }

  const isGameOver = !!game.winner || game.drawn;
  const youLabel = { turn: 'Your turn', win: 'You win' };
  const aiLabel = { turn: `${aiName}'s turn`, win: `${aiName} wins` };

  return (
    <div className="flex flex-col items-center gap-4 sm:gap-6 px-2">
      <div className="w-full flex items-center justify-between max-w-lg">
        <button
          onClick={onBack}
          className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          &larr; Menu
        </button>
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium ${playerSymbol === 'X' ? 'text-cyan-400' : 'text-rose-400'}`}>You ({playerSymbol})</span>
          <span className="text-zinc-600 text-xs">vs</span>
          <span className={`text-sm font-medium ${aiSymbol === 'X' ? 'text-cyan-400' : 'text-rose-400'}`}>{aiName} ({aiSymbol})</span>
        </div>
      </div>

      <GameStatus
        game={{...game, aiPending: aiThinking}}
        labelX={playerSymbol === 'X' ? youLabel : aiLabel}
        labelO={playerSymbol === 'O' ? youLabel : aiLabel}
      />
      <BigBoard
        game={game}
        onCellClick={handleCellClick}
        disabled={aiThinking || game.currentPlayer === aiSymbol}
      />

      {isGameOver && (
        <button
          onClick={startNewGame}
          className="rounded-xl bg-indigo-500 px-6 py-3 text-white font-semibold hover:bg-indigo-400 transition-colors shadow-lg shadow-indigo-500/25 active:scale-[0.98]"
        >
          Play Again
        </button>
      )}
    </div>
  );
}
