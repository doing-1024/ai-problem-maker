import assert from 'assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { app } from '../server/index.js';
import { ensureAppDirs, createWorkspace, getWorkspaceMeta, writeWorkspaceFile, readWorkspaceFile, listWorkspaceFiles, downloadWorkspaceZip } from '../server/workspace.js';
import { generateProblem, generateSolution, regenerateStdSolution, generateDataPlan, runDataGenerator } from '../server/tasks.js';
import { __testHooks } from '../server/tasks.js';
import { withWorkspaceLock } from '../server/job-lock.js';

await ensureAppDirs();

assert.equal(
  __testHooks.sanitizeCppCode('```cpp\n#include <bits/stdc++.h>\nint main(){return 0;}\n```'),
  '#include <bits/stdc++.h>\nint main(){return 0;}'
);
assert.equal(
  __testHooks.sanitizeCppCode('```cpp \n#include <bits/stdc++.h>\nint main(){return 0;}\n```'),
  '#include <bits/stdc++.h>\nint main(){return 0;}'
);
assert.equal(
  __testHooks.sanitizeCppCode('说明\n```c++\n#include <bits/stdc++.h>\nint main(){return 0;}\n```'),
  '#include <bits/stdc++.h>\nint main(){return 0;}'
);
assert.equal(
  __testHooks.sanitizePythonCode('TEST_GEN\nimport random\nprint(1)\n'),
  'import random\nprint(1)'
);
assert.equal(
  __testHooks.sanitizePythonCode('说明\n```python\nBRUTE_TEST_GEN\nimport sys\nprint(2)\n```'),
  'import sys\nprint(2)'
);
assert.equal(
  __testHooks.sanitizeCppCode('#include <bits/stdc++.h>\nstruct Edge{};\nint main(){return 1;}\n#include <bits/stdc++.h>\nstruct Edge{};\nint main(){return 0;}'),
  '#include <bits/stdc++.h>\nstruct Edge{};\nint main(){return 0;}'
);
assert.equal(__testHooks.reviewPassed('PASS\nok'), true);
assert.equal(__testHooks.reviewPassed('CODE_REVIEW\nPASS\nok'), true);
assert.equal(__testHooks.reviewPassed('CODE_REVIEW\nFAIL\nbad'), false);
assert.equal(__testHooks.reviewPassed('标记为 CODE_REVIEW\n\n### 结论\n**PASS**'), true);
assert.equal(__testHooks.reviewPassed('CODE_REVIEW\n\n结论：FAIL'), false);
assert.equal(
  __testHooks.sanitizeMarkdownArtifact('PROBLEM_REVISE\n\n# 标题\n\nSOLUTION_FROM_STD\n\n正文'),
  '# 标题\n\n正文'
);
assert.equal(
  __testHooks.detectProblemGuarantees('输入保证对于所有 1 <= i <= N 有 X_i - X_{i-1} <= C，且 D - X_N <= C。').adjacentDistanceLeCapacity,
  true
);
assert.throws(
  () => __testHooks.assertDataArtifactsRespectProblemGuarantees(
    '输入保证对于所有 1 <= i <= N 有 X_i - X_{i-1} <= C，且 D - X_N <= C。',
    '## 点数分布\n- impossible case: gap > C',
    'X[i] = X[i-1] + C + random.randint(1, 100)',
    ''
  ),
  /violates problem reachability guarantees/
);
const riskyProblem = [
  '# 树上补给查询',
  '## 题意',
  '给定一棵 n 个点的树，每个点有油价和补给容量。q 次操作，每次修改点权或询问 u 到 v 路径上汽车容量 C 下的最小费用。',
  '## 数据范围与提示',
  'n,q <= 200000。'
].join('\n');
assert.equal(__testHooks.assessAlgorithmReliability(riskyProblem, '## 算法选择\n使用树链剖分、DFN 序和线段树优化路径贪心。').level, 'high');
assert.throws(
  () => __testHooks.assertAlgorithmReliabilityContract(
    riskyProblem,
    '# 算法草案\n## 题目重述\n树上路径查询。\n## 约束提取\nn,q<=2e5。\n## 算法选择\n使用树链剖分、DFN 序和线段树优化路径贪心。\n## 正确性要点\n显然正确。\n## 复杂度目标\nO(log^2 n)。\n## 高风险反例\n无。'
  ),
  /algorithm reliability contract incomplete/
);
assert.doesNotThrow(
  () => __testHooks.assertAlgorithmReliabilityContract(
    riskyProblem,
    [
      '# 算法草案',
      '## 题目重述',
      '维护树上 u 到 v 的容量补给最小费用查询。',
      '## 约束提取',
      'n,q<=2e5，容量 C 离散到 K<=30 个关键余量。',
      '## 算法选择',
      '每个线段树片段维护状态 trans[a]=从片段左端进入且剩余油量为 a 时，到右端的最小费用和离开余量；状态只依赖片段内部点。两个相邻片段的合并规则为 compose(A,B)[a]=B[A[a].remain].cost+A[a].cost，merge/combine 是函数复合，因此满足结合律，可用于树链剖分拆出的有序片段。反向路径维护另一套 reversed trans。',
      '## 正确性要点',
      '不变量：每个片段信息精确表示经过该片段的最优转移；叶子按单点补给枚举得到，父节点由左右片段转移复合得到。函数复合保持最优子结构，因此任意路径按顺序合并后得到全路径答案。DFN 只用于拆分重链区间，不假设跨链路径在 DFS 序上连续。',
      '## 复杂度目标',
      '每个片段合并 O(K)，修改 O(K log n)，查询 O(K log^2 n)，空间 O(Kn)。',
      '## 高风险反例',
      '覆盖跨轻边路径、反向路径、容量为 0、某段不可达、相同油价导致多种最优。'
    ].join('\n')
  )
);

