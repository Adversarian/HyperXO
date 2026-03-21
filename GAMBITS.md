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

## AI support

To be determined. Options in order of complexity:

1. **PvP only** — power-up mode disabled for AI games initially.
2. **Heuristic AI** — AI evaluates power-up use outside the search tree
   (check for game-winning or blocking plays, otherwise hold).
3. **Full search integration** — power-up activations as moves in the minimax
   tree. High branching factor increase; likely not worth the complexity.

## Future expansion

Each category can grow independently. New cards can be added to any category
without breaking the draft structure (players still pick 1 per category).
