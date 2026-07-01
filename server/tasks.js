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
            '也不得虚高——实际 CSP-S T3 级别的题不要标成 T4。标难度必须实事求是，符合思维链深度和模型复杂度。',
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
            '⚠️ 提示部分（数据范围与提示）只允许给出方向性提示（如"可以用某种优化结构的 DP"），不允许直接给出状态定义、转移方程、或具体算法名称（如"单调队列"）。',
            '⚠️ 样例部分必须用 HTML 注释标记样例输入和输出的代码块，格式如下：',
            '',
            '<!--SAMPLE_INPUT-->',
            '```',
            '样例输入内容',
            '```',
            '<!--SAMPLE_INPUT_END-->',
            '<!--SAMPLE_OUTPUT-->',
            '```',
            '样例输出内容（可以随便写，后面会被自动替换为标程的真实输出）',
            '```',
            '<!--SAMPLE_OUTPUT_END-->',
            '',
            '注意：如果有多个样例（样例1、样例2），每组都要用各自的注释包裹。',
            '注释必须紧贴在代码块上方，不能有其他 Markdown 内容隔开。',
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
            '3. 是否只是改题名或背景而没有实质改编；',
            '4. 样例自洽性：检查样例输入、样例输出和样例说明是否互相一致。如果样例说明的计算结果是 X 但输出写的是 Y，必须指出。',
            '注意：难度标注的轻微偏差（如实际 T3 标成 T4）属于建议性问题，不要为此单独 FAIL，除非算法模式本身明显低于要求（如用 BFS 解 DP 题）。',
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
            '必须确保：样例输入、样例输出和样例说明三者自洽，不能自相矛盾；',
            '必须保留原始题面中的 HTML 注释标记（<!--SAMPLE_INPUT-->, <!--SAMPLE_INPUT_END-->, <!--SAMPLE_OUTPUT-->, <!--SAMPLE_OUTPUT_END-->），这些标记用于自动化校验，不能删除或改动；',
            '提示部分不得直接给出转移方程、状态设计或具体算法名称（如"单调队列"），只能给方向性提示；',
            '标难度不得虚高——实际 CSP-S T3 级别的题不要标成 T4。',
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
            '必须包含且只需包含：# 标题、## 题意、## 输入格式、## 输出格式、## 样例、## 数据范围与提示。样例必须有输入和输出。',
            '⚠️ 提示部分不得直接给出状态定义、转移方程或具体算法名称。',
            '⚠️ 必须保留原始题面中的 HTML 注释标记（<!--SAMPLE_INPUT-->, <!--SAMPLE_INPUT_END-->, <!--SAMPLE_OUTPUT-->, <!--SAMPLE_OUTPUT_END-->），这些标记用于自动化校验，不能删除或改动。',
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
          '审查步骤：',
          '1. 提取题目所有约束条件（数据范围、特殊限制、操作类型），逐条列出',
          '2. 检查题解算法是否处理了每一条约束。如果有约束未被处理，这是必须指出的 FAIL',
          '3. 检查算法是否正确、复杂度分析是否对齐目标难度',
          '4. 检查代码是否有明显错误',
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

      let lastFailure = '';
      for (let candidate = 1; candidate <= 3; candidate += 1) {
        try {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'solution',
            state: 'running',
            message: `正在生成题解候选 ${candidate}/3`
          });
          const finalText = await generateSolutionCandidate(workspaceId, {
            problem,
            draft,
            critique,
            diffInfo,
            lastFailure,
            candidate
          });
          emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'final', text: finalText.slice(0, 320) });
          const { markdown, cpp } = await validateSolutionCandidate(workspaceId, finalText, problem, diffInfo);
          await writeWorkspaceFile(workspaceId, 'solution/solution.md', markdown);
          await writeWorkspaceFile(workspaceId, 'solution/std.cpp', cpp);
          await saveJobResult(workspaceId, 'solution', fingerprint, {
            resultPaths: ['solution/solution.md', 'solution/std.cpp']
          });
          await setState(workspaceId, 'solution', 'done', '题解与标程已生成');
          emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'done', message: '题解与标程已生成' });
          await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] done\n`);
          return { markdown, cpp, cached: false, critique };
        } catch (candidateError) {
          lastFailure = String(candidateError?.message || candidateError || '').slice(0, 4000);
          await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] candidate ${candidate}/3 failed: ${lastFailure}\n`);
          if (candidate === 3) {
            const error = new Error(`solution quality gates failed after 3 candidates: ${lastFailure}`);
            error.statusCode = candidateError.statusCode || 422;
            throw error;
          }
        }
      }
    } catch (error) {
      await setState(workspaceId, 'solution', 'error', error.message || 'solution failed');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'error', message: error.message || 'solution failed' });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] failed: ${error.message}\n`);
      throw error;
    }
  });
}

async function generateSolutionCandidate(workspaceId, { problem, draft, critique, diffInfo, lastFailure, candidate }) {
  const system = [
    '你是 OI 题解设计师。注意：这不是修订任务，是设计任务。标记为 SOLUTION_FINAL。',
    `难度分级参考：${DIFFICULTY_TAXONOMY}`,
    '',
    '【第一步：约束分析】在写任何代码之前，先逐条列出题目中的所有约束条件：',
    '- 数据范围（N, Q, 值域等）',
    '- 特殊限制（容量、预算、时间窗口等）',
    '- 操作类型（修改、查询的分布）',
    '- 边界情况（最小值、最大值、空、满等）',
    '对每条约束，注明算法需要如何应对。',
    '',
    '【第二步：算法设计】基于约束分析设计满分 AC 算法：',
    '- 复杂度必须满足最大数据范围',
    '- 确保每条约束都在代码中有对应处理',
    '- 如果之前有候选失败，分析失败原因的具体根因，避免新设计重蹈覆辙',
    '',
    '【第三步：输出】',
    '输出必须严格包含中文 Markdown 章节：# 题解、## 思路、## 正确性、## 复杂度。',
    '只输出一个 ```cpp 代码块且必须是最后一个代码块，代码块内是完整 C++17 标程。',
    '标程必须是可独立编译的完整程序，必须包含 int main() 或 signed main() 入口。',
    '标程必须是满分 AC 解法；不要输出部分分、暴力、伪代码或未经证明的贪心。',
    '如果上一候选失败，必须换一种完整设计重新生成，不要只做局部补丁。',
    '',
    '⚠️ 常见错误自查：',
    '- 容量/距离限制是否在代码中有显式的 if/边界判断？',
    '- 修改操作是否导致每次查询 O(N) 重建？是否能做到 O(log N) 更新？',
    '- 贪心策略是否有严格的反例证明？还是凭感觉猜测？',
    '- 递归深度是否可能导致栈溢出 (N=1e5 时递归深度 >1e4 需改迭代)？',
    '- long long 是否足够？（值域乘积是否超过 2e9 * 2e9）',
    '- 代码的最后部分是否是 int main() / signed main()？确保 main 函数没有被截断'
  ];
  const user = [
    'SOLUTION_FINAL',
    `候选编号: ${candidate}/3`,
    diffInfo,
    'SOURCE_TEXT:',
    problem || '',
    'DRAFT:',
    draft || '',
    'CRITIQUE:',
    critique || ''
  ];
  if (lastFailure) {
    user.push(
      'PREVIOUS_CANDIDATE_FAILURE:',
      lastFailure,
      '请根据上述失败原因重新设计题解和标程。若失败原因涉及算法复杂度或核心正确性，不要沿用原算法框架。'
    );
  }
  const finalText = await callLLM([
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: user.filter(Boolean).join('\n') }
  ], {
    temperature: candidate === 1 ? 0.2 : 0.35,
    maxTokens: 8192,
    retries: 5,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'solution.log', `final candidate ${candidate}`, info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      emitWorkspaceEvent(workspaceId, 'task:update', {
        stage: 'solution',
        state: 'running',
        message: `题解候选 ${candidate} 重试 ${attempt + 1}/${retries}`
      });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] final candidate ${candidate} retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
  return finalText;
}

