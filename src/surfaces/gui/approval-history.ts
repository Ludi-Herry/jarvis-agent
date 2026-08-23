import { open, opendir, lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactSecrets } from '../../core/model/errors.js';
import { isApprovalAuditRecord } from '../../runtime/permission/approval-audit-store.js';
import {
  type ApprovalAuditDecision,
  type ApprovalAuditRecord,
} from '../../runtime/permission/index.js';

export interface GuiApprovalHistoryEntry {
  requestId: string;
  sessionId?: string;
  toolName: string;
  capability?: string;
  reason?: string;
  detail?: string;
  requestedAt?: string;
  decision?: ApprovalAuditDecision;
  resolvedAt?: string;
  error?: string;
  status: 'pending' | 'allowed' | 'denied' | 'error' | 'orphan-result';
  source: string;
  persistedRecords: { request: boolean; result: boolean };
}

export interface GuiApprovalHistory {
  records: GuiApprovalHistoryEntry[];
  total: number;
  truncated: boolean;
  coverage: 'complete' | 'partial';
  warnings: string[];
}

export interface ApprovalHistoryTestHooks {
  afterPathValidation?: (path: string) => Promise<void>;
  afterOpen?: (path: string) => Promise<void>;
}

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_DIRECTORY_ENTRIES = 1000;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RECORDS = 1000;
const MAX_WARNINGS = 20;
const MAX_DISPLAY_TEXT = 4000;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/u;

export async function listGuiApprovalHistory(
  dataDir: string,
  limit = DEFAULT_HISTORY_LIMIT,
  hooks: ApprovalHistoryTestHooks = {},
): Promise<GuiApprovalHistory> {
  const approvalsDir = join(dataDir, 'approvals');
  let canonicalDir: string;
  const entries: string[] = [];
  const warnings: string[] = [];
  try {
    const directory = await lstat(approvalsDir);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      return partialHistory('审批历史路径不是安全目录');
    }
    canonicalDir = await realpath(approvalsDir);
    const stream = await opendir(approvalsDir);
    let scanned = 0;
    for await (const entry of stream) {
      scanned++;
      if (scanned > MAX_DIRECTORY_ENTRIES) {
        addWarning(warnings, `审批历史目录超过 ${MAX_DIRECTORY_ENTRIES} 个条目，停止继续枚举`);
        break;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      if (entries.length >= MAX_FILES) {
        addWarning(warnings, `审批历史文件超过 ${MAX_FILES} 个，只读取有界子集`);
        break;
      }
      entries.push(entry.name);
    }
    entries.sort();
  } catch (err) {
    if (isNotFound(err)) return emptyHistory();
    return partialHistory('审批历史目录无法读取');
  }

  const auditRecords: Array<{ record: ApprovalAuditRecord; source: string }> = [];
  for (const entry of entries) {
    if (auditRecords.length >= MAX_RECORDS) {
      addWarning(warnings, `审批历史记录超过 ${MAX_RECORDS} 条，停止继续解析`);
      break;
    }
    if (!SAFE_FILE.test(entry)) {
      addWarning(warnings, '已忽略名称不安全的审批历史文件');
      continue;
    }
    const path = join(approvalsDir, entry);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const pathInfo = await lstat(path);
      if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1) {
        addWarning(warnings, '有一份审批历史不是安全文件');
        continue;
      }
      const canonicalFile = await realpath(path);
      if (!isContainedPath(canonicalDir, canonicalFile)) {
        addWarning(warnings, '有一份审批历史不是安全文件');
        continue;
      }
      await hooks.afterPathValidation?.(path);
      handle = await open(canonicalFile, 'r');
      const fileInfo = await handle.stat();
      if (
        !fileInfo.isFile()
        || fileInfo.nlink !== 1
        || pathInfo.dev !== fileInfo.dev
        || pathInfo.ino !== fileInfo.ino
      ) {
        addWarning(warnings, '有一份审批历史不是安全文件');
        continue;
      }
      if (fileInfo.size > MAX_FILE_BYTES) {
        addWarning(warnings, `有一份审批历史超过 ${MAX_FILE_BYTES} 字节，已跳过`);
        continue;
      }
      await hooks.afterOpen?.(path);
      const bounded = await readBoundedUtf8(handle, MAX_FILE_BYTES);
      const finalInfo = await handle.stat();
      if (
        bounded.exceeded
        || fileInfo.size !== finalInfo.size
        || fileInfo.mtimeMs !== finalInfo.mtimeMs
        || fileInfo.ctimeMs !== finalInfo.ctimeMs
      ) {
        addWarning(warnings, `有一份审批历史超过 ${MAX_FILE_BYTES} 字节或读取期间发生变化，已跳过`);
        continue;
      }
      const parsed = parseApprovalAuditBounded(bounded.text, MAX_RECORDS - auditRecords.length);
      if (parsed.malformed) addWarning(warnings, '有一份审批历史包含无法解析的记录');
      if (parsed.truncated) addWarning(warnings, `审批历史记录超过 ${MAX_RECORDS} 条，停止继续解析`);
      const source = `approvals/${safeDisplayText(basename(entry, '.jsonl'))}.jsonl`;
      for (const record of parsed.records) {
        if (auditRecords.length >= MAX_RECORDS) break;
        auditRecords.push({ record, source });
      }
    } catch {
      addWarning(warnings, '有一份审批历史无法安全读取');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  const records = pairApprovalRecords(auditRecords, warnings);
  records.sort((a, b) => timestamp(b.resolvedAt ?? b.requestedAt) - timestamp(a.resolvedAt ?? a.requestedAt));
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_HISTORY_LIMIT;
  return {
    records: records.slice(0, boundedLimit),
    total: records.length,
    truncated: records.length > boundedLimit,
    coverage: warnings.length === 0 ? 'complete' : 'partial',
    warnings,
  };
}

