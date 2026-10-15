import { useEffect, useMemo, useRef, useState } from 'react';
import type { GuiLiveOverview, GuiLiveSnapshot, GuiModelsResponse, GuiWorkspacePresets, GuiWorkspaceProbe } from '../../../live-types.js';
import { submitTaskDraft, type GuiFreeTaskInput } from '../live/api.js';
import type { ControlState } from './controls.js';
import { PinnedTaskCard } from './empty-state.js';
import { formatTimestamp } from './format.js';
import { ArrowUpIcon, ChatIcon } from './icons.js';

interface FieldErrors {
  readonly [field: string]: string;
}

const STARTERS = [
  { label: '说明文字', objective: '把项目里的说明文字改得清楚易懂' },
  { label: '修复问题', objective: '定位并修复当前项目里的问题' },
  { label: '整理代码', objective: '整理当前代码，并保持现有行为不变' },
  { label: '检查项目', objective: '检查当前项目，并报告需要处理的问题' },
] as const;

function lines(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * Free-task creation: the user drafts the objective and confirms the auditable contract
 * (write paths, check commands, budgets, model) before any model token is spent.
 */
export function CreateTaskPanel({ overview, models, canStart, pending, onValidate, onCreate, onCreateAndStart, onSavePresets, onProbeCommands }: {
  readonly overview: GuiLiveOverview | null;
  readonly models: GuiModelsResponse | null;
  readonly canStart: ControlState;
  readonly pending: boolean;
  readonly onValidate: (input: GuiFreeTaskInput) => Promise<{ ok: boolean; errors: Array<{ field: string; message: string }> }>;
  readonly onCreate: (input: GuiFreeTaskInput) => Promise<GuiLiveSnapshot>;
  readonly onCreateAndStart: (input: GuiFreeTaskInput) => Promise<unknown>;
  readonly onSavePresets: (wsId: string, input: Omit<GuiWorkspacePresets, 'savedAt'>) => Promise<unknown>;
  readonly onProbeCommands: (wsId: string) => Promise<GuiWorkspaceProbe>;
}) {
  const workspaces = useMemo(
    () => overview?.workspaces.filter((item) => !item.archived) ?? [],
    [overview?.workspaces],
  );
  const [objective, setObjective] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [writePaths, setWritePaths] = useState('');
  const [checkCommands, setCheckCommands] = useState('');
  const [maxRounds, setMaxRounds] = useState(2);
  const [maxTurns, setMaxTurns] = useState(6);
  const [minutes, setMinutes] = useState(10);
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('off');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const [contractOpen, setContractOpen] = useState(false);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  // Batch 5 §启动: preset save feedback + probed candidates; both reset on workspace switch.
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const [probe, setProbe] = useState<GuiWorkspaceProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const lastPresetWsRef = useRef<string | null>(null);

  const selectedModel = useMemo(() => (
    models?.models.find((item) => item.id === model)
    ?? models?.models.find((item) => item.id === models.defaultModel)
    ?? models?.models[0]
    ?? null
  ), [models, model]);
  const singleModel = (models?.models.length ?? 0) <= 1;
  const thinkingLevels = selectedModel?.thinkingLevels ?? [];

  useEffect(() => {
    setWorkspaceId((current) => (
      current !== '' && workspaces.some((item) => item.id === current)
        ? current
        : workspaces[0]?.id ?? ''
    ));
  }, [workspaces]);

  // Batch 5 §启动: when the selected workspace id CHANGES (initial default or user switch),
  // prefill the contract fields from its saved presets. The ref of the last-applied id keeps
  // re-renders and overview refreshes from clobbering in-progress edits.
  useEffect(() => {
    if (workspaceId === '' || lastPresetWsRef.current === workspaceId) return;
    lastPresetWsRef.current = workspaceId;
    setPresetNote(null);
    setProbe(null);
    const presets = workspaces.find((item) => item.id === workspaceId)?.presets;
    if (presets === undefined) return;
    setWritePaths(presets.writePaths.join('\n'));
    setCheckCommands(presets.checkCommands.join('\n'));
    setMaxRounds(presets.maxRounds);
    setMaxTurns(presets.maxTurns);
    setMinutes(presets.minutes);
  }, [workspaceId, workspaces]);

  useEffect(() => {
    if (models === null) return;
    setModel((current) => {
      if (models.models.some((item) => item.id === current)) return current;
      return models.models.find((item) => item.id === models.defaultModel)?.id ?? models.models[0]?.id ?? '';
    });
  }, [models]);

  useEffect(() => {
    if (selectedModel === null) return;
    setThinking((current) => (
      selectedModel.thinkingLevels.includes(current)
        ? current
        : selectedModel.thinkingLevels[0] ?? ''
    ));
  }, [selectedModel]);

  useEffect(() => {
    const textarea = objectiveRef.current;
    if (textarea === null) return;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, 164);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 164 ? 'auto' : 'hidden';
  }, [objective]);

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

  const validate = async (input = draft()): Promise<boolean> => {
    setContractOpen(true);
    setValidating(true);
    setSubmitError(null);
    try {
      const result = await onValidate(input);
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
    if (submitLock.current) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitTaskDraft(submitLock, draft(), validate, mode === 'create' ? onCreate : onCreateAndStart);
    } catch (error) {
      setSubmitError(error instanceof Error && error.message.trim() !== '' ? error.message : '任务创建失败。');
    } finally {
      setSubmitting(false);
    }
  };

  const field = (name: string) => (errors[name] !== undefined ? <p className="wb-field-error" role="alert">{errors[name]}</p> : null);

  // Batch 5 §启动: one-line contract summary mirroring what the form would submit today.
  const activeWorkspaceId = workspaceId || workspaces[0]?.id;
  const preset = workspaces.find((item) => item.id === activeWorkspaceId)?.presets;
  const matchesPreset = preset !== undefined
    && lines(writePaths).join('\n') === preset.writePaths.join('\n')
    && lines(checkCommands).join('\n') === preset.checkCommands.join('\n')
    && maxRounds === preset.maxRounds
    && maxTurns === preset.maxTurns
    && minutes === preset.minutes;
  const presetLabel = preset === undefined
    ? '界面默认值（该工作区尚无预设）'
    : matchesPreset
      ? `预设（保存于 ${formatTimestamp(preset.savedAt)}）`
      : '在预设基础上已修改';

  // Batch 5 §启动: presets persist only on this explicit, validated user click (§M5-1 contract).
  const savePresets = async () => {
    if (!(await validate())) { setPresetNote(null); return; }
    setSubmitError(null);
    try {
      await onSavePresets(activeWorkspaceId ?? '', {
        writePaths: lines(writePaths),
        checkCommands: lines(checkCommands),
        maxRounds,
        maxTurns,
        minutes,
      });
      setPresetNote('预设已保存，下次新建任务时自动带入。');
    } catch (error) {
      setPresetNote(null);
      setSubmitError(error instanceof Error && error.message.trim() !== '' ? error.message : '预设保存失败。');
    }
  };

  const probeCommands = async () => {
    setSubmitError(null);
    setProbing(true);
    try {
      setProbe(await onProbeCommands(activeWorkspaceId ?? ''));
    } catch (error) {
      setProbe(null);
      setSubmitError(error instanceof Error && error.message.trim() !== '' ? error.message : '候选命令读取失败。');
    } finally {
      setProbing(false);
    }
  };

  // Batch 5 §启动: adopting a probe candidate only appends it to the check-commands draft.
  const adoptCommand = (command: string) => {
    const adopted = command.trim();
    if (adopted === '') return;
    setCheckCommands((current) => {
      const existing = lines(current);
      return existing.includes(adopted) ? current : [...existing, adopted].join('\n');
    });
  };

  return (
    <section className="wb-empty wb-new-task" aria-labelledby="wb-empty-title">
      <header className="wb-new-task-heading">
        <ChatIcon className="wb-new-task-icon" size={29} />
        <h2 id="wb-empty-title">我们应该创造什么？</h2>
      </header>

      <label className="wb-new-workspace">
        <span>工作区</span>
        <select value={workspaceId} onChange={(event) => setWorkspaceId(event.currentTarget.value)}>
          {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {field('workspaceId')}

      <div className="wb-new-composer" onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea, label') === null) objectiveRef.current?.focus();
      }}>
        <label htmlFor="wb-new-task-objective">任务目标</label>
        <div>
          <textarea
            id="wb-new-task-objective"
            ref={objectiveRef}
            value={objective}
            rows={3}
            style={{ maxHeight: 164 }}
            placeholder="描述你想做的事…"
            onChange={(event) => setObjective(event.currentTarget.value)}
          />
          {field('objective')}
        </div>

        <div className="wb-new-tools">
          <button
            type="button"
            className="wb-ghost"
            aria-expanded={contractOpen}
            aria-controls="wb-create-contract"
            onClick={() => setContractOpen((open) => !open)}
          >
            确认任务范围
          </button>

          <label className="wb-new-model">
            <span>模型</span>
            {singleModel ? (
              <em className="wb-field-static">{selectedModel?.label ?? '模型加载中'}</em>
            ) : (
              <select value={model} onChange={(event) => setModel(event.currentTarget.value)}>
                {models?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            )}
          </label>
          <label className="wb-new-model">
            <span>思考</span>
            {thinkingLevels.length <= 1 ? (
              <em className="wb-field-static">{thinkingLevels[0] ?? 'off'}</em>
            ) : (
              <select value={thinking} onChange={(event) => setThinking(event.currentTarget.value)}>
                {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            )}
          </label>

          <button
            type="button"
            className="wb-send-icon"
            aria-label="校验合同并展开范围与检查"
            title="校验合同并展开范围与检查"
            aria-expanded={contractOpen}
            aria-controls="wb-create-contract"
            onClick={() => { void validate(); }}
          >
            <ArrowUpIcon />
          </button>
        </div>

        {!contractOpen ? (
          <button
            type="button"
            className="wb-contract-summary"
            onClick={() => setContractOpen(true)}
            aria-expanded={contractOpen}
            aria-controls="wb-create-contract"
          >
            {`范围 ${lines(writePaths).length} 条 · 检查 ${lines(checkCommands).length} 条 · 预算 ${maxRounds}轮×${maxTurns}步 ≤${minutes}分 · ${presetLabel}`}
            <span className="wb-contract-summary-edit">修改</span>
          </button>
        ) : null}
      </div>

      <div className="wb-starters" aria-label="任务建议">
        <span className="wb-starters-caption">从这些方向开始</span>
        {STARTERS.map((starter) => (
          <button key={starter.label} type="button" className="wb-starter" onClick={() => setObjective(starter.objective)}>
            <span>{starter.label}</span>
            <small>{starter.objective}</small>
          </button>
        ))}
      </div>

      <section id="wb-create-contract" className="wb-create-contract" hidden={!contractOpen} aria-label="任务合同">
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

        <div className="wb-field-row" data-layout="budget">
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
        {field('maxRounds')}{field('maxTurns')}{field('wallClockMs')}
        {singleModel ? <p className="wb-field-note">模型由当前配置固定：{selectedModel?.id ?? '…'}；多模型切换需要 provider 配置支持，不会在这里虚构列表。</p> : null}

        {submitError !== null ? <p className="wb-field-error" role="alert">{submitError}</p> : null}

        <div className="wb-field-row" data-layout="preset">
          <button
            type="button"
            className="wb-ghost"
            disabled={pending || validating || submitting || activeWorkspaceId === undefined}
            onClick={() => { void savePresets(); }}
          >
            保存为该工作区预设
          </button>
          <button
            type="button"
            className="wb-ghost"
            disabled={pending || validating || submitting || probing || activeWorkspaceId === undefined}
            onClick={() => { void probeCommands(); }}
          >
            {probing ? '读取中…' : '从项目读取候选命令'}
          </button>
        </div>
        {presetNote !== null ? <p className="wb-field-note">{presetNote}</p> : null}
        {probe !== null ? (
          <div className="wb-probe-result">
            <p className="wb-field-note">{probe.note}</p>
            {probe.candidates.length > 0 ? (
              <ul className="wb-probe-list">
                {probe.candidates.map((candidate) => (
                  <li key={candidate.command}>
                    <button type="button" onClick={() => adoptCommand(candidate.command)}>采用</button>
                    <code>{candidate.command}</code>
                    <small>{candidate.source}</small>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="wb-create-actions">
          <button type="button" className="wb-ghost" disabled={pending || validating || submitting} onClick={() => { void validate(); }}>
            {validating ? '校验中…' : '校验合同'}
          </button>
          <button type="button" className="wb-ghost" disabled={pending || validating || submitting || objective.trim() === ''} onClick={() => { void submit('create'); }}>
            {submitting ? '创建中…' : '创建（稍后启动）'}
          </button>
          <button type="button" className="wb-commit" disabled={pending || validating || submitting || objective.trim() === ''} onClick={() => { void submit('start'); }}>
            {submitting ? '提交中…' : '创建并启动'}
          </button>
        </div>
        <p className="wb-field-note">「创建」只在本地落下任务合同；「创建并启动」会捕获当前工作区基线并开始消耗模型。已有运行中任务时启动会如实 409。</p>
      </section>

      {overview?.task !== null && overview?.task !== undefined ? (
        <details className="wb-pinned-task">
          <summary>使用预设任务</summary>
          <PinnedTaskCard overview={overview} canStart={canStart} />
        </details>
      ) : null}
    </section>
  );
}
