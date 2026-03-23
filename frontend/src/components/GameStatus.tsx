import type { GameState } from '../types';
import Mark from './Mark';

interface PlayerLabel {
  turn: string;   // e.g. "Your turn" or "Alice's turn"
  win: string;    // e.g. "You win" or "Alice wins"
}

interface Props {
  game: GameState;
  labelX: PlayerLabel;
  labelO: PlayerLabel;
}

export default function GameStatus({ game, labelX, labelO }: Props) {
  const labelFor = (mark: string) => mark === 'X' ? labelX : labelO;

  if (game.winner) {
    const isX = game.winner === 'X';
    const label = labelFor(game.winner);
    const scores = game.conquestScores;
    return (
      <div className={`text-center px-6 py-2 rounded-full animate-winner-glow ${
        isX ? 'bg-cyan-500/10 ring-1 ring-cyan-500/30' : 'bg-rose-500/10 ring-1 ring-rose-500/30'
      }`}>
        <span className={`text-2xl font-bold ${isX ? 'text-cyan-400' : 'text-rose-400'}`}>
          {label.win}!
        </span>
        {scores && (
          <span className="text-zinc-400 text-sm ml-2">
            ({scores.X} - {scores.O})
          </span>
        )}
      </div>
    );
  }

  if (game.drawn) {
    const scores = game.conquestScores;
    return (
      <div className="text-center px-6 py-2 rounded-full bg-zinc-800 ring-1 ring-zinc-700 animate-draw-in">
        <span className="text-2xl font-bold text-zinc-400">Draw!</span>
        {scores && (
          <span className="text-zinc-500 text-sm ml-2">
            ({scores.X} - {scores.O})
          </span>
        )}
      </div>
    );
  }

  const isX = game.currentPlayer === 'X';
  const label = labelFor(game.currentPlayer);

  return (
    <div className={`flex items-center justify-center gap-2 px-5 py-2 rounded-full transition-colors ${
      isX ? 'bg-cyan-500/10 ring-1 ring-cyan-500/20' : 'bg-rose-500/10 ring-1 ring-rose-500/20'
    }`}>
      <span className={`text-lg font-bold ${isX ? 'text-cyan-400' : 'text-rose-400'}`}>
        <Mark mark={game.currentPlayer} />
      </span>
      <span className="text-zinc-400 text-sm">
        {game.aiPending ? '' : `- ${label.turn}`}
      </span>
      {game.aiPending && (
        <span className="text-zinc-500 text-sm animate-pulse">
          - AI thinking...
        </span>
      )}
    </div>
  );
}
