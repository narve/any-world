/**
 * A short "arming" delay for modals that open in the middle of fast keyboard play (level-up perk
 * cards, GM offers): digits and Enter pressed within `ms` of the modal opening — or of its content
 * changing to a new choice — belong to the rhythm of quick-slot keys + Enter the player was in, not
 * to the card they have not read yet (issues/M5-levelup-accidental-pick.md). Pointer clicks and taps
 * are never blocked. Pure (clock injectable) so it is unit-tested without a DOM.
 */
export const MODAL_ARM_MS = 500;

export class KeyArm {
  private since = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly ms: number = MODAL_ARM_MS,
    private readonly now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  ) {}

  /** the modal opened, or now shows a different choice: start the delay again */
  reset(): void {
    this.since = this.now();
  }

  /** true once keys may act on the modal */
  armed(): boolean {
    return this.now() - this.since >= this.ms;
  }
}

/**
 * Whether a button click came from the keyboard (Enter / Space on a focused button): browsers report
 * `detail === 0` for those, a click count of 1+ for mouse, pen and touch.
 */
export function isKeyboardClick(ev: { detail?: number } | undefined): boolean {
  return !!ev && ev.detail === 0;
}
