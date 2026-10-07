import { useEffect, useMemo, useState } from 'react';
import type { GuiModelsResponse } from '../../../live-types.js';
import { getLiveModels } from './api.js';
import { useLiveSession } from './use-live-session.js';
import { Workbench } from '../workbench/workbench.js';
import type { WorkbenchCommands, WorkbenchInput } from '../workbench/types.js';

/**
 * Live wiring only. The workbench owns layout and display state; this component owns the real
 * projection, the command surface and the readiness marker used by browser verification.
 */
export function LiveJarvisApp() {
  const {
    overview, snapshot, selectedId, connection, actionPending, overviewLoading, overviewError,
    connectionNotice, streamWarning, actionError, chooseSession, start, submitInput, withdrawInput,
    pause, continueRun, stop, resume, decide, submitReview, updateMeta, createWorkspace, saveWorkspacePresets,
    probeWorkspaceCommands, validateTask,
    createTask, createBranch, getGit, getFileView, getWorkspaceTree, openFileExternal, runTerminal, cancelTerminal,
  } = useLiveSession();

  const [models, setModels] = useState<GuiModelsResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getLiveModels(controller.signal).then(setModels).catch(() => setModels(null));
    return () => controller.abort();
  }, []);

  const commands = useMemo<WorkbenchCommands>(() => ({
    chooseSession, start, submitInput, withdrawInput, pause, continueRun, stop, resume, decide, submitReview,
    updateMeta, createWorkspace, saveWorkspacePresets, probeWorkspaceCommands, validateTask,
    createTask, createBranch, getGit, getFileView, getWorkspaceTree,
    openFileExternal, runTerminal, cancelTerminal,
  }), [
    chooseSession, start, submitInput, withdrawInput, pause, continueRun, stop, resume, decide, submitReview,
    updateMeta, createWorkspace, saveWorkspacePresets, probeWorkspaceCommands, validateTask,
    createTask, createBranch, getGit, getFileView, getWorkspaceTree,
    openFileExternal, runTerminal, cancelTerminal,
  ]);

  const input = useMemo<WorkbenchInput>(() => ({
    overview,
    snapshot,
    selectedId,
    connection,
    actionPending,
    notices: { overviewLoading, overviewError, connectionNotice, streamWarning, actionError },
    commands,
    provenance: 'live',
    models,
  }), [
    actionError, actionPending, commands, connection, connectionNotice, models, overview, overviewError,
    overviewLoading, selectedId, snapshot, streamWarning,
  ]);

  useEffect(() => {
    document.documentElement.dataset.liveReady = 'true';
    return () => { delete document.documentElement.dataset.liveReady; };
  }, []);

  return <Workbench input={input} />;
}
