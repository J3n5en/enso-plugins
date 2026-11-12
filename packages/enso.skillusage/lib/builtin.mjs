/** 与 Enso src/shared/types/assets.ts 的 BUILTIN_AGENT_TYPES 一致。占用只算名字和描述。 */
export const BUILTIN_AGENTS = [
  {
    name: 'scout',
    description: 'Fast read-only recon; returns compressed findings',
  },
  {
    name: 'worker',
    description: 'Implements a self-contained coding subtask end to end',
  },
  {
    name: 'reviewer',
    description: 'Reviews code or diffs; read-only, returns prioritized issues',
  },
  {
    name: 'tester',
    description:
      'Writes failing tests first (TDD RED); can only write test files, never implementation',
  },
];

export const RARE_CALLS = 2;
