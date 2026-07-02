import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('loop CLI goal-setter requirements wiring', () => {
  it('loads the trusted map, records path/hash metadata, and passes route plans into runGoal', async () => {
    const source = await readFile('src/surfaces/cli/loop-cli.ts', 'utf8');

    expect(source).toContain('loadLoopGoalSetterRequirementsMap');
    expect(source).toContain('buildLoopGoalSetterRequirementsPlan');
    expect(source).toContain('assertResumeGoalSetterRequirementsMatch');
    expect(source).toContain('goalSetterRequirementsMapPath: goalSetterRequirementsMap?.path');
    expect(source).toContain('goalSetterRequirementsMapHash: goalSetterRequirementsMap?.hash');
    expect(source).toContain('goalSetterRequirementRoutes: goalSetterRoutes');
    expect(source).toContain('sandboxedRequirementCommands');
  });
});
