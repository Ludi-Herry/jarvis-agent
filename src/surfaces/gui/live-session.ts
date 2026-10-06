import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  buildDefaultRegistry, createBashTool, createProvider, DefaultContextManager, defaultShellPath,
  loadDoubaoConfig, runAgent, runCommand, scrubProviderKeyFromEnv,
  type DoubaoConfig, type ModelProvider, type Message, type ThinkingEffort,
} from '../../core/index.js';
import { redactSecrets } from '../../core/model/errors.js';
import {
  buildConfigPermissionPolicy, createEmergencyStopSignal, createSessionComposition,
  DefaultPermissionGate, FileSessionStore, InMemoryEventBus, loadSessionLog,
  NO_DYNAMIC_ADDENDUM, requestEmergencyStop, resolveNoDynamicAddendum, validateSessionId,
  type ApprovalResponse, type Event, type PermissionGate, type SessionComposition, type SessionStore,
} from '../../runtime/index.js';
import {
  applyHumanReviewDecision, FileGoalStore, listPendingHumanReviews, loadGoal, runGoal,
  snapshotWorktreeStatus, updateGoalToolSchema, runDeterministicChecks,
  type GoalResumeState, type HumanReviewDecisionInput, type TestBaseline,
} from '../../capabilities/goal/index.js';
import { createApprovalEventApprover, FileApprovalAuditStore } from '../cli/approval-events.js';
import { appendConfigPermissionBoundary, loadCliConfig } from '../cli/config.js';
import { JARVIS_VERSION } from '../cli/package-info.js';
import { resolveHooks, type HookRunner } from '../../capabilities/hooks/index.js';
import { applyGuiEvent, updateGuiCapabilities, type GuiObservedEvent } from './live-projection.js';
import type {
  GuiGitStatus, GuiLiveOverview, GuiLiveOverviewSession, GuiLiveSnapshot, GuiMessage,
  GuiModelsResponse, GuiTaskContract, GuiTaskFieldError, GuiTaskValidateResponse, GuiWorkspaceInfo,
} from './live-types.js';

/** Operator-owned task contract. The browser/model cannot edit checks, paths or budgets. */
export type GuiTaskDefinition = GuiTaskContract;

/** Requirement auto-derived when a free/branch task omits an explicit list (contract §D10/§E13). */
export const GUI_DERIVED_REQUIREMENT = '完成本轮对话中你确认的目标';

export const FORK_MESSAGE_CAP = 4_000;
export const FORK_TOTAL_CAP = 24_000;

const ALL_THINKING_LEVELS: ThinkingEffort[] = ['off', 'low', 'medium', 'high'];
const GIT_CACHE_MS = 5_000;

interface ForkRecord {
  parentId: string;
  turnId: string;
  round: number;
  omitted: boolean;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
}

interface TaskStarted {
  baseline: TestBaseline;
  composition: SessionComposition;
  model: string;
  at: string;
}

interface CreatedRecord {
  type: 'gui_created';
  sequence: 0;
  id: string;
  task: GuiTaskDefinition;
  model: string;
  at: string;
  /** Pre-batch-2 journals captured baseline/composition inside the created record; batch-2 tasks
   *  write them as a gui_task_started event at actual start time. */
  composition?: SessionComposition;
  baseline?: TestBaseline;
  fork?: ForkRecord;
}
interface EventRecord { type: 'gui_event'; sequence: number; event: GuiObservedEvent; at: string }
interface LiveTask {
  created: CreatedRecord;
  snapshot: GuiLiveSnapshot;
  queue: Promise<void>;
  run?: Promise<void>;
  abort: AbortController;
  pauseRequested: boolean;
  wake?: () => void;
  approval?: { requestId: string; resolve: (response: ApprovalResponse) => void };
  journalError?: Error;
  modelStarts: number;
  checkedEvidence?: string;
  reviewing?: boolean;
  /** True when this task came from the CLI-pinned --task-file contract (resume re-checks it). */
  pinned: boolean;
  /** Timestamp of the latest journaled record (created record or last gui_event). */
  lastEventAt: string;
  /** Baseline/composition frozen at start (folded from created record or gui_task_started). */
  started?: TaskStarted;
  /** Per-task provider identity resolved at start/resume. */
  identity?: { provider: ModelProvider; modelName: string };
  /** Branch context injected into the new Session ahead of the first model call. */
  forkMessages?: Message[];
  forkInjected?: boolean;
  gitCache?: { at: number; payload: GuiGitStatus };
}

export class GuiLiveError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface GuiSessionHostOptions {
  cwd: string;
  dataDir: string;
  task?: GuiTaskDefinition;
  /** Deterministic tests inject a provider; production uses the unchanged CLI config route. */
  provider?: ModelProvider;
  modelName?: string;
}

const BUILDER_PROMPT = [
  '你是 Jarvis，本次通过本地 GUI 与用户协作完成一个固定任务。',
  '先用 read/grep 定位，局部改动用 edit，整文件替换用 write；保留 expectedVersion，创建文件用 createOnly:true。',
  '只有本次合同列出的文件可写。不要修改依赖、测试、检查脚本、配置、密钥或历史证据，不删除/移动文件，不提交或推送。',
  '不要调用未提供的工具。审批被拒绝时读清用户理由并调整，不能更换方法绕过同一拒绝。',
  '禁止查询代理/VPN、网络身份、DNS、IP、网卡、路由、订阅和节点；只处理任务相关源文件。',
  '用户补充通过 user 消息或拒绝理由送达；需要澄清时问一个具体问题。',
  '任务交付后调用 update_goal(complete)，然后清楚说明交付物；Runtime 将独立检查并交给用户验收。',
  '模型的完成声明不代表验证通过；遇到无法继续的阻塞则 update_goal(blocked)。',
].join('\n');

/** Structured per-field contract inspection; validateGuiTask keeps the throwing form. */
export function inspectGuiTask(value: unknown): { ok: boolean; errors: GuiTaskFieldError[]; task?: GuiTaskDefinition } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ field: 'contract', message: '任务合同必须是一个对象' }] };
  }
  const task = value as GuiTaskDefinition;
  const errors: GuiTaskFieldError[] = [];
  if (typeof task.objective !== 'string' || !task.objective.trim() || task.objective.length > 3500) {
    errors.push({ field: 'objective', message: 'objective 必须是 1–3500 字的非空文本' });
  }
  if (typeof task.cwd !== 'string' || !isAbsolute(task.cwd)) {
    errors.push({ field: 'cwd', message: 'cwd 必须是绝对路径' });
  }
  if (!Array.isArray(task.requirements) || !task.requirements.length || task.requirements.length > 8
    || !task.requirements.every((item) => typeof item === 'string' && item.trim() && item.length <= 1000)) {
    errors.push({ field: 'requirements', message: 'requirements 必须是 1–8 条、每条 1–1000 字的文本' });
  }
  if (!Array.isArray(task.writePaths) || !task.writePaths.length
    || !task.writePaths.every((path) => typeof path === 'string' && path !== '' && !isAbsolute(path)
      && !path.split(/[\\/]/u).some((part) => part === '..' || part === '.' || part === '') && !/[*?]/u.test(path))) {
    errors.push({ field: 'writePaths', message: 'writePaths 必须是非空数组，每项为不含 ..、通配符的相对路径' });
  }
  if (!Array.isArray(task.checkCommands) || !task.checkCommands.length
    || !task.checkCommands.every((item) => typeof item === 'string' && item.trim())) {
    errors.push({ field: 'checkCommands', message: 'checkCommands 必须是非空的命令数组' });
  }
  if (!Number.isInteger(task.maxRounds) || task.maxRounds < 1 || task.maxRounds > 8) {
    errors.push({ field: 'maxRounds', message: 'maxRounds 必须是 1–8 的整数' });
  }
  if (!Number.isInteger(task.maxTurns) || task.maxTurns < 1 || task.maxTurns > 16) {
    errors.push({ field: 'maxTurns', message: 'maxTurns 必须是 1–16 的整数' });
  }
  if (!Number.isInteger(task.wallClockMs) || task.wallClockMs < 100 || task.wallClockMs > 900_000) {
    errors.push({ field: 'wallClockMs', message: 'wallClockMs 必须是 100–900000 的整数' });
  }
  if (task.shellCommands !== undefined && (!Array.isArray(task.shellCommands)
    || !task.shellCommands.every((item) => typeof item === 'string' && item.trim()))) {
    errors.push({ field: 'shellCommands', message: 'shellCommands 如给出必须是非空字符串数组' });
  }
  if (task.model !== undefined && (typeof task.model !== 'string' || !task.model.trim() || task.model.length > 200)) {
    errors.push({ field: 'model', message: 'model 如给出必须是 1–200 字的模型 id' });
  }
  if (task.thinking !== undefined && (typeof task.thinking !== 'string' || !ALL_THINKING_LEVELS.includes(task.thinking as ThinkingEffort))) {
    errors.push({ field: 'thinking', message: `thinking 必须是 ${ALL_THINKING_LEVELS.join(' / ')} 之一` });
  }
  if (task.workspaceId !== undefined && (typeof task.workspaceId !== 'string' || !task.workspaceId.trim() || task.workspaceId.length > 200)) {
    errors.push({ field: 'workspaceId', message: 'workspaceId 如给出必须是 1–200 字的非空字符串' });
  }
  if (task.sourceRef !== undefined) {
    const ref = task.sourceRef;
    if (!ref || typeof ref !== 'object' || typeof ref.parentId !== 'string' || !ref.parentId.trim()
      || typeof ref.turnId !== 'string' || !ref.turnId.trim()
      || typeof ref.summary !== 'string' || ref.summary.length > 500) {
      errors.push({ field: 'sourceRef', message: 'sourceRef 必须是 {parentId, turnId, summary≤500字}' });
    }
  }
  if (task.pricing && (!Number.isFinite(task.pricing.inputCnyPerMillion) || task.pricing.inputCnyPerMillion < 0
    || !Number.isFinite(task.pricing.outputCnyPerMillion) || task.pricing.outputCnyPerMillion < 0 || !task.pricing.source)) {
    errors.push({ field: 'pricing', message: 'pricing 单价必须是非负数字且注明来源' });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], task: structuredClone(task) };
}

