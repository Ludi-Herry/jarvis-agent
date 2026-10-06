import { useMemo, useState } from 'react';
import type { GuiConnectionState, GuiLiveOverview, GuiLiveOverviewSession } from '../../../live-types.js';
import type { GuiMetaPatch, GuiWorkspaceInput } from '../live/api.js';
import type { ControlState } from './controls.js';
import { statusPresentation } from './format.js';
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
  onUpdateMeta,
  onCreateWorkspace,
}: {
  readonly overview: GuiLiveOverview | null;
  readonly selectedId: string | null;
  readonly badge: ConnectionBadge;
  readonly collapsed: boolean;
  readonly switchState: (id: string | null) => ControlState;
  readonly newTaskState: ControlState;
  readonly onSelect: (id: string | null) => void;
  readonly onToggleCollapsed: () => void;
  readonly onUpdateMeta: (id: string, patch: GuiMetaPatch) => Promise<unknown>;
  readonly onCreateWorkspace: (input: GuiWorkspaceInput) => Promise<unknown>;
}) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [archivedOpen, setArchivedOpen] = useState<string | null>(null);
  const [wsDialogOpen, setWsDialogOpen] = useState(false);
  const [wsName, setWsName] = useState('');
  const [wsCwd, setWsCwd] = useState('');
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsPending, setWsPending] = useState(false);
  const sessions = overview?.sessions ?? [];
  const workspaces = useMemo(() => (overview?.workspaces ?? []).filter((item) => !item.archived), [overview?.workspaces]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return sessions;
    return sessions.filter((session) =>
      session.title.toLowerCase().includes(needle)
      || session.objective.toLowerCase().includes(needle)
      || session.lastMessage.toLowerCase().includes(needle)
      || session.id.toLowerCase().includes(needle));
  }, [query, sessions]);

  const groups = useMemo(() => {
    const fallback = workspaces[0]?.id ?? '';
    const byWorkspace = new Map<string, GuiLiveOverviewSession[]>();
    for (const session of visible) {
      const key = workspaces.some((item) => item.id === session.workspaceId) ? session.workspaceId : fallback;
      byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), session]);
    }
    return workspaces.map((ws) => ({
      ws,
      active: (byWorkspace.get(ws.id) ?? []).filter((session) => !session.archived),
      archived: (byWorkspace.get(ws.id) ?? []).filter((session) => session.archived),
    })).filter((group) => group.active.length > 0 || group.archived.length > 0 || query.trim() === '');
  }, [visible, workspaces, query]);

  const commitMeta = (id: string, patch: GuiMetaPatch) => {
    setMenuFor(null);
    void onUpdateMeta(id, patch).catch(() => undefined);
  };

  const commitRename = (session: GuiLiveOverviewSession) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (next === '' || next === session.title) return;
    void onUpdateMeta(session.id, { title: next }).catch(() => undefined);
  };

  const submitWorkspace = () => {
    setWsPending(true);
    setWsError(null);
    onCreateWorkspace({ name: wsName.trim(), cwd: wsCwd.trim() })
      .then(() => { setWsDialogOpen(false); setWsName(''); setWsCwd(''); })
      .catch((error: unknown) => setWsError(error instanceof Error && error.message.trim() !== '' ? error.message : '工作区创建失败。'))
      .finally(() => setWsPending(false));
  };

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
            <span>任务空态</span>
          </header>
          <button
            type="button"
            className={`session-row wb-task-row${selectedId === null ? ' is-current' : ''}`}
            aria-current={selectedId === null ? 'page' : undefined}
            disabled={!newTaskState.available && selectedId !== null}
            title={newTaskState.available ? '新任务创建面板' : newTaskState.reason}
            onClick={() => onSelect(null)}
          >
            <span className="session-state is-idle" aria-hidden="true" />
            <span>
              <strong>新建任务</strong>
              <small>输入目标并确认合同</small>
            </span>
          </button>
        </section>
        {groups.map((group) => (
          <section className="wb-group" key={group.ws.id}>
            <header>
              <FolderIcon />
              <span>{group.ws.name}</span>
              <em>{group.active.length}</em>
            </header>
            {group.active.length === 0 && group.archived.length === 0 ? (
              <p className="wb-group-empty">{query.trim() === '' ? '该工作区还没有会话记录。' : '没有匹配的会话。'}</p>
            ) : null}
            {group.active.map((session) => {
              const state = switchState(session.id);
              if (renamingId === session.id) {
                return (
                  <div className="wb-task-wrap" key={session.id}>
                    <input
                      className="wb-rename"
                      value={renameDraft}
                      autoFocus
                      aria-label={`重命名 ${session.title}`}
                      onChange={(event) => setRenameDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename(session);
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={() => commitRename(session)}
                    />
                  </div>
                );
              }
              return (
                <div className="wb-task-wrap" key={session.id}>
                  <button
                    type="button"
                    className={`session-row wb-task-row${selectedId === session.id ? ' is-current' : ''}`}
                    aria-current={selectedId === session.id ? 'page' : undefined}
                    disabled={!state.available}
                    title={state.available ? `${session.objective}${session.lastMessage !== '' ? `\n最近：${session.lastMessage}` : ''}` : state.reason}
                    onClick={() => onSelect(session.id)}
                  >
                    <span className={`session-state is-${session.status}`} aria-hidden="true" />
                    <span>
                      <strong>{session.sourceRef !== undefined && !session.title.startsWith('分支') ? '分支 · ' : ''}{session.title}</strong>
                      <small>{statusPresentation[session.status].label}</small>
                    </span>
                    {session.pinned ? <span className="wb-pin" aria-label="已置顶" title="已置顶">●</span> : null}
                  </button>
                  <button
                    type="button"
                    className="wb-task-menu"
                    aria-expanded={menuFor === session.id}
                    aria-haspopup="menu"
                    aria-label={`任务选项：${session.title}`}
                    onClick={() => setMenuFor(menuFor === session.id ? null : session.id)}
                  >
                    …
                  </button>
                  {menuFor === session.id ? (
                    <div className="wb-task-menu-pop" role="menu" aria-label="任务选项">
                      <button type="button" role="menuitem" onClick={() => { setMenuFor(null); setRenamingId(session.id); setRenameDraft(session.title); }}>重命名</button>
                      <button type="button" role="menuitem" onClick={() => commitMeta(session.id, { pinned: !session.pinned })}>{session.pinned ? '取消置顶' : '置顶'}</button>
                      <button type="button" role="menuitem" onClick={() => commitMeta(session.id, { archived: true })}>归档</button>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {group.archived.length > 0 ? (
              <button
                type="button"
                className="wb-archived-toggle"
                aria-expanded={archivedOpen === group.ws.id}
                onClick={() => setArchivedOpen(archivedOpen === group.ws.id ? null : group.ws.id)}
              >
                已归档 · {group.archived.length}
              </button>
            ) : null}
            {archivedOpen === group.ws.id ? group.archived.map((session) => (
              <div className="wb-task-wrap is-archived" key={session.id}>
                <button
                  type="button"
                  className="session-row wb-task-row"
                  onClick={() => onSelect(session.id)}
                >
                  <span className={`session-state is-${session.status}`} aria-hidden="true" />
                  <span>
                    <strong>{session.title}</strong>
                    <small>{statusPresentation[session.status].label}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="wb-task-menu"
                  aria-label={`恢复归档：${session.title}`}
                  onClick={() => commitMeta(session.id, { archived: false })}
                >
                  恢复
                </button>
              </div>
            )) : null}
          </section>
        ))}
        <section className="wb-group">
          <button type="button" className="wb-action-row" onClick={() => setWsDialogOpen((open) => !open)} aria-expanded={wsDialogOpen}>
            <PlusIcon />
            <span>新建工作区</span>
            <kbd>绝对路径</kbd>
          </button>
          {wsDialogOpen ? (
            <div className="wb-ws-dialog" role="dialog" aria-label="新建工作区">
              <label>
                <span>名称</span>
                <input value={wsName} onChange={(event) => setWsName(event.currentTarget.value)} placeholder="例如 demo 项目" />
              </label>
              <label>
                <span>目录（绝对路径）</span>
                <input value={wsCwd} onChange={(event) => setWsCwd(event.currentTarget.value)} placeholder="H:\\path\\to\\repo" />
              </label>
              {wsError !== null ? <p className="wb-ws-error">{wsError}</p> : null}
              <div className="wb-ws-actions">
                <button type="button" onClick={() => setWsDialogOpen(false)}>取消</button>
                <button type="button" className="wb-ws-confirm" disabled={wsPending || wsName.trim() === '' || wsCwd.trim() === ''} onClick={submitWorkspace}>
                  {wsPending ? '创建中…' : '创建'}
                </button>
              </div>
            </div>
          ) : null}
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
