import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Difficulty, GameMode, GameState, TurnPhase, MoveEntry } from '../types';
import type { PowerUpDraft, PowerUpState, ActiveCard, PowerUpCard, SiegeThreat } from '../engine/powerups';
import {
  createPowerUpState,
  useCard as markCardUsed,
  getAvailableCards,
  CARD_CATALOG,
  applyRecall,
  applySabotage,
  applyOverwrite,
  applySwap,
  applyShatter,
  applyCondemn,
  applyRedirect,
  applyGravity,
  computeGravity,
  refreshSiegeThreats,
  advanceSiegeThreats,
  applySiegeClaim,
  rechargeRandomCard,
} from '../engine/powerups';
import {
  createGame as createEngine,
  availableMoves,
  applyMove,
  validateWinner,
  bigBoardState,
  type HyperXOGame,
  type Player,
} from '../engine/game';
import { engineToGameState, isBoardLive, getNewlyWonBoards } from '../engine/utils';
import { createAI, choose, DIFFICULTY_PRESETS } from '../engine/ai';
import type { MinimaxAI } from '../engine/ai';
import {
  aiDraft as generateAiDraft,
  aiDecideCard,
  isPrePlacementCard,
  applyAiPreCard,
  getCardFlashBoards,
  getCardFlashColor,
  aiRedirectTarget,
  type AiCardDecision,
} from '../engine/ai-gambits';
import BigBoard from './BigBoard';
import GameStatus from './GameStatus';
import CardTray from './CardTray';
import CombatLog, { type LogEntry, createLogEntry } from './CombatLog';
import Mark from './Mark';

interface Props {
  difficulty: Difficulty;
  playerSymbol: 'X' | 'O';
  aiName: string;
  mode: GameMode;
  draft: PowerUpDraft | null;
  playerBan?: PowerUpCard | null;
  aiBan?: PowerUpCard | null;
  onBack: () => void;
}

const MODE_LABELS: Record<GameMode, string> = {
  'classic': 'Classic',
  'sudden-death': 'Sudden Death',
  'misere': 'Misère',
  'conquest': 'Conquest',
};

const toGameState = (engine: HyperXOGame, lastMove?: MoveEntry) => {
  const gs = engineToGameState(engine, 'local', lastMove);
  // Validate winner on game over to catch misattribution bugs
  if (gs.winner || gs.drawn) {
    const err = validateWinner(engine);
    if (err) {
      console.error('[HyperXO] WINNER VALIDATION FAILED:', err);
      console.error('[HyperXO] Board state:', JSON.stringify({
        bigBoard: bigBoardState(engine),
        boardWinners: engine.boards.map(b => b.winner),
        currentPlayer: engine.currentPlayer,
        mode: engine.mode,
        winner: engine.winner,
        drawn: engine.drawn,
      }));
    }
  }
  return gs;
};