export function validateGuiTask(value: unknown): GuiTaskDefinition {
  const result = inspectGuiTask(value);
  if (!result.ok || !result.task) {
    throw new GuiLiveError(400, `invalid task contract: ${result.errors.map((error) => `${error.field}: ${error.message}`).join('；')}`);
  }
  return result.task;
}

/** Cut the parent conversation up to and including turnId into a bounded, redacted excerpt. */
export function buildForkExcerpt(
  messages: GuiMessage[],
  turnId: string,
): { round: number; omitted: boolean; messages: Array<{ role: 'user' | 'assistant'; text: string }> } | null {
  const dialog = messages.filter((message) => message.role === 'user' || message.role === 'assistant');
  const index = dialog.findIndex((message) => message.id === turnId);
  if (index < 0) return null;
  const upto = dialog.slice(0, index + 1);
  const round = Math.max(1, upto.filter((message) => message.role === 'user').length);
  const trimmed = upto.map((message) => ({ role: message.role, text: redactSecrets(message.text).slice(0, FORK_MESSAGE_CAP) }));
  const kept: typeof trimmed = [];
  let total = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const message = trimmed[i];
    if (total + message.text.length > FORK_TOTAL_CAP) {
      if (kept.length === 0) kept.unshift({ ...message, text: message.text.slice(0, FORK_TOTAL_CAP) });
      break;
    }
    kept.unshift(message);
    total += message.text.length;
  }
  return { round, omitted: kept.length < trimmed.length, messages: kept };
}

/** The `[前情 · …]` user-message chain written into a branch Session before the first model call. */
function forkInjectionMessages(fork: ForkRecord): Message[] {
  const header = `[前情 · 来自任务 ${fork.parentId} 第 ${fork.round} 轮]${fork.omitted ? '（更早上下文已省略）' : ''}`;
  return [
    { role: 'user', content: header },
    ...fork.messages.map((message): Message => ({
      role: 'user',
      content: `[前情 · ${message.role === 'user' ? '用户' : '助手'}]\n${message.text}`,
    })),
  ];
}

/** First whitespace-delimited token of a check command, honoring a quoted program path. */
function firstCommandToken(command: string): string {
  const text = command.trim();
  const quoted = /^(["'])([^"']+)\1/u.exec(text);
  if (quoted) return quoted[2];
  return text.split(/\s+/u)[0] ?? '';
}

/** Resolve a program token against cwd (path-like) or PATH (bare name, PATHEXT on Windows). */
function resolveExecutable(token: string, cwd: string): boolean {
  if (!token) return false;
  if (token.includes('/') || token.includes('\\')) {
    return existsSync(isAbsolute(token) ? token : resolve(cwd, token));
  }
  // The harness's own runtime interpreter is always available to check commands.
  if (token.toLowerCase() === basename(process.execPath).replace(/\.exe$/iu, '').toLowerCase()) return existsSync(process.execPath);
  const extensions = new Set(process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').flatMap((ext) => [ext, ext.toLowerCase()])]
    : ['']);
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of extensions) if (existsSync(join(dir, token + ext))) return true;
  }
  return false;
}

/** A surface host, not an agent loop: every run delegates to runGoal/runAgent. */
export class GuiSessionHost {
  private readonly tasks = new Map<string, LiveTask>();
  private readonly listeners = new Set<(id: string) => void>();
  private initialized?: Promise<void>;
  private launching = false;
  private provider?: ModelProvider;
  private modelName = '';
  /** Captured before scrubProviderKeyFromEnv so per-task providers can be cloned at start. */
  private doubaoConfig?: DoubaoConfig;
  private builderPrompt = BUILDER_PROMPT;
  private readonly launchHooksPath = process.env.JARVIS_HOOKS;
  private policy?: Awaited<ReturnType<typeof loadCliConfig>>;
  private workspaces?: GuiWorkspaceInfo[];
  private defaultCwd = '';
  readonly task?: GuiTaskDefinition;

  constructor(private readonly options: GuiSessionHostOptions) {
    this.task = options.task ? validateGuiTask(options.task) : undefined;
  }

