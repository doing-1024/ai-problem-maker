import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import zlib from 'zlib';
import { spawn } from 'child_process';
import { callLLM } from './ai.js';
import { withWorkspaceLock } from './job-lock.js';
import { emitWorkspaceEvent } from './events.js';
import { appendWorkspaceLog, getWorkspaceMetaInternal, updateWorkspaceMeta, writeWorkspaceFile, readWorkspaceFile } from './workspace.js';

function stamp() {
  return new Date().toISOString();
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function setState(workspaceId, stage, state, message) {
  await updateWorkspaceMeta(workspaceId, {
    currentStep: stage,
    status: {
      [stage]: {
        state,
        message,
        updatedAt: stamp()
      }
    }
  });
}

async function saveJobResult(workspaceId, stage, fingerprint, extra = {}) {
  await updateWorkspaceMeta(workspaceId, {
    jobs: {
      [stage]: {
        fingerprint,
        updatedAt: stamp(),
        ...extra
      }
    }
  });
}

export async function generateProblem(workspaceId, payload) {
  return withWorkspaceLock(workspaceId, 'problem', async () => {
    try {
      const source = payload.sourceText || (await safeRead(workspaceId, 'input/problem_raw.md'));
      assertValidText(source, '题面为空或过短');
      const fingerprint = hashText(
        JSON.stringify({
          source,
          difficultyMode: payload.difficultyMode || 'same',
          difficultyText: payload.difficultyText || ''
        })
      );
      const meta = await getWorkspaceMetaInternal(workspaceId);
      if (meta?.jobs?.problem?.fingerprint === fingerprint && await exists(workspaceId, 'problem/problem.md')) {
        return { path: 'problem/problem.md', content: await readWorkspaceFile(workspaceId, 'problem/problem.md'), cached: true };
      }

      await setState(workspaceId, 'problem', 'running', '正在改编题目');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'problem', state: 'running', message: '正在改编题目' });
      await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] start problem generation\n`);
      const difficultyMode = payload.difficultyMode || 'same';
      const difficultyInstruction = buildDifficultyInstruction(difficultyMode, payload.difficultyText || '');
      const adaptationInstruction = buildAdaptationInstruction(difficultyMode);
      const prompt = [
        {
          role: 'system',
          content:
            '你是资深 OI 题目设计师。你要根据用户给出的原题素材重新设计一道 OI 题。用户难度要求优先级最高。自定义难度时可以大幅改编：允许只保留背景、对象、故事或少量概念，算法、数据范围、约束、目标函数都可以完全不同；如果用户要求提高难度，可以主动加入更高级算法与更强数据范围。参考原题时应尽量保持算法难度和复杂度量级接近，但必须大幅更换题目背景、叙事、角色、对象、题名和变量语义，让选手难以通过题面关键词直接搜到原题。输出必须是完整 Markdown 题面，结构固定为：# 标题、## 题意、## 输入格式、## 输出格式、## 样例、## 数据范围与提示。不得省略任何一节。标记为 PROBLEM_REWRITE。'
        },
        {
          role: 'user',
          content: [
            'PROBLEM_REWRITE',
            `难度模式: ${difficultyMode}`,
            `难度说明: ${payload.difficultyText || ''}`,
            `用户难度要求: ${difficultyInstruction}`,
            `改编策略: ${adaptationInstruction}`,
            'SOURCE_TEXT:',
            source || ''
          ].join('\n')
        }
      ];
      let content = await callLLM(prompt, {
        temperature: 0.3,
        maxTokens: 8192,
        retries: 5,
        onComplete: async info => {
          await logLLMComplete(workspaceId, 'problem.log', 'problem draft', info);
        },
        onRetry: async ({ attempt, retries, error }) => {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'problem',
            state: 'running',
            message: `题目生成重试 ${attempt + 1}/${retries}`
          });
          await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] retry ${attempt + 1}/${retries}: ${error.message}\n`);
        }
      });
      emitProblemPreview(workspaceId, content);
      if (!looksLikeProblemMarkdown(content)) {
        emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'problem', state: 'running', message: '正在修正题面格式' });
        const repairPrompt = [
          {
            role: 'system',
            content:
              '你是 Markdown 题面修复助手。优先修正文结构和补齐缺失段落；如果原输出明显只是轻微改名、没有满足用户难度要求，可以顺手重写题目核心。必须输出完整题面，且补齐 # 标题、## 题意、## 输入格式、## 输出格式、## 样例、## 数据范围与提示。'
          },
          { role: 'user', content: ['SOURCE_TEXT:', content || ''].join('\n') }
        ];
        content = await callLLM(repairPrompt, {
          temperature: 0.1,
          timeoutMs: 45000,
          maxTokens: 8192,
          retries: 5,
          onComplete: async info => {
            await logLLMComplete(workspaceId, 'problem.log', 'problem repair', info);
          },
          onRetry: async ({ attempt, retries, error }) => {
            emitWorkspaceEvent(workspaceId, 'task:update', {
              stage: 'problem',
              state: 'running',
              message: `题面修复重试 ${attempt + 1}/${retries}`
            });
            await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] repair retry ${attempt + 1}/${retries}: ${error.message}\n`);
          }
        });
        emitProblemPreview(workspaceId, content);
      }
      content = await completeProblemMarkdown(workspaceId, content, source, difficultyInstruction);
      ensureProblemMarkdownStructure(content);
      await writeWorkspaceFile(workspaceId, 'problem/problem.md', content);
      await saveJobResult(workspaceId, 'problem', fingerprint, { resultPath: 'problem/problem.md' });
      await setState(workspaceId, 'problem', 'done', '题目已生成');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'problem', state: 'done', message: '题目已生成' });
      await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] done\n`);
      return { path: 'problem/problem.md', content, cached: false };
    } catch (error) {
      await setState(workspaceId, 'problem', 'error', error.message || 'problem failed');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'problem', state: 'error', message: error.message || 'problem failed' });
      await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] failed: ${error.message}\n`);
      throw error;
    }
  });
}

async function completeProblemMarkdown(workspaceId, initialContent, source, difficultyInstruction) {
  let content = initialContent || '';
  for (let round = 1; round <= 3; round += 1) {
    const missing = getProblemMarkdownIssues(content);
    if (!missing.length) return content;
    emitWorkspaceEvent(workspaceId, 'task:update', {
      stage: 'problem',
      state: 'running',
      message: `正在补全被截断的题面 ${round}/3`
    });
    await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] completion round ${round}: ${missing.join(', ')}\n`);
    content = await callLLM(
      [
        {
          role: 'system',
          content:
            '你是题面重写与补全助手。请直接输出一份完整 Markdown 题面，不要解释，不要续写半截内容。用户难度要求优先级最高；如果上一版过于保守，可以重新设计算法、数据范围和题目目标。必须包含且只需包含：# 标题、## 题意、## 输入格式、## 输出格式、## 样例、## 数据范围与提示。样例必须有输入和输出。'
        },
        {
          role: 'user',
          content: [
            `用户难度要求: ${difficultyInstruction}`,
            `改编策略: ${buildAdaptationInstruction('custom')}`,
            `当前问题: ${missing.join('；')}`,
            '原始题面:',
            source || '',
            '上一版输出:',
            content || ''
          ].join('\n')
        }
      ],
      {
        temperature: 0.1,
        timeoutMs: 90000,
        maxTokens: 8192,
        retries: 5,
        onComplete: async info => {
          await logLLMComplete(workspaceId, 'problem.log', `problem completion ${round}`, info);
        },
        onRetry: async ({ attempt, retries, error }) => {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'problem',
            state: 'running',
            message: `题面补全重试 ${attempt + 1}/${retries}`
          });
          await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] completion retry ${attempt + 1}/${retries}: ${error.message}\n`);
        }
      }
    );
    emitProblemPreview(workspaceId, content);
  }
  return content;
}

function emitProblemPreview(workspaceId, content) {
  emitWorkspaceEvent(workspaceId, 'task:partial', {
    stage: 'problem',
    text: String(content || '').slice(0, 2000)
  });
}

async function logLLMComplete(workspaceId, logName, label, info) {
  const usage = info?.usage ? ` usage=${JSON.stringify(info.usage)}` : '';
  await appendWorkspaceLog(
    workspaceId,
    logName,
    `[${stamp()}] ${label} finish_reason=${info?.finishReason || 'unknown'} length=${info?.contentLength || 0}${usage}\n`
  );
}

export async function generateSolution(workspaceId) {
  return withWorkspaceLock(workspaceId, 'solution', async () => {
    try {
      const problem = await safeRead(workspaceId, 'problem/problem.md');
      assertValidText(problem, '题目未生成，无法生成题解');
      const fingerprint = hashText(problem);
      const meta = await getWorkspaceMetaInternal(workspaceId);
      if (
        meta?.jobs?.solution?.fingerprint === fingerprint &&
        (await exists(workspaceId, 'solution/solution.md')) &&
        (await exists(workspaceId, 'solution/std.cpp'))
      ) {
        return {
          markdown: await readWorkspaceFile(workspaceId, 'solution/solution.md'),
          cpp: await readWorkspaceFile(workspaceId, 'solution/std.cpp'),
          cached: true
        };
      }

      await setState(workspaceId, 'solution', 'running', '正在生成题解');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'running', message: '正在生成题解' });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] start solution generation\n`);
      const draftPrompt = [
        { role: 'system', content: '你是资深 OI 题解助手。先输出初稿。标记为 SOLUTION_DRAFT。' },
        { role: 'user', content: ['SOLUTION_DRAFT', 'SOURCE_TEXT:', problem || ''].join('\n') }
      ];
      const draft = await callLLM(draftPrompt, {
        temperature: 0.2,
        retries: 5,
        onRetry: async ({ attempt, retries, error }) => {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'solution',
            state: 'running',
            message: `题解初稿重试 ${attempt + 1}/${retries}`
          });
          await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] draft retry ${attempt + 1}/${retries}: ${error.message}\n`);
        }
      });
      emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'draft', text: draft.slice(0, 320) });

      const critiquePrompt = [
        { role: 'system', content: '你是严厉的 OI 题解审校员，只找错误，不写空话。标记为 SOLUTION_CRITIC。' },
        { role: 'user', content: ['SOLUTION_CRITIC', 'SOURCE_TEXT:', problem || '', 'DRAFT:', draft || ''].join('\n') }
      ];
      const critique = await callLLM(critiquePrompt, {
        temperature: 0.1,
        retries: 5,
        onRetry: async ({ attempt, retries, error }) => {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'solution',
            state: 'running',
            message: `题解审校重试 ${attempt + 1}/${retries}`
          });
          await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] critic retry ${attempt + 1}/${retries}: ${error.message}\n`);
        }
      });
      emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'critic', text: critique.slice(0, 320) });

      const revisePrompt = [
        { role: 'system', content: '你是 OI 题解修订员，根据审校意见修订并输出最终 Markdown 和 cpp。标记为 SOLUTION_FINAL。' },
        {
          role: 'user',
          content: ['SOLUTION_FINAL', 'SOURCE_TEXT:', problem || '', 'DRAFT:', draft || '', 'CRITIQUE:', critique || ''].join('\n')
        }
      ];
      const finalText = await callLLM(revisePrompt, {
        temperature: 0.2,
        retries: 5,
        onRetry: async ({ attempt, retries, error }) => {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'solution',
            state: 'running',
            message: `题解修订重试 ${attempt + 1}/${retries}`
          });
          await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] final retry ${attempt + 1}/${retries}: ${error.message}\n`);
        }
      });
      emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'final', text: finalText.slice(0, 320) });
      const cpp = extractCodeBlock(finalText, 'cpp') || '#include <bits/stdc++.h>\nint main(){return 0;}\n';
      const markdown = stripCppBlock(finalText);
      ensureMarkdownStructure(markdown, ['title', '## 思路', '## 正确性', '## 复杂度']);
      assertSolutionTextLooksReasonable(markdown, cpp);
      await verifyCppCompiles(workspaceId, cpp);
      await writeWorkspaceFile(workspaceId, 'solution/solution.md', markdown);
      await writeWorkspaceFile(workspaceId, 'solution/std.cpp', cpp);
      await saveJobResult(workspaceId, 'solution', fingerprint, {
        resultPaths: ['solution/solution.md', 'solution/std.cpp']
      });
      await setState(workspaceId, 'solution', 'done', '题解与标程已生成');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'done', message: '题解与标程已生成' });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] done\n`);
      return { markdown, cpp, cached: false, critique };
    } catch (error) {
      await setState(workspaceId, 'solution', 'error', error.message || 'solution failed');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'error', message: error.message || 'solution failed' });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] failed: ${error.message}\n`);
      throw error;
    }
  });
}

export async function generateDataPlan(workspaceId) {
  return withWorkspaceLock(workspaceId, 'data', async () => {
    try {
      const solution = await safeRead(workspaceId, 'solution/solution.md');
      assertValidText(solution, '题解未生成，无法生成数据');
      const fingerprint = hashText(solution);
      const meta = await getWorkspaceMetaInternal(workspaceId);
      if (
        meta?.jobs?.data?.fingerprint === fingerprint &&
        (await exists(workspaceId, 'data/hack_plan.md')) &&
        (await exists(workspaceId, 'data/gen.py'))
      ) {
        return {
          plan: await readWorkspaceFile(workspaceId, 'data/hack_plan.md'),
          genPy: await readWorkspaceFile(workspaceId, 'data/gen.py'),
          cached: true
        };
      }

      await setState(workspaceId, 'data', 'running', '正在生成数据方案');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'running', message: '正在生成数据方案' });
      await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] start data planning\n`);
      const planPrompt = [
        { role: 'system', content: '你是资深 OI 数据构造助手。标记为 DATA_PLAN。' },
        { role: 'user', content: ['DATA_PLAN', 'SOURCE_TEXT:', solution || ''].join('\n') }
      ];
      const plan = await callLLM(planPrompt, {
        temperature: 0.2,
        retries: 5,
        onRetry: async ({ attempt, retries, error }) => {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'data',
            state: 'running',
            message: `数据方案重试 ${attempt + 1}/${retries}`
          });
          await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] plan retry ${attempt + 1}/${retries}: ${error.message}\n`);
        }
      });
      emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'data', phase: 'plan', text: plan.slice(0, 320) });
      ensureMarkdownStructure(plan, ['title', '## 点数分布']);
      await writeWorkspaceFile(workspaceId, 'data/hack_plan.md', plan);

      const genPrompt = [
        { role: 'system', content: '你要根据数据方案写 Python 数据生成器。标记为 GEN_PY。' },
        { role: 'user', content: ['GEN_PY', 'SOURCE_TEXT:', plan || ''].join('\n') }
      ];
      const genPy = await callLLM(genPrompt, {
        temperature: 0.2,
        retries: 5,
        onRetry: async ({ attempt, retries, error }) => {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'data',
            state: 'running',
            message: `生成器重试 ${attempt + 1}/${retries}`
          });
          await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] gen retry ${attempt + 1}/${retries}: ${error.message}\n`);
        }
      });
      emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'data', phase: 'gen', text: genPy.slice(0, 320) });
      ensurePythonGeneratorShape(genPy);
      assertDataPlanLooksReasonable(plan, genPy);
      await writeWorkspaceFile(workspaceId, 'data/gen.py', genPy);
      await saveJobResult(workspaceId, 'data', fingerprint, {
        resultPaths: ['data/hack_plan.md', 'data/gen.py']
      });
      await setState(workspaceId, 'data', 'done', '数据方案与生成器已生成');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'done', message: '数据方案与生成器已生成' });
      await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] done\n`);
      return { plan, genPy, cached: false };
    } catch (error) {
      await setState(workspaceId, 'data', 'error', error.message || 'data planning failed');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'error', message: error.message || 'data planning failed' });
      await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] failed: ${error.message}\n`);
      throw error;
    }
  });
}

