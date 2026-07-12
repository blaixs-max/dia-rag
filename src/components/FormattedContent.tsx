import { Fragment, type ReactNode } from "react";

/**
 * Presentation-only renderer for assistant answers.
 * Preserves the raw text exactly (no content is dropped) while giving
 * numbered steps, bullets, inline `code` and **bold** a polished look.
 */

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const tok = match[0];
    if (tok.startsWith("`")) {
      nodes.push(<code key={`${keyBase}-c${i}`}>{tok.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`${keyBase}-b${i}`}>{tok.slice(2, -2)}</strong>);
    }
    last = match.index + tok.length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type StepItem = { num: string; text: string };

export default function FormattedContent({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let steps: StepItem[] = [];
  let bullets: string[] = [];
  let key = 0;

  const flushSteps = () => {
    if (!steps.length) return;
    const items = steps;
    steps = [];
    blocks.push(
      <ol className="steps" key={`ol${key++}`}>
        {items.map((s, idx) => (
          <li key={idx}>
            <span className="step-num">{s.num}</span>
            <span>{renderInline(s.text, `s${key}-${idx}`)}</span>
          </li>
        ))}
      </ol>
    );
  };

  const flushBullets = () => {
    if (!bullets.length) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul className="bullets" key={`ul${key++}`}>
        {items.map((b, idx) => (
          <li key={idx}>
            <span className="bullet" />
            <span>{renderInline(b, `u${key}-${idx}`)}</span>
          </li>
        ))}
      </ul>
    );
  };

  for (const line of lines) {
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const bulleted = line.match(/^\s*[-*•]\s+(.*)$/);
    if (numbered) {
      flushBullets();
      steps.push({ num: numbered[1], text: numbered[2] });
    } else if (bulleted) {
      flushSteps();
      bullets.push(bulleted[1]);
    } else if (line.trim() === "") {
      flushSteps();
      flushBullets();
      blocks.push(<div className="spacer" key={`sp${key++}`} />);
    } else {
      flushSteps();
      flushBullets();
      blocks.push(
        <p key={`p${key++}`}>{renderInline(line, `p${key}`)}</p>
      );
    }
  }
  flushSteps();
  flushBullets();

  return <Fragment>{blocks}</Fragment>;
}
