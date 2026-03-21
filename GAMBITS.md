# HyperXO Power-Up Mode Design

Power-Up mode adds a pre-game draft and in-game card activations on top of the
standard Ultimate Tic-Tac-Toe rules.

## Draft

Before the game starts each player selects **1 card from each of the 4 categories**
(3 active + 1 passive = 4-card build). Both players draft independently; duplicate
picks across players are allowed.

Total possible loadouts: 3 x 3 x 3 x 3 = **81**.

## Activation

- **Active cards** are one-time use. On your turn you may activate one active card
  **before** placing your normal piece. You always place a piece — power-ups are a
  bonus, not a replacement.
- **Passive (Doctrine) cards** are always-on effects that apply for the entire game.

## Categories

### 1. Strike (empower your turn)

| Card | Effect |
|------|--------|
| **Double Down** | Place two pieces on the same board this turn. Both follow normal placement rules (empty cells only). The second piece determines the opponent's directed board. |
| **Haste** | Take two consecutive turns. After placing your first piece and being directed, immediately take another full turn before your opponent plays. |
| **Overwrite** | Before placing, replace one opponent piece on any live board with your own. The overwritten cell now belongs to you. Then place your normal piece as usual. |

### 2. Tactics (control the game flow)

| Card | Effect |
|------|--------|
| **Redirect** | After placing your piece, choose which board your opponent is sent to (instead of the normal cell-based direction). The chosen board must be live (not won or drawn). |
| **Recall** | Before placing, relocate one of your pieces from any live board to an empty cell on a different live board. The source board is recalculated. Then place your normal piece. |
| **Condemn** | Before placing, permanently remove one live board from play. It becomes dead (treated as drawn for macro purposes — no one gets credit). Then place your normal piece. |

### 3. Disruption (alter existing board state)

| Card | Effect |
|------|--------|
| **Swap** | Before placing, choose one live board and exchange all X and O pieces on it. X becomes O, O becomes X. Board-win status is recalculated. Then place your normal piece. |
| **Shatter** | Before placing, choose one board and remove all pieces from it. If that board was previously won, the win is revoked. Then place your normal piece. |
| **Sabotage** | Before placing, remove one opponent piece from any board (including won boards — if this breaks a winning line, the win is revoked). Then place your normal piece. |

### 4. Doctrine (passive — always on)

| Card | Effect |
|------|--------|
| **Momentum** | Whenever you win a small board, immediately take an extra turn before your opponent plays. |
| **Siege** | Track your 2-in-a-row threats on each small board. If a threat goes unchallenged (opponent does not place in the blocking cell) for 3 consecutive turns, you automatically claim the 3rd cell and the board is checked for a win. |
| **Flanking** | Whenever any board is won (by either player), you immediately place a bonus piece on any empty cell on any live board. |

## Balance notes

- **Counter-drafting is natural.** Opponent picks Double Down? Shatter their
  target board. Opponent picks Redirect? Recall repositions around the trap.
  Opponent picks Haste? Swap flips what they built.
- **Categories ensure variety.** You always have one offensive, one tactical,
  one disruptive, and one passive tool. No all-offense or all-chaos decks.
- **Passives set the pace.** Momentum snowballs board wins. Siege punishes
  passive defense. Flanking floods the board with pieces after every board
  completion. All three push the game toward faster resolution.
- **3 active uses in a 40-80 move game** means ~5% of turns have a power-up.
  Impactful moments without overwhelming the core game.

## Ban Phase

Before drafting, each player independently bans **1 card** (or skips). Bans
are revealed simultaneously, then both players draft from the reduced pool.
Banned cards are removed for both players; duplicate bans are allowed (both
players waste a ban on the same card).

## AI support

The AI uses a hybrid approach combining card-aware evaluation with heuristic
card timing:

1. **Card-aware minimax evaluation** — the static evaluation function at every
   leaf node of the search tree adjusts scores based on both players' remaining
   cards. Opponent has shatter? Won boards are discounted. AI has overwrite?
   Blocked threats are less of a problem. Mode-specific adjustments exist for
   sudden death (haste is near-lethal) and misère (swap is devastating).

2. **Simulation-based card valuation** — before each AI turn, every available
   card is evaluated by simulating its effect and measuring position improvement
   via `evaluateForPlayer`. Flow modifiers (double-down, haste, redirect) are
   evaluated by simulating the actual move sequences they enable.

3. **Urgency system** — raw card values are multiplied by a situational urgency
   factor based on macro board threats, game progress, and card scarcity. This
   makes the hard AI patient (holds cards for critical moments) while the easy
   AI is impulsive (uses cards on small advantages).

4. **Deep verify** — the top card candidate is verified with a reduced-depth
   minimax search (depth−2, capped at 4) comparing "card + best follow-up" vs
   "best move without card". Catches cases where the heuristic likes a card but
   multi-ply consequences are bad.

5. **Mode-aware banning** — the AI bans the most threatening card for the game
   mode (haste in sudden death, swap in misère, haste in classic).

### Difficulty scaling

| Level | Ban | Card evaluation | Threshold | Behavior |
|-------|-----|-----------------|-----------|----------|
| Easy  | Random | 60% skip rate | 12 (low) | Impulsive — uses cards on small advantages |
| Medium | Top 3 | Always evaluates | 25 | Moderate restraint |
| Hard  | Best threat | Always evaluates | 45 (high) | Patient — saves cards for critical moments |

## Future expansion

Each category can grow independently. New cards can be added to any category
without breaking the draft structure (players still pick 1 per category).
