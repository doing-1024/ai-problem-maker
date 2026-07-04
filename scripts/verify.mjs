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
  __testHooks.sanitizeCppCode('#include <bits/stdc++.h>\nstruct Edge{};\nint main(){return 1;}\n#include <bits/stdc++.h>\nstruct Edge{};\nint main(){return 0;}'),
  '#include <bits/stdc++.h>\nstruct Edge{};\nint main(){return 0;}'
);
assert.equal(__testHooks.reviewPassed('PASS\nok'), true);
assert.equal(__testHooks.reviewPassed('CODE_REVIEW\nPASS\nok'), true);
assert.equal(__testHooks.reviewPassed('CODE_REVIEW\nFAIL\nbad'), false);

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
