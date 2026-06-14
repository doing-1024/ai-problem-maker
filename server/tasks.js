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

const DIFFICULTY_TAXONOMY = `
难度由以下几个因素共同决定，没有固定的算法→难度映射：
1. 思维链深度：从读题到出解需要几步转化？是直接套模板，还是需要关键观察/构造/转化？
2. 复合程度：单一算法 vs. 多种算法复合 vs. 算法嵌套（如数据结构上跑DP）
3. 建模难度：题目条件是否能直接对应到已知模型，还是需要转化建模？
4. 实现复杂度：边界情况数量、讨论分支数、代码长度
5. 隐蔽条件：是否有容易忽略的限制或特殊情况？

举例：
- n=20 但需要折半搜索/状压DP → 可能是 NOIP T4/省选难度（思维链深）
- n=2e5 树状数组求逆序对 → 可能是 NOIP T1（直接套模板，思维链浅）
- n=5000, O(n²) 区间DP → 可能是 NOIP T2/T3（思维链中等，实现稍复杂）
- n=1e5 线段树求区间和 → 可能是 CSP-J T4（直接应用，思维链浅）

核心原则：难度不取决于数据范围或算法名称，而取决于选手解决问题所需的思维深度和综合能力。
`;

const FEW_SHOT_EXAMPLE = `

【改编示例1 - 同难度改背景】
原题：给定 n 个正整数 a[i]，求所有数的和（入门/模拟）。
改编：【矩阵求和】给定 n 行 m 列的矩阵，求每一行的元素之和，并输出所有行和的最大值行号。
——同是求和/模拟，思维链深度相同，但背景从一维数组改为二维矩阵，关键词全部更换。

【改编示例2 - 提升难度（浅→中，增加思维链深度）】
原题：给定 n 个正整数，求最大值和最小值的差。（CSP-J T1，O(n) 扫描，思维链深度 1）
改编：给定 n 个整数 a[i] 和 q 次询问，每次询问区间 [l,r] 的最大值与最小值的差。
要求选手发现：需要先转化为区间最值查询问题，再选择 ST 表/线段树，复杂度 O(n log n + q)。
——思维链从 1 步（扫描比较）变成 3 步（识别问题模型→选择数据结构→实现查询），难度从 CSP-J 升级到 NOIP。

【改编示例3 - 提升难度（中→高，增加复合度）】
原题：给定 n 个节点 m 条边的无向图，求从 1 到 n 的最短路（Dijkstra，NOIP T2）。
改编：给定 n 个节点 m 条边的无向图，每条边有长度和费用两种权值。在总费用不超过预算 K 的前提下，求从 1 到 n 的最短路径。
要求选手发现：这不能直接用最短路算法，需要拆点/分层图最短路或 DP 套最短路。
——从单一算法升级为分层图最短路（复合思维：最短路 + DP/拆点），思维链深度和复合程度都显著提升。
`;

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
          content: [
            '你是资深 OI 题目设计师。你要根据用户给出的原题素材重新设计一道 OI 题。',
            '',
            `难度分级参考：${DIFFICULTY_TAXONOMY}`,
            '用户指定的目标难度必须严格遵守。关键是保证思维链深度、复合度和实现复杂度与目标匹配，而不是只看数据范围或算法名字。不得擅自降级——要求 NOIP 级别就不能写出思维链深度明显是入门级的题目。',
            '',
            '算法范式改编策略：',
            '- 同难度改编（mode=same）：保持原题基础算法范式一致，只改背景、故事、题名、变量名，让选手无法通过关键词搜到原题。原题是 DP 就仍是 DP，图论就仍是图论。',
            '- 提升难度改编（mode=custom）：可以在同一算法谱系内升级（如简单DP→区间DP→树形DP→DP套DP）。必要时经审慎分析可升级到更高阶算法范式。注意只能升级不能降级——不要把 DP 改成 BFS/贪心/纯模拟，但可以把 BFS/贪心升级为 DP。',
            '',
            '输出必须是完整 Markdown 题面，结构固定为：',
            '# 标题',
            '## 题意',
            '## 输入格式',
            '## 输出格式',
            '## 样例',
            '## 数据范围与提示',
            '不得省略任何一节。标记为 PROBLEM_REWRITE。',
            '',
            `改编示例：${FEW_SHOT_EXAMPLE}`
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            'PROBLEM_REWRITE',
            `难度模式: ${difficultyMode}`,
            `难度说明: ${payload.difficultyText || ''}`,
            `用户难度要求: ${difficultyInstruction}`,
            `改编策略: ${adaptationInstruction}`,
            `难度分级参考：`,
            DIFFICULTY_TAXONOMY,
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
            content: [
              '你是 Markdown 题面修复助手。优先修正文结构和补齐缺失段落；如果原输出明显只是轻微改名、没有满足用户难度要求，可以顺手重写题目核心。',
              `难度分级参考：${DIFFICULTY_TAXONOMY}`,
              '算法范式策略：同难度则保持原范式，提升难度可在同一谱系内升级或审慎升级范式，但不能降级。',
              '必须输出完整题面，且补齐 # 标题、## 题意、## 输入格式、## 输出格式、## 样例、## 数据范围与提示。'
            ].join('\n')
          },
          {
            role: 'user',
            content: [
              'SOURCE_TEXT:',
              content || '',
              `难度要求: ${difficultyInstruction}`,
              `改编策略: ${adaptationInstruction}`
            ].join('\n')
          }
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
      content = await completeProblemMarkdown(workspaceId, content, source, difficultyInstruction, difficultyMode);
      content = await reviewAndReviseProblem(workspaceId, content, source, difficultyInstruction, difficultyMode);
      ensureProblemMarkdownStructure(content);
      await writeWorkspaceFile(workspaceId, 'problem/problem.md', content);
      await saveJobResult(workspaceId, 'problem', fingerprint, { resultPath: 'problem/problem.md' });
      await updateWorkspaceMeta(workspaceId, {
        difficulty: {
          mode: difficultyMode,
          text: payload.difficultyText || '',
          instruction: difficultyInstruction
        }
      });
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

