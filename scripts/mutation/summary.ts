/**
 * 把 Stryker 的 mutation.json 变成一段中文 Markdown（PR 评论 / Job Summary 用）。
 *
 * 用法：node scripts/mutation/summary.ts reports/mutation/mutation.json [每个文件最多列几个存活变异，默认 15]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MUTATION_MARKER = '<!-- mutation-report -->';

interface Position {
  line: number;
  column: number;
}

export interface MutantResult {
  id: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  location: { start: Position; end: Position };
}

export interface MutationReport {
  files: Record<string, { source: string; mutants: MutantResult[] }>;
}

export interface FileScore {
  file: string;
  killed: number;
  survived: number;
  noCoverage: number;
  timeout: number;
  errors: number;
  /** 变异分（%）：杀掉的 / (杀掉的 + 存活 + 没覆盖)；超时算杀掉 */
  score: number;
}

export function scoreFile(file: string, mutants: MutantResult[]): FileScore {
  const count = (s: string) => mutants.filter((m) => m.status === s).length;
  const killed = count('Killed');
  const timeout = count('Timeout');
  const survived = count('Survived');
  const noCoverage = count('NoCoverage');
  const errors = count('CompileError') + count('RuntimeError');
  const valid = killed + timeout + survived + noCoverage;
  return { file, killed, survived, noCoverage, timeout, errors, score: valid === 0 ? 100 : ((killed + timeout) / valid) * 100 };
}

export function totalScore(scores: FileScore[]): FileScore {
  const sum = (k: 'killed' | 'survived' | 'noCoverage' | 'timeout' | 'errors') => scores.reduce((n, s) => n + s[k], 0);
  const killed = sum('killed');
  const timeout = sum('timeout');
  const survived = sum('survived');
  const noCoverage = sum('noCoverage');
  const valid = killed + timeout + survived + noCoverage;
  return {
    file: '合计',
    killed,
    survived,
    noCoverage,
    timeout,
    errors: sum('errors'),
    score: valid === 0 ? 100 : ((killed + timeout) / valid) * 100,
  };
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/`/g, "'").replace(/\|/g, '\\|');
  return flat.length > max ? flat.slice(0, max - 3) + '...' : flat;
}

function originalSnippet(source: string, m: MutantResult): string {
  const lines = source.split('\n');
  const { start, end } = m.location;
  if (start.line === end.line) return lines[start.line - 1]?.slice(start.column - 1, end.column - 1) ?? '';
  return (lines[start.line - 1]?.slice(start.column - 1) ?? '') + ' …';
}

export function renderSummary(report: MutationReport, maxPerFile = 15): string {
  const entries = Object.entries(report.files).sort(([a], [b]) => a.localeCompare(b));
  const scores = entries.map(([file, f]) => scoreFile(file, f.mutants));
  const total = totalScore(scores);
  const out: string[] = [MUTATION_MARKER, '## 变异测试（裁判的裁判）', ''];
  out.push(
    `**总变异分 ${total.score.toFixed(1)}%** —— 故意把代码改坏 ${total.killed + total.timeout + total.survived + total.noCoverage} 次，测试抓住了 ${total.killed + total.timeout} 次。`,
    '',
    '| 文件 | 变异分 | 抓住 | 存活 | 没覆盖 | 超时 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const s of [...scores, total]) {
    const name = s.file === '合计' ? '**合计**' : '`' + s.file + '`';
    out.push(`| ${name} | ${s.score.toFixed(1)}% | ${s.killed} | ${s.survived} | ${s.noCoverage} | ${s.timeout} |`);
  }
  const survivors = entries.flatMap(([file, f]) =>
    f.mutants.filter((m) => m.status === 'Survived' || m.status === 'NoCoverage').map((m) => ({ file, f, m })),
  );
  if (survivors.length > 0) {
    out.push('', '<details><summary>存活的变异（测试没抓住的"改坏"）</summary>', '');
    for (const [file, f] of entries) {
      const list = f.mutants
        .filter((m) => m.status === 'Survived' || m.status === 'NoCoverage')
        .sort((a, b) => a.location.start.line - b.location.start.line);
      if (list.length === 0) continue;
      out.push('', `**${file}**（${list.length} 个）`, '', '| 行 | 变异 | 原来 | 改成 | 状态 |', '| ---: | --- | --- | --- | --- |');
      for (const m of list.slice(0, maxPerFile)) {
        out.push(
          `| ${m.location.start.line} | ${m.mutatorName} | \`${oneLine(originalSnippet(f.source, m))}\` | \`${oneLine(m.replacement ?? '')}\` | ${m.status === 'NoCoverage' ? '没覆盖' : '存活'} |`,
        );
      }
      if (list.length > maxPerFile) out.push(`| … | 还有 ${list.length - maxPerFile} 个，见 HTML 报告 | | | |`);
    }
    out.push('', '</details>');
  }
  out.push('', '完整报告：本次运行的 Artifacts → `mutation-report`（下载后打开 `index.html`）。');
  return out.join('\n') + '\n';
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] ?? 'reports/mutation/mutation.json';
  const max = Number(process.argv[3] ?? '15');
  const report = JSON.parse(readFileSync(path, 'utf8')) as MutationReport;
  process.stdout.write(renderSummary(report, Number.isFinite(max) ? max : 15));
}