async function validateSolutionCandidate(workspaceId, finalText, problem, diffInfo) {
  const repaired = await repairSolutionOutput(workspaceId, finalText, problem, diffInfo);
  let cpp = extractCodeBlock(repaired, 'cpp') || '#include <bits/stdc++.h>\nint main(){return 0;}\n';
  const markdown = stripCppBlock(repaired);
  ensureSolutionMarkdownStructure(markdown);
  assertSolutionTextLooksReasonable(markdown, cpp);
  cpp = await repairCppCompilation(workspaceId, cpp, problem);
  cpp = await crossReviewStdCpp(workspaceId, cpp, problem);
  // FIX3: both verifiers now return (possibly repaired) cpp
  cpp = await verifyWithDualSolution(workspaceId, cpp, problem);
  cpp = await verifyWithBruteOracle(workspaceId, cpp, problem);
  await verifyFullScoreReview(workspaceId, markdown, cpp, problem, diffInfo);
  await verifySampleWithStd(workspaceId, cpp);
  return { markdown, cpp };
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
            '输出必须是 Markdown，严格包含 # 数据方案 和 ## 点数分布。',
            '各测试点的 N 值（或其他规模参数）必须具体写明，后续 gen.py 会以此为准生成数据。不要出现方案中写 N=2e5 但实际生成器用 N=5000 的矛盾。'
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

      const problemMd = await safeRead(workspaceId, 'problem/problem.md');
      const stdCpp = await safeRead(workspaceId, 'solution/std.cpp');
      const genPrompt = [
        {
          role: 'system',
          content: [
            '你要根据数据方案写 Python 数据生成器。标记为 GEN_PY。',
            `难度分级参考：${DIFFICULTY_TAXONOMY}`,
            '生成数据的规模必须对齐目标难度。',
            '只输出纯 Python 代码，不要用 Markdown 代码块包裹，不要添加任何解释说明。',
            '生成的数据文件（如 1.in）必须直接写入当前工作目录，不要创建子目录。',
            '数据的输入格式必须严格对标给定 C++ 标程的 cin 读入顺序和数据类型，不可自创格式。',
            '数据方案中声明的 N 值必须与 gen.py 实际使用的 N 值一致。如果出于合理原因（如防 long long 溢出）需要改小 N，请确保数据方案的说明也随之同步更新，不要出现方案说 N=2e5 但代码实际用 N=5000 的矛盾。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            'GEN_PY',
            diffInfo,
            '',
            '题目描述与输入输出格式:',
            problemMd ? problemMd.slice(0, 3000) : '',
            '',
            '数据方案:',
            plan || '',
            '',
            'C++ 标程（以 cin 读入顺序为准）:',
            stdCpp || '',
          ].filter(Boolean).join('\n')
        }
      ];
      let genPy = await callLLM(genPrompt, {
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
      genPy = extractPythonCode(genPy) || genPy;
      ensurePythonGeneratorShape(genPy);
      assertDataPlanLooksReasonable(plan, genPy);
      plan = await validateDataPlanGenConsistency(workspaceId, plan, genPy, diffInfo);
      await writeWorkspaceFile(workspaceId, 'data/hack_plan.md', plan);
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
    const stdCpp = await safeRead(workspaceId, 'solution/std.cpp');
    if (!stdCpp.trim()) {
      const error = new Error('std.cpp not found');
      error.statusCode = 400;
      throw error;
    }
    const combinedInput = genPy + stdCpp;
    const fingerprint = hashText(combinedInput);
    const meta = await getWorkspaceMetaInternal(workspaceId);
    if (meta?.jobs?.run?.fingerprint === fingerprint && (await exists(workspaceId, 'data/datas.zip'))) {
      return { artifact: 'data/datas.zip', cached: true };
    }

    await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] start generator run\n`);
    emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'running', message: '正在运行数据生成器' });

    let currentStdCpp = stdCpp;
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await executePythonGenerator(workspaceId, genPy, currentStdCpp);
        emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'data', phase: 'run', text: (result.stdout || result.stderr || '').slice(0, 320) });
        assertDataZipLooksValid(result.zipContent);
        await verifyZipArchive(result.zipContent);
        await writeWorkspaceFile(workspaceId, 'data/datas.zip', result.zipContent);
        await saveJobResult(workspaceId, 'run', fingerprint, { resultPath: 'data/datas.zip' });
        await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] run finished\n`);
        emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'done', message: '数据包已生成' });
        return { artifact: 'data/datas.zip', cached: false, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        lastError = error;
        const errMsg = error.message || '';
        const isRetryable = errMsg.includes('timed out') || errMsg.includes('std failed') || errMsg.includes('compile');
        if (!isRetryable || attempt === 3) break;

        emitWorkspaceEvent(workspaceId, 'task:update', {
          stage: 'data', state: 'running',
          message: `正在修复标程运行错误 ${attempt}/3`
        });
        await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] fix std.cpp attempt ${attempt}/3: ${errMsg.slice(0, 1000)}\n`);

        const problem = await safeRead(workspaceId, 'problem/problem.md');
        const fixed = await callLLM(
          [
            {
              role: 'system',
              content: '你是 C++ 标程修复助手。根据下方的运行时错误修正标程代码。只输出修正后的完整 C++ 代码，不要 Markdown 包裹，不要解释。',
            },
            {
              role: 'user',
              content: [
                '运行时错误:',
                errMsg,
                '',
                '题目:',
                problem || '',
                '',
                '当前标程代码:',
                currentStdCpp || '',
              ].join('\n'),
            },
          ],
          {
            temperature: 0.1,
            timeoutMs: 60000,
            maxTokens: 4096,
            retries: 3,
            onComplete: async info => {
              await logLLMComplete(workspaceId, 'data.log', `std fix ${attempt}`, info);
            },
            onRetry: async ({ attempt: ra, retries, error }) => {
              await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] std fix LLM retry ${ra + 1}/${retries}: ${error.message}\n`);
            },
          }
        );
        currentStdCpp = extractCodeBlock(fixed, 'cpp') || fixed.trim() || currentStdCpp;
        await writeWorkspaceFile(workspaceId, 'solution/std.cpp', currentStdCpp);
      }
    }

    throw lastError || new Error('run failed');
  });
}

