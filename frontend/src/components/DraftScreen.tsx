import { useState } from 'react';
import {
  CATEGORIES,
  CARD_CATALOG,
  CATEGORY_COLORS,
  STRIKE_CARDS,
  TACTICS_CARDS,
  DISRUPTION_CARDS,
  DOCTRINE_CARDS,
  isDraftComplete,
  type PowerUpDraft,
  type PowerUpCard,
} from '../engine/powerups';

interface Props {
  onReady: (draft: PowerUpDraft, ban: PowerUpCard | null) => void;
  onBack: () => void;
  /** Cards already banned (e.g. by opponent in PvP). Hidden from the draft pool. */
  banned?: Set<string>;
}

type Phase = 'ban' | 'draft';

const ACTIVE_CATS = CATEGORIES.filter(cat => cat.key !== 'doctrine');
const PASSIVE_CATS = CATEGORIES.filter(cat => cat.key === 'doctrine');

/** Divider row spanning 3 active columns */
function ActiveDivider() {
  return (
    <div className="col-span-1 sm:col-span-2 lg:col-span-3 flex items-center gap-3">
      <div className="flex-1 h-px bg-zinc-700/60" />
      <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Active</span>
      <div className="flex-1 h-px bg-zinc-700/60" />
    </div>
  );
}

/** Divider row spanning 1 passive column */
function PassiveDivider() {
  return (
    <div className="col-span-1 flex items-center gap-3">
      <div className="flex-1 h-px bg-zinc-700/60" />
      <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Passive</span>
      <div className="flex-1 h-px bg-zinc-700/60" />
    </div>
  );
}