async function reviewAndReviseProblem(workspaceId, initialContent, source, difficultyInstruction, difficultyMode) {
  let content = initialContent || '';
  for (let round = 1; round <= 2; round += 1) {
    emitWorkspaceEvent(workspaceId, 'task:update', {
      stage: 'problem',
      state: 'running',
      message: `正在审校题目难度与算法范式 ${round}/2`
    });
    const critique = await callLLM(
      [
        {
          role: 'system',
          content: [
            '你是严格的 OI 出题审稿员。只判断题目是否满足要求，不要迎合。',
            `难度分级参考：${DIFFICULTY_TAXONOMY}`,
            '必须检查：',
            '1. 是否严格命中用户目标难度——关键是思维链深度、复合程度、建模难度是否对齐目标级别，而非仅看数据范围或算法名字；',
            '2. 算法范式是否合理：同难度改编不应改变算法范式；提升难度改编应升级算法（如同难度的 BFS→BFS，但提升难度可以 BFS→DP），不能降级；',
            '3. 是否只是改题名或背景而没有实质改编。',
            '输出第一行只能是 PASS 或 FAIL，后面用简短中文列出理由和必须修改点。标记为 PROBLEM_REVIEW。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            'PROBLEM_REVIEW',
            `用户难度要求: ${difficultyInstruction}`,
            `改编策略: ${buildAdaptationInstruction(difficultyMode)}`,
            '原始题面:',
            source || '',
            '候选题面:',
            content || ''
          ].join('\n')
        }
      ],
      {
        temperature: 0.05,
        timeoutMs: 90000,
        maxTokens: 4096,
        retries: 5,
        onComplete: async info => {
          await logLLMComplete(workspaceId, 'problem.log', `problem review ${round}`, info);
        },
        onRetry: async ({ attempt, retries, error }) => {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'problem',
            state: 'running',
            message: `题目审校重试 ${attempt + 1}/${retries}`
          });
          await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] review retry ${attempt + 1}/${retries}: ${error.message}\n`);
        }
      }
    );
    await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] review ${round}: ${critique.slice(0, 1200)}\n`);
    if (/^\s*PASS\b/i.test(critique)) {
      return content;
    }

    emitWorkspaceEvent(workspaceId, 'task:update', {
      stage: 'problem',
      state: 'running',
      message: `正在按审校意见重写题目 ${round}/2`
    });
    content = await callLLM(
      [
        {
          role: 'system',
          content: [
            '你是资深 OI 题目修订员。根据审稿意见重写题面。',
            `难度分级参考：${DIFFICULTY_TAXONOMY}`,
            '必须严格命中用户目标难度，不得降档；同难度则保持算法范式一致；提升难度可在原谱系内升级或审慎升级范式。大幅重写背景和叙事。',
            '只输出完整 Markdown 题面，结构为：# 标题、## 题意、## 输入格式、## 输出格式、## 样例、## 数据范围与提示。标记为 PROBLEM_REVISE。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            'PROBLEM_REVISE',
            `用户难度要求: ${difficultyInstruction}`,
            `改编策略: ${buildAdaptationInstruction(difficultyMode)}`,
            '原始题面:',
            source || '',
            '上一版题面:',
            content || '',
            '审稿意见:',
            critique || ''
          ].join('\n')
        }
      ],
      {
        temperature: 0.15,
        timeoutMs: 90000,
        maxTokens: 8192,
        retries: 5,
        onComplete: async info => {
          await logLLMComplete(workspaceId, 'problem.log', `problem revise ${round}`, info);
        },
        onRetry: async ({ attempt, retries, error }) => {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'problem',
            state: 'running',
            message: `题目重写重试 ${attempt + 1}/${retries}`
          });
          await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] revise retry ${attempt + 1}/${retries}: ${error.message}\n`);
        }
      }
    );
    emitProblemPreview(workspaceId, content);
    content = await completeProblemMarkdown(workspaceId, content, source, difficultyInstruction, difficultyMode);
  }
  return content;
}

async function completeProblemMarkdown(workspaceId, initialContent, source, difficultyInstruction, difficultyMode) {
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
          content: [
            '你是题面重写与补全助手。请直接输出一份完整 Markdown 题面，不要解释，不要续写半截内容。',
            `难度分级参考：${DIFFICULTY_TAXONOMY}`,
            '用户目标难度必须严格遵守，不得降成更低档；同难度则保持算法范式一致；提升难度可在原谱系内升级或审慎升级范式。',
            '必须包含且只需包含：# 标题、## 题意、## 输入格式、## 输出格式、## 样例、## 数据范围与提示。样例必须有输入和输出。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `用户难度要求: ${difficultyInstruction}`,
            `改编策略: ${buildAdaptationInstruction(difficultyMode)}`,
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

      const diffCtx = meta?.difficulty || {};
      const diffInfo = diffCtx.instruction
        ? `目标难度：${diffCtx.instruction}（模式：${diffCtx.mode}${diffCtx.text ? `，说明：${diffCtx.text}` : ''}）`
        : '';

      await setState(workspaceId, 'solution', 'running', '正在生成题解');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'running', message: '正在生成题解' });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] start solution generation\n`);
      const draftPrompt = [
        {
          role: 'system',
          content: [
            '你是资深 OI 题解助手。先输出初稿。标记为 SOLUTION_DRAFT。',
            `难度分级参考：${DIFFICULTY_TAXONOMY}`,
            '题解的算法、复杂度分析应与目标难度匹配，体现相应深度。',
            '必须包含 ## 思路、## 正确性、## 复杂度 三个章节，最后给出 C++ 标程（```cpp 代码块）。'
          ].join('\n')
        },
        {
          role: 'user',
          content: ['SOLUTION_DRAFT', diffInfo, 'SOURCE_TEXT:', problem || ''].filter(Boolean).join('\n')
        }
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
        {
          role: 'system',
          content: [
            '你是严厉的 OI 题解审校员，只找错误，不写空话。标记为 SOLUTION_CRITIC。',
            '检查：算法是否正确、复杂度分析是否对齐目标难度、代码是否包含明显错误。'
          ].join('\n')
        },
        {
          role: 'user',
          content: ['SOLUTION_CRITIC', diffInfo, 'SOURCE_TEXT:', problem || '', 'DRAFT:', draft || ''].filter(Boolean).join('\n')
        }
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
        {
          role: 'system',
          content: [
            '你是 OI 题解修订员，根据审校意见修订并输出最终 Markdown 和 cpp。标记为 SOLUTION_FINAL。',
            `难度分级参考：${DIFFICULTY_TAXONOMY}`,
            '算法分析、复杂度推导必须与目标难度匹配，注意思维链深度要对齐。',
            '输出必须严格包含中文 Markdown 章节：# 题解、## 思路、## 正确性、## 复杂度。',
            '最后必须包含一个 ```cpp 代码块，代码块内是完整 C++17 标程。'
          ].join('\n')
        },
        {
          role: 'user',
          content: ['SOLUTION_FINAL', diffInfo, 'SOURCE_TEXT:', problem || '', 'DRAFT:', draft || '', 'CRITIQUE:', critique || ''].filter(Boolean).join('\n')
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
      const repaired = await repairSolutionOutput(workspaceId, finalText, problem, diffInfo);
      const cpp = extractCodeBlock(repaired, 'cpp') || '#include <bits/stdc++.h>\nint main(){return 0;}\n';
      const markdown = stripCppBlock(repaired);
      ensureSolutionMarkdownStructure(markdown);
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

      const diffCtx = meta?.difficulty || {};
      const diffInfo = diffCtx.instruction
        ? `目标难度：${diffCtx.instruction}（模式：${diffCtx.mode}${diffCtx.text ? `，说明：${diffCtx.text}` : ''}）`
        : '';

      await setState(workspaceId, 'data', 'running', '正在生成数据方案');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'running', message: '正在生成数据方案' });
      await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] start data planning\n`);
      const planPrompt = [
        {
          role: 'system',
          content: [
            '你是资深 OI 数据构造助手。标记为 DATA_PLAN。',
            `难度分级参考：${DIFFICULTY_TAXONOMY}`,
            '数据范围、测试点规模必须对齐目标难度。',
            '输出必须是 Markdown，严格包含 # 数据方案 和 ## 点数分布。'
          ].join('\n')
        },
        { role: 'user', content: ['DATA_PLAN', diffInfo, 'SOURCE_TEXT:', solution || ''].filter(Boolean).join('\n') }
      ];
      let plan = await callLLM(planPrompt, {
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
      plan = await repairDataPlanOutput(workspaceId, plan, solution, diffInfo);
      ensureDataPlanMarkdownStructure(plan);
      await writeWorkspaceFile(workspaceId, 'data/hack_plan.md', plan);

      const genPrompt = [
        {
          role: 'system',
          content: [
            '你要根据数据方案写 Python 数据生成器。标记为 GEN_PY。',
            `难度分级参考：${DIFFICULTY_TAXONOMY}`,
            '生成数据的规模必须对齐目标难度。'
          ].join('\n')
        },
        { role: 'user', content: ['GEN_PY', diffInfo, 'SOURCE_TEXT:', plan || ''].filter(Boolean).join('\n') }
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

      try {
        await runDataGenerator(workspaceId);
      } catch (runError) {
        await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] auto run failed: ${runError.message}\n`);
      }

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
proc = subprocess.run([sys.executable, str(work / "gen.py")], cwd=str(out_dir), capture_output=True, text=True, timeout=30)
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
    const runnerStdout = extractBetween(result.stdout, 'STDOUT_BEGIN', 'STDOUT_END') || result.stdout;
    const error = new Error(
      `generator failed: no ZIP produced. ` +
      `runner stderr: ${result.stderr || '(empty)'}; ` +
      `runner stdout: ${runnerStdout.slice(0, 500)}`
    );
    error.statusCode = 500;
    throw error;
  }
  const zipContent = Buffer.from(zipHex, 'hex');
  try {
    assertDataZipLooksValid(zipContent);
  } catch (e) {
    const error = new Error(`invalid ZIP produced: ${e.message}`);
    error.statusCode = 500;
    throw error;
  }
  return {
    stdout: extractBetween(result.stdout, 'STDOUT_BEGIN', 'STDOUT_END'),
    stderr: extractBetween(result.stdout, 'STDERR_BEGIN', 'STDERR_END'),
    zipContent
  };
}

