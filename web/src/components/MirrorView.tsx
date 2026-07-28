import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Block, Message, Transcript } from '../types';

/* ------------------------------------------------------------- technical -- */

function RawBlocks({ message }: { message: Message }) {
  return (
    <>
      {message.blocks.map((b, i) => {
        if (b.type === 'text') {
          return (
            <div key={i} className="mirror-text">
              {b.text}
            </div>
          );
        }
        if (b.type === 'thinking') {
          return (
            <div key={i} className="mirror-block mirror-thinking">
              {b.text}
            </div>
          );
        }
        if (b.type === 'tool_use') {
          return (
            <div key={i} className="mirror-block mirror-tool">
              <span className="tool-name">{b.name}</span> {b.input}
            </div>
          );
        }
        return (
          <div key={i} className={`mirror-block mirror-tool${b.isError ? ' error' : ''}`}>
            {b.text || '(no output)'}
          </div>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ clean -- */

/**
 * Prose, with the machinery taken out.
 *
 * Fenced code is replaced by a marker rather than deleted — a paragraph that
 * says "here is the corrected clause" reads as a lie when the clause is gone —
 * and the markdown that survives is stripped of the characters that carry no
 * meaning aloud: heading hashes, bullet asterisks, emphasis, backticks.
 */
function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '\n[code]\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Text that arrives as a user turn but that you never typed: the body of a skill
 * Claude Code expanded, the caveat it wraps local commands in, the echo of a
 * command's own output. It belongs to the machinery, and reading a session out
 * loud you would skip every line of it. The technical view still shows it.
 */
const MACHINERY = [
  /^Base directory for this skill:/i,
  /^Caveat: The messages below were generated/i,
  /^<local-command/i,
  /^\[Request interrupted/i,
];

const isMachinery = (text: string) => MACHINERY.some((re) => re.test(text.trim()));

type Action = { verb: string; targets: string[] };

/**
 * Consecutive calls of the same kind read as one line. Nine separate "Read a
 * file" bullets tell you less than "Read 9 files", and take nine times the room.
 */
function actionsOf(blocks: Block[]): Action[] {
  const out: Action[] = [];
  for (const b of blocks) {
    if (b.type !== 'tool_use' || !b.verb) continue;
    const last = out[out.length - 1];
    if (last && last.verb === b.verb) last.targets.push(b.target ?? '');
    else out.push({ verb: b.verb, targets: [b.target ?? ''] });
  }
  return out;
}

function actionLine({ verb, targets }: Action): string {
  const named = [...new Set(targets.filter(Boolean))];
  if (!named.length) return `${verb} ${targets.length} time${targets.length === 1 ? '' : 's'}`;
  if (named.length <= 2) return `${verb} ${named.join(', ')}`;
  return `${verb} ${named.slice(0, 2).join(', ')} +${named.length - 2} more`;
}

/** A failed step is the one piece of machinery worth keeping — it changes the story. */
function failures(blocks: Block[]): number {
  return blocks.filter((b) => b.type === 'tool_result' && b.isError).length;
}

function CleanMessage({ message }: { message: Message }) {
  const texts = message.blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .filter((b) => !(message.role === 'user' && isMachinery(b.text)))
    .map((b) => plainText(b.text))
    .filter(Boolean);

  // A turn made entirely of tool results is the session talking to itself.
  if (message.role === 'user' && !texts.length) return null;

  const actions = message.role === 'assistant' ? actionsOf(message.blocks) : [];
  const failed = message.role === 'assistant' ? failures(message.blocks) : 0;
  if (!texts.length && !actions.length) return null;

  return (
    <div className="mirror-msg clean">
      <div className={`mirror-role ${message.role}`}>
        <span>{message.role === 'user' ? 'You' : 'Claude'}</span>
        {message.timestamp && (
          <span className="when">{new Date(message.timestamp).toLocaleString()}</span>
        )}
      </div>

      {texts.map((t, i) => (
        <div key={i} className="mirror-text">
          {t}
        </div>
      ))}

      {actions.length > 0 && (
        <div className="mirror-actions">
          {actions.map((a, i) => (
            <div key={i} className="did">
              {actionLine(a)}
            </div>
          ))}
          {failed > 0 && (
            <div className="did failed">
              {failed} step{failed === 1 ? '' : 's'} failed
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- pane -- */

/** Read-only rendering of a session's transcript, for sessions the board doesn't own. */
export function MirrorView({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }) {
  const [data, setData] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reading is the point; the technical view is there when you need to check
  // something, and is remembered so you aren't switching to it every time.
  const [clean, setClean] = useState(() => localStorage.getItem('mirrorRaw') !== '1');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem('mirrorRaw', clean ? '0' : '1');
  }, [clean]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .transcript(sessionId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setData(null);
          setError(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data, clean]);

  if (error) {
    return (
      <div className="pane-empty">
        <div>No transcript yet</div>
        <div className="hint">{error}</div>
      </div>
    );
  }
  if (!data) return <div className="pane-empty">Loading transcript…</div>;

  const rendered = clean
    ? data.messages.map((m) => <CleanMessage key={m.uuid} message={m} />).filter(Boolean)
    : data.messages.map((m) => (
        <div key={m.uuid} className="mirror-msg">
          <div className={`mirror-role ${m.role}`}>
            <span>{m.role === 'user' ? 'You' : 'Claude'}</span>
            {m.timestamp && <span className="when">{new Date(m.timestamp).toLocaleString()}</span>}
          </div>
          <RawBlocks message={m} />
        </div>
      ));

  return (
    <div className="mirror" ref={scrollRef}>
      <div className="mirror-toolbar">
        <div className="seg small">
          <button className={clean ? 'on' : ''} onClick={() => setClean(true)}>
            Conversation
          </button>
          <button
            className={clean ? '' : 'on'}
            onClick={() => setClean(false)}
            title="Every tool call, its input and its output, as recorded"
          >
            Technical
          </button>
        </div>
      </div>

      {data.truncated && (
        <div className="mirror-note">Showing the most recent portion of a long transcript.</div>
      )}

      {rendered}

      {data.messages.length === 0 && <div className="pane-empty">This transcript is empty.</div>}
    </div>
  );
}
