import { useMemo, useState } from 'react';
import type { GuiConnectionState, GuiLiveOverview } from '../../../live-types.js';
import type { ControlState } from './controls.js';
import { statusPresentation, workspaceName } from './format.js';
import { FolderIcon, GearIcon, PlusIcon, RailIcon, SearchIcon } from './icons.js';

export interface ConnectionBadge {
  readonly label: string;
  readonly state: string;
  readonly detail: string;
}

export function connectionBadge(
  overview: GuiLiveOverview | null,
  connection: GuiConnectionState,
  loading: boolean,
  hasError: boolean,
): ConnectionBadge {
  if (loading) return { label: '读取中', state: 'loading', detail: '正在读取本地任务' };
  if (hasError) return { label: '读取失败', state: 'danger', detail: '暂时无法显示真实现场' };
  if (overview !== null && !overview.enabled) return { label: '未启用', state: 'muted', detail: '真实运行入口当前关闭' };
  if (connection === 'disconnected') return { label: '连接中断', state: 'danger', detail: '控制已暂时停用' };
  if (connection === 'connecting') return { label: '连接中', state: 'loading', detail: '正在恢复当前现场' };
  if (overview?.task === null && overview.sessions.length === 0) return { label: '等待待办', state: 'muted', detail: '尚未配置真实任务' };
  if (connection === 'connected') return { label: '实时已连接', state: 'success', detail: '状态来自当前运行现场' };
  return { label: '不可用', state: 'danger', detail: '当前现场只读' };
}

function SettingsPanel({ onClose }: { readonly onClose: () => void }) {
  return (
    <div className="wb-settings" role="dialog" aria-label="设置" aria-modal="false">
      <header>
        <strong>设置</strong>
        <button type="button" onClick={onClose} aria-label="关闭设置">关闭</button>
      </header>
      <p className="wb-not-wired">
        <strong>配置未接入</strong>
        <span>未接入</span>
        <small>模型、权限策略、任务合同与密钥由 CLI 配置和 <code>.env</code> 决定；GUI 没有写入配置的命令，因此这里不提供开关，也不显示假设置项。</small>
      </p>
      <p className="wb-settings-note">当前模型与执行上限在右栏「环境信息」和「上下文」中只读显示。</p>
    </div>
  );
}