  subscribe(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async overview(): Promise<GuiLiveOverview> {
    await this.initialize();
    await this.ensureWorkspaces();
    const fallback = this.defaultWorkspace().id;
    const sessions = [...this.tasks.values()].map((task) => this.overviewItem(task, fallback));
    sessions.sort((a, b) =>
      Number(a.archived) - Number(b.archived)
      || Number(b.pinned) - Number(a.pinned)
      || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return {
      cwd: this.task?.cwd ?? this.options.cwd, enabled: this.task !== undefined,
      task: this.task ? { objective: this.task.objective, requirements: this.task.requirements } : null,
      sessions,
      activeId: [...this.tasks.values()].find((task) => task.run)?.snapshot.id
        ?? sessions.find((session) => !session.archived)?.id ?? sessions[0]?.id ?? null,
      workspaces: structuredClone(this.workspaces ?? []),
    };
  }

  async snapshot(id: string): Promise<GuiLiveSnapshot> {
    await this.initialize();
    const task = this.requireTask(id);
    await task.queue;
    if (task.journalError) throw new GuiLiveError(503, '事件持久化失败；执行已停止，等待检查保留的 Session');
    await this.refreshAuthority(task);
    updateGuiCapabilities(task.snapshot, task.run !== undefined);
    const snapshot = structuredClone(task.snapshot);
    const price = task.created.task.pricing;
    if (price) snapshot.usage.costCny = (snapshot.usage.inputTokens * price.inputCnyPerMillion + snapshot.usage.outputTokens * price.outputCnyPerMillion) / 1_000_000;
    snapshot.elapsedMs = task.run ? Date.now() - Date.parse(snapshot.startedAt) : snapshot.elapsedMs;
    return snapshot;
  }

  /** Dry-run a task contract: per-field errors plus workspace/git, writePaths and check-command probes.
   *  Never persists anything, never touches the model. */
  async validateTask(value: unknown): Promise<GuiTaskValidateResponse> {
    await this.initialize();
    await this.ensureWorkspaces();
    const built = await this.buildContract(value);
    if (built.errors.length || !built.contract) return { ok: false, errors: built.errors };
    const contract = built.contract;
    const errors: GuiTaskFieldError[] = [];
    const workspace = await this.resolveWorkspace(contract, errors);
    if (workspace) {
      const git = await runCommand(defaultShellPath(), 'git -c core.fsmonitor=false rev-parse --is-inside-work-tree',
        workspace.cwd, 15_000, 4_000, undefined, { scrubGitEnv: true });
      if (git.code !== 0 || !git.output.includes('true')) {
        errors.push({ field: 'workspaceId', message: `工作区不可运行 git rev-parse（真实任务需要基线）：${redactSecrets(git.output.slice(0, 200)) || '非 Git 仓库'}` });
      }
    }
    contract.checkCommands.forEach((command, index) => {
      const token = firstCommandToken(command);
      if (!resolveExecutable(token, workspace?.cwd ?? contract.cwd)) {
        errors.push({ field: 'checkCommands', message: `第 ${index + 1} 条命令的首个 token 不是可执行程序：${token || '(空)'}` });
      }
    });
    if (!(await this.availableThinkingLevels()).includes(contract.thinking ?? 'off')) {
      errors.push({ field: 'thinking', message: '当前模型不支持该思考档位' });
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, errors: [], task: { ...contract, workspaceId: workspace?.id } };
  }

  /** Register a free task or discussion branch as 待启动: journal the created record, consume no model. */
  async createTask(value: unknown): Promise<GuiLiveSnapshot> {
    await this.initialize();
    await this.ensureWorkspaces();
    const built = await this.buildContract(value);
    if (built.errors.length || !built.contract) {
      throw new GuiLiveError(400, `任务合同无效：${built.errors.map((error) => `${error.field}: ${error.message}`).join('；')}`);
    }
    const contract = built.contract;
    const errors: GuiTaskFieldError[] = [];
    const workspace = await this.resolveWorkspace(contract, errors);
    if (!workspace) {
      throw new GuiLiveError(409, `工作区无效：${errors.map((error) => `${error.field}: ${error.message}`).join('；')}`);
    }
    contract.workspaceId = workspace.id;
    if (!(await this.availableThinkingLevels()).includes(contract.thinking ?? 'off')) {
      throw new GuiLiveError(400, 'thinking: 当前模型不支持该思考档位');
    }
    const task = await this.registerTask(contract, { fork: built.fork });
    return this.snapshot(task.created.id);
  }

  /** Start a registered 待启动 task: capture baseline, freeze composition, then runGoal. */
  async startTask(id: string): Promise<GuiLiveSnapshot> {
    await this.initialize();
    const task = this.requireTask(id);
    await task.queue;
    if (task.journalError) throw new GuiLiveError(503, '事件持久化失败；执行已停止，等待检查保留的 Session');
    if (task.run || task.started) throw new GuiLiveError(409, '任务已有运行记录；请恢复或审阅该记录，不自动重复消耗');
    if (this.launching || [...this.tasks.values()].some((item) => item.run)) throw new GuiLiveError(409, '已有运行中的任务');
    this.launching = true;
    try {
      const identity = await this.resolveIdentity(task.created.task);
      if (identity.modelName !== task.created.model) throw new GuiLiveError(409, '任务或模型配置已变化，拒绝启动');
      task.identity = identity;
      const baseline = await this.captureBaseline(id, task.created.task);
      const composition = this.compositionFor(task.created.task);
      const started: TaskStarted = { baseline, composition, model: identity.modelName, at: new Date().toISOString() };
      // journaled verbatim (see record()): replay and resume both fold this exact payload.
      await this.record(task, { type: 'gui_task_started', baseline, composition, model: started.model });
      await this.record(task, { type: 'gui_status', status: 'starting', phase: '准备 Session 与运行合同' });
      this.launch(task);
      return this.snapshot(id);
    } finally { this.launching = false; }
  }

  /** Rename/pin/archive: append a gui_meta event into the task's own journal and fold it. */
  async setMeta(id: string, patch: Record<string, unknown>): Promise<GuiLiveSnapshot> {
    await this.initialize();
    const task = this.requireTask(id);
    const event: GuiObservedEvent = { type: 'gui_meta' };
    let fields = 0;
    if ('title' in patch) {
      if (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.trim().length > 120) {
        throw new GuiLiveError(400, 'title 必须是 1–120 字的非空文本');
      }
      event.title = patch.title.trim();
      fields++;
    }
    if ('pinned' in patch) {
      if (typeof patch.pinned !== 'boolean') throw new GuiLiveError(400, 'pinned 必须是布尔值');
      event.pinned = patch.pinned;
      fields++;
    }
    if ('archived' in patch) {
      if (typeof patch.archived !== 'boolean') throw new GuiLiveError(400, 'archived 必须是布尔值');
      event.archived = patch.archived;
      fields++;
    }
    if (fields === 0) throw new GuiLiveError(400, '没有可更新的元数据字段（支持 title/pinned/archived）');
    await this.record(task, event);
    return this.snapshot(id);
  }

  /** Read-only git status with a 5s per-task cache; failures degrade to an honest unavailable. */
  async gitStatus(id: string): Promise<GuiGitStatus> {
    await this.initialize();
    const task = this.requireTask(id);
    const cached = task.gitCache;
    if (cached && Date.now() - cached.at < GIT_CACHE_MS) return cached.payload;
    const payload = await this.queryGitStatus(task.created.task.cwd);
    task.gitCache = { at: Date.now(), payload };
    return payload;
  }

  /** Models honestly derived from the real provider/config: single entry, never fabricated. */
  async listModels(): Promise<GuiModelsResponse> {
    await this.initialize();
    await this.prepareProvider();
    const thinkingLevels = await this.availableThinkingLevels();
    return {
      models: [{ id: this.modelName, label: this.modelName, maxContextTokens: this.provider!.capability.maxContextTokens, thinkingLevels }],
      defaultModel: this.modelName,
    };
  }

  /** Register a new workspace after path/git validation; failures list every field problem. */
  async createWorkspace(value: unknown): Promise<{ workspaces: GuiWorkspaceInfo[] }> {
    await this.initialize();
    await this.ensureWorkspaces();
    const input = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    const errors: string[] = [];
    const cwdRaw = typeof input.cwd === 'string' ? input.cwd.trim() : '';
    const nameRaw = typeof input.name === 'string' ? input.name.trim() : '';
    let cwd = '';
    if (!cwdRaw || !isAbsolute(cwdRaw)) {
      errors.push('cwd: 必须是绝对路径');
    } else {
      let info;
      try { info = await lstat(cwdRaw); } catch { errors.push('cwd: 路径不存在'); }
      if (info) {
        if (info.isSymbolicLink()) errors.push('cwd: 不允许符号链接或 Junction');
        else if (!info.isDirectory()) errors.push('cwd: 不是目录');
        else {
          cwd = await realpath(cwdRaw);
          const git = await runCommand(defaultShellPath(), 'git -c core.fsmonitor=false rev-parse --is-inside-work-tree',
            cwd, 15_000, 4_000, undefined, { scrubGitEnv: true });
          if (git.code !== 0 || !git.output.includes('true')) {
            errors.push(`cwd: 工作区必须可运行 git rev-parse（真实任务需要基线）：${redactSecrets(git.output.slice(0, 200)) || '非 Git 仓库'}`);
          }
        }
      }
    }
    if (input.name !== undefined && (!nameRaw || nameRaw.length > 80)) errors.push('name: 必须是 1–80 字的文本');
    if (cwd && this.workspaces!.some((workspace) => workspace.cwd === cwd)) errors.push('cwd: 该工作区已注册');
    if (errors.length) throw new GuiLiveError(409, `无法创建工作区：${errors.join('；')}`);
    const workspace: GuiWorkspaceInfo = {
      id: `ws-${randomUUID()}`, name: nameRaw || basename(cwd) || 'workspace', cwd,
      createdAt: new Date().toISOString(), archived: false,
      sort: Math.max(-1, ...this.workspaces!.map((item) => item.sort)) + 1,
    };
    this.workspaces!.push(workspace);
    await this.persistWorkspaces();
    return { workspaces: structuredClone(this.workspaces!) };
  }

  async input(id: string, text: string): Promise<GuiLiveSnapshot> {
    await this.initialize();
    const task = this.requireTask(id);
    updateGuiCapabilities(task.snapshot, Boolean(task.run));
    if (!task.snapshot.capabilities.submit || !text.trim() || text.length > 3000) throw new GuiLiveError(409, '当前状态不能接收该补充指令');
    await this.record(task, { type: 'gui_input_queued', text: redactSecrets(text.trim()) });
    return this.snapshot(id);
  }

  async decision(id: string, requestId: string, decision: string, reason?: string): Promise<GuiLiveSnapshot> {
    await this.initialize();
    const task = this.requireTask(id);
    if (!task.run || task.abort.signal.aborted || task.approval?.requestId !== requestId) throw new GuiLiveError(409, '审批请求已失效或已处理');
    if (decision !== 'allow-once' && decision !== 'deny') throw new GuiLiveError(400, 'decision must be allow-once or deny');
    if (decision === 'deny' && (!reason?.trim() || reason.length > 1000)) throw new GuiLiveError(400, '拒绝或调整需要 1–1000 字的理由');
    const pending = task.approval;
    task.approval = undefined; // consume exactly once before any await
    pending.resolve(decision === 'deny' ? { decision: 'deny', reason: redactSecrets(reason!.trim()) } : 'allow-once');
    return this.snapshot(id);
  }

  async control(id: string, action: 'pause' | 'continue' | 'stop' | 'resume', reason?: string): Promise<GuiLiveSnapshot> {
    await this.initialize();
    const task = this.requireTask(id);
    updateGuiCapabilities(task.snapshot, Boolean(task.run));
    if (action === 'resume') return this.resume(task);
    if (!task.snapshot.capabilities[action]) throw new GuiLiveError(409, '当前 Runtime 状态不支持此操作');
    if (action === 'pause') {
      task.pauseRequested = true;
      await this.record(task, { type: 'gui_status', status: 'pausing', phase: '等待下一模型调用边界暂停' });
    } else if (action === 'continue') {
      task.pauseRequested = false;
      task.wake?.();
      task.wake = undefined;
      await this.record(task, { type: 'gui_status', status: 'running', phase: '继续现有执行；保留原预算' });
    } else {
      // Abort immediately, even when recording the public emergency-stop audit fails.
      task.abort.abort(new Error('GUI emergency stop'));
      task.wake?.();
      await this.record(task, { type: 'gui_status', status: 'stopping', phase: '正在中断在途执行' });
      await requestEmergencyStop({ cwd: task.created.task.cwd, source: 'gui-p3', reason: reason?.trim() || '用户在 GUI 终止任务' });
    }
    return this.snapshot(id);
  }

  async review(id: string, decisions: HumanReviewDecisionInput[], viewed: { sequence: number; evidenceToken: string }): Promise<GuiLiveSnapshot> {
    await this.initialize();
    const task = this.requireTask(id);
    if (task.run || task.reviewing) throw new GuiLiveError(409, '运行结束后才能做完成验收，且一次只能提交一项验收请求');
    task.reviewing = true;
    try {
    await task.queue;
    await this.refreshAuthority(task);
    if (viewed.sequence !== task.snapshot.sequence || !viewed.evidenceToken || viewed.evidenceToken !== task.snapshot.evidenceToken) {
      throw new GuiLiveError(409, '验收页面已过期，请刷新当前证据后重新检查');
    }
    if (!task.checkedEvidence || await this.evidenceFingerprint(task) !== task.checkedEvidence) {
      await this.record(task, { type: 'gui_warning', message: '产物或检查输入在验证后已改变，旧验证不能授权当前交付；需要重新验证' });
      await this.refreshDiff(task);
      throw new GuiLiveError(409, '证据已变化，已拒绝复用旧检查和验收决定');
    }
    await applyHumanReviewDecision({ dataDir: this.options.dataDir, goalId: id, reviewer: 'Ludi / GUI', decisions });
    await this.record(task, { type: 'gui_review_recorded' });
    await this.refreshAuthority(task);
    return this.snapshot(id);
    } finally { task.reviewing = false; }
  }

  async dispose(): Promise<void> {
    for (const task of this.tasks.values()) { task.abort.abort(new Error('GUI server closing')); task.wake?.(); }
    await Promise.all([...this.tasks.values()].map((task) => task.run));
  }

  /** Normalize a free/branch request body into a contract: forkFrom clones the parent contract
   *  (writePaths/checkCommands/budgets), derives objective/requirements per contract §D10/§E13. */
  private async buildContract(value: unknown): Promise<{ contract?: GuiTaskDefinition; fork?: ForkRecord; errors: GuiTaskFieldError[] }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { errors: [{ field: 'contract', message: '请求必须是一个对象' }] };
    }
    const input = value as Record<string, unknown>;
    let base: Partial<GuiTaskDefinition> = {};
    let fork: ForkRecord | undefined;
    if (input.forkFrom !== undefined) {
      const forkFrom = input.forkFrom as Record<string, unknown>;
      if (!forkFrom || typeof forkFrom !== 'object' || typeof forkFrom.parentId !== 'string' || typeof forkFrom.turnId !== 'string') {
        return { errors: [{ field: 'forkFrom', message: 'forkFrom 必须是 {parentId, turnId}' }] };
      }
      const parent = this.tasks.get(forkFrom.parentId);
      if (!parent) return { errors: [{ field: 'forkFrom.parentId', message: '父任务不存在' }] };
      await parent.queue;
      const excerpt = buildForkExcerpt(parent.snapshot.messages, forkFrom.turnId);
      if (!excerpt) return { errors: [{ field: 'forkFrom.turnId', message: 'turnId 不在父任务消息中' }] };
      const parentTask = parent.created.task;
      const summary = `承接「${redactSecrets(parentTask.objective).slice(0, 80)}」第 ${excerpt.round} 轮的讨论分支`;
      fork = { parentId: forkFrom.parentId, turnId: forkFrom.turnId, round: excerpt.round, omitted: excerpt.omitted, messages: excerpt.messages };
      base = {
        cwd: parentTask.cwd, writePaths: parentTask.writePaths, checkCommands: parentTask.checkCommands,
        maxRounds: parentTask.maxRounds, maxTurns: parentTask.maxTurns, wallClockMs: parentTask.wallClockMs,
        ...(parentTask.shellCommands ? { shellCommands: parentTask.shellCommands } : {}),
        ...(parentTask.pricing ? { pricing: parentTask.pricing } : {}),
        ...(parentTask.model ? { model: parentTask.model } : {}),
        ...(parentTask.thinking ? { thinking: parentTask.thinking } : {}),
        ...(parentTask.workspaceId ? { workspaceId: parentTask.workspaceId } : {}),
      };
      input.objective ??= summary;
      input.sourceRef = { parentId: fork.parentId, turnId: fork.turnId, summary };
    } else {
      delete input.sourceRef; // sourceRef is server-assigned at fork creation only
    }
    const merged: Record<string, unknown> = { ...base };
    for (const key of ['objective', 'cwd', 'requirements', 'writePaths', 'checkCommands', 'shellCommands',
      'maxRounds', 'maxTurns', 'wallClockMs', 'pricing', 'model', 'thinking', 'workspaceId', 'sourceRef'] as const) {
      if (input[key] !== undefined) merged[key] = input[key];
    }
    if (typeof merged.objective === 'string' && merged.objective.trim() && merged.requirements === undefined) {
      merged.requirements = [GUI_DERIVED_REQUIREMENT];
    }
    const inspected = inspectGuiTask(merged);
    return { contract: inspected.task, fork, errors: inspected.errors };
  }