const workspace = await createWorkspace();
assert.ok(workspace.workspaceId);
assert.ok(workspace.accessToken);

await writeWorkspaceFile(workspace.workspaceId, 'input/problem_raw.md', 'hello world');
const content = await readWorkspaceFile(workspace.workspaceId, 'input/problem_raw.md');
assert.equal(content, 'hello world');

const files = await listWorkspaceFiles(workspace.workspaceId);
assert.deepEqual(files, ['input/problem_raw.md', 'meta.json']);

const meta = await getWorkspaceMeta(workspace.workspaceId);
assert.equal(meta.workspaceId, workspace.workspaceId);

const zipPath = await downloadWorkspaceZip(workspace.workspaceId);
const stat = await fs.stat(zipPath);
assert.ok(stat.size > 0);

await writeWorkspaceFile(workspace.workspaceId, 'input/problem_raw.md', '原题面');
const problem = await generateProblem(workspace.workspaceId, { sourceText: '原题面', difficultyMode: 'same' });
assert.match(problem.content, /改编题目|题意/);
const problemCached = await generateProblem(workspace.workspaceId, { sourceText: '原题面', difficultyMode: 'same' });
assert.equal(problemCached.cached, true);

const solution = await generateSolution(workspace.workspaceId);
assert.ok(solution.algorithm.length > 0);
assert.ok(solution.markdown.length > 0);
assert.ok(solution.cpp.length > 0);
assert.ok(solution.verification.length > 0);
assert.match(solution.markdown, /## 思路/);
assert.match(solution.markdown, /## 正确性/);
assert.match(solution.markdown, /## 复杂度/);
assert.match(solution.algorithm, /## 约束提取/);
assert.match(solution.verification, /# 标程验证报告/);
assert.match(solution.verification, /independent-oracle/);
const solutionCached = await generateSolution(workspace.workspaceId);
assert.equal(solutionCached.cached, true);
const stdOnly = await regenerateStdSolution(workspace.workspaceId);
assert.ok(stdOnly.cpp.length > 0);
assert.match(stdOnly.verification, /std-only/);

const plan = await generateDataPlan(workspace.workspaceId);
assert.ok(plan.plan.length > 0);
assert.ok(plan.genPy.length > 0);
assert.ok(plan.validatorPy.length > 0);
assert.equal(plan.problemType.requiresChecker, false);
assert.match(plan.plan, /## 点数分布/);
assert.match(plan.genPy, /import/);
assert.match(plan.validatorPy, /sys\.stdin/);
const planCached = await generateDataPlan(workspace.workspaceId);
assert.equal(planCached.cached, true);

const run = await runDataGenerator(workspace.workspaceId);
assert.equal(run.artifact, 'data/datas.zip');
assert.equal(run.coverage.validator.allPassed, true);
assert.ok(run.coverage.caseCount > 0);
assert.match(run.stressReport, /# 数据压力测试报告/);
const runCached = await runDataGenerator(workspace.workspaceId);
assert.equal(runCached.cached, true);
const zipContent = await readWorkspaceFile(workspace.workspaceId, 'data/datas.zip');
assert.ok(zipContent.length > 0);
assert.ok(JSON.parse(await readWorkspaceFile(workspace.workspaceId, 'data/coverage.json')).caseCount > 0);
assert.match(await readWorkspaceFile(workspace.workspaceId, 'data/stress_report.md'), /Validator: PASS/);
assert.ok(await readWorkspaceFile(workspace.workspaceId, 'logs/problem.log'));
assert.ok(await readWorkspaceFile(workspace.workspaceId, 'logs/solution.log'));
assert.ok(await readWorkspaceFile(workspace.workspaceId, 'logs/data.log'));

let lockHit = false;
await Promise.all([
  withWorkspaceLock(workspace.workspaceId, 'custom', async () => {
    await new Promise(r => setTimeout(r, 100));
  }),
  withWorkspaceLock(workspace.workspaceId, 'custom', async () => {
    lockHit = true;
  }).catch(err => {
    assert.equal(err.statusCode, 409);
  })
]);
assert.equal(lockHit, false);

console.log('verification passed');
console.log(app ? 'app exported' : 'app missing');
console.log(path.basename(zipPath));
