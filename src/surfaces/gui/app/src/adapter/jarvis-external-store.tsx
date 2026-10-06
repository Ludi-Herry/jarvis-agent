import { useCallback, useEffect, useMemo, useRef, type PropsWithChildren } from 'react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreAdapter,
  type ExternalThreadQueueAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type { DemoMessage } from '../demo/gui-recover-17';
import type { GuiMessage, GuiTool } from '../../../live-types.js';

interface JarvisExternalStoreProviderProps extends PropsWithChildren {
  readonly messages: readonly DemoMessage[];
  readonly onAppend: (text: string) => void | Promise<void>;
}

interface LiveJarvisExternalStoreProviderProps extends PropsWithChildren {
  readonly messages: readonly GuiMessage[];
  readonly tools: readonly GuiTool[];
  readonly onAppend: (text: string) => Promise<void>;
  readonly isRunning: boolean;
  readonly isSendDisabled: boolean;
  readonly composerKey: string;
  readonly restoredDraft: string;
  readonly draftRecoveryToken: number;
}

interface ExternalStoreProviderProps<T> extends PropsWithChildren {
  readonly messages: readonly T[];
  readonly convertMessage: (message: T, index: number) => ThreadMessageLike;
  readonly onAppend: (text: string) => Promise<void>;
  readonly isRunning: boolean;
  readonly isSendDisabled: boolean;
  readonly queueWhileRunning?: boolean;
  readonly composerKey?: string;
  readonly restoredDraft?: string;
  readonly draftRecoveryToken?: number;
}

function convertDemoMessage(message: DemoMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.content as ThreadMessageLike['content'],
    createdAt: new Date(`2026-09-02T${message.time}:00+08:00`),
    ...(message.role === 'assistant'
      ? { status: { type: 'complete' as const, reason: 'stop' as const } }
      : {}),
    metadata: {
      custom: {
        name: message.name,
        time: message.time,
      },
    },
  };
}

function safeDate(value: string): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function assistantStatus(status: GuiMessage['status']): ThreadMessageLike['status'] {
  if (status === 'running') return { type: 'running' };
  if (status === 'incomplete') return { type: 'incomplete', reason: 'other' };
  return { type: 'complete', reason: 'stop' };
}

function toolPart(tool: GuiTool): Exclude<ThreadMessageLike['content'], string>[number] {
  const settled = !['proposed', 'running'].includes(tool.status);
  return {
    type: 'tool-call',
    toolCallId: tool.id,
    toolName: tool.name,
    args: {
      arguments: tool.arguments,
      status: tool.status,
      target: tool.path ?? tool.name,
      detail: tool.output ?? '',
    },
    ...(settled
      ? {
          result: {
            status: tool.status,
            output: tool.output ?? '',
            path: tool.path ?? '',
          },
        }
      : {}),
    ...(tool.status === 'failed' ? { isError: true } : {}),
  };
}

function convertLiveMessage(message: GuiMessage, toolById: ReadonlyMap<string, GuiTool>): ThreadMessageLike {
  const content: Exclude<ThreadMessageLike['content'], string> = [
    { type: 'text', text: message.text },
    ...(message.role === 'assistant'
      ? message.toolIds.flatMap((toolId) => {
          const tool = toolById.get(toolId);
          return tool === undefined ? [] : [toolPart(tool)];
        })
      : []),
  ];

  return {
    id: message.id,
    role: message.role,
    content,
    createdAt: safeDate(message.at),
    ...(message.role === 'assistant' ? { status: assistantStatus(message.status) } : {}),
    metadata: {
      custom: {
        name: message.role === 'user' ? 'Ludi' : 'Jarvis',
        time: message.at,
        sourceStatus: message.status,
      },
    },
  };
}

function firstText(message: AppendMessage): string | null {
  const part = message.content.find((item) => item.type === 'text');
  if (part?.type !== 'text') return null;
  const text = part.text.trim();
  return text === '' ? null : text;
}

function ExternalStoreProvider<T>({
  messages,
  convertMessage,
  onAppend,
  isRunning,
  isSendDisabled,
  queueWhileRunning = false,
  composerKey,
  restoredDraft = '',
  draftRecoveryToken = 0,
  children,
}: ExternalStoreProviderProps<T>) {
  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = firstText(message);
      if (text !== null) await onAppend(text);
    },
    [onAppend],
  );

  const runningQueue = useMemo<ExternalThreadQueueAdapter | undefined>(() => {
    if (!queueWhileRunning) return undefined;
    const submit = (message: AppendMessage) => {
      void onNew(message).catch(() => undefined);
    };
    return {
      items: [],
      steerItems: [],
      enqueue: submit,
      steer: submit,
      move: () => undefined,
      edit: () => undefined,
      remove: () => undefined,
    };
  }, [onNew, queueWhileRunning]);

  const store = {
    messages,
    convertMessage,
    onNew,
    isRunning,
    isSendDisabled,
    ...(runningQueue === undefined ? {} : { queue: runningQueue }),
  } as ExternalStoreAdapter<T>;
  const runtime = useExternalStoreRuntime<T>(store);
  const restoredDraftRef = useRef(restoredDraft);
  restoredDraftRef.current = restoredDraft;

  useEffect(() => {
    if (composerKey === undefined) return;
    runtime.thread.composer.setText(restoredDraftRef.current);
  }, [composerKey, draftRecoveryToken, runtime]);

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

export function JarvisExternalStoreProvider({
  messages,
  onAppend,
  children,
}: JarvisExternalStoreProviderProps) {
  const handleAppend = useCallback(async (text: string) => {
    await onAppend(text);
  }, [onAppend]);

  return (
    <ExternalStoreProvider
      messages={messages}
      convertMessage={convertDemoMessage}
      onAppend={handleAppend}
      isRunning={false}
      isSendDisabled={false}
    >
      {children}
    </ExternalStoreProvider>
  );
}

export function LiveJarvisExternalStoreProvider({
  messages,
  tools,
  onAppend,
  isRunning,
  isSendDisabled,
  composerKey,
  restoredDraft,
  draftRecoveryToken,
  children,
}: LiveJarvisExternalStoreProviderProps) {
  const toolById = useMemo(
    () => new Map(tools.map((tool) => [tool.id, tool] as const)),
    [tools],
  );
  const convertMessage = useCallback(
    (message: GuiMessage) => convertLiveMessage(message, toolById),
    [toolById],
  );

  return (
    <ExternalStoreProvider
      messages={messages}
      convertMessage={convertMessage}
      onAppend={onAppend}
      isRunning={isRunning}
      isSendDisabled={isSendDisabled}
      queueWhileRunning={isRunning}
      composerKey={composerKey}
      restoredDraft={restoredDraft}
      draftRecoveryToken={draftRecoveryToken}
    >
      {children}
    </ExternalStoreProvider>
  );
}