  /** Bind the contract to a registered workspace; task↔workspace binding is fixed at creation. */
  private async resolveWorkspace(contract: GuiTaskDefinition, errors: GuiTaskFieldError[]): Promise<GuiWorkspaceInfo | undefined> {
    const cwd = await realpath(contract.cwd).catch(() => resolve(contract.cwd));
    if (contract.workspaceId !== undefined) {
      const workspace = this.workspaces!.find((item) => item.id === contract.workspaceId);
      if (!workspace) { errors.push({ field: 'workspaceId', message: '工作区未注册' }); return undefined; }
      if (workspace.archived) { errors.push({ field: 'workspaceId', message: '工作区已归档' }); return undefined; }
      if (workspace.cwd !== cwd) { errors.push({ field: 'cwd', message: 'cwd 与指定工作区不一致' }); return undefined; }
      return workspace;
    }
    const matched = this.workspaces!.find((item) => item.cwd === cwd);
    if (matched) return matched;
    const fallback = this.defaultWorkspace();
    if (fallback.cwd === cwd) return fallback;
    errors.push({ field: 'cwd', message: 'cwd 未注册为工作区，请先创建工作区' });
    return undefined;
  }

  private defaultWorkspace(): GuiWorkspaceInfo {
    const matched = this.workspaces!.find((workspace) => workspace.cwd === this.defaultCwd);
    return matched ?? [...this.workspaces!].sort((a, b) => a.sort - b.sort)[0];
  }

  private overviewItem(task: LiveTask, defaultWorkspaceId: string): GuiLiveOverviewSession {
    const snapshot = task.snapshot;
    const last = [...snapshot.messages].reverse().find((message) => message.text.trim());
    return {
      id: snapshot.id,
      title: snapshot.title ?? snapshot.objective.slice(0, 80),
      objective: snapshot.objective,
      status: snapshot.status,
      workspaceId: task.created.task.workspaceId ?? defaultWorkspaceId,
      pinned: snapshot.pinned ?? false,
      archived: snapshot.archived ?? false,
      updatedAt: task.lastEventAt,
      lastMessage: last ? last.text.slice(0, 120) : '',
      ...(snapshot.sourceRef ? { sourceRef: snapshot.sourceRef } : {}),
    };
  }

  private async availableThinkingLevels(): Promise<string[]> {
    await this.prepareProvider();
    return this.provider!.capability.thinking ? [...ALL_THINKING_LEVELS] : ['off'];
  }

  private async resolveModelName(contract: GuiTaskDefinition): Promise<string> {
    await this.prepareProvider();
    return contract.model ?? this.modelName;
  }

  /** Per-task provider identity at start/resume: contract.model ?? policy.model, contract.thinking ?? 'off'. */
  private async resolveIdentity(contract: GuiTaskDefinition): Promise<{ provider: ModelProvider; modelName: string }> {
    const thinking = (contract.thinking ?? 'off') as ThinkingEffort;
    await this.prepareProvider();
    if (this.options.provider) {
      return { provider: this.options.provider.withThinking(thinking), modelName: contract.model ?? this.modelName };
    }
    const config: DoubaoConfig = { ...this.doubaoConfig!, model: contract.model ?? this.doubaoConfig!.model };
    return { provider: createProvider(config).withThinking(thinking), modelName: config.model };
  }

  private async registerTask(contract: GuiTaskDefinition, opts: { fork?: ForkRecord; pinned?: boolean } = {}): Promise<LiveTask> {
    const id = `gui-${randomUUID()}`;
    const created: CreatedRecord = {
      type: 'gui_created', sequence: 0, id, task: contract, model: await this.resolveModelName(contract),
      at: new Date().toISOString(), ...(opts.fork ? { fork: opts.fork } : {}),
    };
    const task = this.makeTask(created);
    task.pinned = opts.pinned === true;
    await this.safeJournalPath(id, true);
    await writeFile(task.snapshot.sources.events, `${JSON.stringify(created)}\n`, { encoding: 'utf8', flag: 'wx' });
    this.tasks.set(id, task);
    this.notify(id);
    return task;
  }

