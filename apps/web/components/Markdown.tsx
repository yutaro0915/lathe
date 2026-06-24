import * as React from "react";

// Markdown.tsx — a tiny, dependency-free, XSS-safe markdown renderer for the
// transcript detail "Pretty" view (slice: transcript master-detail). It does NOT
// inject raw HTML (no dangerouslySetInnerHTML) — it parses the source into React
// nodes, so React escapes every text run automatically. Supported subset, chosen
// to make agent/message text readable: ATX headings (#..######), unordered and
// ordered lists, fenced code blocks (```), blockquotes, horizontal rules, and
// inline bold / italic / inline-code / links. Anything unrecognised falls
// through as a plain paragraph. Link href is sanitised to http(s)/mailto only.

type Inline = React.ReactNode;

const SAFE_HREF = /^(https?:|mailto:)/i;

function sanitizeHref(raw: string): string | null {
  const href = raw.trim();
  if (SAFE_HREF.test(href)) return href;
  // allow bare relative anchors but nothing that can carry script
  if (href.startsWith("#") || href.startsWith("/")) return href;
  return null;
}

// Inline tokenizer: bold (**x** / __x__), italic (*x* / _x_), inline code (`x`),
// and links [text](href). Operates on plain text only; React escapes the rest.
function renderInline(text: string, keyBase: string): Inline[] {
  const nodes: Inline[] = [];
  let i = 0;
  let buf = "";
  let n = 0;
  const flush = () => {
    if (buf) {
      nodes.push(buf);
      buf = "";
    }
  };
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    // inline code: `code`
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        nodes.push(
          <code key={`${keyBase}-c${n++}`} className="md-code">
            {text.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }
    // link: [text](href)
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const paren = text.indexOf(")", close + 2);
        if (paren > close) {
          const label = text.slice(i + 1, close);
          const href = sanitizeHref(text.slice(close + 2, paren));
          flush();
          if (href) {
            nodes.push(
              <a key={`${keyBase}-l${n++}`} className="md-link" href={href} target="_blank" rel="noopener noreferrer">
                {renderInline(label, `${keyBase}-l${n}`)}
              </a>,
            );
          } else {
            nodes.push(...renderInline(label, `${keyBase}-l${n++}`));
          }
          i = paren + 1;
          continue;
        }
      }
    }
    // bold: **x** or __x__
    if ((ch === "*" && text[i + 1] === "*") || (ch === "_" && text[i + 1] === "_")) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      if (end > i + 1) {
        flush();
        nodes.push(
          <strong key={`${keyBase}-b${n++}`} className="md-strong">
            {renderInline(text.slice(i + 2, end), `${keyBase}-b${n}`)}
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }
    // italic: *x* or _x_
    if (ch === "*" || ch === "_") {
      const end = text.indexOf(ch, i + 1);
      if (end > i && text[end - 1] !== " ") {
        flush();
        nodes.push(
          <em key={`${keyBase}-i${n++}`} className="md-em">
            {renderInline(text.slice(i + 1, end), `${keyBase}-i${n}`)}
          </em>,
        );
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return nodes;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | { kind: "p"; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }
    // blank line
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    // horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, text: h[2].trim() });
      i += 1;
      continue;
    }
    // blockquote (collapse consecutive > lines)
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }
    // paragraph (collapse consecutive non-blank, non-special lines)
    const body: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])
    ) {
      body.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "p", text: body.join("\n") });
  }
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  const blocks = React.useMemo(() => parseBlocks(text ?? ""), [text]);
  return (
    <div className="md" data-testid="md">
      {blocks.map((b, bi) => {
        const key = `b${bi}`;
        switch (b.kind) {
          case "heading": {
            const Tag = (`h${Math.min(6, b.level)}`) as keyof React.JSX.IntrinsicElements;
            return (
              <Tag key={key} className={`md-h md-h${b.level}`}>
                {renderInline(b.text, key)}
              </Tag>
            );
          }
          case "code":
            return (
              <pre key={key} className="lds-codebox md-pre" data-md-lang={b.lang || undefined}>
                <code className="md-codeblock">{b.text}</code>
              </pre>
            );
          case "ul":
            return (
              <ul key={key} className="md-ul">
                {b.items.map((it, ii) => (
                  <li key={`${key}-${ii}`} className="md-li">
                    {renderInline(it, `${key}-${ii}`)}
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} className="md-ol">
                {b.items.map((it, ii) => (
                  <li key={`${key}-${ii}`} className="md-li">
                    {renderInline(it, `${key}-${ii}`)}
                  </li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={key} className="md-quote">
                {renderInline(b.text, key)}
              </blockquote>
            );
          case "hr":
            return <hr key={key} className="md-hr" />;
          default:
            return (
              <p key={key} className="md-p">
                {renderInline(b.text, key)}
              </p>
            );
        }
      })}
    </div>
  );
}
