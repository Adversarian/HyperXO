import { useState } from 'react';
import {
  CATEGORIES,
  CARD_CATALOG,
  STRIKE_CARDS,
  TACTICS_CARDS,
  DISRUPTION_CARDS,
  DOCTRINE_CARDS,
  isDraftComplete,
  type PowerUpDraft,
  type PowerUpCard,
  type PowerUpCategory,
} from '../engine/powerups';

interface Props {
  onReady: (draft: PowerUpDraft) => void;
  onBack: () => void;
}

const CATEGORY_COLORS: Record<PowerUpCategory, { active: string; text: string }> = {
  strike: { active: 'bg-rose-500/20 ring-rose-500/60', text: 'text-rose-400' },
  tactics: { active: 'bg-sky-500/20 ring-sky-500/60', text: 'text-sky-400' },
  disruption: { active: 'bg-violet-500/20 ring-violet-500/60', text: 'text-violet-400' },
  doctrine: { active: 'bg-amber-500/20 ring-amber-500/60', text: 'text-amber-400' },
};

export default function DraftScreen({ onReady, onBack }: Props) {
  const [picks, setPicks] = useState<Partial<PowerUpDraft>>({});

  const select = (category: PowerUpCategory, cardId: PowerUpCard) => {
    setPicks(prev => ({ ...prev, [category]: cardId }));
  };

  const complete = isDraftComplete(picks);

  return (
    <div className="flex flex-col items-center gap-6 px-4 max-w-4xl mx-auto">
      <div className="w-full flex items-center justify-between">
        <button onClick={onBack} className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
          &larr; Back
        </button>
        <h2 className="text-zinc-200 text-lg font-semibold">Draft Your Gambits</h2>
        <div className="w-12" />
      </div>
      <div className="flex items-center gap-3">
        <p className="text-zinc-500 text-sm">Pick one gambit from each category</p>
        <button
          onClick={() => {
            const pick = <T,>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];
            setPicks({
              strike: pick(STRIKE_CARDS),
              tactics: pick(TACTICS_CARDS),
              disruption: pick(DISRUPTION_CARDS),
              doctrine: pick(DOCTRINE_CARDS),
            });
          }}
          className="text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 hover:border-indigo-500/50 rounded-full px-3 py-1 transition-all hover:bg-indigo-500/10"
        >
          Randomize
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 w-full">
        {CATEGORIES.map(cat => {
          const colors = CATEGORY_COLORS[cat.key];
          const picked = picks[cat.key as keyof PowerUpDraft];
          return (
            <div key={cat.key} className="flex flex-col gap-2">
              <h3 className={`text-sm font-semibold text-center ${colors.text}`}>{cat.label}</h3>
              {cat.cards.map(cardId => {
                const card = CARD_CATALOG[cardId];
                const selected = picked === cardId;
                return (
                  <button
                    key={cardId}
                    onClick={() => select(cat.key, cardId)}
                    title={card.description}
                    className={`
                      text-left rounded-xl p-3 ring-1 transition-all
                      ${selected
                        ? `${colors.active} ring-2`
                        : 'bg-zinc-800/50 ring-zinc-700/50 hover:ring-zinc-600 hover:bg-zinc-800'
                      }
                    `}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-zinc-200">{card.name}</span>
                      <span className={`text-xs ${selected ? colors.text : 'text-zinc-600'}`}>{card.flavor}</span>
                    </div>
                    <p className="text-xs text-zinc-400 mt-1">{card.description}</p>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <button
        onClick={() => complete && onReady(picks as PowerUpDraft)}
        disabled={!complete}
        className={`
          rounded-xl px-8 py-3 font-semibold transition-all
          ${complete
            ? 'bg-indigo-500 text-white hover:bg-indigo-400 shadow-lg shadow-indigo-500/25 active:scale-[0.98]'
            : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
          }
        `}
      >
        Ready
      </button>
    </div>
  );
}
