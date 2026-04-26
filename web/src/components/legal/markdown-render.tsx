/**
 * Tiny markdown renderer for legal documents.
 *
 * The legal corpus is well-formed markdown with a small surface — H1/H2/H3
 * headers, bold/italic spans, ordered + unordered lists, paragraph breaks,
 * and `---` rules. Pulling in `react-markdown` for that would add ~80 KB
 * gzipped and a slate of remark/rehype peers, all to render three static
 * documents that change only when the legal team updates them. A bespoke
 * 100-line renderer keeps the bundle clean and is easy to audit.
 *
 * Not safe for arbitrary user content — handles a known corpus only. If
 * the docs grow tables, code blocks, or HTML, swap to `react-markdown`.
 */

type Block =
  | { kind: 'h1' | 'h2' | 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'hr' };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;

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

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }
    if (line === '---') {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'hr' });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push({ kind: `h${level}` as 'h1' | 'h2' | 'h3', text: heading[2] });
      continue;
    }
    const ulItem = /^[-*]\s+(.*)$/.exec(line);
    if (ulItem) {
      flushParagraph();
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
      if (!list || list.kind !== 'ol') {
        flushList();
        list = { kind: 'ol', items: [] };
      }
      list.items.push(olItem[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const boldStart = text.indexOf('**', i);
    if (boldStart === -1) {
      out.push(text.slice(i));
      break;
    }
    if (boldStart > i) out.push(text.slice(i, boldStart));
    const boldEnd = text.indexOf('**', boldStart + 2);
    if (boldEnd === -1) {
      out.push(text.slice(boldStart));
      break;
    }
    out.push(<strong key={`b-${key++}`}>{text.slice(boldStart + 2, boldEnd)}</strong>);
    i = boldEnd + 2;
  }
  return out;
}

export function MarkdownRender({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className="prose-legal flex flex-col gap-3">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h1':
            return (
              <h1
                key={i}
                className="mt-2 text-[20px] font-semibold text-[var(--color-text-primary)]"
              >
                {renderInline(b.text)}
              </h1>
            );
          case 'h2':
            return (
              <h2
                key={i}
                className="mt-4 text-[16px] font-semibold text-[var(--color-text-primary)]"
              >
                {renderInline(b.text)}
              </h2>
            );
          case 'h3':
            return (
              <h3
                key={i}
                className="mt-2 text-[14px] font-semibold text-[var(--color-text-primary)]"
              >
                {renderInline(b.text)}
              </h3>
            );
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