export async function runDataGenerator(workspaceId) {
  return withWorkspaceLock(workspaceId, 'run', async () => {
    const genPy = await safeRead(workspaceId, 'data/gen.py');
    if (!genPy.trim()) {
      const error = new Error('gen.py not found');
      error.statusCode = 400;
      throw error;
    }
    const fingerprint = hashText(genPy);
    const meta = await getWorkspaceMetaInternal(workspaceId);
    if (meta?.jobs?.run?.fingerprint === fingerprint && (await exists(workspaceId, 'data/datas.zip'))) {
      return { artifact: 'data/datas.zip', cached: true };
    }

    await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] start generator run\n`);
    emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'running', message: '正在运行数据生成器' });
    try {
      const result = await executePythonGenerator(workspaceId, genPy);
      emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'data', phase: 'run', text: (result.stdout || result.stderr || '').slice(0, 320) });
      assertDataZipLooksValid(result.zipContent);
      await verifyZipArchive(result.zipContent);
      await writeWorkspaceFile(workspaceId, 'data/datas.zip', result.zipContent);
      await saveJobResult(workspaceId, 'run', fingerprint, { resultPath: 'data/datas.zip' });
      await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] run finished\n`);
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'done', message: '数据包已生成' });
      return { artifact: 'data/datas.zip', cached: false, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      await setState(workspaceId, 'data', 'error', error.message || 'run failed');
      await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] run failed: ${error.message}\n`);
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'error', message: error.message || 'run failed' });
      throw error;
    }
  });
}

async function executePythonGenerator(workspaceId, genPy) {
  const root = path.resolve(process.cwd(), 'workspaces', workspaceId);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-${workspaceId}-`));
  const scriptPath = path.join(workDir, 'gen.py');
  await fs.writeFile(scriptPath, genPy, 'utf8');

  const runner = `
import os, subprocess, sys, zipfile, pathlib, shutil, textwrap
root = pathlib.Path(r"${root}")
work = pathlib.Path(r"${workDir}")
out_dir = work / "out"
if out_dir.exists():
    shutil.rmtree(out_dir)
out_dir.mkdir(parents=True, exist_ok=True)
proc = subprocess.run([sys.executable, str(work / "gen.py")], cwd=str(work), capture_output=True, text=True, timeout=30)
stdout = proc.stdout
stderr = proc.stderr
zip_path = work / "datas.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    if out_dir.exists():
        for p in out_dir.rglob("*"):
            if p.is_file():
                zf.write(p, p.relative_to(out_dir).as_posix())
print("STDOUT_BEGIN")
print(stdout)
print("STDOUT_END")
print("STDERR_BEGIN")
print(stderr)
print("STDERR_END")
print("ZIP_BEGIN")
print(zip_path.read_bytes().hex())
print("ZIP_END")
`; 

  const result = await runPython(runner, 45000);
  const zipHex = extractBetween(result.stdout, 'ZIP_BEGIN', 'ZIP_END').trim();
  await fs.rm(workDir, { recursive: true, force: true });
  if (!zipHex) {
    const error = new Error(`generator failed: ${result.stderr || 'no zip produced'}`);
    error.statusCode = 500;
    throw error;
  }
  return {
    stdout: extractBetween(result.stdout, 'STDOUT_BEGIN', 'STDOUT_END'),
    stderr: extractBetween(result.stdout, 'STDERR_BEGIN', 'STDERR_END'),
    zipContent: Buffer.from(zipHex, 'hex')
  };
}