function pairApprovalRecords(
  records: ReadonlyArray<{ record: ApprovalAuditRecord; source: string }>,
  warnings: string[],
): GuiApprovalHistoryEntry[] {
  const pairs = new Map<string, {
    request?: Extract<ApprovalAuditRecord, { t: 'approval-request' }>;
    result?: Extract<ApprovalAuditRecord, { t: 'approval-result' }>;
    source: string;
  }>();
  for (const item of records) {
    const key = JSON.stringify([item.source, item.record.requestId]);
    const pair = pairs.get(key) ?? { source: item.source };
    if (item.record.t === 'approval-request') {
      if (pair.request !== undefined) addWarning(warnings, '审批历史包含重复 request 记录');
      else pair.request = item.record;
    } else {
      if (pair.result !== undefined) addWarning(warnings, '审批历史包含重复 result 记录');
      else pair.result = item.record;
    }
    pairs.set(key, pair);
  }

  return [...pairs.values()].map((pair) => {
    const request = pair.request === undefined ? undefined : displaySafeRecord(pair.request);
    const result = pair.result === undefined ? undefined : displaySafeRecord(pair.result);
    const decision = result?.decision;
    return {
      requestId: request?.requestId ?? result?.requestId ?? 'unknown',
      ...optional('sessionId', request?.sessionId ?? result?.sessionId),
      toolName: request?.toolName ?? result?.toolName ?? 'unknown',
      ...optional('capability', request?.capability),
      ...optional('reason', request?.reason),
      ...optional('detail', request?.detail),
      ...optional('requestedAt', request?.at),
      ...optional('decision', decision),
      ...optional('resolvedAt', result?.at),
      ...optional('error', result?.error),
      status: request === undefined
        ? 'orphan-result'
        : result === undefined
          ? 'pending'
          : decision === 'deny'
            ? 'denied'
            : decision === 'error'
              ? 'error'
              : 'allowed',
      source: pair.source,
      persistedRecords: { request: request !== undefined, result: result !== undefined },
    } satisfies GuiApprovalHistoryEntry;
  });
}

