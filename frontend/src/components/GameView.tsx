import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Difficulty, GameMode, GameState, TurnPhase, MoveEntry } from '../types';
import type { PowerUpDraft, PowerUpState, ActiveCard, PowerUpCard, SiegeThreat } from '../engine/powerups';
import {
  createPowerUpState,
  useCard,
  getAvailableCards,
  CARD_CATALOG,
  applyRecall,
  applySabotage,
  applyOverwrite,
  applySwap,
  applyShatter,
  applyCondemn,
  applyRedirect,
  refreshSiegeThreats,
  advanceSiegeThreats,
  applySiegeClaim,
} from '../engine/powerups';
import {
  createGame as createEngine,
  availableMoves,
  applyMove,
  type HyperXOGame,
  type Player,
} from '../engine/game';
import { engineToGameState, isBoardLive, getNewlyWonBoards } from '../engine/utils';
import { createAI, choose, DIFFICULTY_PRESETS } from '../engine/ai';
import type { MinimaxAI, CardContext } from '../engine/ai';
import {
  aiBan as generateAiBan,
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
};

const toGameState = (engine: HyperXOGame, lastMove?: MoveEntry) =>
  engineToGameState(engine, 'local', lastMove);

export default function GameView({ difficulty, playerSymbol, aiName, mode, draft, playerBan, aiBan, onBack }: Props) {
  const [game, setGame] = useState<GameState | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [playerPU, setPlayerPU] = useState<PowerUpState | null>(null);
  const [activatingCard, setActivatingCard] = useState<ActiveCard | null>(null);
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('normal');
  const [siegeThreats, setSiegeThreats] = useState<SiegeThreat[]>([]);
  const [flashBoards, setFlashBoards] = useState<Map<number, string>>(new Map());
  const [recallSource, setRecallSource] = useState<{ boardIdx: number; cellIdx: number } | null>(null);
  const [aiNotification, setAiNotification] = useState<string | null>(null);
  const [aiPUDisplay, setAiPUDisplay] = useState<PowerUpState | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const aiHastePendingRef = useRef(false);

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

  const showAiNotification = useCallback((msg: string) => {
    if (notifTimeoutRef.current) clearTimeout(notifTimeoutRef.current);
    setAiNotification(msg);
    notifTimeoutRef.current = setTimeout(() => {
      setAiNotification(null);
      notifTimeoutRef.current = null;
    }, 2000);
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
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      if (notifTimeoutRef.current) clearTimeout(notifTimeoutRef.current);
    };
  }, []);

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
      showAiNotification(`${aiName}: Momentum!`);
      setGame(toGameState(engine, lastMove));

      setTimeout(() => {
        if (engine.winner || engine.drawn) { setAiThinking(false); return; }
        const move2 = choose(ai, engine);
        const prevW2 = engine.boards.map(b => b.winner);
        applyMove(engine, move2[0], move2[1]);
        const lastMove2 = { player: aiSymbol, boardIndex: move2[0], cellIndex: move2[1] };
        completeAfterAiMoveInner(engine, prevW2, lastMove2, hastePending);
      }, 400);
      return;
    }

    // AI flanking: any board won → AI auto-places bonus piece
    if (aiDoctrine === 'flanking' && newlyWon.length > 0 && !engine.winner && !engine.drawn) {
      engine.currentPlayer = aiSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
      engine.nextBoardIndex = null;
      engine.zkey ^= engine.zobrist.nbiKey(null);
      const bonusMove = choose(ai, engine);
      const prevW2 = engine.boards.map(b => b.winner);
      applyMove(engine, bonusMove[0], bonusMove[1]);
      const flankLastMove = { player: aiSymbol, boardIndex: bonusMove[0], cellIndex: bonusMove[1] };
      triggerFlash(newlyWon.map(w => w.i), 'emerald');
      showAiNotification(`${aiName}: Flanking!`);
      // Defer haste like the player path to avoid giving AI 3 turns
      completeAfterAiMoveInner(engine, prevW2, flankLastMove, hastePending);
      return;
    }

    // Player flanking: any board won after AI move → player bonus piece
    if (doctrine === 'flanking' && newlyWon.length > 0 && !engine.winner && !engine.drawn) {
      if (hastePending) aiHastePendingRef.current = true;
      engine.currentPlayer = playerSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
      engine.nextBoardIndex = null;
      engine.zkey ^= engine.zobrist.nbiKey(null);
      setTurnPhase('flanking-bonus');
      setGame(toGameState(engine, lastMove));
      triggerFlash(newlyWon.map(w => w.i), 'emerald');
      setAiThinking(false);
      return;
    }

    // AI haste second turn
    if (hastePending && !engine.winner && !engine.drawn) {
      engine.currentPlayer = aiSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      setGame(toGameState(engine, lastMove));

      setTimeout(() => {
        if (engine.winner || engine.drawn) { setAiThinking(false); return; }
        const move2 = choose(ai, engine);
        const prevW2 = engine.boards.map(b => b.winner);
        applyMove(engine, move2[0], move2[1]);
        const lastMove2 = { player: aiSymbol, boardIndex: move2[0], cellIndex: move2[1] };
        completeAfterAiMoveInner(engine, prevW2, lastMove2, false);
      }, 300);
      return;
    }

    // Normal: player's turn
    setGame(toGameState(engine, lastMove));
    setAiThinking(false);
  }, [aiSymbol, aiName, aiDoctrine, doctrine, playerSymbol, triggerFlash, showAiNotification, updateSiege]);

  // ---- Execute full AI turn (with card support) ----

  const doAiResponse = useCallback(() => {
    const engine = engineRef.current;
    const ai = aiRef.current;
    if (!engine || !ai || engine.winner || engine.drawn) return;

    syncCardContext();
    setAiThinking(true);

    const aiPU = aiPURef.current;
    const depthLevel = DIFFICULTY_PRESETS[difficulty].depth;

    // Step 1: Decide card usage
    const cardDecision = aiPU ? aiDecideCard(engine, aiPU, aiSymbol as Player, depthLevel) : null;

    let preCardWinners: (Player | null)[] | null = null;
    let flowCard: ActiveCard | null = null;

    if (cardDecision) {
      if (isPrePlacementCard(cardDecision.card)) {
        // Pre-placement card: apply with delay for visual feedback
        preCardWinners = engine.boards.map(b => b.winner);
        applyAiPreCard(engine, cardDecision);
        useCard(aiPU!, cardDecision.card);
        setAiPUDisplay({ ...aiPU! });

        const flashB = getCardFlashBoards(cardDecision);
        const flashC = getCardFlashColor(cardDecision.card);
        showAiNotification(`${aiName} used ${CARD_CATALOG[cardDecision.card].name}!`);
        if (flashB.length > 0) triggerFlash(flashB, flashC);
        setGame(toGameState(engine));

        // Delay before normal move
        setTimeout(() => {
          if (engine.winner || engine.drawn) {
            setGame(toGameState(engine));
            setAiThinking(false);
            return;
          }
          executeAiNormalMove(engine, ai, preCardWinners, null);
        }, 600);
        return;
      } else {
        // Flow modifier: mark for later
        flowCard = cardDecision.card;
        useCard(aiPU!, cardDecision.card);
        setAiPUDisplay({ ...aiPU! });
        showAiNotification(`${aiName} used ${CARD_CATALOG[cardDecision.card].name}!`);
      }
    }

    // No pre-card delay needed
    setTimeout(() => {
      executeAiNormalMove(engine, ai, null, flowCard);
    }, 50);
  }, [aiSymbol, aiName, difficulty, triggerFlash, showAiNotification, syncCardContext]);

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

    // Double-down: second piece on same board
    if (flowCard === 'double-down' && !engine.winner && !engine.drawn && isBoardLive(engine, move[0])) {
      engine.currentPlayer = aiSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
      engine.nextBoardIndex = move[0];
      engine.zkey ^= engine.zobrist.nbiKey(move[0]);
      const move2 = choose(ai, engine);
      applyMove(engine, move2[0], move2[1]);
    }
    // If DD fizzled (board won by first piece), just proceed normally

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

  // ---- Resumable AI turn (for haste second after player flanking) ----

  const resumeAiTurn = useCallback(() => {
    const engine = engineRef.current;
    const ai = aiRef.current;
    if (!engine || !ai || engine.winner || engine.drawn) return;

    setAiThinking(true);
    setTimeout(() => {
      const move = choose(ai, engine);
      const prevW = engine.boards.map(b => b.winner);
      applyMove(engine, move[0], move[1]);
      const lastMove = { player: aiSymbol, boardIndex: move[0], cellIndex: move[1] };
      completeAfterAiMove(engine, prevW, lastMove, false);
    }, 300);
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
        showAiNotification(`${aiName}: Siege claim!`);
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

    // AI flanking: player won a board → AI gets bonus piece
    if (aiDoctrine === 'flanking' && newlyWon.length > 0 && !engine.winner && !engine.drawn) {
      const ai = aiRef.current!;
      engine.currentPlayer = aiSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
      engine.nextBoardIndex = null;
      engine.zkey ^= engine.zobrist.nbiKey(null);
      const bonusMove = choose(ai, engine);
      applyMove(engine, bonusMove[0], bonusMove[1]);
      triggerFlash(newlyWon.map(w => w.i), 'emerald');
      showAiNotification(`${aiName}: Flanking!`);
      // Continue — the flanking bonus might have changed state
      // Recurse afterPlayerTurn to check for more passives
      afterPlayerTurn(engine, lastMove, engine.boards.map(b => b.winner));
      return;
    }

    // Player flanking: any board won → bonus piece anywhere
    if (doctrine === 'flanking' && newlyWon.length > 0 && !engine.winner && !engine.drawn) {
      engine.currentPlayer = playerSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
      engine.nextBoardIndex = null;
      engine.zkey ^= engine.zobrist.nbiKey(null);
      setTurnPhase('flanking-bonus');
      setGame(toGameState(engine, lastMove));
      triggerFlash(newlyWon.map(w => w.i), 'emerald');
      return;
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
  }, [playerSymbol, aiSymbol, aiName, doctrine, aiDoctrine, doAiResponse, triggerFlash, showAiNotification, updateSiege]);

  // ---- Start new game ----

  const startNewGame = useCallback(() => {
    const engine = createEngine(mode);
    const preset = DIFFICULTY_PRESETS[difficulty];
    const ai = createAI(aiSymbol, preset.depth, preset.blunderRate);
    engineRef.current = engine;
    aiRef.current = ai;
    setPlayerPU(draft ? createPowerUpState(draft) : null);
    setActivatingCard(null);
    setRecallSource(null);
    setTurnPhase('normal');
    updateSiege([]);
    setAiNotification(null);

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
      aiHastePendingRef.current = false;
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
    useCard(playerPU, card);
    setPlayerPU({ ...playerPU });
    setActivatingCard(null);
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
        if (card === 'condemn' || card === 'swap' || card === 'shatter') {
          try {
            preCardWinnersRef.current = engine.boards.map(b => b.winner);
            if (card === 'condemn') applyCondemn(engine, boardIndex);
            else if (card === 'swap') applySwap(engine, boardIndex);
            else applyShatter(engine, boardIndex);
            commitCard(card);
            if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
            refreshGame();
            triggerFlash([boardIndex], card === 'swap' ? 'violet' : card === 'shatter' ? 'rose' : 'zinc');
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

      // --- Flanking-bonus phase ---
      if (turnPhase === 'flanking-bonus') {
        if (aiThinking) return;
        const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
        if (!legal) return;
        const prevWinners = engine.boards.map(b => b.winner);
        applyMove(engine, boardIndex, cellIndex);
        const lastMove = { player: playerSymbol, boardIndex, cellIndex };
        setTurnPhase('normal');

        // If AI has a pending haste second turn, resume it
        if (aiHastePendingRef.current) {
          aiHastePendingRef.current = false;
          setGame(toGameState(engine, lastMove));
          resumeAiTurn();
          return;
        }

        afterPlayerTurn(engine, lastMove, prevWinners);
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

      // --- Normal / DD-second / Haste-second placement ---
      if (aiThinking) return;
      if (turnPhase === 'normal' && engine.currentPlayer !== playerSymbol) return;
      const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
      if (!legal) return;

      const savedPreCardWinners = preCardWinnersRef.current;
      preCardWinnersRef.current = null;
      const prevWinners = savedPreCardWinners ?? engine.boards.map(b => b.winner);
      applyMove(engine, boardIndex, cellIndex);
      const lastMove = { player: engine.currentPlayer === 'X' ? 'O' : 'X', boardIndex, cellIndex };

      // DD-second: done, check passives then AI responds
      if (turnPhase === 'dd-second') {
        setTurnPhase('normal');
        afterPlayerTurn(engine, lastMove, prevWinners);
        return;
      }

      // Haste-second: done, check passives then AI responds
      if (turnPhase === 'haste-second') {
        setTurnPhase('normal');
        afterPlayerTurn(engine, lastMove, prevWinners);
        return;
      }

      // --- Check for pending flow-modifier cards ---

      if (activatingCard === 'double-down' && !engine.winner && !engine.drawn) {
        const boardLive = isBoardLive(engine, boardIndex);
        // Undo player switch, force to same board for second piece
        engine.currentPlayer = playerSymbol as Player;
        engine.zkey ^= engine.zobrist.stmKey();
        if (boardLive) {
          engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
          engine.nextBoardIndex = boardIndex;
          engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
          commitCard('double-down');
          setTurnPhase('dd-second');
          setGame(toGameState(engine, lastMove));
          return;
        }
        // Board no longer live (first piece won it), just proceed normally
        engine.currentPlayer = engine.currentPlayer === 'X' ? 'O' : 'X';
        engine.zkey ^= engine.zobrist.stmKey();
        commitCard('double-down');
      }

      if (activatingCard === 'haste' && !engine.winner && !engine.drawn) {
        commitCard('haste');
        hasteFirstRef.current = true;
        afterPlayerTurn(engine, lastMove, prevWinners);
        return;
      }

      if (activatingCard === 'redirect' && !engine.winner && !engine.drawn) {
        commitCard('redirect');
        redirectPrevRef.current = { prevWinners, lastMove };
        setTurnPhase('redirect-pick');
        setGame(toGameState(engine, lastMove));
        return;
      }

      // --- Normal: check passives, then AI responds ---
      setActivatingCard(null);
      afterPlayerTurn(engine, lastMove, prevWinners);
    },
    [activatingCard, turnPhase, aiThinking, aiSymbol, playerSymbol, commitCard, refreshGame, doAiResponse, afterPlayerTurn, resumeAiTurn, triggerFlash]
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
        if ((activatingCard === 'swap' || activatingCard === 'shatter') && !b.cells.some(c => c !== '')) continue;
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
    turnPhase === 'dd-second'
      ? { label: 'Double Down', desc: 'Place your second piece on the same board' }
      : turnPhase === 'haste-second'
        ? { label: 'Haste', desc: 'Take your second consecutive turn' }
        : turnPhase === 'redirect-pick'
          ? { label: 'Redirect', desc: 'Click a board to send your opponent there' }
          : turnPhase === 'momentum-bonus'
            ? { label: 'Momentum', desc: 'You won a board — take a bonus turn!' }
            : turnPhase === 'flanking-bonus'
              ? { label: 'Flanking', desc: 'A board was won — place a bonus piece anywhere' }
              : activatingCard === 'recall' && !recallSource
                ? { label: 'Recall', desc: 'Click one of your pieces to pick it up' }
                : activatingCard === 'recall' && recallSource
                  ? { label: 'Recall', desc: 'Click an empty cell on another board to place it' }
                  : activatingCard && CARD_CATALOG[activatingCard].targetType === 'board'
                    ? { label: CARD_CATALOG[activatingCard].name, desc: 'Click a board to target' }
                    : activatingCard && CARD_CATALOG[activatingCard].targetType === 'opponent-cell'
                      ? { label: CARD_CATALOG[activatingCard].name, desc: 'Click an opponent piece to target' }
                      : null;

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

      {aiNotification && (
        <div className="rounded-lg bg-indigo-500/10 border border-indigo-500/30 px-4 py-2 text-center">
          <span className="text-indigo-400 text-sm font-semibold">{aiNotification}</span>
        </div>
      )}

      {phaseHint && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-2 text-center">
          <span className="text-amber-400 text-sm font-semibold">{phaseHint.label}</span>
          <span className="text-amber-400/70 text-xs block">{phaseHint.desc}</span>
        </div>
      )}

      {aiPUDisplay && (
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-xs text-zinc-600">{aiName}'s Gambits</span>
          <CardTray
            state={aiPUDisplay}
            onActivate={() => {}}
            activatingCard={null}
            disabled={true}
          />
        </div>
      )}

      <BigBoard
        game={game}
        onCellClick={handleCellClick}
        disabled={aiThinking || (!targeting && game.currentPlayer === aiSymbol)}
        targeting={targeting}
        flashBoards={flashBoards.size > 0 ? flashBoards : undefined}
        siegeCells={siegeCellsMap}
      />

      {playerPU && (
        <div className="flex flex-col items-center gap-1">
          <CardTray
            state={playerPU}
            onActivate={handleActivateCard}
            activatingCard={activatingCard}
            disabled={!isPlayerTurn || turnPhase !== 'normal'}
          />
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
