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
 * command's own output, the reminders the harness injects. It belongs to the
 * machinery, and reading a session back you would skip every line of it. The
 * technical view still shows it.
 */
const MACHINERY = [
  /^Base directory for this skill:/i,
  /^Caveat: The messages below were generated/i,
  /^<local-command/i,
  /^<command-/i,
  /^<system-reminder/i,
  /^\[Request interrupted/i,
];

const isMachinery = (text: string) => MACHINERY.some((re) => re.test(text.trim()));

/** Reminders are injected mid-prompt as well as sent alone. */
const stripReminders = (text: string) =>
  text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

type Turn = { key: string; role: 'user' | 'assistant'; text: string; timestamp?: string | null };

/**
 * The conversation, and nothing else.
 *
 * Two rules do all the work. Only text survives — no tool calls, no results, no
 * thinking, not even the tally of what was read or written, because the point of
 * this view is what was *said*. And an assistant turn that ends in a tool call is
 * Claude talking to itself on the way somewhere ("let me check the file"), so only
 * turns that are purely text are kept: those are the ones addressed to you.
 *
 * Where several prose turns run together — Claude saying what it is about to do,
 * working, then answering — the answer is the last one, so that is what the
 * bubble shows. The exception is a one-line sign-off ("Done."), which on its own
 * tells you nothing; there the substantive turn it followed is kept as well.
 */
const SIGN_OFF = 200;
const SUBSTANTIVE = 400;

function chatTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];

  for (const m of messages) {
    const working = m.role === 'assistant' && m.blocks.some((b) => b.type === 'tool_use');
    if (working) continue;

    const text = m.blocks
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => (m.role === 'user' ? stripReminders(b.text) : b.text))
      .filter((t) => t && !(m.role === 'user' && isMachinery(t)))
      .map(plainText)
      .filter(Boolean)
      .join('\n\n');

    // A turn made entirely of tool results is the session talking to itself.
    if (!text) continue;

    const last = turns[turns.length - 1];
    if (last && last.role === m.role && m.role === 'assistant') {
      last.text =
        text.length < SIGN_OFF && last.text.length > SUBSTANTIVE
          ? `${last.text}\n\n${text}`
          : text;
      last.timestamp = m.timestamp;
      continue;
    }
    turns.push({ key: m.uuid, role: m.role, text, timestamp: m.timestamp });
  }

  return turns;
}

function Bubble({ turn }: { turn: Turn }) {
  return (
    <div className={`chat-row ${turn.role}`}>
      <div className="chat-bubble">
        {turn.text}
        {turn.timestamp && (
          <span className="chat-when">
            {new Date(turn.timestamp).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </span>
        )}
      </div>
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

  const turns = clean ? chatTurns(data.messages) : [];
  const rendered = clean
    ? turns.map((t) => <Bubble key={t.key} turn={t} />)
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
    <div className={`mirror${clean ? ' chat' : ''}`} ref={scrollRef}>
      <div className="mirror-toolbar">
        <div className="seg small">
          <button className={clean ? 'on' : ''} onClick={() => setClean(true)}>
            Chat
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
      {clean && data.messages.length > 0 && turns.length === 0 && (
        <div className="pane-empty">
          <div>Nothing said yet</div>
          <div className="hint">
            This session has been working but hasn’t answered in prose. Technical shows what it did.
          </div>
        </div>
      )}
    </div>
  );
}
