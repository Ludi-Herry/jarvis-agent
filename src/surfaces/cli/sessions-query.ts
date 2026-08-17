/**
 * Shared filter / sort / pagination layer for the read-only sessions reports.
 *
 * The pure functions here are the single decision point for `sessions list`
 * (filter + sort + paginate) and `sessions search` (session filter + match
 * pagination). Flag parsing/validation lives here too so the CLI actions can
 * turn bad values into exit 2 before any report work happens. Everything is
 * additive on top of the existing reports: when no flags are given the
 * builder output stays byte-identical to the pre-selection behavior.
 *
 * Damage visibility is intentionally NOT selectable: callers must compute
 * integrity/skip/exit-7 decisions on the unfiltered set and only pass display
 * items through `applySessionSelection`.
 */
import type { SessionResumeVerdict } from './sessions.js';

export const SESSION_SELECTION_FORMATS = ['v1', 'v2', 'unknown'] as const;
export const SESSION_SELECTION_INTEGRITY = ['complete', 'partial'] as const;
export const SESSION_SELECTION_RESUME_VERDICTS: readonly SessionResumeVerdict[] = [
  'ready-for-resume-check',
  'review-pending-effects',
  'review-composition',
  'legacy-incomplete-evidence',
  'refuse-resume',
];
export const SESSION_SELECTION_SORTS = ['modified', 'started', 'id'] as const;
export const SESSION_SELECTION_ORDERS = ['asc', 'desc'] as const;

export type SessionSelectionFormat = (typeof SESSION_SELECTION_FORMATS)[number];
export type SessionSelectionIntegrity = (typeof SESSION_SELECTION_INTEGRITY)[number];
export type SessionSelectionSort = (typeof SESSION_SELECTION_SORTS)[number];
export type SessionSelectionOrder = (typeof SESSION_SELECTION_ORDERS)[number];

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/** Raw flag values as commander hands them to the action (all strings). */
export interface SessionSelectionFlags {
  format?: string;
  integrity?: string;
  resume?: string;
  sort?: string;
  order?: string;
  page?: string;
  pageSize?: string;
}

export interface SessionSelectionQuery {
  format?: SessionSelectionFormat;
  integrity?: SessionSelectionIntegrity;
  resume?: SessionResumeVerdict;
  sort: SessionSelectionSort;
  order: SessionSelectionOrder;
  /** 1-based page; present only when pagination was requested. */
  page?: number;
  pageSize?: number;
}

/** Additive echo block embedded in JSON reports when a selection was applied. */
export interface SessionSelectionInfo {
  filters: {
    format?: SessionSelectionFormat;
    integrity?: SessionSelectionIntegrity;
    resume?: SessionResumeVerdict;
  };
  sort: SessionSelectionSort;
  order: SessionSelectionOrder;
  total: number;
  filtered: number;
  returned: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
}

export type SessionSelectionParse =
  | { status: 'ok'; query: SessionSelectionQuery }
  | { status: 'invalid'; reason: string };

export function parseSessionSelection(flags: SessionSelectionFlags): SessionSelectionParse {
  const query: SessionSelectionQuery = { sort: 'modified', order: 'desc' };
  if (flags.format !== undefined) {
    if (!includes(SESSION_SELECTION_FORMATS, flags.format)) {
      return invalid('--format', flags.format, SESSION_SELECTION_FORMATS);
    }
    query.format = flags.format;
  }
  if (flags.integrity !== undefined) {
    if (!includes(SESSION_SELECTION_INTEGRITY, flags.integrity)) {
      return invalid('--integrity', flags.integrity, SESSION_SELECTION_INTEGRITY);
    }
    query.integrity = flags.integrity;
  }
  if (flags.resume !== undefined) {
    if (!includes(SESSION_SELECTION_RESUME_VERDICTS, flags.resume)) {
      return invalid('--resume', flags.resume, SESSION_SELECTION_RESUME_VERDICTS);
    }
    query.resume = flags.resume;
  }
  if (flags.sort !== undefined) {
    if (!includes(SESSION_SELECTION_SORTS, flags.sort)) {
      return invalid('--sort', flags.sort, SESSION_SELECTION_SORTS);
    }
    query.sort = flags.sort;
  }
  if (flags.order !== undefined) {
    if (!includes(SESSION_SELECTION_ORDERS, flags.order)) {
      return invalid('--order', flags.order, SESSION_SELECTION_ORDERS);
    }
    query.order = flags.order;
  }
  if (flags.pageSize !== undefined) {
    const pageSize = parseBoundedInteger('--page-size', flags.pageSize, 1, MAX_PAGE_SIZE);
    if (typeof pageSize === 'string') return { status: 'invalid', reason: pageSize };
    query.pageSize = pageSize;
  }
  if (flags.page !== undefined) {
    const page = parseBoundedInteger('--page', flags.page, 1, Number.MAX_SAFE_INTEGER);
    if (typeof page === 'string') return { status: 'invalid', reason: page };
    query.page = page;
    query.pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  }
  if (query.pageSize !== undefined && query.page === undefined) query.page = 1;
  return { status: 'ok', query };
}