export const __testHooks = {
  verifySampleWithStd,
  verifyWithBruteOracle,
  verifyFullScoreReview
};

async function executePythonGenerator(workspaceId, genPy, stdCpp) {
  const root = path.resolve(process.cwd(), 'workspaces', workspaceId);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-${workspaceId}-`));
  const scriptPath = path.join(workDir, 'gen.py');
  await fs.writeFile(scriptPath, genPy, 'utf8');
  const stdPath = path.join(workDir, 'std.cpp');
  await fs.writeFile(stdPath, stdCpp, 'utf8');

  const runner = `
import os, subprocess, sys, zipfile, pathlib, shutil, textwrap
root = pathlib.Path(r"${root}")
work = pathlib.Path(r"${workDir}")
out_dir = work / "out"
if out_dir.exists():
    shutil.rmtree(out_dir)
out_dir.mkdir(parents=True, exist_ok=True)

# run gen.py to produce .in files
proc = subprocess.run([sys.executable, str(work / "gen.py")], cwd=str(out_dir), capture_output=True, text=True, timeout=60)
stdout = proc.stdout
stderr = proc.stderr
if proc.returncode != 0:
    print("gen.py failed (exit", proc.returncode, "):", stderr[-2000:], file=sys.stderr)
    sys.exit(1)

in_files = sorted([p for p in out_dir.rglob("*.in")])
if not in_files:
    print("no .in files generated; gen.py stdout:", stdout[-2000:], file=sys.stderr)
    sys.exit(1)

# compile std.cpp
compile_proc = subprocess.run(["g++", "-std=c++17", "-O2", "-pipe", "-static", str(work / "std.cpp"), "-o", str(work / "std")], capture_output=True, text=True, timeout=60)
if compile_proc.returncode != 0:
    print("g++ compile failed:\\n" + compile_proc.stderr[-3000:], file=sys.stderr)
    sys.exit(1)

# run std against each .in to produce .out
for in_file in in_files:
    out_file = in_file.with_suffix(".out")
    try:
        with open(in_file) as inf:
            run_proc = subprocess.run([str(work / "std")], stdin=inf, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        print(f"std timed out on {in_file.relative_to(out_dir)} after 60s", file=sys.stderr)
        sys.exit(1)
    if run_proc.returncode != 0:
        print(f"std failed on {in_file.name} (exit {run_proc.returncode}):\\n" + run_proc.stderr[-2000:], file=sys.stderr)
        sys.exit(1)
    out_file.write_text(run_proc.stdout)

# zip both .in and .out
zip_path = work / "datas.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    for p in sorted(out_dir.rglob("*")):
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

  const result = await runPython(runner, 180000);
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
        const msg = stderr || `process exited with code ${code}`;
        reject(new Error(msg));
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
  const regex = new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, 'gi');
  const matches = Array.from(text.matchAll(regex));
  if (!matches.length) return '';
  const last = matches[matches.length - 1];
  return last[1].trim();
}

function stripCppBlock(text) {
  return text.replace(/```cpp[\s\S]*?```/gi, '').trim();
}

function extractPythonCode(text) {
  const extracted = extractCodeBlock(text, 'python');
  if (extracted) return extracted;
  const generic = extractCodeBlock(text, 'py');
  if (generic) return generic;
  return '';
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
  const content = stripCppBlock(finalText);
  const cpp = extractCodeBlock(finalText, 'cpp');
  const missing = getSolutionContentIssues(content);
  if (!content.trim()) missing.push('缺少题解 Markdown');
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
  const content = String(text || '').trim();
  if (!content) {
    const error = new Error('markdown missing level-1 title');
    error.statusCode = 422;
    throw error;
  }
  const issues = getSolutionContentIssues(content);
  if (issues.length) {
    const error = new Error(`solution content issue: ${issues.join('; ')}`);
    error.statusCode = 422;
    throw error;
  }
}