function runPython(code, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('python timeout'));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `python exited with ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function safeRead(workspaceId, rel) {
  try {
    return await readWorkspaceFile(workspaceId, rel);
  } catch {
    return '';
  }
}

async function exists(workspaceId, rel) {
  try {
    await readWorkspaceFile(workspaceId, rel);
    return true;
  } catch {
    return false;
  }
}

function extractCodeBlock(text, lang) {
  const regex = new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

function stripCppBlock(text) {
  return text.replace(/```cpp[\s\S]*?```/i, '').trim();
}

function extractBetween(text, start, end) {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s === -1 || e === -1 || e <= s) return '';
  return text.slice(s + start.length, e);
}

function assertValidText(text, message) {
  if (!text || String(text).trim().length < 3) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }
}

function looksLikeProblemMarkdown(text) {
  const content = String(text || '');
  const hasTitle = /^#\s+\S+/m.test(content);
  const hasBody = content.length > 80;
  return hasTitle && hasBody;
}

function problemHasCompleteMarkdown(text) {
  return getProblemMarkdownIssues(text).length === 0;
}

function getProblemMarkdownIssues(text) {
  const content = String(text || '').trim();
  const issues = [];
  if (!content) issues.push('输出为空');
  if (content.length < 180) issues.push('内容过短，疑似截断');
  if (!/^#\s+\S+/m.test(content)) issues.push('缺少一级标题');
  if (!content.includes('## 题意')) issues.push('缺少 ## 题意');
  if (!content.includes('## 输入格式')) issues.push('缺少 ## 输入格式');
  if (!content.includes('## 输出格式')) issues.push('缺少 ## 输出格式');
  if (!content.includes('## 样例')) issues.push('缺少 ## 样例');
  if (!hasSampleInputHeading(content)) issues.push('缺少样例输入');
  if (!hasSampleOutputHeading(content)) issues.push('缺少样例输出');
  if (!content.includes('## 数据范围与提示')) issues.push('缺少 ## 数据范围与提示');
  if (/(\.\.\.|……|未完|待补|待续|省略号)/.test(content)) issues.push('含有省略或待补标记');
  const fenceCount = (content.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) issues.push('代码块未闭合');
  if (/[\u4e00-\u9fa5A-Za-z0-9]$/.test(content) && /[：:`]$/.test(content)) {
    issues.push('末尾疑似截断');
  }
  if (content.endsWith('：') || content.endsWith('`') || /等\s*$/.test(content)) {
    issues.push('末尾疑似截断');
  }
  return Array.from(new Set(issues));
}

