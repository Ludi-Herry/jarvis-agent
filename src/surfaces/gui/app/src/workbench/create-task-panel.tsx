import { useMemo, useState } from 'react';
import type { GuiLiveOverview, GuiLiveSnapshot, GuiModelsResponse } from '../../../live-types.js';
import type { GuiFreeTaskInput } from '../live/api.js';
import type { ControlState } from './controls.js';
import { PinnedTaskCard } from './empty-state.js';

interface FieldErrors {
  readonly [field: string]: string;
}

function lines(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * Free-task creation: the user drafts the objective and confirms the auditable contract
 * (write paths, check commands, budgets, model) before any model token is spent.
 */
export function CreateTaskPanel({ overview, models, canStart, pending, onValidate, onCreate, onCreateAndStart }: {
  readonly overview: GuiLiveOverview | null;
  readonly models: GuiModelsResponse | null;
  readonly canStart: ControlState;
  readonly pending: boolean;
  readonly onValidate: (input: GuiFreeTaskInput) => Promise<{ ok: boolean; errors: Array<{ field: string; message: string }> }>;
  readonly onCreate: (input: GuiFreeTaskInput) => Promise<GuiLiveSnapshot>;
  readonly onCreateAndStart: (input: GuiFreeTaskInput) => Promise<unknown>;
}) {
  const workspaces = overview?.workspaces.filter((item) => !item.archived) ?? [];
  const [objective, setObjective] = useState('');
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [writePaths, setWritePaths] = useState('');
  const [checkCommands, setCheckCommands] = useState('');
  const [maxRounds, setMaxRounds] = useState(2);
  const [maxTurns, setMaxTurns] = useState(6);
  const [minutes, setMinutes] = useState(10);
  const [model, setModel] = useState(models?.defaultModel ?? '');
  const [thinking, setThinking] = useState(models?.models[0]?.thinkingLevels[0] ?? 'off');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  const selectedModel = useMemo(() => models?.models.find((item) => item.id === model) ?? models?.models[0] ?? null, [models, model]);
  const singleModel = (models?.models.length ?? 0) <= 1;
  const thinkingLevels = selectedModel?.thinkingLevels ?? ['off'];

  const draft = (): GuiFreeTaskInput => ({
    objective: objective.trim(),
    cwd: workspaces.find((item) => item.id === (workspaceId || workspaces[0]?.id))?.cwd ?? overview?.cwd ?? '',
    workspaceId: workspaceId || workspaces[0]?.id,
    writePaths: lines(writePaths),
    checkCommands: lines(checkCommands),
    maxRounds,
    maxTurns,
    wallClockMs: Math.min(minutes, 15) * 60_000,
    ...(!singleModel && model !== '' ? { model } : {}),
    ...(thinking !== '' ? { thinking } : {}),
  });

  const validate = async (): Promise<boolean> => {
    setValidating(true);
    setSubmitError(null);
    try {
      const result = await onValidate(draft());
      setErrors(Object.fromEntries(result.errors.map((error) => [error.field, error.message])));
      return result.ok;
    } catch (error) {
      setSubmitError(error instanceof Error && error.message.trim() !== '' ? error.message : '校验未完成，请稍后重试。');
      return false;
    } finally {
      setValidating(false);
    }
  };

  const submit = async (mode: 'create' | 'start') => {
    if (!(await validate())) return;
    setSubmitError(null);
    try {
      if (mode === 'create') await onCreate(draft());
      else await onCreateAndStart(draft());
    } catch (error) {
      setSubmitError(error instanceof Error && error.message.trim() !== '' ? error.message : '任务创建失败。');
    }
  };

  const field = (name: string) => (errors[name] !== undefined ? <p className="wb-field-error" role="alert">{errors[name]}</p> : null);

  return (
    <section className="wb-empty" aria-labelledby="wb-empty-title">
      <header>
        <h2 id="wb-empty-title">新任务，先说清要什么</h2>
        <p>目标、可写范围、检查与预算在这里逐项确认；确认前不消耗任何模型。</p>
      </header>

      <div className="wb-create-form">
        <label className="wb-field">
          <span>任务目标</span>
          <textarea
            value={objective}
            rows={3}
            placeholder="例如：把 fixture 目录的说明文字改成第一次使用也能看懂的版本"
            onChange={(event) => setObjective(event.currentTarget.value)}
          />
          {field('objective')}
        </label>

        <div className="wb-field-row">
          <label className="wb-field">
            <span>工作区</span>
            <select value={workspaceId} onChange={(event) => setWorkspaceId(event.currentTarget.value)}>
              {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="wb-field">
            <span>轮数上限（1–8）</span>
            <input type="number" min={1} max={8} value={maxRounds} onChange={(event) => setMaxRounds(Number(event.currentTarget.value))} />
          </label>
          <label className="wb-field">
            <span>每轮步数（1–16）</span>
            <input type="number" min={1} max={16} value={maxTurns} onChange={(event) => setMaxTurns(Number(event.currentTarget.value))} />
          </label>
          <label className="wb-field">
            <span>总分钟（≤15）</span>
            <input type="number" min={1} max={15} value={minutes} onChange={(event) => setMinutes(Number(event.currentTarget.value))} />
          </label>
        </div>
        {field('workspaceId')}{field('maxRounds')}{field('maxTurns')}{field('wallClockMs')}

        <label className="wb-field">
          <span>允许写入的相对路径（每行一个）</span>
          <textarea
            value={writePaths}
            rows={2}
            placeholder={'fixture/answer.mjs\nsrc/surfaces/gui/app/src/live/first-task-guide.tsx'}
            onChange={(event) => setWritePaths(event.currentTarget.value)}
          />
          {field('writePaths')}
        </label>
        <label className="wb-field">
          <span>检查命令（每行一条，逐条固定执行）</span>
          <textarea
            value={checkCommands}
            rows={2}
            placeholder={'node --check fixture/answer.mjs'}
            onChange={(event) => setCheckCommands(event.currentTarget.value)}
          />
          {field('checkCommands')}
        </label>

        <div className="wb-field-row">
          <label className="wb-field">
            <span>模型</span>
            {singleModel ? (
              <em className="wb-field-static">{selectedModel?.label ?? '由当前配置固定'}</em>
            ) : (
              <select value={model} onChange={(event) => setModel(event.currentTarget.value)}>
                {models?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            )}
          </label>
          <label className="wb-field">
            <span>思考强度</span>
            {thinkingLevels.length <= 1 ? (
              <em className="wb-field-static">{thinkingLevels[0] ?? 'off'}（当前模型固定档）</em>
            ) : (
              <select value={thinking} onChange={(event) => setThinking(event.currentTarget.value)}>
                {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            )}
          </label>
        </div>
        {singleModel ? <p className="wb-field-note">模型由当前配置固定：{selectedModel?.id ?? '…'}；多模型切换需要 provider 配置支持，不会在这里虚构列表。</p> : null}

        {submitError !== null ? <p className="wb-field-error" role="alert">{submitError}</p> : null}
        <div className="wb-create-actions">
          <button type="button" className="wb-ghost" disabled={pending || validating} onClick={() => { void validate(); }}>
            {validating ? '校验中…' : '校验合同'}
          </button>
          <button type="button" className="wb-ghost" disabled={pending || objective.trim() === ''} onClick={() => { void submit('create'); }}>
            创建（稍后启动）
          </button>
          <button type="button" className="wb-commit" disabled={pending || objective.trim() === ''} onClick={() => { void submit('start'); }}>
            创建并启动
          </button>
        </div>
        <p className="wb-field-note">「创建」只在本地落下任务合同；「创建并启动」会捕获当前工作区基线并开始消耗模型。已有运行中任务时启动会如实 409。</p>
      </div>

      <PinnedTaskCard overview={overview} canStart={canStart} />
    </section>
  );
}