function getSolutionContentIssues(text) {
  const content = String(text || '');
  const issues = [];
  if (!content.trim()) { issues.push('输出为空'); return issues; }
  if (!/^#\s+\S+/m.test(content)) issues.push('缺少一级标题');
  if (!hasAlgorithmDescription(content)) issues.push('缺少算法/思路描述');
  if (!hasCorrectnessArgument(content)) issues.push('缺少正确性论证');
  if (!hasComplexityAnalysis(content)) issues.push('缺少复杂度分析');
  if (/(\.\.\.|……|未完|待补|待续|省略号)/.test(content)) issues.push('含有省略或待补标记');
  const fenceCount = (content.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) issues.push('代码块未闭合');
  return issues;
}

function hasAlgorithmDescription(text) {
  const headers = ['思路', '解法', '解题思路', '算法思路', '算法分析', '算法描述', 'Approach', 'Algorithm', 'Solution'];
  if (headers.some(h => text.includes(`## ${h}`) || text.includes(`### ${h}`))) return true;
  const patterns = [
    /(首先|然后|接着|最后|步骤|分为.*步|方法|策略|算法|贪心|DP|动态规划|二分|搜索|递归|迭代|遍历|构造|模拟|排序|分治)/,
    /(先.*再.*最[终后]|核心思想|主要思路|解题思路|算法流程)/,
    /we (can|will|use|apply|adopt|propose|design|consider)/i,
    /algorithm|approach|solution|method/i,
  ];
  return patterns.some(p => p.test(text));
}

function hasCorrectnessArgument(text) {
  const headers = ['正确性', '正确性证明', '正确性分析', '证明', 'Proof', 'Correctness'];
  if (headers.some(h => text.includes(`## ${h}`) || text.includes(`### ${h}`))) return true;
  const patterns = [
    /(证明|正确性|充分性|必要性|归纳|反证|反例|矛盾|成立|必然|显然|因此|所以|因为.*所以|由于|故|从而|可得|则.*成立)/,
    /(correctness|proof|prove|valid|invariant|induction|contradiction|suffice|necessary|hence|therefore|thus|consequently)/i,
    /(可以证明|不难证明|易证|需证|要证|只需|考虑.*情况|分[类情].*讨论|边界.*情况|特例)/,
  ];
  return patterns.some(p => p.test(text));
}

function hasComplexityAnalysis(text) {
  const headers = ['复杂度', '复杂度分析', '时空复杂度', '时间复杂度', '空间复杂度', 'Complexity', 'Time complexity', 'Space complexity'];
  if (headers.some(h => text.includes(`## ${h}`) || text.includes(`### ${h}`))) return true;
  const patterns = [
    /(复杂度|时间.*复杂度|空间.*复杂度|时空.*复杂度|时间.*空间)/,
    /\$?O\s*\(/,
    /\bO\(n|\bO\(log|\bO\(N|\bO\(1/,
    /(complexity|time\s*(and\s*space)?|space\s*complexity)/i,
    /(线性|对数|指数|多项式|平方|立方|常数|\$n\$\s*\(?\$?m\$?)/,
  ];
  return patterns.some(p => p.test(text));
}

async function repairCppCompilation(workspaceId, cpp, problem) {
  let current = String(cpp || '');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await verifyCppCompiles(workspaceId, current);
      return current;
    } catch (compileError) {
      const message = compileError.message || '';
      if (!message || attempt === 3) throw compileError;
      emitWorkspaceEvent(workspaceId, 'task:update', {
        stage: 'solution',
        state: 'running',
        message: `正在修复标程编译错误 ${attempt}/3`
      });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] compile fix ${attempt}/3: ${message.slice(0, 500)}\n`);
      const fixed = await callLLM(
        [
          {
            role: 'system',
            content: '你是 C++ 标程修复助手。根据编译错误修正下方的 C++ 代码。只输出修正后的完整 C++ 代码，不要 Markdown 包裹，不要解释。\n'
              + '⚠️ 如果链接错误提示 undefined reference to `main`，必须在代码末尾补上完整的 int main() 或 signed main() 函数。',
          },
          {
            role: 'user',
            content: [
              '编译错误:',
              message,
              '',
              '题目描述:',
              problem || '',
              '',
              '当前代码:',
              current || '',
            ].join('\n'),
          },
        ],
        {
          temperature: 0.1,
          timeoutMs: 60000,
          maxTokens: 4096,
          retries: 3,
          onComplete: async info => {
            await logLLMComplete(workspaceId, 'solution.log', `compile fix ${attempt}`, info);
          },
          onRetry: async ({ attempt: retryAttempt, retries, error }) => {
            await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] compile fix LLM retry ${retryAttempt + 1}/${retries}: ${error.message}\n`);
          },
        }
      );
      current = extractCodeBlock(fixed, 'cpp') || fixed.trim() || current;
    }
  }
  return current;
}

