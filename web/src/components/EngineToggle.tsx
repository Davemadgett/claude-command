import type { AppConfig, EngineId } from '../types';

type Props = {
  config: AppConfig;
  onChange: (engine: EngineId) => void;
};

/**
 * Which coding agent the next session will be.
 *
 * Sits beside "+ New session" because that is the button it governs, and it is
 * a switch rather than a menu so the answer is readable without clicking:
 * whatever is lit is what starts. One choice for the whole board — the note in
 * server/engines.js says why it isn't per-card.
 *
 * Cards already on the board are unaffected, and the title says so. That is the
 * one thing about this control that isn't obvious from looking at it, and
 * getting it wrong would mean expecting a Claude conversation to reopen in
 * Codex.
 *
 * An engine that isn't installed is shown and disabled rather than hidden.
 * Hiding it makes a board that can only ever be one thing look like a board that
 * was only ever built for one thing, and there would be nothing to tell you the
 * other half exists.
 */
export function EngineToggle({ config, onChange }: Props) {
  const engines = config.engines ?? [];
  // Nothing to choose between — don't put a control there at all.
  if (engines.length < 2) return null;

  return (
    <div className="engine-toggle" role="group" aria-label="Engine for new sessions">
      {engines.map((e) => {
        const on = e.id === config.engine;
        return (
          <button
            key={e.id}
            className={`engine-choice${on ? ' on' : ''}`}
            disabled={!e.found}
            aria-pressed={on}
            title={
              e.found
                ? `Start new sessions in ${e.name}. Cards already on the board keep the engine they were started in.`
                : `${e.name} isn't installed on this Mac.`
            }
            onClick={() => {
              if (!on && e.found) onChange(e.id);
            }}
          >
            {e.name.split(' ')[0]}
          </button>
        );
      })}
    </div>
  );
}
