import type {
  CheckedRestorePreview,
  ShadowGit,
} from '../../capabilities/shadow/shadow-git.js';
import {
  applyConversationRewind,
  assertConversationRewindSourceUnchanged,
  type ConversationRewindPlan,
  type ConversationRewindResult,
} from '../../runtime/checkpoint/index.js';

export interface PreparedFileRewind {
  conversation: ConversationRewindPlan;
  shadow: ShadowGit;
  restore: CheckedRestorePreview;
}

export type FileRewindExecutionResult =
  | { status: 'declined'; preflightRef: string }
  | { status: 'blocked'; preflightRef: string; reason: string }
  | ({ status: 'created'; preflightRef: string } & ConversationRewindResult);

export async function prepareFileRewind(input: {
  conversation: ConversationRewindPlan;
  shadow: ShadowGit;
}): Promise<PreparedFileRewind> {
  const checkpoint = input.conversation.checkpoint;
  if (!checkpoint.effects.canRewindFiles || checkpoint.shadow.status !== 'captured') {
    throw new Error('checkpoint is not eligible for file rewind because no trusted ShadowGit ref was captured');
  }
  const prepared = await input.shadow.prepareCheckedRestore(
    checkpoint.shadow.ref,
    `rewind preflight ${input.conversation.rewindId}`,
  );
  if (!prepared.ok) throw new Error(`file rewind preview blocked: ${prepared.reason}`);
  return {
    conversation: input.conversation,
    shadow: input.shadow,
    restore: prepared.preview,
  };
}

export async function executeFileRewind(
  prepared: PreparedFileRewind,
  approved: boolean,
): Promise<FileRewindExecutionResult> {
  const plan = prepared.conversation;
  const auditBase = {
    rewindId: plan.rewindId,
    checkpointId: plan.checkpointId,
    sourceSessionId: plan.sourceSessionId,
    forkSessionId: plan.forkSessionId,
    mode: 'conversation-and-files' as const,
  };
  if (!approved) {
    await plan.auditStore.appendRewind({
      ...auditBase,
      outcome: 'declined',
      reason: `preflight ${prepared.restore.preflightRef}`,
    });
    return { status: 'declined', preflightRef: prepared.restore.preflightRef };
  }

  await assertConversationRewindSourceUnchanged(
    plan,
    'changed before checked file restore',
    'conversation-and-files',
  );
  await plan.auditStore.appendRewind({
    ...auditBase,
    outcome: 'planned',
    reason: `preflight ${prepared.restore.preflightRef}`,
  });
  const restored = await prepared.shadow.applyCheckedRestore(prepared.restore);
  if (!restored.ok) {
    const reason = `${restored.kind}: ${restored.reason}; preflight ${restored.preflightRef}`;
    try {
      await plan.auditStore.appendRewind({ ...auditBase, outcome: 'failed', reason });
    } catch {
      // Keep the checked-restore failure as the primary operator signal.
    }
    return { status: 'blocked', preflightRef: restored.preflightRef, reason };
  }

  try {
    const conversation = await applyConversationRewind(plan, {
      mode: 'conversation-and-files',
      plannedAlready: true,
    });
    return { ...conversation, status: 'created', preflightRef: restored.preflightRef };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `files restored but conversation fork was not completed; preflight ${restored.preflightRef}; ${detail}`,
      { cause: err },
    );
  }
}