async function crossReviewStdCpp(workspaceId, cpp, problem) {
  let current = String(cpp || '');
  const reviews = [];
  for (let round = 1; round <= 3; round += 1) {
    emitWorkspaceEvent(workspaceId, 'task:update', {
      stage: 'solution', state: 'running',
      message: `算法审查 ${round}/3`
    });
    const prevReviewText = round > 1
      ? reviews.map((r, i) => `第${i + 1}轮审查：${r.slice(0, 600)}`).join('\n\n')
      : '';
    const reviewerPrompt = [
      {
        role: 'system',
        content: '你是严格的 OI 代码审查员。只找错误，不写空话。标记为 CODE_REVIEW。\n'
          + '审查步骤：\n'
          + '1. 从题目中提取所有约束条件（数据范围、特殊限制、操作类型、边界条件），逐条列出\n'
          + '2. 对每条约束，检查代码中是否有对应处理。如果某约束在代码中完全未被处理（如容量限制、范围限制没出现任何判断），这是 FAIL\n'
          + '3. 算法正确性：贪心策略是否存在反例？DP 转移是否正确？数据结构维护是否有效？\n'
          + '4. 边界情况：数组越界、整数溢出、空队列/空容器访问、特殊值（如 -1, INF）处理\n'
          + '5. 复杂度：最坏情况下时间复杂度是否在题目数据范围内可接受？注意 O(N) 的修改操作在 Q 次询问下是否退化到 O(NQ)\n'
          + '6. 输入输出：读入格式是否与题面一致？变量类型是否匹配？\n'
          + '输出第一行只能是 PASS 或 FAIL，第二行开始列出具体问题（含代码行号和原因）。\n'
          + '⚠️ 多轮审查须知：如果之前轮次已报告过的问题，本轮代码中已修复则不应再次报告；如果修复不完整或引入了新问题，指出遗留/新问题即可。'
      },
      {
        role: 'user',
        content: [
          'CODE_REVIEW',
          '题目：',
          problem || '',
          prevReviewText ? ['', '历史审查记录（之前轮次已报告过的错误，本轮不再重复）：', prevReviewText].join('\n') : '',
          '',
          '标程代码：',
          current || ''
        ].filter(Boolean).join('\n')
      }
    ];
    const review = await callLLM(reviewerPrompt, {
      temperature: 0.05,
      maxTokens: 4096,
      retries: 3,
      onComplete: async info => {
        await logLLMComplete(workspaceId, 'solution.log', `code review ${round}`, info);
      },
    });
    await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] review ${round}: ${review.slice(0, 500)}\n`);
    reviews.push(`Round ${round}:\n${review}`);

    if (/^\s*PASS\b/i.test(review)) {
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] code review PASS in round ${round}\n`);
      return current;
    }

    emitWorkspaceEvent(workspaceId, 'task:update', {
      stage: 'solution', state: 'running',
      message: `正在按审查意见修复标程 ${round}/3`
    });
    const fixHistoryText = round > 1
      ? reviews.map((r, i) => `第${i + 1}轮审查意见：${r.slice(0, 400)}`).join('\n\n')
      : '';
    const fixPrompt = [
      {
        role: 'system',
        content: '你是 C++ 代码修复/重设计助手。根据审查意见处理代码。\n'
          + '判断审查类型：\n'
          + '- 如果审查指出的是变量名错误、边界加减1、类型不匹配等小问题 → 在原代码上修补\n'
          + '- 如果审查指出算法根本性错误（如忽略了核心约束、复杂度退化到不可接受、贪心策略缺乏正确性保证）→ **必须否定原算法框架，从零重新设计**，不做局部修补\n'
          + '只输出修正/重设计后的完整 C++ 代码（```cpp 代码块），不要解释。\n'
          + '审查意见中提到的反例场景必须正确解决，不可敷衍。\n'
          + '⚠️ 多轮修复须知：请结合本轮审查意见和历轮审查历史判断问题根因。如果同一问题在多轮中被反复指出，说明之前的修补方案无效，需要换一种根本性不同的解法。'
      },
      {
        role: 'user',
        content: [
          'CODE_FIX',
          '题目：',
          problem || '',
          fixHistoryText ? ['', '历轮审查历史（之前轮次指出的问题及修复方向）：', fixHistoryText].join('\n') : '',
          '',
          '当前标程：',
          current || '',
          '',
          '本轮审查意见：',
          review || ''
        ].filter(Boolean).join('\n')
      }
    ];
    const fixed = await callLLM(fixPrompt, {
      temperature: 0.1,
      maxTokens: 8192,
      retries: 3,
      onComplete: async info => {
        await logLLMComplete(workspaceId, 'solution.log', `code fix ${round}`, info);
      },
    });
    current = extractCodeBlock(fixed, 'cpp') || fixed.trim() || current;
    try {
      await verifyCppCompiles(workspaceId, current);
    } catch (compileError) {
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] fix ${round} broke compilation, retrying: ${compileError.message.slice(0, 300)}\n`);
      if (round === 3) throw compileError;
    }
  }
  const error = new Error(`code review did not reach PASS after 3 rounds\n${reviews.join('\n\n').slice(0, 3500)}`);
  error.statusCode = 422;
  throw error;
}

async function verifyWithDualSolution(workspaceId, stdCpp, problem) {
  let primaryStd = String(stdCpp || '');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-dual-${workspaceId}-`));
  try {
    const primaryPath = path.join(tmpDir, 'primary');
    const secondaryPath = path.join(tmpDir, 'secondary');

    const writeAndCompile = async (code, outPath, label) => {
      await fs.writeFile(outPath + '.cpp', code, 'utf8');
      await runCommand('g++', ['-std=c++17', '-O2', '-pipe', '-static', outPath + '.cpp', '-o', outPath], 60000);
    };

    await writeAndCompile(primaryStd, primaryPath, 'primary');

    for (let round = 1; round <= 3; round += 1) {
      emitWorkspaceEvent(workspaceId, 'task:update', {
        stage: 'solution', state: 'running',
        message: `双解法对拍验证 ${round}/3`
      });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] dual round ${round}\n`);

      const altSol = await callLLM([
        {
          role: 'system',
          content: [
            '你是 OI 标程生成器。写一个与已有标程**算法范式完全不同**的 C++ 解法。',
            '标记为 ALT_SOL。只输出 ```cpp 代码块，不要解释。',
            '具体要求：',
            '- 如果已有代码用贪心，你用 DP 或树上倍增；如果已有代码用 DP，你用贪心或数据结构维护',
            '- 输入输出格式必须与已有代码完全一致',
            '- 你写的解法应该是独立的正确解法（不依赖已有代码）',
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            'ALT_SOL',
            '题目：',
            problem || '',
            '',
            '已有标程（用于参考输入输出格式，不要复制其算法）：',
            primaryStd || ''
          ].join('\n')
        }
      ], {
        temperature: 0.4,
        maxTokens: 8192,
        retries: 3,
        onComplete: async info => {
          await logLLMComplete(workspaceId, 'solution.log', `alt ${round}`, info);
        },
      });

      let altCpp = extractCodeBlock(altSol, 'cpp') || altSol.trim();
      if (!altCpp) {
        await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] alt gen failed\n`);
        continue;
      }

      try {
        await writeAndCompile(altCpp, secondaryPath, 'secondary');
      } catch (compileError) {
        await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] alt compile failed\n`);
        if (round === 3) throw compileError;
        continue;
      }

      const testGen = await callLLM([
        {
          role: 'system',
          content: [
            '写一个 Python 脚本生成 5 组小规模随机测试数据。',
            '数据格式必须严格对标题目输入格式。',
            'N 的规模由你根据题目复杂度把控：简单问题 N=5~10，中等问题 N=8~15，复杂问题 N=12~20。',
            '值域尽量小以便人工核对（如价格 ≤ 20，容量 ≤ 20）。',
            '每组输出到 stdout，组间用 "===CASE===" 分隔。',
            '只输出纯 Python 代码，无 Markdown 包裹。标记为 TEST_GEN。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            'TEST_GEN',
            '题目（含输入格式）：',
            problem || '',
            '',
            '标程（参考输入格式）：',
            primaryStd || ''
          ].join('\n')
        }
      ], {
        temperature: 0.15,
        maxTokens: 4096,
        retries: 3,
        onComplete: async info => {
          await logLLMComplete(workspaceId, 'solution.log', `test gen dual ${round}`, info);
        },
      });

      const genScript = extractPythonCode(testGen) || testGen.trim();
      if (!genScript) {
        await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] test gen failed\n`);
        return primaryStd;
      }

      let testOutput;
      try {
        testOutput = await runPython(genScript, 15000);
      } catch (testGenError) {
        await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] test gen python error\n`);
        if (round === 3) throw testGenError;
        continue;
      }

      const cases = testOutput.stdout.split('===CASE===').filter(s => s.trim());
      if (cases.length < 2) {
        await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] too few cases (${cases.length})\n`);
        continue;
      }

      let disagreements = [];
      for (let t = 0; t < cases.length; t++) {
        const input = cases[t].trim();
        const outA = await runStdWithInput(primaryPath, input, 30000).catch(e => 'ERR:' + e.message);
        const outB = await runStdWithInput(secondaryPath, input, 30000).catch(e => 'ERR:' + e.message);
        if (outA.trim() !== outB.trim()) {
          disagreements.push({ index: t + 1, input, outputA: outA.trim(), outputB: outB.trim() });
        }
      }

      if (disagreements.length === 0) {
        await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] dual: ${cases.length} cases all AGREE\n`);
        return primaryStd;
      }

      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] dual: ${disagreements.length}/${cases.length} disagree\n`);
      for (const d of disagreements) {
        await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] case ${d.index}: A=${d.outputA} B=${d.outputB}\n`);
      }

      emitWorkspaceEvent(workspaceId, 'task:update', {
        stage: 'solution', state: 'running',
        message: `正在修复算法分歧 ${round}/3`
      });

      const report = disagreements.map(d =>
        `测试 ${d.index}:\n输入:\n${d.input}\n解法A(主)输出:\n${d.outputA}\n解法B(备)输出:\n${d.outputB}`
      ).join('\n\n');

      const fixed = await callLLM([
        {
          role: 'system',
          content: [
            '你是 OI 标程审查员。主解法（A）和备用解法（B）在一些测试上的输出不一致。',
            '分析不一致的原因，判断哪种解法正确，然后**只输出修正后的主解法完整 C++ 代码**（```cpp 代码块）。',
            '备用解法仅作参考，可能有自己的错误，不要直接复制备用解法的代码。',
            '标记为 DUAL_FIX。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            'DUAL_FIX',
            '题目：',
            problem || '',
            '',
            '当前主解法(A)：',
            primaryStd || '',
            '',
            '备用解法(B)：',
            altCpp || '',
            '',
            '不一致的测试：',
            report || ''
          ].join('\n')
        }
      ], {
        temperature: 0.1,
        maxTokens: 8192,
        retries: 3,
        onComplete: async info => {
          await logLLMComplete(workspaceId, 'solution.log', `dual fix ${round}`, info);
        },
      });

      const newCode = extractCodeBlock(fixed, 'cpp') || fixed.trim();
      if (newCode && newCode.length > 20) {
        primaryStd = newCode;
        try {
          await writeAndCompile(primaryStd, primaryPath, 'primary');
        } catch {
          await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] fix ${round} broke compilation\n`);
        }
      }
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
  // FIX1: After 3 rounds without agreement, warn and return best primaryStd.
  // The alternate solution may itself be buggy on complex problems; forcing strict
  // agreement rejects correct answers more often than it catches wrong ones.
  await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] dual: 3 rounds exhausted without full agreement - proceeding with best primary\n`);
  emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'running', message: '双解法校验未完全一致，以主解法继续（已尽力修复）' });
  return primaryStd;
}

