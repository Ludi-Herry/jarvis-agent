import type { GuiLiveOverview } from '../../../live-types.js';
import type { ControlState } from './controls.js';
import { FirstTaskGuide } from '../live/first-task-guide.js';

/** Operator-fixed pinned contract card; start happens from the composer or an idle task's start button. */
export function PinnedTaskCard({ overview, canStart }: {
  readonly overview: GuiLiveOverview | null;
  readonly canStart: ControlState;
}) {
  const task = overview?.task ?? null;
  if (task === null) return null;
  return (
    <section className="wb-empty-task" data-available={canStart.available}>
      <header>
        <h3>启动参数固定的任务合同</h3>
        <strong>{canStart.available ? '可启动' : '不可启动'}</strong>
      </header>
      <p className="wb-empty-objective">{task.objective}</p>
      {task.requirements.length > 0 ? (
        <ul className="wb-empty-requirements">
          {task.requirements.map((requirement, index) => <li key={requirement}><span>R{index + 1}</span>{requirement}</li>)}
        </ul>
      ) : null}
      {!canStart.available ? <p className="wb-gate-note">{canStart.reason}</p> : null}
    </section>
  );
}

/**
 * Empty-task orientation built from real facts only: the operator-fixed task contract, whether the
 * runtime currently allows a start, and where each column is used. It never claims a run happened.
 */
export function EmptyTaskState({ overview, canStart }: {
  readonly overview: GuiLiveOverview | null;
  readonly canStart: ControlState;
}) {
  return (
    <section className="wb-empty" aria-labelledby="wb-empty-title">
      <header>
        <h2 id="wb-empty-title">一项任务，三栏分工</h2>
        <p>左栏选哪件事，中栏说清要什么并持续对话，证据栏按需打开、凭它判断是否完成。</p>
      </header>

      <ul className="wb-empty-rules">
        <li><strong>审批</strong>写入、修改、运行命令会停在对话里等你决定：允许一次只放行这一次，拒绝与要求调整必须写理由并回到 Jarvis。</li>
        <li><strong>完成</strong>模型说完成、请求成功或界面变色都不算；合同检查通过且你逐项提交人工验收后，完成授权才会授予。</li>
        <li><strong>急停</strong>方向跑偏或不想再等就急停：中断在途执行并阻止后续副作用，已保留的消息与证据不丢失，终态不自动重跑。</li>
      </ul>

      <PinnedTaskCard overview={overview} canStart={canStart} />

      <FirstTaskGuide />
    </section>
  );
}