  private async ensureWorkspaces(): Promise<void> {
    if (this.workspaces) return;
    this.defaultCwd = await realpath(this.options.cwd).catch(() => resolve(this.options.cwd));
    const loaded = await this.loadWorkspaces();
    if (loaded.length > 0) {
      this.workspaces = loaded;
      return;
    }
    // The host cwd is the implicit default workspace, registered on first access (contract §C8).
    this.workspaces = [{
      id: `ws-${randomUUID()}`, name: basename(this.defaultCwd) || 'workspace', cwd: this.defaultCwd,
      createdAt: new Date().toISOString(), archived: false, sort: 0,
    }];
    await this.persistWorkspaces();
  }

  private async loadWorkspaces(): Promise<GuiWorkspaceInfo[]> {
    const path = await this.safeWorkspacesPath();
    let raw: string;
    try { raw = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const parsed = JSON.parse(raw) as { version?: unknown; workspaces?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)
      || !parsed.workspaces.every((item) => item && typeof item === 'object'
        && typeof (item as GuiWorkspaceInfo).id === 'string' && (item as GuiWorkspaceInfo).id
        && typeof (item as GuiWorkspaceInfo).name === 'string'
        && typeof (item as GuiWorkspaceInfo).cwd === 'string' && isAbsolute((item as GuiWorkspaceInfo).cwd)
        && typeof (item as GuiWorkspaceInfo).createdAt === 'string'
        && typeof (item as GuiWorkspaceInfo).archived === 'boolean'
        && Number.isInteger((item as GuiWorkspaceInfo).sort))) {
      throw new GuiLiveError(409, 'workspaces.json 格式无效');
    }
    return structuredClone(parsed.workspaces) as GuiWorkspaceInfo[];
  }