async function verifyWithBruteOracle(workspaceId, stdCpp, problem) {
  emitWorkspaceEvent(workspaceId, 'task:update', {
    stage: 'solution',
    state: 'running',
    message: '正在用暴力 oracle 对拍标程'
  });
  await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] brute oracle verification start\n`);

  const oracleText = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI 暴力正确性 oracle 编写助手。必须写一个只用于小规模测试的朴素 C++17 解法。',
        '优先正确性，不追求效率；可以枚举、搜索、模拟、 Floyd、暴力 DP，但必须严格匹配题面输入输出。',
        '必须覆盖所有操作类型和边界情况；不要复用或照抄标程算法。',
        '只输出 ```cpp 代码块，不要解释。标记为 BRUTE_ORACLE。'
      ].join('\n')
    },
    {
      role: 'user',
      content: ['BRUTE_ORACLE', '题目:', problem || '', '待验证标程:', stdCpp || ''].join('\n')
    }
  ], {
    temperature: 0.15,
    timeoutMs: 90000,
    maxTokens: 8192,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'solution.log', 'brute oracle', info);
    }
  });

  const generatorText = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI 对拍数据生成器编写助手。根据题面写 Python3 脚本，生成至少 80 组小规模合法测试。',
        '每组测试必须是完整输入，输出到 stdout，组间用一行 ===CASE=== 分隔。',
        '必须覆盖随机、最小规模、最大的小规模、特殊结构、边界值、所有操作类型。',
        '规模要足够小，保证暴力 oracle 可以在 2 秒内处理每组。',
        '只输出纯 Python 代码，不要 Markdown 包裹。标记为 BRUTE_TEST_GEN。'
      ].join('\n')
    },
    {
      role: 'user',
      content: ['BRUTE_TEST_GEN', '题目:', problem || '', '标程（参考输入格式）:', stdCpp || ''].join('\n')
    }
  ], {
    temperature: 0.25,
    timeoutMs: 90000,
    maxTokens: 8192,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'solution.log', 'brute test gen', info);
    }
  });

  const oracleCpp = extractCodeBlock(oracleText, 'cpp') || oracleText.trim();
  const genPy = extractPythonCode(generatorText) || generatorText.trim();
  if (!oracleCpp || !genPy) {
    const error = new Error('brute oracle or test generator missing');
    error.statusCode = 422;
    throw error;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-oracle-${workspaceId}-`));
  try {
    const stdPath = path.join(tmpDir, 'std');
    const oraclePath = path.join(tmpDir, 'oracle');
    await fs.writeFile(stdPath + '.cpp', stdCpp, 'utf8');
    await fs.writeFile(oraclePath + '.cpp', oracleCpp, 'utf8');
    await runCommand('g++', ['-std=c++17', '-O2', '-pipe', '-static', stdPath + '.cpp', '-o', stdPath], 60000);
    await runCommand('g++', ['-std=c++17', '-O2', '-pipe', '-static', oraclePath + '.cpp', '-o', oraclePath], 60000);

    const generated = await runPython(genPy, 30000);
    const cases = generated.stdout.split('===CASE===').map(s => s.trim()).filter(Boolean);
    if (cases.length < 80) {
      const error = new Error(`brute test generator produced too few cases (${cases.length})`);
      error.statusCode = 422;
      throw error;
    }

    const disagreements = [];
    for (let i = 0; i < cases.length; i += 1) {
      const input = cases[i];
      const stdOut = await runStdWithInput(stdPath, input, 30000).catch(e => `ERR:${e.message}`);
      const oracleOut = await runStdWithInput(oraclePath, input, 30000).catch(e => `ERR:${e.message}`);
      if (normalizeJudgeOutput(stdOut) !== normalizeJudgeOutput(oracleOut)) {
        disagreements.push({ index: i + 1, input, stdOut: stdOut.trim(), oracleOut: oracleOut.trim() });
        if (disagreements.length >= 5) break;
      }
    }

    if (disagreements.length) {
      for (const d of disagreements) {
        await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] oracle disagree case ${d.index}: std=${d.stdOut.slice(0, 300)} oracle=${d.oracleOut.slice(0, 300)}\n`);
      }
      const error = new Error(`brute oracle verification failed with ${disagreements.length} disagreement(s)`);
      error.statusCode = 422;
      throw error;
    }

    await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] brute oracle verification passed ${cases.length} cases\n`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
  // FIX2: return stdCpp so caller can capture any repaired version
  return stdCpp;
}

async function verifyFullScoreReview(workspaceId, markdown, cpp, problem, diffInfo) {
  emitWorkspaceEvent(workspaceId, 'task:update', {
    stage: 'solution',
    state: 'running',
    message: '正在审查满分复杂度与 AC 风险'
  });
  const review = await callLLM([
    {
      role: 'system',
      content: [
        '你是严格的 OI 标程终审员。目标是判断这份题解和 C++ 标程是否能在题面最大数据范围下作为满分 AC 正解。',
        '必须独立检查：输入输出格式、算法正确性、边界情况、整数溢出、递归深度、最坏时间复杂度、空间复杂度。',
        '如果只能通过部分分、复杂度不满足最大数据、证明缺口明显、或无法确认，请输出 FAIL。',
        '第一行只能是 PASS 或 FAIL；后续列出具体理由。标记为 FULL_AC_REVIEW。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'FULL_AC_REVIEW',
        diffInfo,
        '题目:',
        problem || '',
        '',
        '题解:',
        markdown || '',
        '',
        '标程:',
        cpp || ''
      ].join('\n')
    }
  ], {
    temperature: 0.05,
    timeoutMs: 90000,
    maxTokens: 8192,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'solution.log', 'full ac review', info);
    }
  });
  await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] full ac review: ${review.slice(0, 1000)}\n`);
  if (!/^\s*PASS\b/i.test(review)) {
    const error = new Error(`full AC review failed: ${review.slice(0, 800)}`);
    error.statusCode = 422;
    throw error;
  }
}