function runPython(code, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
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
    child.unref();
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
    return '同难度改编：参考原题难度与算法量级，保持原题基础算法范式一致；同时尽可能改换背景、故事、对象、题名、变量语义和表述方式；避免保留原题可搜索的关键词、专有名词、样例背景和原句。不要只改题名。';
  }
  return '提升难度改编：按用户输入的目标难度设计，目标难度必须严格命中；算法范式可在原谱系内升级（如普通DP→树形DP），必要时可审慎升级到更高阶范式（如BFS/贪心→DP）。不能降级。背景、变量和叙事可以大幅重写。';
}

function ensureProblemMarkdownStructure(text) {
  ensureMarkdownStructure(text, ['title', '## 题意', '## 输入格式', '## 输出格式', '## 样例', '## 数据范围与提示']);
  if (!problemHasCompleteMarkdown(text)) {
    const error = new Error('markdown missing complete problem structure');
    error.statusCode = 422;
    throw error;
  }
}

async function repairSolutionOutput(workspaceId, finalText, problem, diffInfo) {
  const requiredHeaders = ['## 思路', '## 正确性', '## 复杂度'];
  const markdown = stripCppBlock(finalText);
  const cpp = extractCodeBlock(finalText, 'cpp');
  const missing = requiredHeaders.filter(header => !markdown.includes(header));
  if (!markdown.trim()) missing.push('缺少题解 Markdown');
  if (!/^#\s+\S+/m.test(markdown)) missing.push('缺少一级标题');
  if (!cpp) missing.push('缺少 C++ 标程代码块');
  if (!missing.length) return finalText;

  emitWorkspaceEvent(workspaceId, 'task:update', {
    stage: 'solution',
    state: 'running',
    message: '正在修正题解格式'
  });
  await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] repair solution: ${missing.join(', ')}\n`);

  const repaired = await callLLM(
    [
      {
        role: 'system',
        content: [
          '你是 OI 题解格式修复助手。必须保留正确算法含义，修复 Markdown 结构和 C++ 标程代码块。',
          `难度分级参考：${DIFFICULTY_TAXONOMY}`,
          '只输出最终结果，不要解释。',
          '输出格式必须严格为：',
          '# 题解',
          '## 思路',
          '## 正确性',
          '## 复杂度',
          '```cpp',
          '完整 C++17 标程',
          '```'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          'SOLUTION_REPAIR',
          diffInfo,
          `当前问题: ${missing.join('；')}`,
          '题目:',
          problem || '',
          '待修复输出:',
          finalText || ''
        ].filter(Boolean).join('\n')
      }
    ],
    {
      temperature: 0.05,
      timeoutMs: 90000,
      maxTokens: 8192,
      retries: 5,
      onComplete: async info => {
        await logLLMComplete(workspaceId, 'solution.log', 'solution repair', info);
      },
      onRetry: async ({ attempt, retries, error }) => {
        emitWorkspaceEvent(workspaceId, 'task:update', {
          stage: 'solution',
          state: 'running',
          message: `题解格式修复重试 ${attempt + 1}/${retries}`
        });
        await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] repair retry ${attempt + 1}/${retries}: ${error.message}\n`);
      }
    }
  );
  emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'repair', text: repaired.slice(0, 320) });
  return repaired;
}

function ensureSolutionMarkdownStructure(text) {
  ensureMarkdownStructure(text, ['title', '## 思路', '## 正确性', '## 复杂度']);
}

async function repairDataPlanOutput(workspaceId, plan, solution, diffInfo) {
  const text = String(plan || '');
  const missing = [];
  if (!text.trim()) missing.push('缺少数据方案 Markdown');
  if (!/^#\s+\S+/m.test(text)) missing.push('缺少一级标题');
  if (!text.includes('## 点数分布')) missing.push('缺少 ## 点数分布');
  if (!missing.length) return plan;

  emitWorkspaceEvent(workspaceId, 'task:update', {
    stage: 'data',
    state: 'running',
    message: '正在修正数据方案格式'
  });
  await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] repair data plan: ${missing.join(', ')}\n`);

  const repaired = await callLLM(
    [
      {
        role: 'system',
        content: [
          '你是 OI 数据方案格式修复助手。必须保留数据构造意图，修复 Markdown 结构。',
          `难度分级参考：${DIFFICULTY_TAXONOMY}`,
          '只输出最终数据方案，不要解释。',
          '输出格式必须严格包含：',
          '# 数据方案',
          '## 点数分布',
          '在 ## 点数分布 下列出各测试点/测试组比例、规模、构造目的和边界覆盖。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          'DATA_PLAN_REPAIR',
          diffInfo,
          `当前问题: ${missing.join('；')}`,
          '题解:',
          solution || '',
          '待修复数据方案:',
          plan || ''
        ].filter(Boolean).join('\n')
      }
    ],
    {
      temperature: 0.05,
      timeoutMs: 90000,
      maxTokens: 8192,
      retries: 5,
      onComplete: async info => {
        await logLLMComplete(workspaceId, 'data.log', 'data plan repair', info);
      },
      onRetry: async ({ attempt, retries, error }) => {
        emitWorkspaceEvent(workspaceId, 'task:update', {
          stage: 'data',
          state: 'running',
          message: `数据方案格式修复重试 ${attempt + 1}/${retries}`
        });
        await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] plan repair retry ${attempt + 1}/${retries}: ${error.message}\n`);
      }
    }
  );
  emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'data', phase: 'plan-repair', text: repaired.slice(0, 320) });
  return repaired;
}

function ensureDataPlanMarkdownStructure(text) {
  ensureMarkdownStructure(text, ['title', '## 点数分布']);
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
    child.on('error', error => {
      if (error?.code === 'ENOENT') {
        reject(new Error(`${command} not found. Please install ${command} in the runtime environment.`));
        return;
      }
      reject(error);
    });
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
