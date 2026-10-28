/**
 * Client-only log lines of a room session (MP3 design §1.1): lines single player writes into its own
 * state's log, which a room may not (the replica is the room's, hashed and shared), such as the
 * healer's "helps you: +4 hp" line after "Ask for help". They are merged into the log view by turn
 * and never written into `state`.
 */
import type { LogMessage } from '../../engine/types';

/** lines kept at most (older ones have scrolled out of the log view long before) */
const MAX_LINES = 100;

export class LogOverlay {
  private kept: LogMessage[] = [];

  get lines(): readonly LogMessage[] {
    return this.kept;
  }

  add(line: LogMessage): void {
    this.kept.push(line);
    if (this.kept.length > MAX_LINES) this.kept.splice(0, this.kept.length - MAX_LINES);
  }

  /** `log` (oldest first) with the overlay's lines merged in by turn; an overlay line goes after the lines of its turn */
  merge(log: readonly LogMessage[]): LogMessage[] {
    if (!this.kept.length) return log as LogMessage[];
    const out: LogMessage[] = [];
    let i = 0;
    let j = 0;
    while (i < log.length || j < this.kept.length) {
      if (j >= this.kept.length || (i < log.length && log[i].turn <= this.kept[j].turn)) out.push(log[i++]);
      else out.push(this.kept[j++]);
    }
    return out;
  }
}