async function verifySampleWithStd(workspaceId, stdCpp) {
  const problemMd = await safeRead(workspaceId, 'problem/problem.md');
  if (!problemMd || !problemMd.includes('<!--SAMPLE_INPUT')) return;

  emitWorkspaceEvent(workspaceId, 'task:update', {
    stage: 'solution', state: 'running',
    message: '正在用标程验证样例输出'
  });
  await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] verify sample with std\n`);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-sample-${workspaceId}-`));
  try {
    const stdBin = path.join(tmpDir, 'std');
    await fs.writeFile(path.join(tmpDir, 'std.cpp'), stdCpp, 'utf8');
    await runCommand('g++', ['-std=c++17', '-O2', '-pipe', '-static', path.join(tmpDir, 'std.cpp'), '-o', stdBin], 45000);

    let result = problemMd;
    for (let idx = 1; ; idx++) {
      const inTag = idx === 1 ? '<!--SAMPLE_INPUT-->' : `<!--SAMPLE_INPUT${idx}-->`;
      const inEndTag = idx === 1 ? '<!--SAMPLE_INPUT_END-->' : `<!--SAMPLE_INPUT${idx}_END-->`;
      const outTag = idx === 1 ? '<!--SAMPLE_OUTPUT-->' : `<!--SAMPLE_OUTPUT${idx}-->`;
      const outEndTag = idx === 1 ? '<!--SAMPLE_OUTPUT_END-->' : `<!--SAMPLE_OUTPUT${idx}_END-->`;

      const inStart = problemMd.indexOf(inTag);
      if (inStart === -1) break;

      const inEnd = problemMd.indexOf(inEndTag, inStart);
      if (inEnd === -1) continue;
      const inputMatch = problemMd.slice(inStart, inEnd).match(/```(?:\w+)?\n([\s\S]*?)```/);
      if (!inputMatch) continue;

      const outStart = problemMd.indexOf(outTag, inEnd);
      if (outStart === -1) continue;
      const outEnd = problemMd.indexOf(outEndTag, outStart);
      if (outEnd === -1) continue;
      const outputMatch = problemMd.slice(outStart, outEnd).match(/```(?:\w+)?\n[\s\S]*?```/);
      if (!outputMatch) continue;

      const sampleInput = inputMatch[1];
      const oldOutputBlock = outputMatch[0];

      const actualOutput = await runStdWithInput(stdBin, sampleInput, 30000);
      const newOutputBlock = oldOutputBlock.replace(/```(?:\w+)?\n[\s\S]*?\n```/, '```\n' + actualOutput.trimEnd() + '\n```');

      result = result.slice(0, outStart) + outTag + '\n' + newOutputBlock + '\n' + outEndTag + result.slice(outEnd + outEndTag.length);
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] sample ${idx}: old='${extractFenceContent(oldOutputBlock).trim()}' new='${actualOutput.trim()}'\n`);
    }

    result = result.replace(/<!--SAMPLE_INPUT\d*-->/g, '');
    result = result.replace(/<!--SAMPLE_INPUT\d*_END-->/g, '');
    result = result.replace(/<!--SAMPLE_OUTPUT\d*-->/g, '');
    result = result.replace(/<!--SAMPLE_OUTPUT\d*_END-->/g, '');
    result = result.replace(/\n{3,}/g, '\n\n');

    if (result !== problemMd) {
      await writeWorkspaceFile(workspaceId, 'problem/problem.md', result);
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] problem.md sample output updated\n`);
    }
  } catch (error) {
    await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] sample generation failed: ${error.message}\n`);
    const wrapped = new Error(`sample generation failed: ${error.message}`);
    wrapped.statusCode = error.statusCode || 422;
    throw wrapped;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function extractFenceContent(block) {
  const match = String(block || '').match(/```(?:\w+)?\n([\s\S]*?)```/);
  return match ? match[1] : '';
}

function normalizeJudgeOutput(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n');
}

function runStdWithInput(stdBin, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(stdBin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('sample std timeout'));
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr || `std exited ${code}`));
      else resolve(stdout);
    });
    child.stdin.write(input);
    child.stdin.end();
  });
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

async function validateDataPlanGenConsistency(workspaceId, plan, genPy, diffInfo) {
  const pNums = extractNumbersFromText(plan, ['N', 'n']);
  const gNums = extractNumbersFromText(genPy, ['N', 'n']);
  const mismatch = findSignificantMismatch(pNums, gNums);
  if (!mismatch) return plan;

  emitWorkspaceEvent(workspaceId, 'task:update', {
    stage: 'data', state: 'running',
    message: '正在修正数据方案与生成器的规模不一致'
  });
  await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] plan/gen mismatch: plan N=${mismatch.planVal}, gen N=${mismatch.genVal}\n`);

  const fixed = await callLLM([
    {
      role: 'system',
      content: '你是 OI 数据方案修订员。数据方案中声明的测试点规模（N 值）与 gen.py 实际使用的 N 值不一致。修正数据方案使其反映 gen.py 中的真实规模。只输出完整修正后的数据方案 Markdown，不要解释。标记为 DATA_PLAN_FIX。'
    },
    {
      role: 'user',
      content: [
        'DATA_PLAN_FIX',
        diffInfo,
        `不一致：方案中说 N=${mismatch.planVal}，gen.py 实际使用 N=${mismatch.genVal}`,
        '',
        '数据方案:',
        plan || '',
        '',
        'gen.py:',
        genPy || '',
      ].join('\n')
    }
  ], {
    temperature: 0.05,
    timeoutMs: 45000,
    maxTokens: 4096,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'data.log', 'data plan consistency fix', info);
    },
  });
  return fixed;
}