function hasSampleInputHeading(content) {
  return /#{2,4}\s*(样例\s*)?(输入|input)(\s*(#|编号)?\s*\d+)?/i.test(content) || /输入样例/i.test(content);
}

function hasSampleOutputHeading(content) {
  return /#{2,4}\s*(样例\s*)?(输出|output)(\s*(#|编号)?\s*\d+)?/i.test(content) || /输出样例/i.test(content);
}

function buildDifficultyInstruction(mode, text) {
  const raw = String(text || '').trim();
  const normalizedMode = String(mode || 'same').trim();
  if (!raw) {
    return normalizedMode === 'custom' ? '用户未填写具体难度，请自由选择合理难度' : '保持与原题接近';
  }
  return raw;
}

function buildAdaptationInstruction(mode) {
  if (String(mode || 'same') === 'same') {
    return '参考原题难度与算法量级，但必须尽可能改换背景、故事、对象、题名、变量语义和表述方式；避免保留原题可搜索的关键词、专有名词、样例背景和原句。不要只改题名。';
  }
  return '按用户输入难度自由设计，可以更换算法、模型、约束和目标函数；不要求与原题解法相同。';
}

function ensureProblemMarkdownStructure(text) {
  ensureMarkdownStructure(text, ['title', '## 题意', '## 输入格式', '## 输出格式', '## 样例', '## 数据范围与提示']);
  if (!problemHasCompleteMarkdown(text)) {
    const error = new Error('markdown missing complete problem structure');
    error.statusCode = 422;
    throw error;
  }
}

