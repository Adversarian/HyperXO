import { useState } from 'react';
import type { Difficulty, GameMode } from '../types';

interface Props {
  onStartAI: (difficulty: Difficulty, symbol: 'X' | 'O', aiName: string, mode: GameMode) => void;
  onHostGame: () => void;
  onJoinGame: () => void;
}

const MODES: { value: GameMode; label: string; desc: string; activeClass: string }[] = [
  { value: 'classic', label: 'Classic', desc: 'Standard rules', activeClass: 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/25' },
  { value: 'sudden-death', label: 'Sudden Death', desc: 'Win 1 board to win', activeClass: 'bg-orange-500 text-white shadow-lg shadow-orange-500/25' },
  { value: 'misere', label: 'Misère', desc: 'Avoid 3 in a row', activeClass: 'bg-violet-500 text-white shadow-lg shadow-violet-500/25' },
];

const DIFFICULTIES: { value: Difficulty; label: string; name: string; desc: string; activeClass: string }[] = [
  { value: 3, label: 'Easy', name: 'Novax', desc: 'Casual play', activeClass: 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/25' },
  { value: 5, label: 'Medium', name: 'Stratix', desc: 'A solid challenge', activeClass: 'bg-amber-500 text-white shadow-lg shadow-amber-500/25' },
  { value: 8, label: 'Hard', name: 'Terminus', desc: 'Expert level', activeClass: 'bg-rose-500 text-white shadow-lg shadow-rose-500/25' },
];

export default function Menu({ onStartAI, onHostGame, onJoinGame }: Props) {
  const [mode, setMode] = useState<GameMode>('classic');
  const [difficulty, setDifficulty] = useState<Difficulty>(3);
  const [symbol, setSymbol] = useState<'X' | 'O'>('X');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesVisible, setRulesVisible] = useState(false);

  const openRules = () => {
    setRulesOpen(true);
    requestAnimationFrame(() => setRulesVisible(true));
  };

  const closeRules = () => {
    setRulesVisible(false);
    setTimeout(() => setRulesOpen(false), 150);
  };

  return (
    <div className="flex flex-col items-center gap-8 px-4">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight bg-clip-text text-transparent animate-logo-glow">
          HyperXO
        </h1>
        <p className="text-zinc-500 text-sm">Ultimate Tic-Tac-Toe</p>
        <button
          onClick={openRules}
          className="mt-2 px-4 py-1.5 rounded-full text-sm text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 hover:border-indigo-500/50 hover:bg-indigo-500/10 transition-all"
        >
          How to Play
        </button>
      </div>

      {/* AI Game */}
      <div className="w-full max-w-lg flex flex-col gap-5">
        <h2 className="text-zinc-300 text-lg font-medium text-center">Play vs. AI</h2>

        <div className="grid grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              className={`
                flex flex-col items-center justify-center rounded-lg px-3 py-2.5 h-16 text-sm font-medium transition-all
                ${
                  mode === m.value
                    ? m.activeClass
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300'
                }
              `}
            >
              <div className="leading-tight">{m.label}</div>
              <div className={`text-xs whitespace-nowrap mt-0.5 ${mode === m.value ? 'text-white/80' : 'text-zinc-500'}`}>{m.desc}</div>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.value}
              onClick={() => setDifficulty(d.value)}
              className={`
                flex flex-col items-center justify-center rounded-lg px-3 py-2.5 h-16 text-sm font-medium transition-all
                ${
                  difficulty === d.value
                    ? d.activeClass
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300'
                }
              `}
            >
              <div className="leading-tight">{d.label}</div>
              <div className={`text-xs whitespace-nowrap mt-0.5 ${difficulty === d.value ? 'text-white/80' : 'text-zinc-500'}`}>{d.desc}</div>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-center gap-3">
          <span className="text-zinc-400 text-sm">Play as:</span>
          <button
            onClick={() => setSymbol('X')}
            className={`px-4 py-1.5 rounded-lg text-sm font-bold transition-all ${
              symbol === 'X'
                ? 'bg-cyan-500 text-white shadow-lg shadow-cyan-500/25'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            X (first)
          </button>
          <button
            onClick={() => setSymbol('O')}
            className={`px-4 py-1.5 rounded-lg text-sm font-bold transition-all ${
              symbol === 'O'
                ? 'bg-rose-500 text-white shadow-lg shadow-rose-500/25'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            O (second)
          </button>
        </div>

        <button
          onClick={() => onStartAI(difficulty, symbol, DIFFICULTIES.find(d => d.value === difficulty)!.name, mode)}
          className="w-full rounded-xl bg-indigo-500 px-6 py-3 text-white font-semibold hover:bg-indigo-400 transition-colors shadow-lg shadow-indigo-500/25 active:scale-[0.98]"
        >
          Start Game
        </button>
      </div>

      {!import.meta.env.VITE_PAGES && (
        <>
          {/* Divider */}
          <div className="flex items-center gap-4 w-full max-w-lg">
            <div className="flex-1 h-px bg-zinc-700" />
            <span className="text-zinc-600 text-xs">or</span>
            <div className="flex-1 h-px bg-zinc-700" />
          </div>

          {/* Friend Game */}
          <div className="w-full max-w-lg flex flex-col gap-3">
            <h2 className="text-zinc-300 text-lg font-medium text-center">Play with a Friend</h2>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={onHostGame}
                className="rounded-xl border border-zinc-700 bg-zinc-800/50 px-6 py-3 text-zinc-300 font-semibold hover:bg-zinc-700/50 hover:border-zinc-600 transition-all active:scale-[0.98]"
              >
                Host Game
              </button>
              <button
                onClick={onJoinGame}
                className="rounded-xl border border-zinc-700 bg-zinc-800/50 px-6 py-3 text-zinc-300 font-semibold hover:bg-zinc-700/50 hover:border-zinc-600 transition-all active:scale-[0.98]"
              >
                Join Game
              </button>
            </div>
          </div>
        </>
      )}

      {/* How to Play Modal */}
      {rulesOpen && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center px-4 transition-all duration-150 ${
            rulesVisible ? 'bg-zinc-950/95 backdrop-blur-sm' : 'bg-zinc-950/0'
          }`}
          onClick={closeRules}
        >
          <div
            className={`w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl text-left transition-all duration-150 ${
              rulesVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-zinc-200 text-lg font-semibold">How to Play</h2>
              <button
                onClick={closeRules}
                className="flex items-center justify-center h-9 w-9 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 text-2xl leading-none transition-all"
              >
                &times;
              </button>
            </div>
            <ol className="space-y-3 text-sm text-zinc-400 list-decimal list-outside ml-4">
              <li>
                The board is a <span className="text-zinc-300">3x3 grid of smaller tic-tac-toe boards</span>.
                Win three small boards in a row to win the game.
              </li>
              <li>
                <span className="text-zinc-300">Where you play determines where your opponent must play next.</span>{' '}
                If you place in the top-right cell of any board, your opponent is sent to the top-right board.
              </li>
              <li>
                The <span className="text-indigo-400">highlighted board</span> shows where you must play.
                If that board is already won or full, you get a free move anywhere.
              </li>
              <li>
                Win a small board the normal way — get <span className="text-cyan-400">three in a row</span>.
                Then win three <em>boards</em> in a row on the big grid.
              </li>
            </ol>
            <p className="mt-4 text-xs text-zinc-600">
              Tip: every move is a tradeoff between strengthening your position and controlling where your opponent plays next.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