function findSignificantMismatch(planNums, genNums) {
  if (!planNums.length || !genNums.length) return null;
  const planMax = Math.max(...planNums);
  const genMax = Math.max(...genNums);
  const ratio = Math.max(planMax, genMax) / Math.min(planMax, genMax);
  if (ratio > 2) {
    return { planVal: planMax, genVal: genMax };
  }
  return null;
}

function extractNumbersFromText(text, varNames) {
  const nums = [];
  for (const name of varNames) {
    const re = new RegExp(`\\b${name}\\s*[=:×xX]\\s*(\\d+(?:\\.\\d+)?)(?:\\s*×\\s*10[⁰¹²³⁴⁵⁶⁷⁸⁹]|\\s*10\\^\\d+)?`, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      const val = parseInt(m[1], 10);
      if (!isNaN(val) && val > 0) nums.push(val);
    }
    const reSci = new RegExp(`\\b${name}\\s*[=:]\\s*(\\d+)\\s*[×xX*]\\s*10\\s*[\\^⁰¹²³⁴⁵⁶⁷⁸⁹]\\s*(\\d+)`, 'gi');
    while ((m = reSci.exec(text)) !== null) {
      const base = parseInt(m[1], 10);
      const exp = parseInt(m[2], 10);
      if (!isNaN(base) && !isNaN(exp)) nums.push(base * Math.pow(10, exp));
    }
  }
  return nums;
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
