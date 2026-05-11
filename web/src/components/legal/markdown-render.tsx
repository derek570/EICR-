/**
 * Markdown renderer for legal documents.
 *
 * Two corpora share this renderer:
 *   1. In-app, iOS-mirrored docs in src/content/legal/{terms,privacy,eula}.md
 *      (rendered by /settings/legal/[doc])
 *   2. Public compliance corpus in src/content/legal/public/*.md
 *      (rendered by /legal/[doc])
 *
 * Both are trusted, repo-controlled markdown. Output is NOT safe for
 * arbitrary user input — there is no HTML sanitisation because the inputs
 * cannot contain HTML in the first place.
 *
 * Supported syntax:
 *   - YAML frontmatter (stripped)
 *   - H1 / H2 / H3 headings
 *   - Paragraphs
 *   - Unordered (`-`, `*`) + ordered (`1.`) lists
 *   - GFM pipe tables (header row + `|---|---|` separator + data rows)
 *   - Blockquotes (`> `)
 *   - Horizontal rules (`---`)
 *   - Inline: **bold**, *italic*, `code`, [text](url)
 *
 * Deliberately unsupported (none of these appear in the corpus):
 *   - Code fences, images, raw HTML, autolinks, h4+, footnotes
 */

import * as React from 'react';

type Block =
  | { kind: 'h1' | 'h2' | 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'blockquote'; lines: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'hr' };

/**
 * Strip a leading YAML frontmatter block (delimited by `---` on its own line
 * top and bottom). The compliance docs use frontmatter for sync metadata.
 * The in-app corpus doesn't, so this is a no-op there.
 */
function stripFrontmatter(source: string): string {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return source;
  const nl = source.indexOf('\n');
  const end = source.indexOf('\n---', nl);
  if (end === -1) return source;
  // Skip past the closing `---` line and its trailing newline if present.
  const after = source.indexOf('\n', end + 4);
  return after === -1 ? '' : source.slice(after + 1);
}

const TABLE_SEPARATOR = /^\|[\s:|-]+\|$/;

function parseBlocks(source: string): Block[] {
  const lines = stripFrontmatter(source).replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'p', text: paragraph.join(' ').trim() });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(list);
    list = null;
  };
  const flushQuote = () => {
    if (!quote) return;
    blocks.push({ kind: 'blockquote', lines: quote });
    quote = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();

    if (line === '') {
      flushAll();
      continue;
    }
    if (line === '---') {
      flushAll();
      blocks.push({ kind: 'hr' });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push({ kind: `h${level}` as 'h1' | 'h2' | 'h3', text: heading[2] });
      continue;
    }

    // GFM pipe table: current line starts `|` AND next line is the
    // `|---|---|` separator. Consume the whole table here.
    if (line.startsWith('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1].trim())) {
      flushAll();
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      i += 2; // skip header + separator
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!rowLine.startsWith('|')) break;
        rows.push(splitTableRow(rowLine));
        i += 1;
      }
      i -= 1; // for-loop will increment
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    if (line.startsWith('>')) {
      flushParagraph();
      flushList();
      if (!quote) quote = [];
      quote.push(line.replace(/^>\s?/, ''));
      continue;
    }

    const ulItem = /^[-*]\s+(.*)$/.exec(line);
    if (ulItem) {
      flushParagraph();
      flushQuote();
      if (!list || list.kind !== 'ul') {
        flushList();
        list = { kind: 'ul', items: [] };
      }
      list.items.push(ulItem[1]);
      continue;
    }

    const olItem = /^\d+\.\s+(.*)$/.exec(line);
    if (olItem) {
      flushParagraph();
      flushQuote();
      if (!list || list.kind !== 'ol') {
        flushList();
        list = { kind: 'ol', items: [] };
      }
      list.items.push(olItem[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  }
  flushAll();
  return blocks;
}

function splitTableRow(line: string): string[] {
  // Strip leading + trailing pipes, split on remaining pipes, trim each cell.
  const inner = line.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

/**
 * Inline tokenizer. Recognises (in priority order):
 *   `code`  →  literal, no nested formatting
 *   [t](u)  →  link, opens external URLs in a new tab
 *   **b**   →  bold
 *   *i*     →  italic (must not be `**` — checked after bold)
 *
 * Spans do not nest: bold inside a link is rendered as plain text inside
 * the link. The corpus does not use nested formatting, so the simpler
 * non-recursive tokenizer is sufficient and avoids a class of bugs.
 */
function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const pushText = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (typeof last === 'string') {
      out[out.length - 1] = last + s;
    } else {
      out.push(s);
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        out.push(
          <code
            key={`c-${key++}`}
            className="rounded-[3px] bg-[var(--color-surface-2)] px-1 py-px font-mono text-[0.9em] text-[var(--color-text-primary)]"
          >
            {text.slice(i + 1, end)}
          </code>
        );
        i = end + 1;
        continue;
      }
    }

    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(i + 1, closeBracket);
          const href = text.slice(closeBracket + 2, closeParen);
          const isExternal = /^https?:\/\//i.test(href);
          out.push(
            <a
              key={`l-${key++}`}
              href={href}
              {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="text-[var(--color-brand-blue)] underline underline-offset-2 hover:text-[var(--color-brand-blue-soft)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
            >
              {label}
            </a>
          );
          i = closeParen + 1;
          continue;
        }
      }
    }

    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        out.push(<strong key={`b-${key++}`}>{text.slice(i + 2, end)}</strong>);
        i = end + 2;
        continue;
      }
    }

    if (ch === '*' && text[i + 1] !== '*') {
      // Match the next single `*` that is not followed by another `*`
      // (which would start a bold span we already would have matched).
      let end = -1;
      for (let j = i + 1; j < text.length; j += 1) {
        if (text[j] === '*' && text[j + 1] !== '*') {
          end = j;
          break;
        }
      }
      if (end > i + 1) {
        out.push(<em key={`i-${key++}`}>{text.slice(i + 1, end)}</em>);
        i = end + 1;
        continue;
      }
    }

    pushText(ch);
    i += 1;
  }

  return out;
}

