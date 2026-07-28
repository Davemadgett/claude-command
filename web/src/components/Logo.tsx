/**
 * Drawn rather than loaded, so it takes the accent colour from CSS in both
 * themes and stays crisp at any size. A bitmap logo on a dark header reads as a
 * pasted-on sticker; this does not.
 *
 * The bracket is deliberately content-free — it frames whatever the install
 * calls itself, which is `appName` from config.json. Replace this component
 * wholesale if you have a real mark: nothing else depends on its shape.
 */

type Props = { appName: string };

export function Logo({ appName }: Props) {
  // "Claude Command" → CLAUDE over COMMAND. A single word sits alone in the
  // bracket, centred, with no rule under it.
  const words = appName.trim().split(/\s+/).filter(Boolean);
  const top = words.length > 1 ? words.slice(0, -1).join(' ') : (words[0] ?? 'Board');
  const bottom = words.length > 1 ? words[words.length - 1] : null;

  // Long words would otherwise run past the bracket; squeeze rather than clip.
  const fit = (s: string) => (s.length > 8 ? 104 : undefined);

  return (
    <span className="lockup">
      <svg className="lockup-mark" viewBox="0 0 132 56" role="img" aria-label={appName} height="30">
        <rect
          x="1.5"
          y="1.5"
          width="129"
          height="53"
          rx="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        />
        <text
          x="66"
          y={bottom ? 23 : 34}
          textAnchor="middle"
          fill="currentColor"
          fontFamily="var(--font)"
          fontSize="15"
          fontWeight="700"
          letterSpacing="2.6"
          textLength={fit(top)}
          lengthAdjust="spacingAndGlyphs"
        >
          {top.toUpperCase()}
        </text>

        {bottom && (
          <>
            <line x1="16" y1="30" x2="116" y2="30" stroke="currentColor" strokeWidth="2.5" />
            <text
              x="66"
              y="47"
              textAnchor="middle"
              fill="currentColor"
              fontFamily="var(--font)"
              fontSize="15"
              fontWeight="700"
              letterSpacing="5"
              textLength={fit(bottom)}
              lengthAdjust="spacingAndGlyphs"
            >
              {bottom.toUpperCase()}
            </text>
          </>
        )}
      </svg>
    </span>
  );
}