export default function DraftScreen({ onReady, onBack, banned: externalBans }: Props) {
  // Skip ban phase if external bans were already provided (PvP flow)
  const [phase, setPhase] = useState<Phase>(externalBans ? 'draft' : 'ban');
  const [myBan, setMyBan] = useState<PowerUpCard | null>(null);
  const [picks, setPicks] = useState<Partial<PowerUpDraft>>({});

  // All banned cards (external + our own)
  const allBans = new Set<string>(externalBans ?? []);
  if (myBan) allBans.add(myBan);

  const select = (category: string, cardId: PowerUpCard) => {
    setPicks(prev => ({ ...prev, [category]: cardId }));
  };

  const complete = isDraftComplete(picks);

  // ---- Ban Phase ----
  if (phase === 'ban') {
    return (
      <div className="flex flex-col items-center gap-6 px-4 max-w-4xl mx-auto">
        <div className="w-full flex items-center justify-between">
          <button onClick={onBack} className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
            &larr; Back
          </button>
          <h2 className="text-zinc-200 text-lg font-semibold">Ban Phase</h2>
          <div className="w-12" />
        </div>
        <p className="text-zinc-500 text-sm">Ban one card to remove it from both players' draft pools, or skip.</p>

        {/* row-count: 1 divider + 1 header + 3 cards = 5 rows */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2 w-full lg:grid-rows-[auto_auto_1fr_1fr_1fr]">
          <ActiveDivider />
          <PassiveDivider />

          {ACTIVE_CATS.map(cat => {
            const colors = CATEGORY_COLORS[cat.key];
            return (
              <div key={cat.key} className="grid grid-rows-subgrid row-span-4 gap-2">
                <h3 className={`text-sm font-semibold text-center ${colors.text}`}>{cat.label}</h3>
                {cat.cards.map(cardId => {
                  const card = CARD_CATALOG[cardId];
                  const isBanned = myBan === cardId;
                  const externallyBanned = externalBans?.has(cardId);
                  if (externallyBanned) {
                    return (
                      <div
                        key={cardId}
                        className="text-left rounded-xl p-3 ring-1 bg-zinc-900 ring-zinc-800 opacity-30"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-zinc-500 line-through">{card.name}</span>
                          <span className="text-xs text-red-500">Opponent Ban</span>
                        </div>
                        <p className="text-xs text-zinc-500 mt-1">{card.description}</p>
                      </div>
                    );
                  }
                  return (
                    <button
                      key={cardId}
                      onClick={() => setMyBan(isBanned ? null : cardId)}
                      className={`
                        text-left rounded-xl p-3 ring-1 transition-all
                        ${isBanned
                          ? 'bg-red-500/20 ring-2 ring-red-500/60'
                          : 'bg-zinc-800/50 ring-zinc-700/50 hover:ring-zinc-600 hover:bg-zinc-800'
                        }
                      `}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`text-sm font-medium ${isBanned ? 'text-red-400 line-through' : 'text-zinc-200'}`}>
                          {card.name}
                        </span>
                        <span className={`text-xs ${isBanned ? 'text-red-400' : 'text-zinc-600'}`}>
                          {isBanned ? 'Banned' : card.flavor}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1">{card.description}</p>
                    </button>
                  );
                })}
              </div>
            );
          })}

          {PASSIVE_CATS.map(cat => {
            const colors = CATEGORY_COLORS[cat.key];
            return (
              <div key={cat.key} className="grid grid-rows-subgrid row-span-4 gap-2">
                <h3 className={`text-sm font-semibold text-center ${colors.text}`}>{cat.label}</h3>
                {cat.cards.map(cardId => {
                  const card = CARD_CATALOG[cardId];
                  const isBanned = myBan === cardId;
                  const externallyBanned = externalBans?.has(cardId);
                  if (externallyBanned) {
                    return (
                      <div
                        key={cardId}
                        className="text-left rounded-xl p-3 ring-1 bg-zinc-900 ring-zinc-800 opacity-30"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-zinc-500 line-through">{card.name}</span>
                          <span className="text-xs text-red-500">Opponent Ban</span>
                        </div>
                        <p className="text-xs text-zinc-500 mt-1">{card.description}</p>
                      </div>
                    );
                  }
                  return (
                    <button
                      key={cardId}
                      onClick={() => setMyBan(isBanned ? null : cardId)}
                      className={`
                        text-left rounded-xl p-3 ring-1 transition-all
                        ${isBanned
                          ? 'bg-red-500/20 ring-2 ring-red-500/60'
                          : 'bg-zinc-800/50 ring-zinc-700/50 hover:ring-zinc-600 hover:bg-zinc-800'
                        }
                      `}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`text-sm font-medium ${isBanned ? 'text-red-400 line-through' : 'text-zinc-200'}`}>
                          {card.name}
                        </span>
                        <span className={`text-xs ${isBanned ? 'text-red-400' : 'text-zinc-600'}`}>
                          {isBanned ? 'Banned' : card.flavor}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1">{card.description}</p>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setPhase('draft')}
            className="rounded-xl px-8 py-3 font-semibold transition-all bg-indigo-500 text-white hover:bg-indigo-400 shadow-lg shadow-indigo-500/25 active:scale-[0.98]"
          >
            {myBan ? 'Confirm Ban' : 'Skip Ban'}
          </button>
        </div>
      </div>
    );
  }

  // ---- Draft Phase ----
  return (
    <div className="flex flex-col items-center gap-6 px-4 max-w-4xl mx-auto">
      <div className="w-full flex items-center justify-between">
        <button onClick={externalBans ? onBack : () => { setPhase('ban'); setPicks({}); }} className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
          &larr; {externalBans ? 'Back' : 'Back to Ban'}
        </button>
        <h2 className="text-zinc-200 text-lg font-semibold">Draft Your Gambits</h2>
        <div className="w-12" />
      </div>
      <div className="flex items-center gap-3">
        <p className="text-zinc-500 text-sm">Pick one gambit from each category</p>
        <button
          onClick={() => {
            const pick = <T extends string>(arr: readonly T[]) => {
              const available = arr.filter(c => !allBans.has(c));
              return available[Math.floor(Math.random() * available.length)];
            };
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

      {myBan && (
        <div className="text-xs text-red-400/70 border border-red-500/20 rounded-lg px-3 py-1.5">
          Banned: <span className="font-semibold text-red-400">{CARD_CATALOG[myBan].name}</span>
        </div>
      )}

      {/* row-count: 1 divider + 1 header + 3 cards = 5 rows */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2 w-full lg:grid-rows-[auto_auto_1fr_1fr_1fr]">
        <ActiveDivider />
        <PassiveDivider />

        {ACTIVE_CATS.map(cat => {
          const colors = CATEGORY_COLORS[cat.key];
          const picked = picks[cat.key as keyof PowerUpDraft];
          return (
            <div key={cat.key} className="grid grid-rows-subgrid row-span-4 gap-2">
              <h3 className={`text-sm font-semibold text-center ${colors.text}`}>{cat.label}</h3>
              {cat.cards.map(cardId => {
                const card = CARD_CATALOG[cardId];
                const isBanned = allBans.has(cardId);
                if (isBanned) {
                  return (
                    <div
                      key={cardId}
                      className="text-left rounded-xl p-3 ring-1 bg-zinc-900 ring-zinc-800 opacity-30"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-zinc-500 line-through">{card.name}</span>
                        <span className="text-xs text-red-500">Banned</span>
                      </div>
                    </div>
                  );
                }
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

        {PASSIVE_CATS.map(cat => {
          const colors = CATEGORY_COLORS[cat.key];
          const picked = picks[cat.key as keyof PowerUpDraft];
          return (
            <div key={cat.key} className="grid grid-rows-subgrid row-span-4 gap-2">
              <h3 className={`text-sm font-semibold text-center ${colors.text}`}>{cat.label}</h3>
              {cat.cards.map(cardId => {
                const card = CARD_CATALOG[cardId];
                const isBanned = allBans.has(cardId);
                if (isBanned) {
                  return (
                    <div
                      key={cardId}
                      className="text-left rounded-xl p-3 ring-1 bg-zinc-900 ring-zinc-800 opacity-30"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-zinc-500 line-through">{card.name}</span>
                        <span className="text-xs text-red-500">Banned</span>
                      </div>
                    </div>
                  );
                }
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
        onClick={() => complete && onReady(picks as PowerUpDraft, myBan)}
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
