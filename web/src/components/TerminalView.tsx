import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

const LIGHT = {
  background: '#ffffff',
  foreground: '#1f2937',
  cursor: '#2563eb',
  selectionBackground: '#c7dbff',
  black: '#1f2937',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#2563eb',
  magenta: '#7c3aed',
  cyan: '#0e7490',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#3b82f6',
  brightMagenta: '#8b5cf6',
  brightCyan: '#0891b2',
  brightWhite: '#f9fafb',
};

const DARK = {
  background: '#080b12',
  foreground: '#e6ebf4',
  cursor: '#5b8cff',
  selectionBackground: '#2b3a5c',
  black: '#0b0f17',
  red: '#f43f5e',
  green: '#22c55e',
  yellow: '#f59e0b',
  blue: '#5b8cff',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#cbd5e1',
  brightBlack: '#64748b',
  brightRed: '#fb7185',
  brightGreen: '#4ade80',
  brightYellow: '#fbbf24',
  brightBlue: '#93b4ff',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f1f5f9',
};

type Props = {
  sessionId: string;
  onExit: () => void;
  fontSize?: number;
  autoFocus?: boolean;
};

/**
 * Live terminal for a board-owned session. The session must already be running —
 * SessionPanel renders the start prompt when it is not.
 */
export function TerminalView({ sessionId, onExit, fontSize = 12.5, autoFocus = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 20_000,
      theme: document.documentElement.getAttribute('data-theme') === 'light' ? LIGHT : DARK,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        /* the host can be zero-sized while the panel animates */
      }
    };
    safeFit();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/pty?sessionId=${sessionId}`);

    ws.onopen = () => {
      setStatus('open');
      safeFit();
      ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      if (autoFocus) term.focus();
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'data') term.write(msg.d);
      else if (msg.t === 'exit') {
        term.write(`\r\n\x1b[38;5;244m── session exited (code ${msg.code}) ──\x1b[0m\r\n`);
        setStatus('closed');
        onExit();
      } else if (msg.t === 'notlive' || msg.t === 'error') {
        setStatus('closed');
        onExit();
      }
    };

    ws.onclose = () => setStatus((s) => (s === 'open' ? 'closed' : s));

    const disposeData = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', d }));
    });

    const ro = new ResizeObserver(() => {
      safeFit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      disposeData.dispose();
      ws.close();
      term.dispose();
    };
  }, [sessionId, onExit, fontSize, autoFocus]);

  return (
    <div className="term-host" ref={hostRef}>
      {status === 'connecting' && (
        <div style={{ color: '#64748b', fontSize: 12, position: 'absolute', top: 10, right: 14 }}>
          connecting…
        </div>
      )}
    </div>
  );
}
