import { useState } from 'react';
import { MessagePrimitive, type EnrichedPartState, type MessageState } from '@assistant-ui/react';
import type { GuiTool } from '../../../live-types.js';
import type { EvidenceTab } from './prefs.js';
import { formatTimestamp, stringValue, toolStatusLabels } from './format.js';
import { BranchIcon, ChevronIcon, CopyIcon } from './icons.js';
import { MarkdownBody } from './markdown.js';

type ToolPartState = Extract<EnrichedPartState, { type: 'tool-call' }>;

function evidenceTabFor(part: ToolPartState): EvidenceTab {
  const target = stringValue(part.args.target, part.toolName);
  const status = stringValue(part.args.status, 'unknown');
  const path = stringValue(part.args.path, '');
  if (path !== '' || target.includes('\\') || target.includes('/')) return 'diff';
  return status === 'failed' || status === 'committed' ? 'verification' : 'context';
}

function aggregateStatus(parts: readonly ToolPartState[]): GuiTool['status'] {
  const statuses = parts.map((part) => stringValue(part.args.status, 'unknown') as GuiTool['status']);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('denied')) return 'denied';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('proposed')) return 'proposed';
  if (statuses.includes('committed')) return 'committed';
  return 'unknown';
}

function ToolRow({ part, onEvidence }: {
  readonly part: ToolPartState;
  readonly onEvidence: (toolId: string, tab: EvidenceTab) => void;
}) {
  const target = stringValue(part.args.target, part.toolName);
  const status = stringValue(part.args.status, 'unknown') as GuiTool['status'];
  const detail = stringValue(part.args.detail, '查看实际输出');
  return (
    <button
      type="button"
      className="tool-item live-tool-item wb-tool-item"
      data-status={status}
      onClick={() => onEvidence(part.toolCallId, evidenceTabFor(part))}
      aria-label={`查看 ${part.toolName} 的实际证据`}
    >
      <span className="status-word" data-status={status}>{toolStatusLabels[status] ?? status}</span>
      <code>{part.toolName}</code>
      <span className="tool-target">{target}</span>
      <span className="tool-detail">{detail}</span>
      <span className="tool-link">查看证据</span>
    </button>
  );
}

/** The tool stream stays folded; one click opens it, one click on a row opens its evidence. */
function ToolGroup({ parts, onEvidence }: {
  readonly parts: readonly ToolPartState[];
  readonly onEvidence: (toolId: string, tab: EvidenceTab) => void;
}) {
  const [open, setOpen] = useState(false);
  if (parts.length === 0) return null;
  const status = aggregateStatus(parts);
  return (
    <div className="wb-tools" data-open={open}>
      <button type="button" className="wb-tools-head" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <ChevronIcon className="wb-chevron" />
        <span>工具执行</span>
        <em>{parts.length} 步</em>
        <strong className="status-word" data-status={status}>{toolStatusLabels[status]}</strong>
      </button>
      {open ? (
        <div className="wb-tools-body">
          {parts.map((part) => <ToolRow key={part.toolCallId} part={part} onEvidence={onEvidence} />)}
        </div>
      ) : null}
    </div>
  );
}

export function MessageView({
  message,
  isLatestAssistant,
  assistantSubline,
  onEvidence,
  onBranch,
}: {
  readonly message: MessageState;
  readonly isLatestAssistant: boolean;
  readonly assistantSubline?: string | null;
  readonly onEvidence: (toolId: string, tab: EvidenceTab) => void;
  readonly onBranch?: (messageId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const name = stringValue(message.metadata.custom.name, isUser ? 'Ludi' : 'Jarvis');
  const time = formatTimestamp(message.metadata.custom.time);
  const timeValue = stringValue(message.metadata.custom.time, '');
  const incomplete = message.metadata.custom.sourceStatus === 'incomplete';
  const toolParts = message.content.filter((part): part is ToolPartState => part.type === 'tool-call');

  const copy = async () => {
    const text = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n')
      .trim();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const parts = (
    <MessagePrimitive.Parts>
      {({ part }) => {
        if (part.type === 'text') return <div className="message-copy"><MarkdownBody text={part.text} /></div>;
        if (part.type === 'tool-call') return null;
        return <div className="unsupported-part">这部分内容暂时无法显示，原始事实仍保留在会话中。</div>;
      }}
    </MessagePrimitive.Parts>
  );

  if (isUser) {
    return (
      <MessagePrimitive.Root className="message-item wb-message" data-role={message.role} role="article" aria-label={`${name}，${time}`}>
        <div className="message-meta wb-message-meta">
          <strong>{name}</strong>
          <time dateTime={timeValue}>{time}</time>
          {incomplete ? (
            <em className="wb-incomplete" data-tone="danger">回复未完整落盘</em>
          ) : null}
        </div>
        {parts}
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root className="message-item wb-message" data-role={message.role} role="article" aria-label={`${name}，${time}`}>
      <div className="wb-msg-head">
        <span className="wb-msg-avatar" aria-hidden="true">J</span>
        <div className="wb-msg-ident">
          <strong>{name}</strong>
          {typeof assistantSubline === 'string' && assistantSubline !== '' ? <small>{assistantSubline}</small> : null}
        </div>
        {incomplete ? (
          <em className="wb-incomplete" data-tone="danger">回复未完整落盘</em>
        ) : null}
      </div>
      <div className="wb-msg-body">
        {parts}
        <ToolGroup parts={toolParts} onEvidence={onEvidence} />
        <div className="wb-reply-actions" data-latest={isLatestAssistant}>
          <button
            type="button"
            className="wb-action"
            onClick={() => { void copy(); }}
            title={copied ? '已复制' : '复制'}
            aria-label="复制这条回复"
          >
            <CopyIcon />
          </button>
          {onBranch !== undefined ? (
            <button
              type="button"
              className="wb-action"
              onClick={() => onBranch(message.id)}
              title="从此处创建讨论分支"
              aria-label="从此处创建讨论分支"
            >
              <BranchIcon />
            </button>
          ) : null}
          <time className="wb-time" dateTime={timeValue}>{time}</time>
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}
