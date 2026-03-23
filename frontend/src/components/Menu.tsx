import { useState } from 'react';
import type { Difficulty, GameMode } from '../types';

type RulesTab = 'general' | 'modes' | 'gambits';

const RULES_TABS: { value: RulesTab; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'modes', label: 'Game Modes' },
  { value: 'gambits', label: 'Gambits' },
];

const MODE_DESCRIPTIONS: { id: string; label: string; color: string; desc: string }[] = [
  {
    id: 'classic', label: 'Classic', color: 'text-indigo-400',
    desc: 'The standard game mode. Line up three won boards in a row, column, or diagonal on the big grid to win. If every macro line is blocked (contains boards won by both players), the game ends in a draw.',
  },
  {
    id: 'sudden-death', label: 'Sudden Death', color: 'text-orange-400',
    desc: 'The first player to win any single board wins the entire game. Macro lines don\'t matter. Every 2-in-a-row threat is lethal — one mistake and it\'s over.',
  },
  {
    id: 'misere', label: 'Misère', color: 'text-violet-400',
    desc: 'Inverted rules: completing three boards in a row on the macro grid means you lose. Force your opponent into wins they don\'t want. Winning individual boards is fine — just don\'t complete a macro line.',
  },
  {
    id: 'conquest', label: 'Conquest', color: 'text-amber-400',
    desc: 'A point-based mode. 3 random boards are marked high-value (2 pts each), the rest are worth 1 pt. Win boards to score points — most points wins. The game ends early if the trailing player can\'t catch up. Tiebreaker: more high-value boards captured.',
  },
];

interface Props {
  onStartAI: (difficulty: Difficulty, symbol: 'X' | 'O', aiName: string, mode: GameMode, powerUps: boolean) => void;
  onHostGame: (mode: GameMode) => void;
  onJoinGame: () => void;
}