/** True when the user supplied any selection flag; false keeps report output
 * byte-identical to the pre-selection contract. */
export function hasSessionSelection(flags: SessionSelectionFlags): boolean {
  return Object.values(flags).some((value) => value !== undefined);
}

/** Copy only the known selection keys off a commander options object. */
export function pickSelectionFlags(source: SessionSelectionFlags): SessionSelectionFlags {
  const flags: SessionSelectionFlags = {};
  if (source.format !== undefined) flags.format = source.format;
  if (source.integrity !== undefined) flags.integrity = source.integrity;
  if (source.resume !== undefined) flags.resume = source.resume;
  if (source.sort !== undefined) flags.sort = source.sort;
  if (source.order !== undefined) flags.order = source.order;
  if (source.page !== undefined) flags.page = source.page;
  if (source.pageSize !== undefined) flags.pageSize = source.pageSize;
  return flags;
}

export interface SessionSelectable {
  id: string;
  format: 'v1' | 'v2' | 'unknown';
  integrityStatus: SessionSelectionIntegrity;
  resumeVerdict: SessionResumeVerdict;
  /** ms epoch; absent values sort as oldest. */
  modifiedMs: number;
  /** ISO timestamp; absent values sort as oldest. */
  startedAt?: string;
}

export interface SessionSelectionResult<T> {
  items: T[];
  info: SessionSelectionInfo;
}

/** Filter → sort → paginate display items. `total` is the pre-filter count so
 * the report can show how much the filters removed. */
export function applySessionSelection<T extends SessionSelectable>(
  items: readonly T[],
  query: SessionSelectionQuery,
): SessionSelectionResult<T> {
  const filtered = items.filter((item) => {
    if (query.format !== undefined && item.format !== query.format) return false;
    if (query.integrity !== undefined && item.integrityStatus !== query.integrity) return false;
    if (query.resume !== undefined && item.resumeVerdict !== query.resume) return false;
    return true;
  });
  const direction = query.order === 'asc' ? 1 : -1;
  const sorted = [...filtered].sort((left, right) => {
    const primary = compareBySort(left, right, query.sort);
    if (primary !== 0) return primary * direction;
    return compareText(left.id, right.id); // stable, direction-independent tie-break
  });
  const paginated = query.page === undefined || query.pageSize === undefined
    ? sorted
    : sorted.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  const info: SessionSelectionInfo = {
    filters: {
      ...(query.format === undefined ? {} : { format: query.format }),
      ...(query.integrity === undefined ? {} : { integrity: query.integrity }),
      ...(query.resume === undefined ? {} : { resume: query.resume }),
    },
    sort: query.sort,
    order: query.order,
    total: items.length,
    filtered: filtered.length,
    returned: paginated.length,
    ...(query.page === undefined || query.pageSize === undefined
      ? {}
      : {
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(filtered.length / query.pageSize)),
      }),
  };
  return { items: paginated, info };
}

function compareBySort<T extends SessionSelectable>(left: T, right: T, sort: SessionSelectionSort): number {
  switch (sort) {
    case 'id':
      return compareText(left.id, right.id);
    case 'started':
      return compareText(left.startedAt ?? '', right.startedAt ?? '');
    case 'modified':
      return left.modifiedMs - right.modifiedMs;
  }
}

function parseBoundedInteger(flag: string, raw: string, min: number, max: number): number | string {
  if (!/^\d+$/u.test(raw)) return `${flag} must be a positive integer, got ${JSON.stringify(raw.slice(0, 80))}`;
  const value = Number(raw);
  if (value < min || value > max) return `${flag} must be between ${min} and ${max}, got ${value}`;
  return value;
}

function invalid(flag: string, value: string, allowed: readonly string[]): SessionSelectionParse {
  return {
    status: 'invalid',
    reason: `${flag} must be one of ${allowed.join('|')}, got ${JSON.stringify(value.slice(0, 80))}`,
  };
}

function includes<T>(allowed: readonly T[], value: unknown): value is T {
  return (allowed as readonly unknown[]).includes(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