export default function GameView({ difficulty, playerSymbol, aiName, mode, draft, playerBan, aiBan, onBack }: Props) {
  const [game, setGame] = useState<GameState | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [playerPU, setPlayerPU] = useState<PowerUpState | null>(null);
  const [activatingCard, setActivatingCard] = useState<ActiveCard | null>(null);
  const [cardUsedThisTurn, setCardUsedThisTurn] = useState<ActiveCard | null>(null);
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('normal');
  const [siegeThreats, setSiegeThreats] = useState<SiegeThreat[]>([]);
  const [flashBoards, setFlashBoards] = useState<Map<number, string>>(new Map());
  const [recallSource, setRecallSource] = useState<{ boardIdx: number; cellIdx: number } | null>(null);
  const [aiPUDisplay, setAiPUDisplay] = useState<PowerUpState | null>(null);
  const [combatLog, setCombatLog] = useState<LogEntry[]>([]);
  const [gravityAnimation, setGravityAnimation] = useState<{ boardIdx: number; moves: Map<number, number> } | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engineRef = useRef<HyperXOGame | null>(null);
  const aiRef = useRef<MinimaxAI | null>(null);
  const siegeRef = useRef<SiegeThreat[]>([]);
  const redirectPrevRef = useRef<{ prevWinners: (Player | null)[]; lastMove: { player: string; boardIndex: number; cellIndex: number } } | null>(null);
  const hasteFirstRef = useRef(false);
  const preCardWinnersRef = useRef<(Player | null)[] | null>(null);

  // AI gambit state
  const aiDraftRef = useRef<PowerUpDraft | null>(null);
  const aiPURef = useRef<PowerUpState | null>(null);
  const aiSiegeRef = useRef<SiegeThreat[]>([]);
  const aiCardThisTurnRef = useRef<ActiveCard | null>(null);

  const aiSymbol = playerSymbol === 'X' ? 'O' : 'X';
  const doctrine = draft?.doctrine ?? null;
  const aiDoctrine = aiDraftRef.current?.doctrine ?? null;

  const triggerFlash = useCallback((boards: number[], color: string) => {
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    setFlashBoards(new Map(boards.map(b => [b, color])));
    flashTimeoutRef.current = setTimeout(() => {
      setFlashBoards(new Map());
      flashTimeoutRef.current = null;
    }, 600);
  }, []);

  const logEvent = useCallback((message: string, color = 'text-zinc-400') => {
    setCombatLog(prev => [...prev.slice(-19), createLogEntry(message, color)]);
  }, []);

  /** Sync both players' remaining cards onto the AI's cardCtx so minimax eval is card-aware. */
  const syncCardContext = useCallback(() => {
    const ai = aiRef.current;
    const aiPU = aiPURef.current;
    if (!ai || !draft) { if (ai) ai.cardCtx = null; return; }
    const myCards = aiPU ? getAvailableCards(aiPU).map(String) : [];
    const opponentCards = playerPU ? getAvailableCards(playerPU).map(String) : [];
    ai.cardCtx = { myCards, opponentCards };
  }, [draft, playerPU]);

  useEffect(() => {
    return () => { if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current); };
  }, []);

  // Clear gravity animation after it plays
  useEffect(() => {
    if (!gravityAnimation) return;
    const t = setTimeout(() => setGravityAnimation(null), 500);
    return () => clearTimeout(t);
  }, [gravityAnimation]);

  const updateSiege = useCallback((threats: SiegeThreat[]) => {
    siegeRef.current = threats;
    setSiegeThreats(threats);
  }, []);

  const siegeCellsMap = useMemo(() => {
    if (doctrine !== 'siege' || siegeThreats.length === 0) return undefined;
    const map = new Map<number, Set<number>>();
    for (const t of siegeThreats) {
      if (!map.has(t.boardIdx)) map.set(t.boardIdx, new Set());
      map.get(t.boardIdx)!.add(t.blockingCell);
    }
    return map;
  }, [doctrine, siegeThreats]);

  const refreshGame = useCallback((lastMove?: { player: string; boardIndex: number; cellIndex: number }) => {
    if (engineRef.current) setGame(toGameState(engineRef.current, lastMove));
  }, []);

  // ---- AI passive handling after AI moves ----

  const completeAfterAiMove = useCallback(function completeAfterAiMoveInner(
    engine: HyperXOGame,
    prevWinners: (Player | null)[],
    lastMove: { player: string; boardIndex: number; cellIndex: number },
    hastePending: boolean,
  ): void {
    if (engine.winner || engine.drawn) {
      setGame(toGameState(engine, lastMove));
      setAiThinking(false);
      return;
    }

    const ai = aiRef.current!;
    const newlyWon = getNewlyWonBoards(engine, prevWinners);
    const aiWonBoard = newlyWon.some(w => w.winner === aiSymbol);

    try {
    // AI siege refresh after AI's own move
    if (aiDoctrine === 'siege') {
      aiSiegeRef.current = refreshSiegeThreats(aiSiegeRef.current, engine, aiSymbol as Player);
    }

    // Player siege advance after AI move
    if (doctrine === 'siege') {
      const result = advanceSiegeThreats(siegeRef.current, engine, playerSymbol as Player);
      for (const claim of result.claimed) {
        applySiegeClaim(engine, claim.boardIdx, claim.cellIdx, playerSymbol as Player);
      }
      updateSiege(result.updated);
      if (result.claimed.length > 0) {
        triggerFlash(result.claimed.map(c => c.boardIdx), 'amber');
      }
      if (engine.winner || engine.drawn) {
        setGame(toGameState(engine, lastMove));
        setAiThinking(false);
        return;
      }
    }

    // AI momentum: AI won a board → bonus turn
    if (aiDoctrine === 'momentum' && aiWonBoard && !engine.winner && !engine.drawn) {
      engine.currentPlayer = aiSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      triggerFlash(
        newlyWon.filter(w => w.winner === aiSymbol).map(w => w.i),
        aiSymbol === 'X' ? 'cyan' : 'rose',
      );
      logEvent(`${aiName}: Momentum!`, 'text-amber-400');
      setGame(toGameState(engine, lastMove));

      setTimeout(() => {
        try {
          if (engine.winner || engine.drawn) { setAiThinking(false); return; }
          const move2 = choose(ai, engine);
          const prevW2 = engine.boards.map(b => b.winner);
          applyMove(engine, move2[0], move2[1]);
          const lastMove2 = { player: aiSymbol, boardIndex: move2[0], cellIndex: move2[1] };
          completeAfterAiMoveInner(engine, prevW2, lastMove2, hastePending);
        } catch (e) { console.error('AI momentum error:', e); setAiThinking(false); }
      }, 1200);
      return;
    }

    // Recompute newly won boards after siege (siege claims can win boards)
    const allNewlyWon = getNewlyWonBoards(engine, prevWinners);

    // AI arsenal: AI won a board on its turn → recharge a random used card
    if (aiDoctrine === 'arsenal' && allNewlyWon.some(w => w.winner === aiSymbol) && !engine.winner && !engine.drawn) {
      const aPU = aiPURef.current;
      if (aPU) {
        const recharged = rechargeRandomCard(aPU, aiCardThisTurnRef.current ?? undefined);
        if (recharged) { logEvent(`${aiName}: Arsenal — ${CARD_CATALOG[recharged].name} recharged!`, 'text-emerald-400'); setAiPUDisplay({ ...aPU }); }
      }
    }

    // AI haste second turn
    if (hastePending && !engine.winner && !engine.drawn) {
      engine.currentPlayer = aiSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      setGame(toGameState(engine, lastMove));

      setTimeout(() => {
        try {
          if (engine.winner || engine.drawn) { setAiThinking(false); return; }
          const move2 = choose(ai, engine);
          const prevW2 = engine.boards.map(b => b.winner);
          applyMove(engine, move2[0], move2[1]);
          const lastMove2 = { player: aiSymbol, boardIndex: move2[0], cellIndex: move2[1] };
          completeAfterAiMoveInner(engine, prevW2, lastMove2, false);
        } catch (e) { console.error('AI haste error:', e); setAiThinking(false); }
      }, 1000);
      return;
    }

    } catch (e) {
      console.error('AI passive error:', e);
    }

    // Normal: player's turn
    setGame(toGameState(engine, lastMove));
    setAiThinking(false);
    setCardUsedThisTurn(null);
  }, [aiSymbol, aiName, aiDoctrine, doctrine, playerSymbol, triggerFlash, logEvent, updateSiege]);

  // ---- Execute full AI turn (with card support) ----

  const doAiResponse = useCallback(() => {
    const engine = engineRef.current;
    const ai = aiRef.current;
    if (!engine || !ai || engine.winner || engine.drawn) return;

    syncCardContext();
    setAiThinking(true);
    aiCardThisTurnRef.current = null;

    const aiPU = aiPURef.current;
    const depthLevel = DIFFICULTY_PRESETS[difficulty].depth;

    // Step 1: Decide card usage
    let cardDecision: AiCardDecision | null = null;
    try {
      cardDecision = aiPU ? aiDecideCard(engine, aiPU, aiSymbol as Player, depthLevel) : null;
    } catch (e) { console.error('AI card decision error:', e); }

    let preCardWinners: (Player | null)[] | null = null;
    let flowCard: ActiveCard | null = null;

    if (cardDecision) {
      if (isPrePlacementCard(cardDecision.card)) {
        // Pre-placement card: apply with delay for visual feedback
        preCardWinners = engine.boards.map(b => b.winner);
        // Pre-compute gravity moves for animation before state changes
        let aiGravityMoves: Map<number, number> | undefined;
        if (cardDecision.card === 'gravity' && cardDecision.boardIdx !== undefined) {
          aiGravityMoves = computeGravity(engine.boards[cardDecision.boardIdx].cells as ('' | 'X' | 'O')[]);
        }
        try { applyAiPreCard(engine, cardDecision); } catch (e) {
          console.error('AI pre-card error:', e);
          preCardWinners = null;
          cardDecision = null;
        }
        if (cardDecision) {
          markCardUsed(aiPU!, cardDecision.card);
          aiCardThisTurnRef.current = cardDecision.card;
          setAiPUDisplay({ ...aiPU! });

          const flashB = getCardFlashBoards(cardDecision);
          const flashC = getCardFlashColor(cardDecision.card);
          logEvent(`${aiName} used ${CARD_CATALOG[cardDecision.card].name}!`, 'text-indigo-400');
          if (flashB.length > 0) triggerFlash(flashB, flashC);
          if (aiGravityMoves && aiGravityMoves.size > 0 && cardDecision.boardIdx !== undefined) {
            setGravityAnimation({ boardIdx: cardDecision.boardIdx, moves: aiGravityMoves });
          }
          setGame(toGameState(engine));

          // Delay before normal move
          setTimeout(() => {
            try {
              if (engine.winner || engine.drawn) {
                setGame(toGameState(engine));
                setAiThinking(false);
                return;
              }
              executeAiNormalMove(engine, ai, preCardWinners, null);
            } catch (e) { console.error('AI move after card error:', e); setAiThinking(false); }
          }, 1500);
          return;
        }
      } else {
        // Flow modifier: mark for later
        flowCard = cardDecision.card;
        markCardUsed(aiPU!, cardDecision.card);
        aiCardThisTurnRef.current = cardDecision.card;
        setAiPUDisplay({ ...aiPU! });
        logEvent(`${aiName} used ${CARD_CATALOG[cardDecision.card].name}!`, 'text-indigo-400');
      }
    }

    // Normal AI move (with flow card notification delay if applicable)
    setTimeout(() => {
      try {
        executeAiNormalMove(engine, ai, null, flowCard);
      } catch (e) { console.error('AI move error:', e); setAiThinking(false); }
    }, flowCard ? 800 : 500);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- executeAiNormalMove is defined below (mutual recursion)
  }, [aiSymbol, aiName, difficulty, triggerFlash, logEvent, syncCardContext]);

  const executeAiNormalMove = useCallback((
    engine: HyperXOGame,
    ai: MinimaxAI,
    preCardWinners: (Player | null)[] | null,
    flowCard: ActiveCard | null,
  ) => {
    if (engine.winner || engine.drawn) {
      setGame(toGameState(engine));
      setAiThinking(false);
      return;
    }

    const prevWinners = preCardWinners ?? engine.boards.map(b => b.winner);
    const move = choose(ai, engine);
    applyMove(engine, move[0], move[1]);
    const lastMove = { player: aiSymbol, boardIndex: move[0], cellIndex: move[1] };

    // Redirect: pick target after placement
    if (flowCard === 'redirect' && !engine.winner && !engine.drawn) {
      const target = aiRedirectTarget(engine, aiSymbol as Player);
      if (target >= 0) {
        try { applyRedirect(engine, target); } catch { /* invalid target */ }
      }
    }

    // Haste: check passives, then take second turn
    const hastePending = flowCard === 'haste' && !engine.winner && !engine.drawn;

    completeAfterAiMove(engine, prevWinners, lastMove, hastePending);
  }, [aiSymbol, completeAfterAiMove]);

  // ---- Check passives after player's full turn, before AI responds ----

  const afterPlayerTurn = useCallback((
    engine: HyperXOGame,
    lastMove: { player: string; boardIndex: number; cellIndex: number },
    prevWinners: (Player | null)[],
  ) => {
    if (engine.winner || engine.drawn) {
      setGame(toGameState(engine, lastMove));
      return;
    }

    const newlyWon = getNewlyWonBoards(engine, prevWinners);
    const playerWonBoard = newlyWon.some(w => w.winner === playerSymbol);

    // Player siege refresh after player move
    if (doctrine === 'siege') {
      updateSiege(refreshSiegeThreats(siegeRef.current, engine, playerSymbol as Player));
    }

    // AI siege advance after player move
    if (aiDoctrine === 'siege') {
      const result = advanceSiegeThreats(aiSiegeRef.current, engine, aiSymbol as Player);
      for (const claim of result.claimed) {
        applySiegeClaim(engine, claim.boardIdx, claim.cellIdx, aiSymbol as Player);
      }
      aiSiegeRef.current = result.updated;
      if (result.claimed.length > 0) {
        triggerFlash(result.claimed.map(c => c.boardIdx), 'amber');
        logEvent(`${aiName}: Siege claim!`, 'text-amber-400');
      }
      if (engine.winner || engine.drawn) {
        setGame(toGameState(engine, lastMove));
        return;
      }
    }

    // Player momentum: player won a board → bonus turn
    if (doctrine === 'momentum' && playerWonBoard && !engine.winner && !engine.drawn) {
      engine.currentPlayer = playerSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      setTurnPhase('momentum-bonus');
      setGame(toGameState(engine, lastMove));
      triggerFlash(
        newlyWon.filter(w => w.winner === playerSymbol).map(w => w.i),
        playerSymbol === 'X' ? 'cyan' : 'rose',
      );
      return;
    }

    // Recompute newly won boards after siege (siege claims can win boards)
    const allNewlyWon = getNewlyWonBoards(engine, prevWinners);

    // Player arsenal: player won a board on their turn → recharge a random used card
    if (doctrine === 'arsenal' && allNewlyWon.some(w => w.winner === playerSymbol) && !engine.winner && !engine.drawn && playerPU) {
      const recharged = rechargeRandomCard(playerPU, cardUsedThisTurn ?? undefined);
      if (recharged) { logEvent(`Arsenal — ${CARD_CATALOG[recharged].name} recharged!`, 'text-emerald-400'); setPlayerPU({ ...playerPU }); }
    }

    // Deferred haste: resume haste second turn after passives resolved
    if (hasteFirstRef.current) {
      hasteFirstRef.current = false;
      engine.currentPlayer = playerSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      setTurnPhase('haste-second');
      setGame(toGameState(engine, lastMove));
      return;
    }

    setGame(toGameState(engine, lastMove));
    doAiResponse();
  }, [playerSymbol, aiSymbol, aiName, doctrine, aiDoctrine, playerPU, cardUsedThisTurn, doAiResponse, triggerFlash, logEvent, updateSiege]);

  // ---- Start new game ----

  const startNewGame = useCallback(() => {
    const engine = createEngine(mode);
    const preset = DIFFICULTY_PRESETS[difficulty];
    const ai = createAI(aiSymbol, preset.depth, preset.blunderRate);
    engineRef.current = engine;
    aiRef.current = ai;
    setPlayerPU(draft ? createPowerUpState(draft) : null);
    setActivatingCard(null);
    setCardUsedThisTurn(null);
    setRecallSource(null);
    setTurnPhase('normal');
    setGravityAnimation(null);
    updateSiege([]);
    setCombatLog([]);

    // AI gambit setup
    if (draft) {
      // Collect bans: player's ban + AI's ban (AI ban was pre-generated)
      const bannedSet = new Set<string>();
      if (playerBan) bannedSet.add(playerBan);
      if (aiBan) bannedSet.add(aiBan);
      const aDraft = generateAiDraft(preset.depth, bannedSet);
      aiDraftRef.current = aDraft;
      const aPU = createPowerUpState(aDraft);
      aiPURef.current = aPU;
      aiSiegeRef.current = [];
      setAiPUDisplay({ ...aPU });
    } else {
      aiDraftRef.current = null;
      aiPURef.current = null;
      aiSiegeRef.current = [];
      setAiPUDisplay(null);
    }

    if (aiSymbol === 'X') {
      const move = choose(ai, engine);
      applyMove(engine, move[0], move[1]);
      setGame(toGameState(engine, { player: aiSymbol, boardIndex: move[0], cellIndex: move[1] }));
    } else {
      setGame(toGameState(engine));
    }
  }, [difficulty, aiSymbol, mode, draft, playerBan, aiBan, updateSiege]);

  useEffect(() => { startNewGame(); }, [startNewGame]);

  // --- Card activation ---

  const commitCard = useCallback((card: ActiveCard) => {
    if (!playerPU) return;
    markCardUsed(playerPU, card);
    setPlayerPU({ ...playerPU });
    setActivatingCard(null);
    setCardUsedThisTurn(card);
  }, [playerPU]);

  const handleActivateCard = useCallback((card: ActiveCard) => {
    const engine = engineRef.current;
    if (!engine || !playerPU || engine.currentPlayer !== playerSymbol) return;

    setActivatingCard(card);
    setRecallSource(null);
  }, [playerPU, playerSymbol]);

  const cancelActivation = useCallback(() => {
    setActivatingCard(null);
    setRecallSource(null);
  }, []);

  // --- Click handler ---

  const handleCellClick = useCallback(
    (boardIndex: number, cellIndex: number) => {
      const engine = engineRef.current;
      const ai = aiRef.current;
      if (!engine || !ai) return;
      if (engine.winner || engine.drawn) return;

      // --- Pre-placement targeting ---
      if (activatingCard && turnPhase === 'normal') {
        const card = activatingCard;

        // Board-target cards (pre-placement)
        if (card === 'condemn' || card === 'swap' || card === 'shatter' || card === 'gravity') {
          try {
            preCardWinnersRef.current = engine.boards.map(b => b.winner);
            if (card === 'condemn') applyCondemn(engine, boardIndex);
            else if (card === 'swap') applySwap(engine, boardIndex);
            else if (card === 'gravity') {
              const gravityMoves = applyGravity(engine, boardIndex);
              setGravityAnimation({ boardIdx: boardIndex, moves: gravityMoves });
            }
            else applyShatter(engine, boardIndex);
            commitCard(card);
            logEvent(`You used ${CARD_CATALOG[card].name}!`, 'text-cyan-400');
            if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
            refreshGame();
            triggerFlash([boardIndex], card === 'swap' ? 'violet' : card === 'shatter' ? 'rose' : card === 'gravity' ? 'amber' : 'zinc');
          } catch { /* invalid target, ignore */ }
          return;
        }

        // Recall: two-step targeting
        if (card === 'recall') {
          if (!recallSource) {
            const b = engine.boards[boardIndex];
            if (b.condemned || b.winner || b.drawn) return;
            if (b.cells[cellIndex] !== playerSymbol) return;
            setRecallSource({ boardIdx: boardIndex, cellIdx: cellIndex });
          } else {
            try {
              preCardWinnersRef.current = engine.boards.map(b => b.winner);
              applyRecall(engine, recallSource.boardIdx, recallSource.cellIdx, boardIndex, cellIndex);
              commitCard('recall');
              logEvent(`You used Recall!`, 'text-cyan-400');
              if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
              setRecallSource(null);
              refreshGame();
              triggerFlash([recallSource.boardIdx, boardIndex], 'sky');
            } catch { /* invalid target */ }
          }
          return;
        }

        // Cell-target cards (pre-placement)
        if (card === 'overwrite' || card === 'sabotage') {
          try {
            preCardWinnersRef.current = engine.boards.map(b => b.winner);
            if (card === 'overwrite') applyOverwrite(engine, boardIndex, cellIndex);
            else applySabotage(engine, boardIndex, cellIndex);
            commitCard(card);
            logEvent(`You used ${CARD_CATALOG[card].name}!`, 'text-cyan-400');
            if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
            refreshGame();
            triggerFlash([boardIndex], card === 'overwrite' ? 'rose' : 'violet');
          } catch { /* invalid target, ignore */ }
          return;
        }

        // Flow modifiers: fall through to placement (handled below)
      }

      // --- Redirect-pick phase ---
      if (turnPhase === 'redirect-pick') {
        try {
          applyRedirect(engine, boardIndex);
        } catch { /* invalid target, ignore */ return; }
        setTurnPhase('normal');
        const rp = redirectPrevRef.current;
        redirectPrevRef.current = null;
        if (rp) {
          afterPlayerTurn(engine, rp.lastMove, rp.prevWinners);
        } else {
          refreshGame();
          doAiResponse();
        }
        return;
      }

      // --- Momentum-bonus phase ---
      if (turnPhase === 'momentum-bonus') {
        if (aiThinking) return;
        const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
        if (!legal) return;
        const prevWinners = engine.boards.map(b => b.winner);
        applyMove(engine, boardIndex, cellIndex);
        const lastMove = { player: playerSymbol, boardIndex, cellIndex };
        setTurnPhase('normal');
        afterPlayerTurn(engine, lastMove, prevWinners);
        return;
      }

      // --- Normal / Haste-second placement ---
      if (aiThinking) return;
      if (turnPhase === 'normal' && engine.currentPlayer !== playerSymbol) return;
      const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
      if (!legal) return;

      const savedPreCardWinners = preCardWinnersRef.current;
      preCardWinnersRef.current = null;
      const prevWinners = savedPreCardWinners ?? engine.boards.map(b => b.winner);
      applyMove(engine, boardIndex, cellIndex);
      const lastMove = { player: engine.currentPlayer === 'X' ? 'O' : 'X', boardIndex, cellIndex };

      // Haste-second: done, check passives then AI responds
      if (turnPhase === 'haste-second') {
        setTurnPhase('normal');
        afterPlayerTurn(engine, lastMove, prevWinners);
        return;
      }

      // --- Check for pending flow-modifier cards ---

      if (activatingCard === 'haste' && !engine.winner && !engine.drawn) {
        commitCard('haste');
        logEvent('You used Haste!', 'text-cyan-400');
        hasteFirstRef.current = true;
        afterPlayerTurn(engine, lastMove, prevWinners);
        return;
      }

      if (activatingCard === 'redirect' && !engine.winner && !engine.drawn) {
        commitCard('redirect');
        logEvent('You used Redirect!', 'text-cyan-400');
        redirectPrevRef.current = { prevWinners, lastMove };
        setTurnPhase('redirect-pick');
        setGame(toGameState(engine, lastMove));
        return;
      }

      // --- Normal: check passives, then AI responds ---
      setActivatingCard(null);
      afterPlayerTurn(engine, lastMove, prevWinners);
    },
    [activatingCard, turnPhase, aiThinking, playerSymbol, commitCard, refreshGame, doAiResponse, afterPlayerTurn, triggerFlash, logEvent, recallSource]
  );

  // --- Compute targeting info ---

  const targeting = (() => {
    const engine = engineRef.current;
    if (!engine || !activatingCard || turnPhase !== 'normal') {
      if (turnPhase === 'redirect-pick' && engine) {
        const validBoards = new Set<number>();
        for (let i = 0; i < 9; i++) {
          if (isBoardLive(engine, i)) validBoards.add(i);
        }
        return { mode: 'board' as const, validBoards };
      }
      return null;
    }

    const def = CARD_CATALOG[activatingCard];

    // Recall: two-step targeting
    if (activatingCard === 'recall') {
      if (!recallSource) {
        const validBoards = new Set<number>();
        for (let i = 0; i < 9; i++) {
          if (isBoardLive(engine, i) && engine.boards[i].cells.some(c => c === playerSymbol))
            validBoards.add(i);
        }
        return { mode: 'opponent-cell' as const, validBoards, opponentSymbol: playerSymbol };
      } else {
        const validBoards = new Set<number>();
        for (let i = 0; i < 9; i++) {
          if (i === recallSource.boardIdx) continue;
          if (isBoardLive(engine, i) && engine.boards[i].cells.some(c => c === ''))
            validBoards.add(i);
        }
        return { mode: 'opponent-cell' as const, validBoards, opponentSymbol: '' };
      }
    }

    if (def.targetType === 'board') {
      const validBoards = new Set<number>();
      for (let i = 0; i < 9; i++) {
        const b = engine.boards[i];
        if (b.condemned) continue;
        if (activatingCard === 'condemn' && (b.winner || b.drawn)) continue;
        if (activatingCard === 'swap' && (b.winner || b.drawn)) continue;
        if (activatingCard === 'gravity' && (b.winner || b.drawn)) continue;
        if ((activatingCard === 'swap' || activatingCard === 'shatter') && !b.cells.some(c => c !== '')) continue;
        if (activatingCard === 'gravity' && computeGravity(b.cells as ('' | 'X' | 'O')[]).size === 0) continue;
        validBoards.add(i);
      }
      return { mode: 'board' as const, validBoards };
    }

    if (def.targetType === 'opponent-cell') {
      const validBoards = new Set<number>();
      for (let i = 0; i < 9; i++) {
        const b = engine.boards[i];
        if (b.condemned) continue;
        if (activatingCard === 'overwrite' && (b.winner || b.drawn)) continue;
        if (b.cells.some(c => c === aiSymbol)) validBoards.add(i);
      }
      return { mode: 'opponent-cell' as const, validBoards, opponentSymbol: aiSymbol };
    }

    return null;
  })();

  // --- Render ---

  if (!game) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-zinc-500 animate-pulse">Starting game...</div>
      </div>
    );
  }

  const isGameOver = !!game.winner || game.drawn;
  const isPlayerTurn = game.currentPlayer === playerSymbol && !aiThinking && !isGameOver;
  const youLabel = { turn: 'Your turn', win: 'You win' };
  const aiLabel = { turn: `${aiName}'s turn`, win: `${aiName} wins` };

  const phaseHint =
    turnPhase === 'haste-second'
      ? { label: 'Haste', desc: 'Take your second consecutive turn' }
      : turnPhase === 'redirect-pick'
          ? { label: 'Redirect', desc: 'Click a board to send your opponent there' }
          : turnPhase === 'momentum-bonus'
            ? { label: 'Momentum', desc: 'You won a board — take a bonus turn!' }
            : activatingCard === 'recall' && !recallSource
                ? { label: 'Recall', desc: 'Click one of your pieces to pick it up' }
                : activatingCard === 'recall' && recallSource
                  ? { label: 'Recall', desc: 'Click an empty cell on another board to place it' }
                  : activatingCard && CARD_CATALOG[activatingCard].targetType === 'board'
                    ? { label: CARD_CATALOG[activatingCard].name, desc: 'Click a board to target' }
                    : activatingCard && CARD_CATALOG[activatingCard].targetType === 'opponent-cell'
                      ? { label: CARD_CATALOG[activatingCard].name, desc: 'Click an opponent piece to target' }
                      : null;

  const hasGambits = !!(playerPU || aiPUDisplay);

  return (
    <div className="flex flex-col items-center gap-4 sm:gap-5 px-2">
      <div className="w-full flex items-center justify-between max-w-lg">
        <button
          onClick={onBack}
          className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          &larr; Menu
        </button>
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium inline-flex items-center gap-1 ${playerSymbol === 'X' ? 'text-cyan-400' : 'text-rose-400'}`}>You <Mark mark={playerSymbol} /></span>
          <span className="text-zinc-600 text-xs">vs</span>
          <span className={`text-sm font-medium inline-flex items-center gap-1 ${aiSymbol === 'X' ? 'text-cyan-400' : 'text-rose-400'}`}>{aiName} <Mark mark={aiSymbol} /></span>
          {mode !== 'classic' && (
            <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">{MODE_LABELS[mode]}</span>
          )}
          {draft && (
            <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">Gambits</span>
          )}
        </div>
      </div>

      <GameStatus
        game={{...game, aiPending: aiThinking}}
        labelX={playerSymbol === 'X' ? youLabel : aiLabel}
        labelO={playerSymbol === 'O' ? youLabel : aiLabel}
      />

      {mode === 'conquest' && game.conquestScores && (
        <div className="flex items-center gap-3 px-4 py-1.5 rounded-full bg-zinc-800/80 border border-zinc-700/50">
          <span className="text-cyan-400 font-bold text-sm">{game.conquestScores.X}</span>
          <span className="text-zinc-600 text-xs">pts</span>
          <div className="w-px h-4 bg-zinc-700" />
          <span className="text-rose-400 font-bold text-sm">{game.conquestScores.O}</span>
          <span className="text-zinc-600 text-xs">pts</span>
        </div>
      )}

      {phaseHint && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-2 text-center">
          <span className="text-amber-400 text-sm font-semibold">{phaseHint.label}</span>
          <span className="text-amber-400/70 text-xs block">{phaseHint.desc}</span>
        </div>
      )}

      {/* Main area: side cards on wide screens, stacked on mobile */}
      <div className={hasGambits
        ? 'flex flex-col lg:flex-row lg:items-start lg:gap-4 w-full max-w-4xl'
        : 'flex flex-col items-center'
      }>
        {/* Left panel: AI cards (lg: side, mobile: above board) */}
        {aiPUDisplay && (
          <div className="lg:w-36 shrink-0 flex flex-col items-center gap-1 mb-3 lg:mb-0 lg:pt-8">
            <span className="text-xs text-zinc-600">{aiName}</span>
            <div className="hidden lg:block w-full">
              <CardTray state={aiPUDisplay} onActivate={() => {}} activatingCard={null} disabled={true} vertical />
            </div>
            <div className="lg:hidden">
              <CardTray state={aiPUDisplay} onActivate={() => {}} activatingCard={null} disabled={true} />
            </div>
          </div>
        )}

        {/* Center: board + log */}
        <div className="flex flex-col items-center gap-3 flex-1 min-w-0">
          <BigBoard
            game={game}
            onCellClick={handleCellClick}
            disabled={aiThinking || (!targeting && game.currentPlayer === aiSymbol)}
            targeting={targeting}
            flashBoards={flashBoards.size > 0 ? flashBoards : undefined}
            siegeCells={siegeCellsMap}
            conquestBonusBoards={game.conquestBonusBoards ? new Set(game.conquestBonusBoards) : undefined}
            gravityMoves={gravityAnimation?.moves}
            gravityBoardIdx={gravityAnimation?.boardIdx}
          />
          {hasGambits && <CombatLog entries={combatLog} />}
        </div>

        {/* Right panel: Player cards (lg: side, mobile: below board) */}
        {playerPU && (
          <div className="lg:w-36 shrink-0 flex flex-col items-center gap-1 mt-3 lg:mt-0 lg:pt-8">
            <span className="text-xs text-zinc-600">You</span>
            <div className="hidden lg:block w-full">
              <CardTray
                state={playerPU}
                onActivate={handleActivateCard}
                activatingCard={activatingCard}
                disabled={!isPlayerTurn || turnPhase !== 'normal' || !!cardUsedThisTurn}
                vertical
              />
            </div>
            <div className="lg:hidden">
              <CardTray
                state={playerPU}
                onActivate={handleActivateCard}
                activatingCard={activatingCard}
                disabled={!isPlayerTurn || turnPhase !== 'normal' || !!cardUsedThisTurn}
              />
            </div>
            {activatingCard && (
              <button
                onClick={cancelActivation}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

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