  private async persistWorkspaces(): Promise<void> {
    const path = await this.safeWorkspacesPath();
    const tmp = join(dirname(path), `workspaces.json.tmp-${process.pid}-${randomUUID()}`);
    await writeFile(tmp, `${JSON.stringify({ version: 1, workspaces: this.workspaces }, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  }

  /** Same symlink/escape posture as safeJournalPath, applied to dataDir/gui/workspaces.json (§C7). */
  private async safeWorkspacesPath(): Promise<string> {
    const root = resolve(this.options.dataDir);
    const dir = join(root, 'gui');
    await mkdir(dir, { recursive: true });
    for (const path of [root, dir, join(dir, 'workspaces.json')]) {
      let info;
      try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (info.isSymbolicLink() || (path.endsWith('.json') ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) {
        throw new GuiLiveError(409, 'unsafe GUI workspaces path');
      }
      const local = relative(await realpath(root), await realpath(path));
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new GuiLiveError(409, 'GUI workspaces file escapes data directory');
    }
    return join(dir, 'workspaces.json');
  }

  private async queryGitStatus(cwd: string): Promise<GuiGitStatus> {
    const at = new Date().toISOString();
    const result = await runCommand(defaultShellPath(), 'git -c core.fsmonitor=false status --porcelain=v2 --branch',
      cwd, 15_000, 200_000, undefined, { scrubGitEnv: true });
    if (result.code !== 0) {
      const detail = redactSecrets((result.spawnError ?? result.output).slice(0, 300));
      return { at, unavailable: detail || (result.timedOut ? 'git status 超时' : 'git 不可用或当前目录不是仓库') };
    }
    let branch = '';
    let ahead = 0;
    let behind = 0;
    let uncommitted = 0;
    for (const line of result.output.split(/\r?\n/u)) {
      if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
      else if (line.startsWith('# branch.ab ')) {
        const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(line);
        if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
      } else if (/^[12u?] /u.test(line)) uncommitted++;
    }
    return { at, branch: branch || '(unknown)', ahead, behind, uncommitted, worktree: uncommitted > 0 ? 'dirty' : 'clean' };
  }

  private async prepareProvider(): Promise<void> {
    if (this.provider) return;
    if (this.options.provider) {
      this.provider = this.options.provider;
      this.modelName = this.options.modelName ?? 'deterministic-test';
      return;
    }
    // Same runtime-only key loading as the CLI; never return the env/config object to the GUI.
    const envPath = join(this.options.cwd, '.env');
    if (existsSync(envPath)) process.loadEnvFile(envPath);
    this.policy = await loadCliConfig({ cwd: this.task?.cwd ?? this.options.cwd, options: { strict: false, ignoreUser: false } });
    this.doubaoConfig = loadDoubaoConfig(process.env, { model: this.policy.model, baseURL: this.policy.baseURL });
    this.provider = createProvider(this.doubaoConfig).withThinking('off');
    this.modelName = this.doubaoConfig.model;
    scrubProviderKeyFromEnv();
    this.builderPrompt = appendConfigPermissionBoundary(BUILDER_PROMPT, this.policy);
  }

  private toolsFor(contract: GuiTaskDefinition) {
    const tools = buildDefaultRegistry();
    if (contract.shellCommands?.length) tools.register(createBashTool());
    return tools;
  }

  private compositionFor(contract: GuiTaskDefinition): SessionComposition {
    return createSessionComposition({ root: 'goal', runtimeVersion: JARVIS_VERSION, permissionMode: 'interactive',
      toolSchemas: [...this.toolsFor(contract).schemasForModel(), updateGoalToolSchema()], systemPrompt: this.builderPrompt, dynamicAddendum: NO_DYNAMIC_ADDENDUM });
  }

  private async execute(task: LiveTask, resume?: GoalResumeState): Promise<void> {
    const { created } = task;
    const contract = created.task;
    const snapshot = task.snapshot;
    const provider = task.identity?.provider;
    if (!provider || !task.started) throw new Error('任务缺少启动身份（provider/baseline/composition）');
    const emergency = createEmergencyStopSignal({ cwd: contract.cwd });
    const deadline = new AbortController();
    const remainingMs = Math.max(0, Date.parse(created.at) + contract.wallClockMs - Date.now());
    const deadlineTimer = setTimeout(() => deadline.abort(new Error('任务总时限已到，恢复不会重置时限')), remainingMs);
    if (remainingMs === 0) deadline.abort(new Error('任务总时限已到，恢复不会重置时限'));
    const signal = AbortSignal.any([task.abort.signal, emergency.signal, deadline.signal]);
    const bus = new InMemoryEventBus((error) => { task.abort.abort(error); });
    const goalStore = new FileGoalStore(snapshot.sources.goal);
    let hooks: HookRunner | undefined;
    let rawStore: FileSessionStore;
    let lastMessageSequence = 0;
    const refreshMessages = async (): Promise<void> => {
      const log = await loadSessionLog(snapshot.sources.session, { requireHeader: true, validateIntegrity: true, expectedSessionId: created.id });
      for (const record of log.records) {
        if (record.t !== 'message' || !('seq' in record) || record.seq <= lastMessageSequence) continue;
        lastMessageSequence = record.seq;
        const message = record.message;
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        const projected: GuiMessage = { id: message.role === 'assistant' && message.requestId ? message.requestId : `message-${record.seq}`,
          role: message.role, text: redactSecrets(message.content ?? ''), at: record.at, status: 'complete',
          toolIds: message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : [] };
        await this.record(task, { type: 'gui_message', message: projected });
      }
    };
    bus.subscribe((event: Event) => { void this.record(task, event as unknown as GuiObservedEvent).catch(() => undefined); });
    try {
      const resolvedHooks = this.options.provider ? {} : await resolveHooks({ hooksPath: this.launchHooksPath, cwd: contract.cwd, shellPath: defaultShellPath(), signal });
      hooks = resolvedHooks.hooks;
      if (resolvedHooks.warning) await this.record(task, { type: 'gui_warning', message: resolvedHooks.warning });
      if (resume) {
        const loaded = await loadSessionLog(snapshot.sources.session, { requireHeader: true, validateIntegrity: true });
        rawStore = new FileSessionStore(snapshot.sources.session, loaded.loaded.messages.length, { format: loaded.loaded.format, initialSequence: loaded.loaded.lastSequence });
        lastMessageSequence = loaded.loaded.lastSequence;
      } else {
        rawStore = new FileSessionStore(snapshot.sources.session);
        await rawStore.writeHeader({ id: created.id, model: created.model, cwd: contract.cwd, startedAt: created.at, composition: task.started.composition });
      }
      const store: SessionStore = {
        receiptFormat: 'v2',
        sync: async (messages) => { await rawStore.sync(messages); await refreshMessages(); },
        checkpoint: async (messages) => { await rawStore.checkpoint(messages); },
        recordRequest: (receipt) => rawStore.recordRequest(receipt),
        recordToolPlanned: (receipt) => rawStore.recordToolPlanned(receipt),
        recordToolCommitted: (receipt) => rawStore.recordToolCommitted(receipt),
        recordToolUnknown: (receipt) => rawStore.recordToolUnknown(receipt),
      };
      let requestedId = '';
      bus.subscribe((event) => { if (event.type === 'approval_request') requestedId = event.requestId; });
      const approver = createApprovalEventApprover({ bus, sessionId: created.id,
        store: new FileApprovalAuditStore(snapshot.sources.approvals),
        approver: async (request) => {
          await task.queue;
          signal.throwIfAborted();
          const requestId = requestedId;
          const promise = new Promise<ApprovalResponse>((resolveApproval, reject) => {
            const onAbort = () => { task.approval = undefined; reject(new Error('审批因执行中断而失效')); };
            signal.addEventListener('abort', onAbort, { once: true });
            task.approval = { requestId, resolve: (answer) => { signal.removeEventListener('abort', onAbort); resolveApproval(answer); } };
          });
          // Install the abort handler before awaiting disk; avoid an unhandled rejection.
          void promise.catch(() => undefined);
          await this.record(task, { type: 'gui_approval', approval: { requestId, toolName: request.toolName,
            capability: request.capability, reason: request.reason, detail: '仅允许本次请求；拒绝理由会传回模型',
            arguments: JSON.stringify(request.args) } });
          return promise;
        },
      });
      const existing = new DefaultPermissionGate({ approver, ...(this.policy ? { policy: buildConfigPermissionPolicy(this.policy) } : {}) });
      const gate: PermissionGate = { check: async (call, capability) => {
        signal.throwIfAborted();
        if (task.journalError) throw task.journalError;
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.arguments || '{}') as Record<string, unknown>; }
        catch { return existing.check(call, capability); }
        if (!args || typeof args !== 'object') return existing.check(call, capability);
        const path = typeof args.path === 'string' ? args.path.replaceAll('\\', '/') : '';
        if (call.name !== 'update_goal' && (/^(?:data|node_modules|\.git)(?:\/|$)/iu.test(path)
          || /(?:v2rayn|sing-box|clash|hysteria|wireguard|proxy|vpn)/iu.test(path))) {
          return { allowed: false, reason: '该路径不在本次源文件任务范围内', source: 'rule' };
        }
        if (capability === 'writes-files' && !contract.writePaths.map((item) => item.replaceAll('\\', '/')).includes(path)) {
          return { allowed: false, reason: '目标不在本次合同允许写入的文件中', source: 'rule' };
        }
        if (capability === 'executes-code' && !contract.shellCommands?.includes(String(args.command))) {
          return { allowed: false, reason: '命令不在本次合同的固定命令中', source: 'rule' };
        }
        return existing.check(call, capability);
      } };
      const pinned = contract.requirements.map((text, index) => ({ id: `R${index + 1}`, text, route: 'human' as const }));
      await hooks?.sessionStart();
      const result = await runGoal({ id: created.id, sessionId: created.id, objective: contract.objective,
        budget: { maxRounds: contract.maxRounds, maxTotalTurns: contract.maxRounds * contract.maxTurns, maxWallClockMs: contract.wallClockMs },
        baseline: task.started.baseline, worktreeBaseline: resume?.goal.worktreeBaseline ?? await snapshotWorktreeStatus(defaultShellPath(), contract.cwd, signal), pinned, resume }, {
        model: provider, tools: this.toolsFor(contract), bus, gate, hooks, store, goalStore, cwd: contract.cwd, shellPath: defaultShellPath(),
        builderSystemPrompt: this.builderPrompt, perRoundMaxTurns: contract.maxTurns,
        context: new DefaultContextManager({ summarizer: provider, maxContextTokens: provider.capability.maxContextTokens, maxOutputTokens: 16_384 }),
        checkCommands: contract.checkCommands, goalSetterRequirementRoutes: new Map(pinned.map((item) => [item.id, 'human' as const])), signal,
        check: async (deps, baseline) => {
          const before = await this.evidenceFingerprint(task, signal);
          const checks = await runDeterministicChecks({ ...deps, baselineIndexFile: join(this.options.dataDir, 'gui-baselines', `${created.id}.index`) }, baseline);
          const after = await this.evidenceFingerprint(task, signal);
          if (before !== after) {
            checks.objectiveChecksPassed = false;
            checks.results.push({ command: 'GUI evidence stability', code: 1, output: '验证期间源文件或交付物已变化，不能证明检查对应当前交付' });
          }
          await this.record(task, { type: 'gui_checked_evidence', fingerprint: before === after ? after : null });
          return checks;
        },
        run: async (ctx) => {
          // Branch tasks prepend the parent's truncated conversation chain ahead of the new
          // objective (contract §E14); a resumed session already carries it in the log.
          if (!resume && task.forkMessages?.length && !task.forkInjected) {
            task.forkInjected = true;
            const at = ctx.messages.findIndex((message) => message.role !== 'system');
            ctx.messages.splice(at < 0 ? ctx.messages.length : at, 0, ...task.forkMessages);
          }
          const outcome = await runAgent({ ...ctx, beforeModelWave: async () => {
          signal.throwIfAborted();
          await task.queue;
          if (task.modelStarts >= contract.maxRounds * contract.maxTurns) throw new Error('本次任务的累计模型调用上限已用尽，不能通过恢复重置');
          if (Date.now() - Date.parse(created.at) >= contract.wallClockMs) throw new Error('本次任务的总时限已用尽，不能通过恢复重置');
          if (task.pauseRequested) {
            await this.record(task, { type: 'gui_status', status: 'paused', phase: '已在模型调用边界暂停；尚未发送下一请求' });
            await new Promise<void>((resolvePause, reject) => {
              const onAbort = () => { task.wake = undefined; reject(new Error('paused run interrupted')); };
              signal.addEventListener('abort', onAbort, { once: true });
              task.wake = () => { signal.removeEventListener('abort', onAbort); resolvePause(); };
              if (signal.aborted) onAbort();
              else if (!task.pauseRequested) task.wake();
            });
          }
          signal.throwIfAborted();
          await task.queue;
          if (task.journalError) throw task.journalError;
          const inputs = snapshot.pendingInputs.slice();
          if (inputs.length) {
            ctx.messages.push(...inputs.map((content): Message => ({ role: 'user', content })));
            await store.sync(ctx.messages);
            await this.record(task, { type: 'gui_inputs_consumed', count: inputs.length });
          }
          } });
          await task.queue;
          if (snapshot.pendingInputs.length || task.pauseRequested) return { halted: 'paused', turns: outcome.turns };
          return outcome;
        },
      });
      await this.record(task, { type: 'gui_status', status: result.state === 'complete' ? 'complete' : 'blocked',
        phase: result.haltReason ? `运行停止：${result.haltReason}` : result.finalVerdict?.rationale ?? '本次执行结束，等待证据审阅' });
    } catch (error) {
      if (existsSync(snapshot.sources.goal)) await goalStore.recordState('blocked', new Date().toISOString());
      await this.record(task, { type: 'gui_status', status: deadline.signal.aborted ? 'blocked' : signal.aborted ? 'interrupted' : 'blocked', phase: deadline.signal.aborted ? '任务总时限已到，已停止执行' : redactSecrets(error instanceof Error ? error.message : String(error)) });
    } finally {
      await hooks?.sessionEnd().catch(() => undefined);
      emergency.dispose();
      clearTimeout(deadlineTimer);
      task.approval = undefined;
      snapshot.approval = null;
      snapshot.elapsedMs = Date.now() - Date.parse(created.at);
      for (const message of snapshot.messages) if (message.status === 'running') message.status = 'incomplete';
      await this.record(task, { type: 'gui_elapsed', elapsedMs: snapshot.elapsedMs });
      await this.refreshDiff(task);
      await this.refreshAuthority(task);
    }
  }

  private async refreshAuthority(task: LiveTask): Promise<void> {
    const snapshot = task.snapshot;
    snapshot.completion = { granted: false, verdict: 'none', rationale: '完成授权未授予' };
    if (!existsSync(snapshot.sources.goal)) return;
    try {
      const loaded = await loadGoal(snapshot.sources.goal);
      if (!loaded.goal || loaded.goal.id !== snapshot.id || loaded.goal.sessionId !== snapshot.sessionId) throw new Error('Goal identity mismatch');
      const last = loaded.rounds.at(-1);
      snapshot.checks = (last?.checks?.results ?? []).map((result) => ({ ...result, output: redactSecrets(result.output) }));
      snapshot.completion = { granted: loaded.goal.state === 'complete' && last?.verdict?.outcome === 'verified',
        verdict: last?.verdict?.outcome ?? 'none', rationale: redactSecrets(last?.verdict?.rationale ?? '尚未产生可信裁决') };
      const pending = (await listPendingHumanReviews(this.options.dataDir)).find((item) => item.goalId === snapshot.id);
      snapshot.review = pending ? { requirements: pending.requirements } : null;
      snapshot.evidenceToken = task.checkedEvidence && last?.checks ? createHash('sha256').update(JSON.stringify({ fingerprint: task.checkedEvidence, round: last.round, checks: last.checks })).digest('hex') : null;
      if (snapshot.completion.granted) { snapshot.status = 'complete'; snapshot.phase = '任务交付与验收已完成'; }
      else if (snapshot.review) { snapshot.phase = '等待你的交付验收'; snapshot.status = 'blocked'; }
      else if (!task.run && snapshot.status !== 'interrupted' && snapshot.status !== 'unavailable') {
        snapshot.status = loaded.goal.state === 'active' ? 'recoverable' : 'blocked';
      }
    } catch (error) {
      snapshot.status = 'unavailable';
      snapshot.completion.granted = false;
      const warning = `持久事实读取失败：${redactSecrets(error instanceof Error ? error.message : String(error))}`;
      if (!snapshot.warnings.includes(warning)) snapshot.warnings.push(warning);
    }
  }

  private async refreshDiff(task: LiveTask): Promise<void> {
    const paths = task.created.task.writePaths.map(shellQuote).join(' ');
    const result = await runCommand(defaultShellPath(), `git -c core.fsmonitor=false diff --no-ext-diff --no-textconv --no-color ${task.started!.baseline.headSha} -- ${paths}`,
      task.created.task.cwd, 15_000, 80_000, undefined, { scrubGitEnv: true, extraEnv: { GIT_INDEX_FILE: join(this.options.dataDir, 'gui-baselines', `${task.created.id}.index`).replaceAll('\\', '/') } });
    await this.record(task, { type: 'gui_diff', diff: result.code === 0 ? result.output : `Diff 读取失败：${result.output}` });
    if (result.truncated) await this.record(task, { type: 'gui_warning', message: 'Diff 预览已截断，请检查工作区原文件' });
  }

  private async resume(task: LiveTask): Promise<GuiLiveSnapshot> {
    if (this.launching || [...this.tasks.values()].some((item) => item.run)) throw new GuiLiveError(409, '已有运行中的任务');
    this.launching = true;
    try {
    await this.refreshAuthority(task);
    if (task.run || task.snapshot.status !== 'recoverable') throw new GuiLiveError(409, '只有原 active 的任务可恢复执行；终态只恢复查看');
    if (task.snapshot.pendingInputs.length) throw new GuiLiveError(409, '崩溃现场含待确认输入；为避免重复执行，须人工核对后另行决定');
    if (!task.started) throw new GuiLiveError(409, '任务尚未启动，无法恢复；请使用启动');
    const identity = await this.resolveIdentity(task.created.task);
    if (task.created.model !== identity.modelName) throw new GuiLiveError(409, '任务或模型配置已变化，拒绝恢复');
    if (task.pinned && this.task && JSON.stringify(task.created.task) !== JSON.stringify(validateGuiTask(this.task))) {
      throw new GuiLiveError(409, '任务或模型配置已变化，拒绝恢复');
    }
    task.identity = identity;
    const loaded = await loadSessionLog(task.snapshot.sources.session, { requireHeader: true, validateIntegrity: true, expectedSessionId: task.created.id,
      resume: { expectedComposition: task.started.composition, resolveDynamicAddendum: resolveNoDynamicAddendum } });
    if (loaded.loaded.pendingTools.length) throw new GuiLiveError(409, '存在未决工具副作用，不能自动恢复');
    if (loaded.loaded.header?.cwd !== task.created.task.cwd || loaded.loaded.header?.model !== identity.modelName) throw new GuiLiveError(409, 'Session cwd/model 不匹配');
    const goal = await loadGoal(task.snapshot.sources.goal);
    if (!goal.goal || goal.goal.state !== 'active') throw new GuiLiveError(409, 'Goal 已不是 active');
    task.abort = new AbortController();
    task.pauseRequested = false;
    this.launch(task, { goal: goal.goal, rounds: goal.rounds, messages: loaded.loaded.messages });
    return this.snapshot(task.created.id);
    } finally { this.launching = false; }
  }

  private async captureBaseline(id: string, task: GuiTaskDefinition): Promise<TestBaseline> {
    // A private Git index captures the current source tree without a commit or touching the user's index.
    const folder = join(this.options.dataDir, 'gui-baselines');
    await mkdir(folder, { recursive: true });
    const indexPath = join(folder, `${id}.index`);
    const opts = { scrubGitEnv: true, extraEnv: { GIT_INDEX_FILE: indexPath.replaceAll('\\', '/') } };
    const run = (command: string) => runCommand(defaultShellPath(), command, task.cwd, 30_000, 300_000, undefined, opts);
    const init = await run('git -c core.fsmonitor=false read-tree HEAD');
    if (init.code !== 0) throw new GuiLiveError(409, '真实任务需要可用的 Git 基线');
    const files = await run('git -c core.fsmonitor=false -c core.quotePath=false ls-files --modified --others --exclude-standard -- src test tests package.json package-lock.json tsconfig.json tsconfig.build.json eslint.config.js');
    if (files.code !== 0 || files.truncated) throw new GuiLiveError(409, '无法完整捕获源文件基线');
    const selected = new Set([...files.output.split(/\r?\n/u).filter((path) => /\.(?:tsx?|jsx?|json|css|html)$/u.test(path)), ...task.writePaths.filter((path) => existsSync(resolve(task.cwd, path)))]);
    // Each path is a literal argument; no shell-derived text can become a command.
    for (const path of selected) {
      const added = await run(`git -c core.fsmonitor=false add -- ${shellQuote(path)}`);
      if (added.code !== 0) throw new GuiLiveError(409, `无法捕获基线文件：${path}`);
    }
    const tree = await run('git -c core.fsmonitor=false write-tree');
    if (tree.code !== 0 || !/^[a-f0-9]{40,64}$/u.test(tree.output.trim())) throw new GuiLiveError(409, '无法固定源文件树');
    return { headSha: tree.output.trim(), testFiles: [] };
  }

  private record(task: LiveTask, event: GuiObservedEvent): Promise<void> {
    // gui_task_started carries the frozen composition (system prompt/schemas); it is journaled
    // verbatim so resume compares the session header against the exact original, not a redacted copy.
    const safe = (event.type === 'gui_task_started' ? { ...event } : redactValue({ ...event })) as GuiObservedEvent;
    safe.at = safe.at ?? new Date().toISOString();
    const pending = task.queue.then(async () => {
      const record: EventRecord = { type: 'gui_event', sequence: task.snapshot.sequence + 1, event: safe, at: new Date().toISOString() };
      await appendFile(task.snapshot.sources.events, `${JSON.stringify(record)}\n`, 'utf8');
      applyGuiEvent(task.snapshot, safe);
      this.foldTaskEvent(task, safe, record.at);
      task.snapshot.sequence = record.sequence;
      const price = task.created.task.pricing;
      if (price) task.snapshot.usage.costCny = (task.snapshot.usage.inputTokens * price.inputCnyPerMillion + task.snapshot.usage.outputTokens * price.outputCnyPerMillion) / 1_000_000;
      this.notify(task.created.id);
    });
    task.queue = pending.catch((error: unknown) => {
      task.journalError = error instanceof Error ? error : new Error(String(error));
      task.abort.abort(task.journalError);
      task.snapshot.status = 'unavailable';
      task.snapshot.completion.granted = false;
      task.snapshot.warnings.push('事件持久化失败，已停止执行；不能据此宣布完成');
    });
    return pending;
  }

  /** Host-side (non-projection) folds for task bookkeeping; replay applies the same folds. */
  private foldTaskEvent(task: LiveTask, event: GuiObservedEvent, recordAt: string): void {
    if (event.type === 'model_started') task.modelStarts++;
    if (event.type === 'gui_checked_evidence') task.checkedEvidence = typeof event.fingerprint === 'string' ? event.fingerprint : undefined;
    if (event.type === 'gui_elapsed') task.snapshot.elapsedMs = Number(event.elapsedMs);
    if (event.type === 'gui_task_started') {
      task.started = { baseline: event.baseline as TestBaseline, composition: event.composition as SessionComposition,
        model: String(event.model), at: String(event.at ?? recordAt) };
    }
    task.lastEventAt = recordAt;
  }

  private makeTask(created: CreatedRecord): LiveTask {
    const root = this.options.dataDir;
    const snapshot: GuiLiveSnapshot = { id: created.id, sequence: 0, objective: created.task.objective, cwd: created.task.cwd, model: created.model,
      thinking: created.task.thinking ?? 'off',
      sessionId: created.id, goalId: created.id, status: 'idle', phase: '任务已创建，待启动', nextAction: '', startedAt: created.at, elapsedMs: 0,
      messages: [], tools: [], approval: null, approvalHistory: [], pendingInputs: [], completion: { granted: false, verdict: 'none', rationale: '完成授权未授予' },
      review: null, evidenceToken: null, checks: [], diff: '', artifacts: [], usage: { inputTokens: 0, outputTokens: 0, costCny: created.task.pricing ? 0 : null,
        costNote: created.task.pricing ? `估算 CNY；${created.task.pricing.source}；不含无法单列的缓存折扣` : '未配置可核实单价；Token 实际记录，费用未知' },
      limits: { maxRounds: created.task.maxRounds, maxTurns: created.task.maxTurns, turnTimeoutMs: 120_000, wallClockMs: created.task.wallClockMs },
      sources: { session: join(root, 'sessions', `${created.id}.jsonl`), goal: join(root, 'goals', `${created.id}.jsonl`), approvals: join(root, 'approvals', `${created.id}.jsonl`), events: join(root, 'gui', `${created.id}.jsonl`) },
      warnings: ['Runtime 尚未提供可显示的实时 Reasoning 摘要；不生成模拟摘要。'], capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
      ...(created.task.sourceRef ? { sourceRef: created.task.sourceRef } : {}) };
    return { created, queue: Promise.resolve(), abort: new AbortController(), pauseRequested: false, modelStarts: 0, snapshot,
      pinned: false, lastEventAt: created.at,
      forkMessages: created.fork ? forkInjectionMessages(created.fork) : undefined,
      started: created.baseline && created.composition
        ? { baseline: created.baseline, composition: created.composition, model: created.model, at: created.at }
        : undefined };
  }

  private launch(task: LiveTask, resume?: GoalResumeState): void {
    task.run = this.execute(task, resume).catch((error: unknown) => {
      task.snapshot.status = 'unavailable';
      task.snapshot.completion.granted = false;
      task.snapshot.warnings.push(redactSecrets(error instanceof Error ? error.message : String(error)));
    }).finally(async () => {
      task.run = undefined;
      if (!task.journalError) await this.record(task, { type: 'gui_settled' }).catch(() => undefined);
      this.notify(task.created.id);
    });
  }

  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const dir = join(this.options.dataDir, 'gui');
      let files: string[] = [];
      try { files = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const file of files.filter((name) => /^gui-[a-f0-9-]+\.jsonl$/u.test(name)).sort()) {
        const id = file.slice(0, -6);
        const path = await this.safeJournalPath(id, false);
        const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
        const created = JSON.parse(lines[0]) as CreatedRecord;
        if (created.type !== 'gui_created' || created.id !== id || created.sequence !== 0) throw new GuiLiveError(409, 'GUI journal identity mismatch');
        validateGuiTask(created.task);
        const task = this.makeTask(created);
        for (const line of lines.slice(1)) {
          const record = JSON.parse(line) as EventRecord;
          if (record.type !== 'gui_event' || record.sequence !== task.snapshot.sequence + 1) throw new GuiLiveError(409, 'GUI journal sequence is invalid');
          applyGuiEvent(task.snapshot, record.event);
          this.foldTaskEvent(task, record.event, record.at);
          task.snapshot.sequence = record.sequence;
        }
        for (const message of task.snapshot.messages) if (message.status === 'running') message.status = 'incomplete';
        task.snapshot.approval = null;
        await this.restoreSessionProjection(task);
        await this.refreshAuthority(task);
        updateGuiCapabilities(task.snapshot, false);
        this.tasks.set(id, task);
      }
      // A CLI-pinned --task-file contract registers as a 待启动 task; an identical already-journaled
      // contract is reused instead of re-registered (pinned-contract dedupe only, free tasks never dedupe).
      if (this.task) {
        const wanted = JSON.stringify(validateGuiTask(this.task));
        const existing = [...this.tasks.values()].find((task) => JSON.stringify(validateGuiTask(task.created.task)) === wanted);
        if (existing) existing.pinned = true;
        else await this.registerTask(validateGuiTask(this.task), { pinned: true });
      }
    })();
    return this.initialized;
  }

  private async safeJournalPath(id: string, create: boolean): Promise<string> {
    if (!validateSessionId(id).ok) throw new GuiLiveError(400, 'invalid session id');
    const root = resolve(this.options.dataDir);
    const dir = join(root, 'gui');
    if (create) await mkdir(dir, { recursive: true });
    for (const path of [root, dir, join(dir, `${id}.jsonl`)]) {
      let info;
      try { info = await lstat(path); } catch (error) { if (create && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (info.isSymbolicLink() || (path.endsWith('.jsonl') ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) throw new GuiLiveError(409, 'unsafe GUI journal path');
      const local = relative(await realpath(root), await realpath(path));
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new GuiLiveError(409, 'GUI journal escapes data directory');
    }
    return join(dir, `${id}.jsonl`);
  }

  private async restoreSessionProjection(task: LiveTask): Promise<void> {
    if (!existsSync(task.snapshot.sources.session)) {
      if (task.started) {
        task.snapshot.status = 'unavailable';
        task.snapshot.warnings.push('Session 初始化未完成，不能恢复执行');
      }
      return;
    }
    try {
      for (const path of [task.snapshot.sources.session, task.snapshot.sources.goal]) {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error('unsafe persistent fact file');
        const local = relative(await realpath(this.options.dataDir), await realpath(path));
        if (local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('persistent fact escapes data root');
      }
      const log = await loadSessionLog(task.snapshot.sources.session, { requireHeader: true, validateIntegrity: true, expectedSessionId: task.created.id });
      task.modelStarts = Math.max(task.modelStarts, log.loaded.requests.length);
      const orderedMessageIds: string[] = [];
      for (const record of log.records) {
        if (record.t !== 'message' || !('seq' in record)) continue;
        const message = record.message;
        if (message.role === 'user' || message.role === 'assistant') {
          orderedMessageIds.push(message.role === 'assistant' && message.requestId ? message.requestId : `message-${record.seq}`);
          applyGuiEvent(task.snapshot, { type: 'gui_message', message: {
            id: message.role === 'assistant' && message.requestId ? message.requestId : `message-${record.seq}`,
            role: message.role, text: redactSecrets(message.content ?? ''), at: record.at, status: 'complete',
            toolIds: message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : [],
          } });
          if (message.role === 'assistant') for (const call of message.toolCalls ?? []) {
            if (!task.snapshot.tools.some((tool) => tool.id === call.id)) applyGuiEvent(task.snapshot, { type: 'tool_call', call: redactValue(call) });
          }
        } else if (message.role === 'tool') {
          const tool = task.snapshot.tools.find((item) => item.id === message.toolCallId);
          if (tool && tool.output === undefined) tool.output = redactSecrets(message.content);
        }
      }
      const byId = new Map(task.snapshot.messages.map((message) => [message.id, message]));
      task.snapshot.messages = [...orderedMessageIds.map((id) => byId.get(id)!), ...task.snapshot.messages.filter((message) => !orderedMessageIds.includes(message.id))];
      for (const receipt of log.loaded.toolReceipts) {
        if (receipt.phase !== 'committed') continue;
        const tool = task.snapshot.tools.find((item) => item.id === receipt.result.callId);
        if (tool && ['proposed', 'running'].includes(tool.status)) tool.status = receipt.result.error ? 'failed' : 'committed';
      }
      if (log.loaded.pendingTools.length) {
        if (task.snapshot.status !== 'interrupted') task.snapshot.status = 'unavailable';
        task.snapshot.warnings.push('存在未决工具副作用，已禁止自动恢复');
      }
      if (task.snapshot.pendingInputs.length) {
        task.snapshot.status = 'unavailable';
        task.snapshot.warnings.push('崩溃现场含待确认输入；为避免重复执行，已禁止自动恢复');
      }
    } catch (error) {
      task.snapshot.status = 'unavailable';
      task.snapshot.warnings.push(`Session 恢复失败：${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
  }

  private async evidenceFingerprint(task: LiveTask, signal?: AbortSignal): Promise<string> {
    const diff = await runCommand(defaultShellPath(), `git -c core.fsmonitor=false diff --no-ext-diff --no-textconv --binary --no-color ${task.started!.baseline.headSha}`,
      task.created.task.cwd, 15_000, 500_000, signal,
      { scrubGitEnv: true, extraEnv: { GIT_INDEX_FILE: join(this.options.dataDir, 'gui-baselines', `${task.created.id}.index`).replaceAll('\\', '/') } });
    if (diff.code !== 0 || diff.truncated) throw new GuiLiveError(409, '无法完整确认验证对应的工作树');
    const hash = createHash('sha256').update(diff.output);
    for (const path of task.created.task.writePaths) {
      const content = await readFile(resolve(task.created.task.cwd, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      hash.update(JSON.stringify({ path, content: content ? createHash('sha256').update(content).digest('hex') : null }));
    }
    return hash.digest('hex');
  }

  private requireTask(id: string): LiveTask {
    if (!validateSessionId(id).ok) throw new GuiLiveError(400, 'invalid session id');
    const task = this.tasks.get(id);
    if (!task) throw new GuiLiveError(404, 'task not found');
    return task;
  }

  private notify(id: string): void { for (const listener of this.listeners) listener(id); }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  return value;
}