const MODES: { value: GameMode; label: string; desc: string; activeClass: string }[] = [
  { value: 'classic', label: 'Classic', desc: 'Standard rules', activeClass: 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/25' },
  { value: 'sudden-death', label: 'Sudden Death', desc: 'Win 1 board to win', activeClass: 'bg-orange-500 text-white shadow-lg shadow-orange-500/25' },
  { value: 'misere', label: 'Misère', desc: 'Avoid 3 in a row', activeClass: 'bg-violet-500 text-white shadow-lg shadow-violet-500/25' },
  { value: 'conquest', label: 'Conquest', desc: 'Score the most points', activeClass: 'bg-amber-500 text-white shadow-lg shadow-amber-500/25' },
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
  const [powerUps, setPowerUps] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesVisible, setRulesVisible] = useState(false);
  const [rulesTab, setRulesTab] = useState<RulesTab>('general');
  const [openMode, setOpenMode] = useState<string | null>(null);

  const openRules = () => {
    setRulesOpen(true);
    requestAnimationFrame(() => setRulesVisible(true));
  };

  const closeRules = () => {
    setRulesVisible(false);
    setTimeout(() => setRulesOpen(false), 150);
  };

  return (
    <div className="flex flex-col items-center gap-5 px-4">
      <div className="flex flex-col items-center gap-1">
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight bg-clip-text text-transparent animate-logo-glow">
          HyperXO
        </h1>
        <p className="text-zinc-500 text-sm">Ultimate Tic-Tac-Toe</p>
        <button
          onClick={openRules}
          className="mt-1.5 px-4 py-1.5 rounded-full text-sm text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 hover:border-indigo-500/50 hover:bg-indigo-500/10 transition-all"
        >
          How to Play
        </button>
      </div>

      {/* Game settings — shared across all play modes */}
      <div className="w-full max-w-lg flex flex-col gap-3">
        <div>
          <p className="text-zinc-500 text-xs text-center mb-2">Game Mode</p>
          <div className="grid grid-cols-2 gap-2">
            {MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => setMode(m.value)}
                className={`
                  flex flex-col items-center justify-center rounded-lg px-3 py-2 h-14 text-sm font-medium transition-all
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
        </div>

        <div className="flex items-center justify-center gap-3">
          <span className="text-zinc-400 text-sm relative group cursor-default">
            Gambits:
            <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-48 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-xs text-zinc-300 text-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
              Draft tactical power-ups to spice up the game
            </span>
          </span>
          <button
            onClick={() => setPowerUps(false)}
            className={`px-4 py-1.5 rounded-lg text-sm font-bold transition-all ${
              !powerUps
                ? 'bg-zinc-600 text-white'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            Off
          </button>
          <button
            onClick={() => setPowerUps(true)}
            className={`px-4 py-1.5 rounded-lg text-sm font-bold transition-all ${
              powerUps
                ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/25'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            On
          </button>
        </div>
      </div>

      {/* Play vs. AI */}
      <div className="w-full max-w-lg flex flex-col gap-3">
        <h2 className="text-zinc-300 text-lg font-medium text-center">Play vs. AI</h2>

        <div>
          <p className="text-zinc-500 text-xs text-center mb-2">Difficulty</p>
          <div className="grid grid-cols-3 gap-2">
            {DIFFICULTIES.map((d) => (
            <button
              key={d.value}
              onClick={() => setDifficulty(d.value)}
              className={`
                flex flex-col items-center justify-center rounded-lg px-3 py-2 h-14 text-sm font-medium transition-all
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
          onClick={() => onStartAI(difficulty, symbol, DIFFICULTIES.find(d => d.value === difficulty)!.name, mode, powerUps)}
          className="w-full rounded-xl bg-indigo-500 px-6 py-2.5 text-white font-semibold hover:bg-indigo-400 transition-colors shadow-lg shadow-indigo-500/25 active:scale-[0.98]"
        >
          {powerUps ? 'Draft Gambits' : 'Start Game'}
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
                onClick={() => onHostGame(mode)}
                className="rounded-xl border border-zinc-700 bg-zinc-800/50 px-6 py-2.5 text-zinc-300 font-semibold hover:bg-zinc-700/50 hover:border-zinc-600 transition-all active:scale-[0.98]"
              >
                Host Game
              </button>
              <button
                onClick={onJoinGame}
                className="rounded-xl border border-zinc-700 bg-zinc-800/50 px-6 py-2.5 text-zinc-300 font-semibold hover:bg-zinc-700/50 hover:border-zinc-600 transition-all active:scale-[0.98]"
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
            <div className="flex gap-1 mb-4 border-b border-zinc-800 pb-2">
              {RULES_TABS.map((tab) => (
                <button
                  key={tab.value}
                  onClick={() => setRulesTab(tab.value)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    rulesTab === tab.value
                      ? 'bg-indigo-500 text-white'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div key={rulesTab} className="animate-tab-fade">
            {rulesTab === 'general' && (
              <>
                <ol className="space-y-3 text-sm text-zinc-400 list-decimal list-outside ml-4">
                  <li>
                    The board is a <span className="text-zinc-300">3x3 grid of smaller tic-tac-toe boards</span>.
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
                  </li>
                </ol>
                <p className="mt-4 text-xs text-zinc-600">
                  Tip: every move is a tradeoff between strengthening your position and controlling where your opponent plays next.
                </p>
              </>
            )}

            {rulesTab === 'modes' && (
              <div className="space-y-1.5">
                {MODE_DESCRIPTIONS.map((m) => (
                  <div key={m.id}>
                    <button
                      onClick={() => setOpenMode(openMode === m.id ? null : m.id)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-800/60 hover:bg-zinc-800 transition-colors"
                    >
                      <span className={`text-sm font-medium ${m.color}`}>{m.label}</span>
                      <span className={`text-zinc-600 text-xs transition-transform duration-200 ${openMode === m.id ? 'rotate-180' : ''}`}>&#9662;</span>
                    </button>
                    <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${openMode === m.id ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                      <div className="overflow-hidden">
                        <p className="text-sm text-zinc-400 px-3 py-2">{m.desc}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {rulesTab === 'gambits' && (
              <>
                <p className="text-sm text-zinc-400 mb-3">
                  Enable <span className="text-zinc-300">Gambits</span> to draft tactical cards before the game.
                  Each player bans one card, then picks one from each of four categories:
                </p>
                <ul className="space-y-1.5 text-sm text-zinc-400 ml-1">
                  <li><span className="text-rose-400 font-medium">Strike</span> — power up your turn</li>
                  <li><span className="text-sky-400 font-medium">Tactics</span> — control the flow</li>
                  <li><span className="text-violet-400 font-medium">Disruption</span> — alter the board</li>
                  <li><span className="text-amber-400 font-medium">Doctrine</span> — passive ability active all game</li>
                </ul>
                <p className="text-xs text-zinc-500 mt-3">
                  You get 3 active cards (one-time use) and 1 passive doctrine.
                  Activate cards before placing your piece.
                </p>
              </>
            )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
