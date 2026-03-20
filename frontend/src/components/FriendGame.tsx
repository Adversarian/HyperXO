import { useState, useEffect, useRef, useCallback } from 'react';
import type { GameState } from '../types';
import {
  createGame as createEngine,
  availableMoves,
  applyMove as engineApply,
  type HyperXOGame,
  type Player,
} from '../engine/game';
import BigBoard from './BigBoard';
import GameStatus from './GameStatus';

interface Props {
  ws: WebSocket;
  role: 'host' | 'guest';
  myName: string;
  opponentName: string;
  mySymbol: 'X' | 'O';
  onBack: () => void;
}

function engineToGameState(
  engine: HyperXOGame,
  lastMove?: { player: string; boardIndex: number; cellIndex: number },
): GameState {
  const moves = availableMoves(engine);
  return {
    id: 'p2p',
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

function freshGameState(): { engine: HyperXOGame; state: GameState } {
  const engine = createEngine();
  return { engine, state: engineToGameState(engine) };
}

export default function FriendGame({ ws, myName, opponentName, mySymbol, onBack }: Props) {
  const [game, setGame] = useState<GameState>(() => freshGameState().state);
  const [peerLeft, setPeerLeft] = useState(false);
  const engineRef = useRef<HyperXOGame>(createEngine());
  const gameRef = useRef(game);
  gameRef.current = game;

  const myMark: Player = mySymbol;

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'move') {
        const engine = engineRef.current;
        const player = engine.currentPlayer;
        engineApply(engine, msg.boardIndex, msg.cellIndex);
        setGame(engineToGameState(engine, { player, boardIndex: msg.boardIndex, cellIndex: msg.cellIndex }));
      } else if (msg.type === 'peer-status' && msg.status === 'left') {
        setPeerLeft(true);
      } else if (msg.type === 'rematch-accept') {
        const { engine, state } = freshGameState();
        engineRef.current = engine;
        setGame(state);
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  const handleCellClick = useCallback(
    (boardIndex: number, cellIndex: number) => {
      const g = gameRef.current;
      const engine = engineRef.current;
      if (g.winner || g.drawn || engine.currentPlayer !== myMark) return;
      const isLegal = g.availableMoves.some(m => m.board === boardIndex && m.cell === cellIndex);
      if (!isLegal) return;

      ws.send(JSON.stringify({ type: 'move', boardIndex, cellIndex }));
      const player = engine.currentPlayer;
      engineApply(engine, boardIndex, cellIndex);
      setGame(engineToGameState(engine, { player, boardIndex, cellIndex }));
    },
    [ws, myMark]
  );

  const isMyTurn = game.currentPlayer === myMark;
  const isGameOver = !!game.winner || game.drawn;

  const xName = mySymbol === 'X' ? myName : opponentName;
  const oName = mySymbol === 'O' ? myName : opponentName;

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
          <span className="text-sm font-medium text-cyan-400">{xName} (X)</span>
          <span className="text-zinc-600 text-xs">vs</span>
          <span className="text-sm font-medium text-rose-400">{oName} (O)</span>
        </div>
      </div>

      {peerLeft && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2 text-red-400 text-sm">
          Opponent disconnected
        </div>
      )}

      <GameStatus
        game={game}
        labelX={{ turn: `${xName}'s turn`, win: `${xName} wins` }}
        labelO={{ turn: `${oName}'s turn`, win: `${oName} wins` }}
      />

      <BigBoard
        game={game}
        onCellClick={handleCellClick}
        disabled={!isMyTurn || isGameOver || peerLeft}
      />

      {isGameOver && (
        <button
          onClick={() => {
            ws.send(JSON.stringify({ type: 'rematch-accept' }));
            const { engine, state } = freshGameState();
            engineRef.current = engine;
            setGame(state);
          }}
          className="rounded-xl bg-indigo-500 px-6 py-3 text-white font-semibold hover:bg-indigo-400 transition-colors shadow-lg shadow-indigo-500/25 active:scale-[0.98]"
        >
          Rematch
        </button>
      )}
    </div>
  );
}