const HEADING_CLASSES = {
  h1: 'mt-2 text-[20px] font-semibold text-[var(--color-text-primary)]',
  h2: 'mt-4 text-[16px] font-semibold text-[var(--color-text-primary)]',
  h3: 'mt-2 text-[14px] font-semibold text-[var(--color-text-primary)]',
} as const;

export function MarkdownRender({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className="prose-legal flex flex-col gap-3">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h1':
          case 'h2':
          case 'h3': {
            const Tag = b.kind;
            return (
              <Tag key={i} className={HEADING_CLASSES[b.kind]}>
                {renderInline(b.text)}
              </Tag>
            );
          }
          case 'p':
            return (
              <p key={i} className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
                {renderInline(b.text)}
              </p>
            );
          case 'ul':
            return (
              <ul key={i} className="ml-5 list-disc text-[13px] text-[var(--color-text-secondary)]">
                {b.items.map((item, j) => (
                  <li key={j} className="mb-1 leading-relaxed">
                    {renderInline(item)}
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol
                key={i}
                className="ml-5 list-decimal text-[13px] text-[var(--color-text-secondary)]"
              >
                {b.items.map((item, j) => (
                  <li key={j} className="mb-1 leading-relaxed">
                    {renderInline(item)}
                  </li>
                ))}
              </ol>
            );
          case 'blockquote':
            return (
              <blockquote
                key={i}
                className="border-l-2 border-[var(--color-brand-blue)] bg-[var(--color-surface-2)]/40 px-3 py-2 text-[13px] italic leading-relaxed text-[var(--color-text-secondary)]"
              >
                {b.lines.map((ln, j) => (
                  <p key={j} className={j > 0 ? 'mt-1' : ''}>
                    {renderInline(ln)}
                  </p>
                ))}
              </blockquote>
            );
          case 'table':
            return (
              <div
                key={i}
                className="-mx-1 overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)]"
              >
                <table className="w-full min-w-max border-collapse text-left text-[12px]">
                  <thead className="bg-[var(--color-surface-2)] text-[var(--color-text-primary)]">
                    <tr>
                      {b.headers.map((h, j) => (
                        <th
                          key={j}
                          scope="col"
                          className="border-b border-[var(--color-border-subtle)] px-3 py-2 font-semibold"
                        >
                          {renderInline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr
                        key={j}
                        className="border-b border-[var(--color-border-subtle)] last:border-b-0 align-top"
                      >
                        {row.map((cell, k) => (
                          <td key={k} className="px-3 py-2 text-[var(--color-text-secondary)]">
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return (
              <hr key={i} className="my-2 border-0 border-t border-[var(--color-border-subtle)]" />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
