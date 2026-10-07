import { useMemo, useState, type ReactNode } from 'react';
import { parseMarkdown, type MdBlock, type MdInline } from './markdown-blocks.js';

/** Batch 4 §阅读: restricted Markdown rendering for live message text. The parser only emits
 *  structured nodes (no HTML, no dangerouslySetInnerHTML); React escaping owns output safety. */

function InlineNodes({ inline }: { readonly inline: readonly MdInline[] }): ReactNode {
  return inline.map((node, index) => {
    switch (node.kind) {
      case 'code':
        return <code key={index} className="wb-md-inline-code">{node.text}</code>;
      case 'bold':
        return <strong key={index}><InlineNodes inline={node.inner} /></strong>;
      case 'italic':
        return <em key={index}><InlineNodes inline={node.inner} /></em>;
      case 'link':
        return <a key={index} className="wb-md-link" href={node.href} target="_blank" rel="noreferrer noopener">{node.text}</a>;
      default:
        return node.text;
    }
  });
}

/** One fenced code block with the language label and a copy affordance (clipboard pattern from message-item). */
function CodeBlock({ lang, code }: { readonly lang: string; readonly code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="wb-md-code">
      <div className="wb-md-code-head">
        <span>{lang === '' ? 'code' : lang}</span>
        <button type="button" onClick={() => { void copy(); }}>{copied ? '已复制' : '复制'}</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function BlockNodes({ blocks }: { readonly blocks: readonly MdBlock[] }): ReactNode {
  return blocks.map((block, index) => {
    switch (block.kind) {
      case 'heading': {
        const inner = <InlineNodes inline={block.inline} />;
        if (block.level === 1) return <h3 key={index} className="wb-md-heading">{inner}</h3>;
        if (block.level === 2) return <h4 key={index} className="wb-md-heading">{inner}</h4>;
        return <h5 key={index} className="wb-md-heading">{inner}</h5>;
      }
      case 'paragraph':
        return <p key={index} className="wb-md-p"><InlineNodes inline={block.inline} /></p>;
      case 'code':
        return <CodeBlock key={index} lang={block.lang} code={block.code} />;
      case 'quote':
        return <blockquote key={index} className="wb-md-quote"><BlockNodes blocks={block.blocks} /></blockquote>;
      case 'list': {
        const items = block.items.map((item, itemIndex) => <li key={itemIndex}><InlineNodes inline={item} /></li>);
        return block.ordered
          ? <ol key={index} className="wb-md-list">{items}</ol>
          : <ul key={index} className="wb-md-list">{items}</ul>;
      }
      case 'table':
        return (
          <table key={index} className="wb-md-table">
            <thead>
              <tr>{block.header.map((cell, cellIndex) => <th key={cellIndex}><InlineNodes inline={cell} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><InlineNodes inline={cell} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        );
      case 'rule':
        return <hr key={index} className="wb-md-rule" />;
      default:
        return null;
    }
  });
}

export function MarkdownBody({ text }: { readonly text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return null;
  return <BlockNodes blocks={blocks} />;
}