async function readBoundedUtf8(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<{ text: string; exceeded: boolean }> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return {
    text: buffer.subarray(0, Math.min(offset, maxBytes)).toString('utf8'),
    exceeded: offset > maxBytes,
  };
}

function parseApprovalAuditBounded(
  text: string,
  maxRecords: number,
): { records: ApprovalAuditRecord[]; malformed: boolean; truncated: boolean } {
  const records: ApprovalAuditRecord[] = [];
  let malformed = false;
  let cursor = 0;
  while (cursor <= text.length) {
    const newline = text.indexOf('\n', cursor);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(cursor, end).trim();
    if (line !== '') {
      if (records.length >= maxRecords) return { records, malformed, truncated: true };
      try {
        const value: unknown = JSON.parse(line);
        if (isGuiApprovalAuditRecord(value)) records.push(value);
        else malformed = true;
      } catch {
        malformed = true;
      }
    }
    if (newline === -1) break;
    cursor = newline + 1;
  }
  return { records, malformed, truncated: false };
}

function displaySafeRecord(
  record: Extract<ApprovalAuditRecord, { t: 'approval-request' }>,
): Extract<ApprovalAuditRecord, { t: 'approval-request' }>;
function displaySafeRecord(
  record: Extract<ApprovalAuditRecord, { t: 'approval-result' }>,
): Extract<ApprovalAuditRecord, { t: 'approval-result' }>;
function displaySafeRecord(record: ApprovalAuditRecord): ApprovalAuditRecord {
  if (record.t === 'approval-request') {
    return {
      ...record,
      requestId: safeDisplayText(record.requestId),
      ...(record.sessionId === undefined ? {} : { sessionId: safeDisplayText(record.sessionId) }),
      toolName: safeDisplayText(record.toolName),
      reason: safeDisplayText(record.reason),
      detail: safeDisplayText(record.detail),
      at: safeDisplayText(record.at),
    };
  }
  return {
    ...record,
    requestId: safeDisplayText(record.requestId),
    ...(record.sessionId === undefined ? {} : { sessionId: safeDisplayText(record.sessionId) }),
    toolName: safeDisplayText(record.toolName),
    ...(record.error === undefined ? {} : { error: safeDisplayText(record.error) }),
    at: safeDisplayText(record.at),
  };
}

function isGuiApprovalAuditRecord(value: unknown): value is ApprovalAuditRecord {
  return isApprovalAuditRecord(value)
    && (value.sessionId === undefined || typeof value.sessionId === 'string');
}

function emptyHistory(): GuiApprovalHistory {
  return { records: [], total: 0, truncated: false, coverage: 'complete', warnings: [] };
}

function partialHistory(warning: string): GuiApprovalHistory {
  return { ...emptyHistory(), coverage: 'partial', warnings: [warning] };
}

function addWarning(warnings: string[], warning: string): void {
  if (warnings.includes(warning)) return;
  if (warnings.length < MAX_WARNINGS) {
    warnings.push(warning);
    return;
  }
  warnings[MAX_WARNINGS - 1] = '更多审批历史问题已省略';
}

function safeDisplayText(text: string): string {
  return redactSecrets(stripUnsafeInline(text)).slice(0, MAX_DISPLAY_TEXT);
}

function stripUnsafeInline(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 32;
    const unsafe = code < 32
      || (code >= 127 && code <= 159)
      || code === 0x2028
      || code === 0x2029
      || code === 0x200e
      || code === 0x200f
      || code === 0x061c
      || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069);
    return unsafe ? ' ' : char;
  }).join('').replace(/ +/gu, ' ').trim();
}

function isContainedPath(parent: string, child: string): boolean {
  const local = relative(resolve(parent), resolve(child));
  return local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

function timestamp(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]: V };
}