async function verifyCppCompiles(workspaceId, cpp) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-std-${workspaceId}-`));
  const sourcePath = path.join(tmpDir, 'std.cpp');
  await fs.writeFile(sourcePath, cpp, 'utf8');
  try {
    await runCommand('g++', ['-std=c++17', '-O2', '-pipe', '-static', sourcePath, '-o', path.join(tmpDir, 'std')], 45000);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function ensurePythonGeneratorShape(genPy) {
  const text = String(genPy || '');
  if (!text.includes('import') || (!text.includes('print') && !text.includes('write'))) {
    const error = new Error('gen.py structure looks invalid');
    error.statusCode = 422;
    throw error;
  }
}

function assertDataZipLooksValid(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    const error = new Error('datas.zip is invalid');
    error.statusCode = 500;
    throw error;
  }
}

function assertSolutionTextLooksReasonable(markdown, cpp) {
  const md = String(markdown || '');
  const code = String(cpp || '');
  if (md.length < 50 || code.length < 20) {
    const error = new Error('solution is too short');
    error.statusCode = 422;
    throw error;
  }
  if (code.includes('TODO') || md.includes('TODO')) {
    const error = new Error('solution contains TODO');
    error.statusCode = 422;
    throw error;
  }
}

function assertDataPlanLooksReasonable(plan, genPy) {
  const p = String(plan || '');
  const g = String(genPy || '');
  if (p.length < 40 || g.length < 20) {
    const error = new Error('data output is too short');
    error.statusCode = 422;
    throw error;
  }
}

function ensureMarkdownStructure(text, requiredHeaders) {
  const content = String(text || '');
  for (const header of requiredHeaders) {
    if (header === 'title') {
      if (!content.trim()) {
        const error = new Error('markdown missing level-1 title');
        error.statusCode = 422;
        throw error;
      }
      continue;
    }
    if (!content.includes(header)) {
      const error = new Error(`markdown missing section: ${header}`);
      error.statusCode = 422;
      throw error;
    }
  }
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timeout`));
    }, timeoutMs);
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `${command} exited with ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function verifyZipArchive(buffer) {
  if (!buffer || buffer.length < 22) {
    const error = new Error('datas.zip is invalid');
    error.statusCode = 500;
    throw error;
  }
  const signature = buffer.readUInt32LE(0);
  if (signature !== 0x04034b50 && signature !== 0x06054b50) {
    const error = new Error('datas.zip has bad signature');
    error.statusCode = 500;
    throw error;
  }
}
