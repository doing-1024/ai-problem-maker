import fs from 'fs/promises';
import assert from 'assert/strict';

const DEFAULT_BASE_URL = 'https://doing1024001-ai-problem-maker.hf.space';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

const P1016 = `# P1016 [NOIP 1999 普及组/提高组] 旅行家的预算

## 题目描述

一个旅行家想驾驶汽车以最小的费用从一个城市到另一个城市（假设出发时油箱是空的）。给定两个城市之间的距离 $S$、汽车油箱的容量 $C$（单位为升）、每升汽油能行驶的距离 $L$、出发点每升汽油价格 $P_0$ 和沿途油站数 $N$，油站 $i$ 离出发点的距离 $D_i$、油站 $i$ 每升汽油价格 $P_i$（$i=1,2,\\dots,N$），你需要求出最小的费用。

## 输入格式

第一行，四个实数 $S,C,L,P_0$ 和一个整数 $N$，含义见题目描述。

接下来 $N$ 行，第 $i+1$ 行两个实数 $D_i,P_i$，含义见题目描述。

## 输出格式

仅一行一个实数，代表最小的费用（四舍五入至小数点后两位）。

如果无法到达目的地，输出 \`No Solution\`。

## 输入输出样例 #1

### 输入 #1

\`\`\`
275.6 11.9 27.4 2.8 2
102.0 2.9
220.0 2.2

\`\`\`

### 输出 #1

\`\`\`
26.95

\`\`\`

## 说明/提示

保证 $0 \\leq N \\leq 6$，$0 \\leq S,C,L \\leq 500$，且对于任意 $0\\leq i \\leq N$，均有 $0 \\leq P_i \\leq 500$，$0 \\leq D_i \\leq S$。输入的浮点数，小数点后最多保留两位小数。

NOIP 1999 普及组第三题、提高组第三题。`;

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args.baseUrl || process.env.APM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
const timeoutMs = Number(args.timeoutMs || process.env.APM_E2E_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
const requestTimeoutMs = Number(args.requestTimeoutMs || process.env.APM_E2E_REQUEST_TIMEOUT_MS || 240000);
const rateLimitRetries = Number(args.rateLimitRetries || process.env.APM_E2E_RATE_LIMIT_RETRIES || 2);
const dumpDir = args.dumpDir ? String(args.dumpDir) : '';
const difficultyMode = String(args.difficultyMode || 'custom');
const difficultyText = String(args.difficultyText || 'CSP-S T4');
const sourceText = args.problemFile ? await fs.readFile(String(args.problemFile), 'utf8') : P1016;

let workspace = null;
let failed = false;

try {
  await step('health', async () => {
    const health = await api('/api/health');
    assert.equal(health.ok, true);
  });

  workspace = await step('create workspace', async () => api('/api/workspaces', { method: 'POST' }));
  console.log(`workspace=${workspace.workspaceId}`);
  console.log(`accessToken=${workspace.accessToken}`);

  const problem = await runJob('generate problem', 'problem', `/api/workspaces/${workspace.workspaceId}/problem?async=1`, [
    'problem/problem.md'
  ], {
    method: 'POST',
    token: workspace.accessToken,
    timeoutMs: requestTimeoutMs,
    body: {
      difficultyMode,
      difficultyText
    }
  });
  assert.ok(problem.content?.includes('## 题意'));
  assert.ok(problem.content?.includes('## 输入格式'));

  const solution = await runJob('generate solution/std.cpp', 'solution', `/api/workspaces/${workspace.workspaceId}/solution?async=1`, [
    'solution/algorithm.md',
    'solution/std.cpp',
    'solution/solution.md',
    'solution/verification.md'
  ], {
    method: 'POST',
    token: workspace.accessToken,
    timeoutMs: requestTimeoutMs
  });
  assert.ok(solution.algorithm?.length > 0);
  assert.ok(solution.cpp?.includes('main'));
  assert.ok(solution.verification?.includes('# 标程验证报告'));

  const dataPlan = await runJob('generate data plan/validator', 'data', `/api/workspaces/${workspace.workspaceId}/data/plan?async=1`, [
    'data/hack_plan.md',
    'data/gen.py',
    'data/validator.py',
    'data/problem_type.json'
  ], {
    method: 'POST',
    token: workspace.accessToken,
    timeoutMs: requestTimeoutMs
  });
  assert.ok(dataPlan.plan?.includes('## 点数分布'));
  assert.ok(dataPlan.genPy?.includes('import'));
  assert.ok(dataPlan.validatorPy?.includes('sys.stdin'));

  const run = await runJob('run data generator', 'data', `/api/workspaces/${workspace.workspaceId}/data/run?async=1`, [
    'data/datas.zip',
    'data/coverage.json',
    'data/stress_report.md'
  ], {
    method: 'POST',
    token: workspace.accessToken,
    timeoutMs: requestTimeoutMs
  });
  assert.equal(run.artifact, 'data/datas.zip');
  assert.equal(run.coverage?.validator?.allPassed, true);
  assert.ok(run.stressReport?.includes('# 数据压力测试报告'));

  const files = await step('list files', async () => api(`/api/workspaces/${workspace.workspaceId}/files`, {
    token: workspace.accessToken
  }));
  for (const required of [
    'problem/problem.md',
    'solution/algorithm.md',
    'solution/std.cpp',
    'solution/solution.md',
    'solution/verification.md',
    'data/hack_plan.md',
    'data/gen.py',
    'data/validator.py',
    'data/problem_type.json',
    'data/coverage.json',
    'data/stress_report.md',
    'data/datas.zip'
  ]) {
    assert.ok(files.files.includes(required), `missing ${required}`);
  }

  if (dumpDir) {
    await step('dump artifacts', async () => dumpArtifacts(files.files));
  }

  console.log('E2E PASS');
} catch (error) {
  failed = true;
  console.error(`E2E FAIL: ${error.message}`);
  if (workspace?.workspaceId && workspace?.accessToken) {
    await dumpDiagnostics(workspace).catch(diagError => {
      console.error(`diagnostics failed: ${diagError.message}`);
    });
  }
} finally {
  if (workspace?.workspaceId) {
    console.log(`workspace_url=${baseUrl}/?workspace=${workspace.workspaceId}`);
    if (workspace.accessToken) {
      console.log(`download_cmd=curl -L -H 'x-workspace-token: ${workspace.accessToken}' '${baseUrl}/api/workspaces/${workspace.workspaceId}/download' -o ${workspace.workspaceId}.zip`);
    }
  }
  process.exit(failed ? 1 : 0);
}

async function step(name, fn) {
  const start = Date.now();
  console.log(`-- ${name}`);
  try {
    const result = await fn();
    console.log(`ok ${name} ${Date.now() - start}ms`);
    return result;
  } catch (error) {
    console.error(`fail ${name} ${Date.now() - start}ms: ${error.message}`);
    throw error;
  }
}

async function runJob(name, stage, path, requiredFiles, options) {
  return step(name, async () => {
    const startRetries = Math.max(rateLimitRetries, 2);
    for (let attempt = 0; attempt <= startRetries; attempt += 1) {
      try {
        let directResult = null;
        let interrupted = false;
        try {
          directResult = await api(path, options);
        } catch (error) {
          if (!isLikelyLongRequestDisconnect(error)) throw error;
          interrupted = true;
          console.warn(`request interrupted for ${name}; confirming whether the job started`);
        }

        if (interrupted) {
          const startState = await waitForStageStart(stage, requiredFiles, 30000);
          if (startState.ready) return readJobResult(requiredFiles);
          if (!startState.started) {
            if (attempt >= startRetries) {
              throw new Error(`${name} request disconnected before the server accepted the async job`);
            }
            console.warn(`${name} still idle after disconnect; retrying async start ${attempt + 1}/${startRetries}`);
            continue;
          }
        }

        const pollResult = await waitForStage(stage, requiredFiles, timeoutMs);
        if (directResult && !directResult.accepted && requiredFiles.every(file => pollResult.files.includes(file))) {
          return directResult;
        }
        return readJobResult(requiredFiles);
      } catch (error) {
        const waitMs = rateLimitWaitMs(error);
        if (!waitMs || attempt >= rateLimitRetries) throw error;
        console.warn(`rate limited during ${name}; retry ${attempt + 1}/${rateLimitRetries} after ${Math.ceil(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
    }
    throw new Error(`${name} retry loop exited unexpectedly`);
  });
}

async function waitForStageStart(stage, requiredFiles, totalTimeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < totalTimeoutMs) {
    const snapshot = await getStageSnapshot(stage);
    if (requiredFiles.every(file => snapshot.files.includes(file))) {
      return { ...snapshot, ready: true, started: true };
    }
    if (snapshot.state === 'running' || snapshot.state === 'done' || snapshot.state === 'error') {
      return { ...snapshot, ready: false, started: true };
    }
    await sleep(3000);
  }
  const snapshot = await getStageSnapshot(stage);
  return {
    ...snapshot,
    ready: requiredFiles.every(file => snapshot.files.includes(file)),
    started: snapshot.state === 'running' || snapshot.state === 'done' || snapshot.state === 'error'
  };
}

async function waitForStage(stage, requiredFiles, totalTimeoutMs) {
  const started = Date.now();
  while (Date.now() - started < totalTimeoutMs) {
    const snapshot = await getStageSnapshot(stage);
    if (requiredFiles.every(file => snapshot.files.includes(file))) {
      return { meta: snapshot.meta, files: snapshot.files };
    }
    if (snapshot.state === 'error') {
      throw new Error(snapshot.message || `${stage} failed`);
    }
    await sleep(5000);
  }
  throw new Error(`${stage} did not finish within ${totalTimeoutMs}ms`);
}

async function getStageSnapshot(stage) {
  const [meta, files] = await Promise.all([
    api(`/api/workspaces/${workspace.workspaceId}`, { token: workspace.accessToken }),
    api(`/api/workspaces/${workspace.workspaceId}/files`, { token: workspace.accessToken })
  ]);
  return {
    meta,
    files: files.files || [],
    state: meta.status?.[stage]?.state || 'idle',
    message: meta.status?.[stage]?.message || ''
  };
}

async function readJobResult(requiredFiles) {
  if (requiredFiles.includes('problem/problem.md')) {
    return { content: await readTextFile('problem/problem.md'), path: 'problem/problem.md', polled: true };
  }
  if (requiredFiles.includes('solution/std.cpp')) {
    return {
      algorithm: await readTextFile('solution/algorithm.md'),
      cpp: await readTextFile('solution/std.cpp'),
      markdown: await readTextFile('solution/solution.md'),
      verification: await readTextFile('solution/verification.md'),
      polled: true
    };
  }
  if (requiredFiles.includes('data/gen.py')) {
    return {
      plan: await readTextFile('data/hack_plan.md'),
      genPy: await readTextFile('data/gen.py'),
      validatorPy: await readTextFile('data/validator.py'),
      problemType: JSON.parse(await readTextFile('data/problem_type.json')),
      polled: true
    };
  }
  if (requiredFiles.includes('data/datas.zip')) {
    return {
      artifact: 'data/datas.zip',
      coverage: JSON.parse(await readTextFile('data/coverage.json')),
      stressReport: await readTextFile('data/stress_report.md'),
      polled: true
    };
  }
  return { polled: true };
}

async function readTextFile(file) {
  const res = await fetch(`${baseUrl}/api/workspaces/${workspace.workspaceId}/files/${file}`, {
    headers: { 'x-workspace-token': workspace.accessToken }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`read ${file} failed: ${text}`);
  return text;
}

async function dumpArtifacts(files) {
  await fs.mkdir(dumpDir, { recursive: true });
  await fs.writeFile(`${dumpDir}/workspace.json`, JSON.stringify({
    baseUrl,
    workspaceId: workspace.workspaceId,
    accessToken: workspace.accessToken,
    files
  }, null, 2));
  for (const file of files) {
    if (file.endsWith('.zip')) continue;
    const target = `${dumpDir}/${file.replaceAll('/', '__')}`;
    await fs.writeFile(target, await readTextFile(file), 'utf8');
  }
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 120000);
  try {
    const headers = { ...(options.headers || {}) };
    let body;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.token) headers['x-workspace-token'] = options.token;
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body,
      signal: controller.signal
    });
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      const error = new Error(data.error || data.raw || `HTTP ${res.status}`);
      error.statusCode = res.status;
      error.body = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function isLikelyLongRequestDisconnect(error) {
  const message = String(error?.message || '').toLowerCase();
  const raw = String(error?.body?.raw || '').toLowerCase();
  return message.includes('fetch failed')
    || message.includes('aborted')
    || message.includes('terminated')
    || message.includes('eof')
    || (error?.statusCode >= 500 && (message.includes('<!doctype html') || raw.includes('<!doctype html') || raw.includes('hugging face')));
}

function rateLimitWaitMs(error) {
  const message = String(error?.message || '');
  if (!/限流|429|too many requests/i.test(message)) return 0;
  const match = message.match(/预计\s*(\d+)\s*秒后可重试/);
  const seconds = match ? Number(match[1]) : 300;
  return Math.max(30_000, (Number.isFinite(seconds) ? seconds : 300) * 1000 + 5000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function dumpDiagnostics(ws) {
  console.error('--- diagnostics ---');
  const meta = await api(`/api/workspaces/${ws.workspaceId}`, { token: ws.accessToken });
  console.error(JSON.stringify(meta.status || {}, null, 2));
  const files = await api(`/api/workspaces/${ws.workspaceId}/files`, { token: ws.accessToken });
  console.error(JSON.stringify(files.files || [], null, 2));
  const logs = await api(`/api/workspaces/${ws.workspaceId}/logs`, { token: ws.accessToken });
  for (const [name, content] of Object.entries(logs.logs || {})) {
    console.error(`--- ${name} tail ---`);
    console.error(String(content || '').slice(-5000));
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}
