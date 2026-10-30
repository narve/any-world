/**
 * The live game master, client side (DESIGN §4.3).
 *
 *  - The director contract, the OFFLINE director, hook detection (`gmHooksFor`, `HookTracker`) and
 *    response helpers live in src/gm/offline.ts (shared with the room server, MP2) and are
 *    re-exported here; the client's OfflineGmDirector labels its offers with the client's i18n.
 *  - `GmRunner` calls a director WITHOUT ever blocking turns (queue, timeout, fallback, epochs). It
 *    lives in src/gm/runner.ts (shared with the room server, MP4) and is re-exported here.
 *
 * Results are applied by the controller through GameSession.applyGm → engine applyGmActions, which
 * enforces the GM budget, references and rule limits. Nothing in here touches the DOM.
 */
import { t as tr } from './i18n/index';
import { OfflineGmDirector as SharedOfflineGmDirector, type OfflineDirectorOptions } from '../gm/offline';

export { GmRunner, partyCoalesce, type GmResult, type GmRunnerOptions } from '../gm/runner';

export {
  FIRST_IDLE_TURNS,
  IDLE_TURNS,
  drainEngineQueue,
  engineQueuedHooks,
  eventFlag,
  gmHooksFor,
  hashOf,
  isGmActionType,
  narrationOf,
  newHookTracker,
  responseCost,
  saidFlag,
  sanitizeResponse,
  type Difficulty,
  type GmContext,
  type GmDirector,
  type GmHookDetail,
  type GmHookEvent,
  type GmRequest,
  type GmTranslate,
  type HookTracker,
  type OfflineDirectorOptions,
} from '../gm/offline';

/** the offline director with the client's i18n labels (src/gm/offline.ts) */
export class OfflineGmDirector extends SharedOfflineGmDirector {
  constructor(opts: OfflineDirectorOptions = {}) {
    super({ t: tr, ...opts });
  }
}
