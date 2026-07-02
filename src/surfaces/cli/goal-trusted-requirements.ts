import {
  loadGoalSetterRequirementsPlan,
  loadSandboxedCheckPlan,
  type LoadedGoalSetterRequirements,
  type LoadedSandboxedCheckPlan,
} from '../../capabilities/index.js';
import type { ReadText } from '../../capabilities/rules/index.js';

export type GoalCliTrustedRequirements =
  | { readonly kind: 'none' }
  | { readonly kind: 'sandbox-checks'; readonly plan: LoadedSandboxedCheckPlan }
  | { readonly kind: 'goal-setter-requirements'; readonly plan: LoadedGoalSetterRequirements };

export async function loadGoalCliTrustedRequirements(deps: {
  readonly sandboxCheckPlanPath?: string;
  readonly goalSetterRequirementsPath?: string;
  readonly cwd: string;
  readonly forbiddenRoots: readonly string[];
  readonly readText: ReadText;
  readonly realpath?: (path: string) => Promise<string | null>;
}): Promise<GoalCliTrustedRequirements> {
  const sandboxPath = blankToUndefined(deps.sandboxCheckPlanPath);
  const goalSetterPath = blankToUndefined(deps.goalSetterRequirementsPath);

  if (sandboxPath !== undefined && goalSetterPath !== undefined) {
    throw new Error('choose one trusted requirements source: JARVIS_SANDBOX_CHECKS_FILE or JARVIS_GOAL_SETTER_REQUIREMENTS_FILE');
  }

  if (goalSetterPath !== undefined) {
    const plan = await loadGoalSetterRequirementsPlan({
      path: goalSetterPath,
      cwd: deps.cwd,
      forbiddenRoots: deps.forbiddenRoots,
      readText: deps.readText,
      realpath: deps.realpath,
    });
    return { kind: 'goal-setter-requirements', plan };
  }

  if (sandboxPath !== undefined) {
    const plan = await loadSandboxedCheckPlan({
      path: sandboxPath,
      cwd: deps.cwd,
      forbiddenRoots: deps.forbiddenRoots,
      readText: deps.readText,
      realpath: deps.realpath,
    });
    return { kind: 'sandbox-checks', plan };
  }

  return { kind: 'none' };
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}
