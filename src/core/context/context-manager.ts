/**
 * ContextManager — keeps the conversation under the model's window (plan §3.5).
 *
 * Two jobs:
 *  1. COMPACT when the prompt nears the window: summarize an old prefix with a cheap model
 *     and keep a recent tail verbatim, cutting only at a safe boundary (split.ts) so a
 *     tool call is never torn from its result. The system prompt (index 0) is preserved as
 *     the immutable prefix.
 *  2. BUDGET a single oversized tool result: truncate it and offload the full text to disk,
 *     leaving a pointer + preview in context — so one giant `read` can't blow the window
 *     before compaction even gets a chance (kimi-code `budgetToolResultForModel`).
 *
 * The trigger threshold is measured against the EFFECTIVE input budget (window − reserved
 * output), reusing the loop's pure {@link decideCompact}. `budgetToolResult` is async (it
 * writes a file) — a deliberate departure from the plan's sync draft, since the rest of the
 * harness is async and sync fs in a hot path is a smell.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message, ToolResult } from '../types.js';
import type { ModelProvider, Usage } from '../model/types.js';
import { decideCompact } from '../loop/decisions.js';
import { findSplitPoint } from './split.js';

/** The contract the loop depends on (injected as optional `ctx.context`). */
export interface ContextManager {
  shouldCompact(usage: Usage): boolean;
  /** Replace the summarizable prefix in place with a single summary message. No-op when no
   *  safe cut summarizes anything. */
  compact(messages: Message[]): Promise<void>;
  /** Truncate + offload an oversized tool result; pass small results through unchanged. */
  budgetToolResult(out: ToolResult): Promise<ToolResult>;
}

export interface ContextManagerOptions {
  /** Model that writes the summary — a cheap one in production. */
  summarizer: ModelProvider;
  /** Total context window in tokens. */
  maxContextTokens: number;
  /** Tokens reserved for output; effective input budget = context − output. */
  maxOutputTokens: number;
  /** Verbatim tail kept uncompacted (plan §5.2: ~20). */
  keepRecent?: number;
  /** A tool result longer than this (chars) is truncated and offloaded. */
  maxToolResultChars?: number;
  /** Directory offloaded tool results are written to (gitignored). */
  toolResultDir?: string;
}

const DEFAULT_KEEP_RECENT = 20;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 50_000;
const DEFAULT_TOOL_RESULT_DIR = 'data/tool-results';
const TOOL_PREVIEW_CHARS = 2_000;

/** Marker prefixing the injected summary so it's identifiable in context and logs. */
export const SUMMARY_MARKER = '[对话历史摘要]';

const SUMMARY_INSTRUCTION = [
  '你在压缩一段较长的对话历史,供后续对话继续参考。',
  '请严格按以下小节输出结构化摘要,每节即使为空也要保留并写"无":',
  '## 目标\n## 已完成\n## 阻塞/待解决\n## 关键决策\n## 待办\n## 相关文件/路径',
  '只输出摘要本身,不要寒暄或解释。尽量保留具体的文件名、路径、数字与结论。',
].join('\n');

export class DefaultContextManager implements ContextManager {
  private readonly summarizer: ModelProvider;
  private readonly effectiveBudget: number;
  private readonly keepRecent: number;
  private readonly maxToolResultChars: number;
  private readonly toolResultDir: string;

  constructor(options: ContextManagerOptions) {
    this.summarizer = options.summarizer;
    this.effectiveBudget = options.maxContextTokens - options.maxOutputTokens;
    this.keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
    this.maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    this.toolResultDir = options.toolResultDir ?? DEFAULT_TOOL_RESULT_DIR;
  }

  shouldCompact(usage: Usage): boolean {
    return decideCompact(usage, this.effectiveBudget);
  }

  async compact(messages: Message[]): Promise<void> {
    const headStart = messages[0]?.role === 'system' ? 1 : 0;
    const split = findSplitPoint(messages, this.keepRecent, headStart);
    if (split <= headStart) return; // no safe cut summarizes anything → leave as-is

    const toSummarize = messages.slice(headStart, split);
    const summary = await this.summarize(toSummarize);
    const summaryMsg: Message = { role: 'user', content: `${SUMMARY_MARKER}\n${summary}` };
    // Splice in place so the loop's `ctx.messages` reference observes the replacement.
    messages.splice(headStart, split - headStart, summaryMsg);
  }

  async budgetToolResult(out: ToolResult): Promise<ToolResult> {
    if (out.content.length <= this.maxToolResultChars) return out;

    await mkdir(this.toolResultDir, { recursive: true });
    const file = join(this.toolResultDir, `${sanitizeFileName(out.callId)}.txt`);
    await writeFile(file, out.content, 'utf8');

    const preview = out.content.slice(0, TOOL_PREVIEW_CHARS);
    return {
      ...out,
      content:
        `[tool output truncated: ${out.content.length} chars saved to ${file}; ` +
        `first ${TOOL_PREVIEW_CHARS} chars below]\n${preview}`,
    };
  }

  /** Drive the summarizer to completion (no event streaming) and return its text. */
  private async summarize(messages: Message[]): Promise<string> {
    const stream = this.summarizer.call(
      [
        { role: 'system', content: SUMMARY_INSTRUCTION },
        { role: 'user', content: renderTranscript(messages) },
      ],
      [],
    );
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    return next.value.text.trim();
  }
}

/** Render messages as a plain labeled transcript for the summarizer to read. */
function renderTranscript(messages: Message[]): string {
  return messages
    .map((m): string => {
      switch (m.role) {
        case 'system':
          return `[system]\n${m.content}`;
        case 'user':
          return `[user]\n${m.content}`;
        case 'assistant': {
          const parts: string[] = [];
          if (m.content) parts.push(m.content);
          if (m.toolCalls && m.toolCalls.length > 0) {
            parts.push(
              `(调用工具: ${m.toolCalls.map((c) => `${c.name}(${c.arguments})`).join(', ')})`,
            );
          }
          return `[assistant]\n${parts.join('\n')}`;
        }
        case 'tool':
          return `[tool result]\n${m.content}`;
      }
    })
    .join('\n\n');
}

/** Make a tool_call_id safe as a filename, capped so an odd id can't produce a huge name. */
function sanitizeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'tool-result';
}