export function WorkspaceRail({
  overview,
  selectedId,
  badge,
  collapsed,
  switchState,
  newTaskState,
  onSelect,
  onToggleCollapsed,
}: {
  readonly overview: GuiLiveOverview | null;
  readonly selectedId: string | null;
  readonly badge: ConnectionBadge;
  readonly collapsed: boolean;
  readonly switchState: (id: string | null) => ControlState;
  readonly newTaskState: ControlState;
  readonly onSelect: (id: string | null) => void;
  readonly onToggleCollapsed: () => void;
}) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sessions = overview?.sessions ?? [];
  const workspace = workspaceName(overview?.cwd);
  const taskTitle = overview?.task?.objective.split(/[。\n]/u)[0].slice(0, 60) ?? '等待真实待办';

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return sessions;
    return sessions.filter((session) => session.objective.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle));
  }, [query, sessions]);

  if (collapsed) {
    return (
      <aside className="wb-rail is-collapsed" aria-label="任务与工作区（已收起）">
        <button type="button" className="wb-icon-btn" onClick={onToggleCollapsed} aria-label="展开左栏" title="展开左栏">
          <RailIcon />
        </button>
        <button
          type="button"
          className="wb-icon-btn"
          disabled={!newTaskState.available}
          title={newTaskState.available ? '新任务' : newTaskState.reason}
          aria-label="新任务"
          onClick={() => onSelect(null)}
        >
          <PlusIcon />
        </button>
        <div className="wb-rail-dots">
          {sessions.slice(0, 12).map((session) => (
            <button
              key={session.id}
              type="button"
              className="wb-rail-dot"
              data-status={session.status}
              aria-current={selectedId === session.id ? 'page' : undefined}
              aria-label={`${session.objective.slice(0, 40)}（${statusPresentation[session.status].label}）`}
              title={switchState(session.id).available ? session.objective : switchState(session.id).reason}
              disabled={!switchState(session.id).available}
              onClick={() => onSelect(session.id)}
            />
          ))}
        </div>
        <button type="button" className="wb-icon-btn wb-rail-gear" onClick={() => setSettingsOpen((open) => !open)} aria-label="设置" title="设置（未接入）">
          <GearIcon />
        </button>
        {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
      </aside>
    );
  }

  return (
    <aside className="wb-rail" aria-label="任务与工作区">
      <header className="wb-rail-head">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">J</div>
          <div>
            <strong>Jarvis</strong>
            <span>任务工作区</span>
          </div>
        </div>
        <button type="button" className="wb-icon-btn" onClick={onToggleCollapsed} aria-label="收起左栏" title="收起左栏">
          <RailIcon />
        </button>
      </header>

      <div className="wb-rail-actions">
        <button
          type="button"
          className="wb-action-row"
          disabled={!newTaskState.available}
          title={newTaskState.available ? '查看任务空态并启动' : newTaskState.reason}
          onClick={() => onSelect(null)}
        >
          <PlusIcon />
          <span>新建任务</span>
          <kbd>{newTaskState.available ? '进入空态' : '不可用'}</kbd>
        </button>
        <button
          type="button"
          className="wb-action-row"
          aria-expanded={searching}
          onClick={() => setSearching((open) => !open)}
        >
          <SearchIcon />
          <span>搜索任务</span>
          <kbd>{sessions.length} 条</kbd>
        </button>
        {searching ? (
          <label className="wb-search">
            <span className="wb-sr-only">按目标或 ID 过滤会话</span>
            <input
              type="search"
              value={query}
              placeholder="按目标或会话 ID 过滤"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        ) : null}
      </div>

      <div className="wb-presence" data-state={badge.state}>
        <span className="prototype-dot" aria-hidden="true" />
        <div>
          <strong>{badge.label}</strong>
          <span>{badge.detail}</span>
        </div>
      </div>

      <nav className="wb-groups" aria-label="工作区与任务">
        <section className="wb-group">
          <header>
            <FolderIcon />
            <span>{workspace}</span>
            <em>{sessions.length}</em>
          </header>
          <button
            type="button"
            className={`session-row wb-task-row${selectedId === null ? ' is-current' : ''}`}
            aria-current={selectedId === null ? 'page' : undefined}
            disabled={!newTaskState.available && selectedId !== null}
            title={newTaskState.available ? '任务空态' : newTaskState.reason}
            onClick={() => onSelect(null)}
          >
            <span className="session-state is-idle" aria-hidden="true" />
            <span>
              <strong>{taskTitle}</strong>
              <small>任务空态</small>
            </span>
          </button>
          {visible.length === 0 ? (
            <p className="wb-group-empty">{query.trim() === '' ? '还没有会话记录。' : '没有匹配的会话。'}</p>
          ) : null}
          {visible.map((session) => {
            const state = switchState(session.id);
            return (
              <button
                key={session.id}
                type="button"
                className={`session-row wb-task-row${selectedId === session.id ? ' is-current' : ''}`}
                aria-current={selectedId === session.id ? 'page' : undefined}
                disabled={!state.available}
                title={state.available ? `${session.objective}\n${session.id}` : state.reason}
                onClick={() => onSelect(session.id)}
              >
                <span className={`session-state is-${session.status}`} aria-hidden="true" />
                <span>
                  <strong>{session.objective.split(/[。\n]/u)[0].slice(0, 60)}</strong>
                  <small>{statusPresentation[session.status].label}</small>
                </span>
              </button>
            );
          })}
        </section>
      </nav>

      <footer className="wb-rail-foot">
        <div className="wb-person">
          <span className="wb-avatar" aria-hidden="true">L</span>
          <div>
            <strong>Ludi</strong>
            <small title={overview?.cwd ?? ''}>{overview?.cwd ?? '本地工作区'}</small>
          </div>
        </div>
        <button
          type="button"
          className="wb-icon-btn"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
          title="设置（未接入）"
          aria-label="设置"
        >
          <GearIcon />
        </button>
      </footer>
      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </aside>
  );
}
