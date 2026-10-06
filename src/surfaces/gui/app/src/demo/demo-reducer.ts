import { baseMessages, type DemoMessage } from './gui-recover-17.js';

export type RunState =
  | 'running'
  | 'approval'
  | 'paused'
  | 'validating'
  | 'failed'
  | 'interrupted'
  | 'restored'
  | 'completed';

export type ReviewStage = 'approval' | 'verification' | 'failure' | 'completed';
export type EvidenceTab = 'diff' | 'verification' | 'context';
export type ApprovalState = 'pending' | 'allowed' | 'denied' | 'revised';

export interface DemoState {
  readonly runState: RunState;
  readonly returnState: RunState;
  readonly reviewStage: ReviewStage;
  readonly evidenceTab: EvidenceTab;
  readonly approval: ApprovalState;
  readonly verified: boolean;
  readonly reviewExpanded: boolean;
  readonly unknownEvent: string | null;
  readonly messages: readonly DemoMessage[];
  readonly sequence: number;
}

export type DemoAction =
  | { readonly type: 'reset' }
  | { readonly type: 'set-fixture'; readonly state: 'running' | 'approval' | 'failed' | 'completed' }
  | { readonly type: 'pause' }
  | { readonly type: 'continue' }
  | { readonly type: 'terminate' }
  | { readonly type: 'recover' }
  | { readonly type: 'approve-once' }
  | { readonly type: 'reject' }
  | { readonly type: 'revise' }
  | { readonly type: 'validation-failed' }
  | { readonly type: 'finish-verified' }
  | { readonly type: 'set-evidence-tab'; readonly tab: EvidenceTab }
  | { readonly type: 'toggle-review' }
  | { readonly type: 'append-exchange'; readonly text: string }
  | { readonly type: 'show-unknown'; readonly eventType: string }
  | { readonly type: 'dismiss-unknown' };

export function createInitialDemoState(): DemoState {
  return {
    runState: 'approval',
    returnState: 'approval',
    reviewStage: 'approval',
    evidenceTab: 'diff',
    approval: 'pending',
    verified: false,
    reviewExpanded: false,
    unknownEvent: null,
    messages: [...baseMessages],
    sequence: 17,
  };
}

function setFixture(state: DemoState, fixture: Extract<DemoAction, { type: 'set-fixture' }>['state']): DemoState {
  if (fixture === 'approval') return createInitialDemoState();
  if (fixture === 'running') {
    return {
      ...state,
      runState: 'running',
      returnState: 'running',
      reviewStage: 'approval',
      approval: 'pending',
      verified: false,
      unknownEvent: null,
    };
  }
  if (fixture === 'failed') {
    return {
      ...state,
      runState: 'failed',
      returnState: 'running',
      reviewStage: 'failure',
      evidenceTab: 'verification',
      approval: 'allowed',
      verified: false,
      reviewExpanded: true,
      unknownEvent: null,
    };
  }
  return {
    ...state,
    runState: 'completed',
    returnState: 'completed',
    reviewStage: 'completed',
    evidenceTab: 'verification',
    approval: 'allowed',
    verified: true,
    reviewExpanded: true,
    unknownEvent: null,
  };
}

function appendExchange(state: DemoState, text: string): DemoState {
  const sequence = state.sequence + 1;
  const user: DemoMessage = {
    id: `message_user_${sequence}`,
    role: 'user',
    name: 'Ludi',
    time: '14:33',
    content: [{ type: 'text', text }],
  };
  const assistant: DemoMessage = {
    id: `message_assistant_${sequence}`,
    role: 'assistant',
    name: 'Jarvis',
    time: '14:33',
    content: [
      {
        type: 'text',
        text: state.approval === 'revised'
          ? '调整意见已写入模拟现场。审批请求重新打开；真实 Runtime、权限与工作区仍未连接。'
          : '补充指令已加入本地模拟会话。P2 Spike 没有连接模型或 Runtime。',
      },
    ],
  };
  const revised = state.approval === 'revised';
  return {
    ...state,
    runState: revised ? 'approval' : state.runState,
    returnState: revised ? 'approval' : state.returnState,
    reviewStage: revised ? 'approval' : state.reviewStage,
    approval: revised ? 'pending' : state.approval,
    messages: [...state.messages, user, assistant],
    sequence,
  };
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'reset':
      return createInitialDemoState();
    case 'set-fixture':
      return setFixture(state, action.state);
    case 'pause':
      if (!['running', 'approval', 'validating'].includes(state.runState)) return state;
      return { ...state, runState: 'paused', returnState: state.runState };
    case 'continue':
      if (state.runState !== 'paused' && state.runState !== 'restored') return state;
      return { ...state, runState: state.returnState };
    case 'terminate':
      if (state.runState === 'completed' || state.runState === 'interrupted') return state;
      return {
        ...state,
        runState: 'interrupted',
        returnState: state.runState === 'paused' || state.runState === 'restored'
          ? state.returnState
          : state.runState,
      };
    case 'recover':
      if (state.runState !== 'failed' && state.runState !== 'interrupted') return state;
      return {
        ...state,
        runState: 'restored',
        returnState: state.runState === 'failed' ? 'running' : state.returnState,
      };
    case 'approve-once':
      if (state.runState !== 'approval') return state;
      return {
        ...state,
        runState: 'validating',
        returnState: 'validating',
        reviewStage: 'verification',
        evidenceTab: 'verification',
        approval: 'allowed',
        verified: false,
        reviewExpanded: true,
      };
    case 'reject':
      if (state.runState !== 'approval') return state;
      return {
        ...state,
        runState: 'failed',
        returnState: 'approval',
        reviewStage: 'failure',
        evidenceTab: 'diff',
        approval: 'denied',
        verified: false,
      };
    case 'revise':
      if (state.runState !== 'approval') return state;
      return {
        ...state,
        runState: 'paused',
        returnState: 'approval',
        approval: 'revised',
        verified: false,
      };
    case 'validation-failed':
      if (state.runState !== 'validating') return state;
      return {
        ...state,
        runState: 'failed',
        returnState: 'running',
        reviewStage: 'failure',
        evidenceTab: 'verification',
        verified: false,
      };
    case 'finish-verified':
      if (state.runState !== 'validating') return state;
      return {
        ...state,
        runState: 'completed',
        returnState: 'completed',
        reviewStage: 'completed',
        evidenceTab: 'verification',
        verified: true,
      };
    case 'set-evidence-tab':
      return { ...state, evidenceTab: action.tab };
    case 'toggle-review':
      return { ...state, reviewExpanded: !state.reviewExpanded };
    case 'append-exchange':
      return appendExchange(state, action.text);
    case 'show-unknown':
      return { ...state, unknownEvent: action.eventType };
    case 'dismiss-unknown':
      return { ...state, unknownEvent: null };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
