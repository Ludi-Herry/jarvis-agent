/**
 * Pure geometry rules for the long-conversation aids. They decide only what the surface shows;
 * message facts, ordering and identity stay with the runtime projection.
 */

export interface TurnGeometry {
  readonly id: string;
  readonly questionTop: number;
  readonly questionBottom: number;
  readonly question: string;
  readonly answer: string;
}

export const MAP_MIN_WINDOW_WIDTH = 1200;
/** The track lives in the history gutter; 36px is enough for a 12px tick plus its focus ring. */
export const MAP_MIN_GUTTER = 36;
export const MAP_MIN_SCROLLABLE = 160;

/**
 * The sticky summary appears only after a whole question has left the top of the history area.
 * Scrolling further down hands over to the next question; scrolling back up reveals the original
 * and removes the summary again.
 */
export function selectStickyTurn(turns: readonly TurnGeometry[], scrollTop: number): TurnGeometry | null {
  let selected: TurnGeometry | null = null;
  for (const turn of turns) {
    if (turn.questionBottom <= scrollTop) selected = turn;
  }
  return selected;
}

export interface ConversationMapGate {
  readonly windowWidth: number;
  readonly gutterWidth: number;
  readonly turnCount: number;
  readonly scrollablePx: number;
  readonly hasScrolled: boolean;
}

/** The track needs a real gutter; a narrow window or an expanded detail pane takes it away. */
export function shouldShowConversationMap(gate: ConversationMapGate): boolean {
  return gate.windowWidth >= MAP_MIN_WINDOW_WIDTH
    && gate.gutterWidth >= MAP_MIN_GUTTER
    && gate.turnCount > 0
    && gate.scrollablePx >= MAP_MIN_SCROLLABLE
    && gate.hasScrolled;
}

export function tickFractions(turns: readonly TurnGeometry[], contentHeight: number): number[] {
  if (contentHeight <= 0) return turns.map(() => 0);
  return turns.map((turn) => Math.min(1, Math.max(0, turn.questionTop / contentHeight)));
}

export function currentTurnIndex(turns: readonly TurnGeometry[], scrollTop: number, viewportHeight: number): number {
  if (turns.length === 0) return -1;
  const middle = scrollTop + viewportHeight / 2;
  let index = 0;
  for (let position = 0; position < turns.length; position += 1) {
    if (turns[position].questionTop <= middle) index = position;
  }
  return index;
}

export function summarize(text: string, limit = 90): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
