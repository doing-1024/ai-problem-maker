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

const PROBLEM_PIPELINE_VERSION = 'contract-first-workflow-v1';
const SOLUTION_PIPELINE_VERSION = 'verified-std-workflow-v1';
const DATA_PIPELINE_VERSION = 'data-bundle-workflow-v1';
const ORIGINAL_PROBLEM_PIPELINE_VERSION = 'original-candidate-tournament-v1';
const PROBLEM_CANDIDATE_COUNT = Math.max(1, envInt('PROBLEM_CANDIDATE_COUNT', 5));
const PROBLEM_CANDIDATE_CONCURRENCY = Math.max(1, envInt('PROBLEM_CANDIDATE_CONCURRENCY', PROBLEM_CANDIDATE_COUNT));
const BRUTE_ORACLE_MIN_CASES = envInt('BRUTE_ORACLE_MIN_CASES', 200);
const COUNTEREXAMPLE_MIN_CASES = envInt('COUNTEREXAMPLE_MIN_CASES', 40);
const SOLUTION_VERIFICATION_LEVEL = envChoice('SOLUTION_VERIFICATION_LEVEL', 'standard', ['fast', 'standard', 'strict']);
const SOLUTION_MAX_CANDIDATES = Math.max(1, envInt('SOLUTION_MAX_CANDIDATES', 3));
const SOLUTION_REVIEW_ROUNDS = Math.max(1, envInt('SOLUTION_REVIEW_ROUNDS', 3));
const SOLUTION_TIME_BUDGET_MS = Math.max(60_000, envInt('SOLUTION_TIME_BUDGET_MS', 10 * 60 * 1000));
const SOLUTION_REDESIGN_ROUNDS = Math.max(0, envIntAllowZero('SOLUTION_REDESIGN_ROUNDS', 2));
const PROVIDER_METHOD_FALLBACK_COOLDOWN_MS = envInt('PROVIDER_METHOD_FALLBACK_COOLDOWN_MS', 60_000);
const JOINT_DESIGN_COMPACT_FIRST = envBool('JOINT_DESIGN_COMPACT_FIRST', true);
const INDEPENDENT_ORACLE_CASES = envInt('INDEPENDENT_ORACLE_CASES', 60);

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envIntAllowZero(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function envChoice(name, fallback, choices) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  return choices.includes(value) ? value : fallback;
}

function envBool(name, fallback) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function setSolutionProgress(workspaceId, message) {
  await setState(workspaceId, 'solution', 'running', message);
  emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'running', message });
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
    return generateProblemContractFirst(workspaceId, payload);
    try {
      const source = payload.sourceText || (await safeRead(workspaceId, 'input/problem_raw.md'));
      assertValidText(source, '题面为空或过短');
      const fingerprint = hashText(
        JSON.stringify({
          source,
          version: PROBLEM_PIPELINE_VERSION,
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
            '- 提升难度必须以“可写出清晰满分标程”为边界：不要为了贴近目标难度堆叠过多维状态、树/图嵌套、非线性损耗、自由排列、浮点和多阶段限制。若需要提升，只增加 1 个核心难点，并保持输入格式、状态定义和转移可以被 200 行以内 C++17 稳定实现。',
            '- 对原题包含浮点/无解/最小费用等高风险细节时，改编题优先保持线性结构或小规模状态空间，避免同时引入树形遍历、任意顺序、复杂四舍五入和多种容量约束。',
            '- 可靠性硬约束：如果设计容量/能量 DP，必须保证状态数 N*C 或 事件数*C 不超过 2e7；若数据范围更大，算法草案必须给出明确可实现的 O(N log N) 或 O(N log C) 转移，不能只写“线段树优化/单调队列优化”而不给出可验证转移。',
            '- 算法契约要求：复杂题可以使用树、图、动态查询、容量/能量、数据结构复合等任意题型，但算法草案必须写清楚可验证契约：状态含义、转移/合并规则、不变量或单调性来源、复杂度推导、容易错的反例边界。只写算法名（如 HLD、DFN、线段树优化、二分、单调队列）不算契约。',
            '- 若使用路径/区间数据结构维护 DP 或贪心状态，必须说明每个节点保存什么信息、两个相邻片段如何合并，以及为什么合并满足结合律/可组合性；若依赖二分或 DFN 顺序，必须说明单调性或顺序性质。',
            '- 不要设计“每站至多一次购买、正整数购买、到站截断、跨点倍增”等多限制叠加题；这类题很容易使 std.cpp 和题解不稳定。',
            '',
            '你必须在同一次连续设计中同时给出题面、满分算法草案和 C++17 标程种子，三者必须完全一致。',
            '第一轮输出题面和算法草案；随后会在同一对话上下文中继续要求你输出 std.cpp。',
            '第一轮输出格式必须使用以下 HTML 注释分段，不能省略任何分段：',
            '<!--PROBLEM_MD-->',
            '完整 Markdown 题面',
            '<!--PROBLEM_MD_END-->',
            '<!--ALGORITHM_MD-->',
            '完整算法草案 Markdown',
            '<!--ALGORITHM_MD_END-->',
            '',
            '题面结构固定为：',
            '# 标题',
            '## 题意',
            '## 输入格式',
            '## 输出格式',
            '## 样例',
            '## 数据范围与提示',
            '不得省略任何一节。标记为 JOINT_PROBLEM_DESIGN。',
            '算法草案必须包含：# 算法草案、## 题目重述、## 难度命中理由、## 约束提取、## 算法选择、## 正确性要点、## 复杂度目标、## 高风险反例。',
            '整体输出要紧凑：题面不超过 1800 字，算法草案不超过 1200 字，避免超长解释。',
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
      'JOINT_PROBLEM_DESIGN',
      `难度模式: ${difficultyMode}`,
      `难度说明: ${payload.difficultyText || ''}`,
      `用户难度要求: ${difficultyInstruction}`,
      `改编策略: ${adaptationInstruction}`,
      '工程可验证性要求: 题面必须能稳定生成、编译和验证满分 C++17 标程；同一轮输出的算法草案和 std.cpp 必须能证明题面难度与可靠性。若使用 DP，请显式控制状态总量；不要设计 N*C=1e10 但声称可用线段树优化的题。',
      `难度分级参考：`,
            DIFFICULTY_TAXONOMY,
            'SOURCE_TEXT:',
            source || ''
          ].join('\n')
        }
      ];
      let designMessages = JOINT_DESIGN_COMPACT_FIRST
        ? buildCompactJointDesignPrompt({ source, difficultyMode, difficultyInstruction, adaptationInstruction })
        : prompt;
      let designText;
      try {
        if (JOINT_DESIGN_COMPACT_FIRST) {
          await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] using compact joint design first\n`);
          emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'problem', state: 'running', message: '正在使用紧凑联合设计' });
        }
        designText = await callLLM(designMessages, {
          temperature: 0.3,
          maxTokens: 4096,
          retries: 5,
          retryMethodErrors: JOINT_DESIGN_COMPACT_FIRST,
          onComplete: async info => {
            await logLLMComplete(workspaceId, 'problem.log', 'problem draft', info);
          },
          onRetry: async ({ attempt, retries, error, waitMs }) => {
            const waitSeconds = Math.ceil((waitMs || 0) / 1000);
            const isRateLimited = /429|too many requests/i.test(error.message || '');
            const message = isRateLimited
              ? `供应商限流，等待 ${waitSeconds} 秒后重试 ${attempt + 1}/${retries}`
              : `题目生成重试 ${attempt + 1}/${retries}`;
            emitWorkspaceEvent(workspaceId, 'task:update', {
              stage: 'problem',
              state: 'running',
              message
            });
            await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] retry ${attempt + 1}/${retries} after ${waitSeconds}s: ${error.message}\n`);
          }
        });
      } catch (error) {
        if (!isProviderMethodError(error)) throw error;
        await appendWorkspaceLog(
          workspaceId,
          'problem.log',
          `[${stamp()}] joint design primary prompt failed with provider method error, cooldown ${PROVIDER_METHOD_FALLBACK_COOLDOWN_MS}ms before compact prompt\n`
        );
        await setState(workspaceId, 'problem', 'running', '供应商路由异常，等待后切换兼容模式');
        emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'problem', state: 'running', message: '供应商路由异常，等待后切换兼容模式' });
        await sleep(PROVIDER_METHOD_FALLBACK_COOLDOWN_MS);
        emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'problem', state: 'running', message: '正在使用兼容模式联合设计' });
        designMessages = buildCompactJointDesignPrompt({ source, difficultyMode, difficultyInstruction, adaptationInstruction });
        designText = await callLLM(designMessages, {
          temperature: 0.25,
          maxTokens: 4096,
          retries: 5,
          onComplete: async info => {
            await logLLMComplete(workspaceId, 'problem.log', 'compact joint design', info);
          },
          onRetry: async ({ attempt, retries, error, waitMs }) => {
            const waitSeconds = Math.ceil((waitMs || 0) / 1000);
            emitWorkspaceEvent(workspaceId, 'task:update', {
              stage: 'problem',
              state: 'running',
              message: `兼容模式限流，等待 ${waitSeconds} 秒后重试 ${attempt + 1}/${retries}`
            });
            await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] compact joint retry ${attempt + 1}/${retries} after ${waitSeconds}s: ${error.message}\n`);
          }
        });
      }
      let design = parseJointDesignBundle(designText);
      design.algorithm = await ensureAlgorithmReliabilityContractWithRepair(workspaceId, {
        problem: design.problem,
        algorithm: design.algorithm,
        difficultyInstruction,
        difficultyMode,
        logName: 'problem.log',
        label: 'initial joint algorithm'
      });
      const originalDesignProblem = design.problem;
      let cppText = '';
      try {
        cppText = await callLLM([
          ...designMessages,
          { role: 'assistant', content: designText },
          {
            role: 'user',
            content: [
              'JOINT_STD_CPP',
              '请基于上面你刚设计的题面和算法草案，继续输出完整 C++17 标程源码。',
              '只输出纯 C++17 源码，不要 Markdown 代码块，不要解释。',
              '必须可独立编译，必须包含 main，输入输出严格匹配题面，代码尽量简洁，不超过 220 行。'
            ].join('\n')
          }
        ], {
        temperature: 0.15,
        maxTokens: 8192,
        retries: 5,
        onComplete: async info => {
          await logLLMComplete(workspaceId, 'problem.log', 'joint std seed', info);
        },
        onRetry: async ({ attempt, retries, error }) => {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'problem',
            state: 'running',
            message: `联合标程种子重试 ${attempt + 1}/${retries}`
          });
          await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] joint std retry ${attempt + 1}/${retries}: ${error.message}\n`);
        }
      });
      } catch (error) {
        if (!isProviderMethodError(error)) throw error;
        await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] joint std seed skipped after provider method error; solution stage will regenerate std.cpp\n`);
      }
      design.cpp = design.cpp || sanitizeCppCode(cppText);
      let content = design.problem;
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
      if (design.algorithm) {
        design.algorithm = await ensureAlgorithmReliabilityContractWithRepair(workspaceId, {
          problem: content,
          algorithm: design.algorithm,
          difficultyInstruction,
          difficultyMode,
          logName: 'problem.log',
          label: 'reviewed problem algorithm'
        });
      }
      if (jointArtifactsNeedRealignment(originalDesignProblem, content, design)) {
        await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] final problem changed after review; regenerating aligned algorithm/std seed\n`);
        emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'problem', state: 'running', message: '正在对齐最终题面、思路和标程种子' });
        design.algorithm = '';
        design.cpp = '';
        try {
          const aligned = await generateAlignedJointArtifacts(workspaceId, {
            problem: content,
            difficultyInstruction,
            difficultyMode
          });
          design.algorithm = aligned.algorithm;
          design.cpp = aligned.cpp;
        } catch (error) {
          await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] aligned artifacts skipped: ${error.message}\n`);
        }
      }
      content = sanitizeMarkdownArtifact(content);
      await writeWorkspaceFile(workspaceId, 'problem/problem.md', content);
      if (design.algorithm) {
        design.algorithm = sanitizeMarkdownArtifact(design.algorithm);
        design.algorithm = await ensureAlgorithmReliabilityContractWithRepair(workspaceId, {
          problem: content,
          algorithm: design.algorithm,
          difficultyInstruction,
          difficultyMode,
          logName: 'problem.log',
          label: 'final algorithm'
        });
        await writeWorkspaceFile(workspaceId, 'solution/algorithm.md', design.algorithm);
        emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'algorithm', text: design.algorithm });
      }
      if (design.cpp) {
        await writeWorkspaceFile(workspaceId, 'solution/std.cpp', design.cpp);
        emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'std', text: design.cpp });
      }
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

async function generateProblemContractFirst(workspaceId, payload = {}) {
  return generateOriginalProblemTournament(workspaceId, payload);
}

async function generateOriginalProblemTournament(workspaceId, payload = {}) {
  try {
    const difficultyMode = payload.difficultyMode || 'custom';
    const difficultyInstruction = buildOriginalDifficultyInstruction(payload.difficultyText || '', difficultyMode);
    const fingerprint = hashText(JSON.stringify({
      version: ORIGINAL_PROBLEM_PIPELINE_VERSION,
      candidateCount: PROBLEM_CANDIDATE_COUNT,
      difficultyMode,
      difficultyText: payload.difficultyText || ''
    }));
    const meta = await getWorkspaceMetaInternal(workspaceId);
    if (
      meta?.jobs?.problem?.fingerprint === fingerprint &&
      await exists(workspaceId, 'problem/problem.md') &&
      await exists(workspaceId, 'solution/algorithm.md') &&
      await exists(workspaceId, 'solution/std.cpp')
    ) {
      return { path: 'problem/problem.md', content: await readWorkspaceFile(workspaceId, 'problem/problem.md'), cached: true };
    }

    await setState(workspaceId, 'problem', 'running', `正在并发生成 ${PROBLEM_CANDIDATE_COUNT} 个原创候选`);
    emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'problem', state: 'running', message: `正在并发生成 ${PROBLEM_CANDIDATE_COUNT} 个原创候选` });
    await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] start original tournament ${ORIGINAL_PROBLEM_PIPELINE_VERSION} count=${PROBLEM_CANDIDATE_COUNT} concurrency=${PROBLEM_CANDIDATE_CONCURRENCY}\n`);

    const attempts = await runProblemCandidatePool(workspaceId, {
      difficultyInstruction,
      difficultyMode
    });
    const accepted = attempts
      .filter(item => item.state === 'accepted')
      .sort((a, b) => (b.score || 0) - (a.score || 0))[0];

    if (!accepted) {
      const verification = buildProblemTournamentReport({
        attempts,
        acceptedCandidate: null,
        difficultyInstruction,
        difficultyMode
      });
      await writeWorkspaceFile(workspaceId, 'solution/verification.md', verification);
      const lastFailure = attempts.map(a => `candidate ${a.candidate}: ${a.error || a.state}`).join('\n').slice(0, 2500);
      const error = new Error(`no original problem candidate passed gates\n${lastFailure}`);
      error.statusCode = 422;
      throw error;
    }

    const { problem, algorithm, cpp } = accepted.artifacts;
    const verification = buildProblemTournamentReport({
      attempts,
      acceptedCandidate: accepted.candidate,
      difficultyInstruction,
      difficultyMode
    });

    await writeWorkspaceFile(workspaceId, 'problem/problem.md', problem);
    await writeWorkspaceFile(workspaceId, 'solution/algorithm.md', algorithm);
    await writeWorkspaceFile(workspaceId, 'solution/std.cpp', cpp);
    await writeWorkspaceFile(workspaceId, 'solution/verification.md', verification);
    emitProblemPreview(workspaceId, problem);
    emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'algorithm', text: algorithm });
    emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'std', text: cpp });

    await saveJobResult(workspaceId, 'problem', fingerprint, {
      resultPath: 'problem/problem.md',
      pipelineVersion: ORIGINAL_PROBLEM_PIPELINE_VERSION,
      contractPaths: ['solution/algorithm.md', 'solution/std.cpp', 'solution/verification.md']
    });
    await updateWorkspaceMeta(workspaceId, {
      difficulty: {
        mode: difficultyMode,
        text: payload.difficultyText || '',
        instruction: difficultyInstruction
      }
    });
    await setState(workspaceId, 'problem', 'done', `原创候选 ${accepted.candidate} 已通过硬门`);
    emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'problem', state: 'done', message: `原创候选 ${accepted.candidate} 已通过硬门` });
    await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] done accepted=${accepted.candidate} score=${accepted.score}\n`);
    return { path: 'problem/problem.md', content: problem, cached: false };
  } catch (error) {
    await setState(workspaceId, 'problem', 'error', error.message || 'problem failed');
    emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'problem', state: 'error', message: error.message || 'problem failed' });
    await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] failed: ${error.message}\n`);
    throw error;
  }
}

async function runProblemCandidatePool(workspaceId, { difficultyInstruction, difficultyMode }) {
  const queue = Array.from({ length: PROBLEM_CANDIDATE_COUNT }, (_, i) => i + 1);
  const attempts = [];
  let active = 0;

  return new Promise(resolve => {
    const launch = () => {
      while (active < PROBLEM_CANDIDATE_CONCURRENCY && queue.length) {
        const candidate = queue.shift();
        active += 1;
        evaluateOriginalProblemCandidate(workspaceId, {
          candidate,
          difficultyInstruction,
          difficultyMode
        }).then(record => {
          attempts.push(record);
        }).catch(error => {
          attempts.push({
            candidate,
            state: 'rejected',
            error: String(error?.message || error || '').slice(0, 5000)
          });
        }).finally(() => {
          active -= 1;
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'problem',
            state: 'running',
            message: `候选池进度 ${attempts.length}/${PROBLEM_CANDIDATE_COUNT}`
          });
          if (!queue.length && active === 0) {
            attempts.sort((a, b) => a.candidate - b.candidate);
            resolve(attempts);
          } else {
            launch();
          }
        });
      }
    };
    launch();
  });
}

async function evaluateOriginalProblemCandidate(workspaceId, { candidate, difficultyInstruction, difficultyMode }) {
  const record = { candidate, state: 'rejected', gates: [], score: 0 };
  try {
    await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] candidate ${candidate} start\n`);
    const design = await generateValidOriginalCandidateDesign(workspaceId, {
      candidate,
      difficultyInstruction,
      difficultyMode
    });
    let problem = design.problem;
    let algorithm = design.algorithm;
    record.gates.push('problem-structure');
    record.gates.push('algorithm-shape');
    algorithm = await ensureAlgorithmReliabilityContractWithRepair(workspaceId, {
      problem,
      algorithm,
      difficultyInstruction,
      difficultyMode,
      logName: 'problem.log',
      label: `candidate ${candidate} algorithm`
    });
    record.gates.push('algorithm-contract');

    let cpp = await generateValidOriginalCandidateStd(workspaceId, { candidate, problem, algorithm });
    record.gates.push('std-compile');

    problem = await recomputeProblemSamplesWithStd(workspaceId, problem, cpp, { logName: 'problem.log', label: `candidate ${candidate}` });
    record.gates.push('sample-recomputed');

    await verifyIndependentOracleWithRetry(workspaceId, cpp, problem, { logName: 'problem.log', label: `candidate ${candidate}` });
    record.gates.push(`independent-oracle-${INDEPENDENT_ORACLE_CASES}+cases`);

    const score = normalizeProblemCandidateScore(design.score);
    record.score = score.total;
    record.scoreBreakdown = score;
    record.state = 'accepted';
    record.artifacts = { problem: removeInternalSampleMarkers(problem), algorithm, cpp };
    await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] candidate ${candidate} accepted score=${record.score}\n`);
    return record;
  } catch (error) {
    record.error = String(error?.message || error || '').slice(0, 5000);
    await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] candidate ${candidate} rejected: ${record.error}\n`);
    return record;
  }
}

async function generateValidOriginalCandidateDesign(workspaceId, { candidate, difficultyInstruction, difficultyMode }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const designRaw = await generateOriginalCandidateDesign(workspaceId, {
        candidate,
        difficultyInstruction,
        difficultyMode,
        attempt
      });
      const design = parseOriginalCandidateDesign(designRaw);
      const problem = sanitizeMarkdownArtifact(design.problem);
      const algorithm = sanitizeMarkdownArtifact(design.algorithm);
      ensureProblemMarkdownStructure(problem);
      ensureAlgorithmPlanLooksReasonable(algorithm);
      return { ...design, problem, algorithm };
    } catch (error) {
      lastError = error;
      await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] candidate ${candidate} design content retry ${attempt}/3: ${error.message}\n`);
    }
  }
  throw lastError || new Error('candidate design failed');
}

async function generateValidOriginalCandidateStd(workspaceId, { candidate, problem, algorithm }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const cppRaw = await generateOriginalCandidateStd(workspaceId, { candidate, problem, algorithm, attempt });
      const cpp = sanitizeCppCode(extractFlexibleSection(cppRaw, 'STD_CPP') || cppRaw);
      assertCppLooksReasonable(cpp);
      await verifyCppCompiles(workspaceId, cpp);
      return cpp;
    } catch (error) {
      lastError = error;
      await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] candidate ${candidate} std content retry ${attempt}/3: ${error.message}\n`);
    }
  }
  throw lastError || new Error('candidate std generation failed');
}

async function verifyIndependentOracleWithRetry(workspaceId, cpp, problem, { logName = 'problem.log', label = 'candidate' } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await verifyWithIndependentOracle(workspaceId, cpp, problem);
    } catch (error) {
      lastError = error;
      await appendWorkspaceLog(workspaceId, logName, `[${stamp()}] ${label} independent oracle retry ${attempt}/3: ${error.message}\n`);
      if (!isRetryableOracleFailure(error)) throw error;
    }
  }
  throw lastError || new Error('independent oracle verification failed');
}

function isRetryableOracleFailure(error) {
  return /missing oracle\.cpp|test generator|compile failed|not found|timeout|LLM request failed|502|503|504|Cloudflare|bad gateway/i.test(String(error?.message || ''));
}

async function generateOriginalCandidateDesign(workspaceId, { candidate, difficultyInstruction, difficultyMode, attempt = 1 }) {
  return callLLM([
    {
      role: 'system',
      content: [
        '你是资深 OI 原创出题工程师。你正在参加候选池锦标赛：候选题必须能被后续标程和 oracle 验证，不能靠修补半成品发布。',
        `难度分级参考：${DIFFICULTY_TAXONOMY}`,
        '必须全原创，不参考用户原题素材。不要输出解释性寒暄。',
        '优先唯一输出、整数答案、普通 stdin/stdout；避免交互、浮点误差和必须自定义 checker 的题。',
        '样例输出可以先写占位，后续会由通过编译的 std.cpp 自动重算；样例输入必须合法且足够小。',
        '算法合同必须写清状态/数据结构含义、转移或合并规则、正确性不变量、复杂度和高风险边界。',
        '题面不超过 1400 字，算法合同不超过 1000 字。',
        '输出第一行必须是 PROBLEM_MD_BEGIN，严格使用普通文本分段标记，不要用 Markdown 代码块包住整份回答。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'ORIGINAL_PROBLEM_CANDIDATE_DESIGN',
        `候选编号: ${candidate}`,
        `候选重试: ${attempt}/3`,
        `难度模式: ${difficultyMode}`,
        `目标难度: ${difficultyInstruction}`,
        '',
        '严格输出：',
        'PROBLEM_MD_BEGIN',
        '# 标题',
        '## 题意',
        '## 输入格式',
        '## 输出格式',
        '## 样例',
        '## 数据范围与提示',
        'PROBLEM_MD_END',
        'ALGORITHM_MD_BEGIN',
        '# 算法草案',
        '## 题目重述',
        '## 约束提取',
        '## 算法选择',
        '## 正确性要点',
        '## 复杂度目标',
        '## 高风险反例',
        'ALGORITHM_MD_END',
        'RISK_REPORT_MD_BEGIN',
        '正确性风险、数据构造风险和规避方式。',
        'RISK_REPORT_MD_END',
        'SCORE_JSON_BEGIN',
        '{"difficulty":0-10,"originality":0-10,"explainability":0-10,"dataCoverage":0-10,"riskPenalty":0-10}',
        'SCORE_JSON_END'
      ].join('\n')
    }
  ], {
    temperature: 0.5,
    timeoutMs: 150000,
    maxTokens: 9000,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'problem.log', `candidate ${candidate} design`, info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] candidate ${candidate} design retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
}

async function generateOriginalCandidateStd(workspaceId, { candidate, problem, algorithm, attempt = 1 }) {
  return callLLM([
    {
      role: 'system',
      content: [
        '你是 OI 标程工程师。只根据已冻结的题面和算法合同写完整 C++17 标程。',
        '只输出 C++17 源码或 STD_CPP_BEGIN/STD_CPP_END 分段，不要解释。必须包含 main，输入输出严格匹配题面。',
        '不要改变题意，不要修题面。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'ORIGINAL_PROBLEM_CANDIDATE_STD',
        `候选编号: ${candidate}`,
        `标程重试: ${attempt}/3`,
        '题面:',
        problem || '',
        '',
        '算法合同:',
        algorithm || '',
        '',
        '输出：',
        'STD_CPP_BEGIN',
        '完整 C++17 代码',
        'STD_CPP_END'
      ].join('\n')
    }
  ], {
    temperature: 0.12,
    timeoutMs: 150000,
    maxTokens: 9000,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'problem.log', `candidate ${candidate} std`, info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] candidate ${candidate} std retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
}

function parseOriginalCandidateDesign(raw) {
  const text = String(raw || '');
  const fallback = splitOriginalCandidateFallback(text);
  const problem = extractFlexibleSection(text, 'PROBLEM_MD') || fallback.problem;
  const algorithm = extractFlexibleSection(text, 'ALGORITHM_MD') || fallback.algorithm;
  const riskReport = extractFlexibleSection(text, 'RISK_REPORT_MD');
  const score = parseJsonOrDefault(extractJsonObject(extractFlexibleSection(text, 'SCORE_JSON')), {});
  if (!problem.trim() || !algorithm.trim()) {
    const error = new Error('candidate missing problem/algorithm section');
    error.statusCode = 422;
    throw error;
  }
  return { problem, algorithm, riskReport, score };
}

function splitOriginalCandidateFallback(text) {
  const raw = String(text || '').trim();
  const algorithmMatch = raw.match(/(?:^|\n)#\s*算法草案\b/);
  if (!algorithmMatch) return { problem: '', algorithm: '' };
  const algorithmStart = algorithmMatch.index + (raw[algorithmMatch.index] === '\n' ? 1 : 0);
  const problem = raw.slice(0, algorithmStart)
    .replace(/^\s*PROBLEM_MD_BEGIN\s*/i, '')
    .replace(/\s*PROBLEM_MD_END\s*$/i, '')
    .trim();
  let rest = raw.slice(algorithmStart);
  const riskIdx = rest.search(/\n(?:RISK_REPORT_MD_BEGIN|#\s*风险|##\s*风险|SCORE_JSON_BEGIN)\b/i);
  if (riskIdx !== -1) rest = rest.slice(0, riskIdx);
  rest = rest.replace(/\s*ALGORITHM_MD_END\s*$/i, '').trim();
  return { problem, algorithm: rest };
}

function extractFlexibleSection(text, name) {
  return extractBetween(text, `${name}_BEGIN`, `${name}_END`) ||
    extractBetween(text, `<!--${name}-->`, `<!--${name}_END-->`);
}

function normalizeProblemCandidateScore(score) {
  const difficulty = clampScore(score?.difficulty);
  const originality = clampScore(score?.originality);
  const explainability = clampScore(score?.explainability);
  const dataCoverage = clampScore(score?.dataCoverage);
  const riskPenalty = clampScore(score?.riskPenalty);
  return {
    difficulty,
    originality,
    explainability,
    dataCoverage,
    riskPenalty,
    total: Math.max(0, difficulty + originality + explainability + dataCoverage - riskPenalty)
  };
}

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(10, num));
}

function buildProblemTournamentReport({ attempts, acceptedCandidate, difficultyInstruction, difficultyMode }) {
  const lines = [
    '# 标程验证报告',
    '',
    `- Pipeline: ${ORIGINAL_PROBLEM_PIPELINE_VERSION}`,
    '- Mode: original-candidate-tournament',
    `- Generated at: ${stamp()}`,
    `- Target difficulty: ${difficultyInstruction}`,
    `- Difficulty mode: ${difficultyMode}`,
    `- Candidate count: ${attempts.length}`,
    `- Accepted candidate: ${acceptedCandidate || 'none'}`,
    '',
    '## 候选记录',
    ''
  ];
  for (const attempt of attempts) {
    lines.push(`### Candidate ${attempt.candidate}`);
    lines.push(`- State: ${attempt.state}`);
    lines.push(`- Score: ${attempt.score || 0}`);
    if (attempt.gates?.length) lines.push(`- Gates: ${attempt.gates.join(', ')}`);
    if (attempt.scoreBreakdown) lines.push(`- Score detail: ${JSON.stringify(attempt.scoreBreakdown)}`);
    if (attempt.error) {
      lines.push('- Error:');
      lines.push('```');
      lines.push(String(attempt.error).slice(0, 2000));
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function generateContractAlgorithmFromProblem(workspaceId, { problem, difficultyInstruction = '', difficultyMode = '', source = '' }) {
  const algorithm = await callLLM([
    {
      role: 'system',
      content: [
        '你是同一个 OI 出题 agent 的算法合同补全步骤。题面已经确定，现在只补全满分算法合同，不改题面。',
        '允许任意题型和算法范式；不要降低题目多样性。目标是把题面约束转成可审查、可实现、可验证的算法合同。',
        '输出 Markdown，必须包含且只包含这些主章节：',
        '# 算法草案',
        '## 题目重述',
        '## 约束提取',
        '## 算法选择',
        '## 正确性要点',
        '## 复杂度目标',
        '## 高风险反例',
        '算法选择必须写清状态/数据结构含义、转移或合并规则；正确性要点必须写关键不变量、单调性或归纳理由。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'CONTRACT_ALGORITHM_FROM_PROBLEM',
        `难度模式: ${difficultyMode}`,
        `目标难度: ${difficultyInstruction}`,
        '',
        '原题素材:',
        source || '',
        '',
        '最终题面:',
        problem || ''
      ].join('\n')
    }
  ], {
    temperature: 0.12,
    timeoutMs: 90000,
    maxTokens: 4096,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'problem.log', 'contract algorithm fallback', info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] contract algorithm retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
  const cleaned = sanitizeMarkdownArtifact(algorithm);
  ensureAlgorithmPlanLooksReasonable(cleaned);
  return cleaned;
}

async function generateStdSeedFromContract(workspaceId, { problem, algorithm }) {
  const cppText = await callLLM([
    {
      role: 'system',
      content: [
        '你是同一个 OI 出题 agent 的 C++ 标程种子补全步骤。只基于最终题面和算法合同写 C++17 满分标程。',
        '只输出纯 C++17 源码，不要 Markdown 代码块，不要解释。必须包含 main，输入输出严格匹配题面。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'CONTRACT_STD_SEED',
        '最终题面:',
        problem || '',
        '',
        '算法合同:',
        algorithm || ''
      ].join('\n')
    }
  ], {
    temperature: 0.1,
    timeoutMs: 90000,
    maxTokens: 8192,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'problem.log', 'contract std seed fallback', info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] contract std seed retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
  const cpp = sanitizeCppCode(cppText);
  assertCppLooksReasonable(cpp);
  return cpp;
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
            '4. 样例结构：必须有样例输入/输出代码块并保留 HTML 标记；样例输出数值会在 std.cpp 通过验证后自动重算替换，不要仅因样例算术不一致判 FAIL。',
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
    if (reviewPassed(critique)) {
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
            '必须确保：样例输入格式合法、样例输出代码块存在并保留标记；样例输出数值可作为占位，后续会由 std.cpp 自动重算替换，不要写长篇样例推演以免自相矛盾；',
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
  const remaining = getProblemMarkdownIssues(content);
  if (remaining.length) {
    emitWorkspaceEvent(workspaceId, 'task:update', {
      stage: 'problem',
      state: 'running',
      message: '正在强制重写完整题面'
    });
    await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] force rewrite incomplete problem: ${remaining.join(', ')}\n`);
    content = await callLLM(
      [
        {
          role: 'system',
          content: [
            '你是严格的 OI 题面重写助手。当前题面多轮补全后仍含占位或结构缺失，必须整篇重写为完整 Markdown 题面。',
            `难度分级参考：${DIFFICULTY_TAXONOMY}`,
            '只输出完整题面，不要解释。',
            '必须包含且只包含这些主章节：# 标题、## 题意、## 输入格式、## 输出格式、## 样例、## 数据范围与提示。',
            '样例必须包含输入和输出代码块，并保留 HTML 注释标记：<!--SAMPLE_INPUT-->, <!--SAMPLE_INPUT_END-->, <!--SAMPLE_OUTPUT-->, <!--SAMPLE_OUTPUT_END-->。',
            '严禁出现任何省略或占位表达，包括 ...、……、待补、待续、略、同上、依此类推、等。',
            '题面必须自洽，输入格式中的每个变量都要定义，数据范围中的每个变量都要给出限制。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `用户难度要求: ${difficultyInstruction}`,
            `改编策略: ${buildAdaptationInstruction(difficultyMode)}`,
            `当前遗留问题: ${remaining.join('；')}`,
            '原始题面:',
            source || '',
            '不完整题面:',
            content || ''
          ].join('\n')
        }
      ],
      {
        temperature: 0.08,
        timeoutMs: 90000,
        maxTokens: 8192,
        retries: 5,
        onComplete: async info => {
          await logLLMComplete(workspaceId, 'problem.log', 'problem force rewrite', info);
        },
        onRetry: async ({ attempt, retries, error }) => {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'problem',
            state: 'running',
            message: `完整题面重写重试 ${attempt + 1}/${retries}`
          });
          await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] force rewrite retry ${attempt + 1}/${retries}: ${error.message}\n`);
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
    text: String(content || '')
  });
}

function parseJointDesignBundle(text) {
  const raw = String(text || '');
  const problem = extractBetween(raw, '<!--PROBLEM_MD-->', '<!--PROBLEM_MD_END-->').trim();
  const algorithm = extractBetween(raw, '<!--ALGORITHM_MD-->', '<!--ALGORITHM_MD_END-->').trim();
  const cppBlock = extractBetween(raw, '<!--STD_CPP-->', '<!--STD_CPP_END-->').trim();
  const cpp = sanitizeCppCode(cppBlock);
  return {
    problem: problem || raw,
    algorithm,
    cpp
  };
}

function removeInternalSampleMarkers(text) {
  return String(text || '');
}

function jointArtifactsNeedRealignment(originalProblem, finalProblem, design) {
  if (!String(design?.algorithm || '').trim()) return true;
  const before = normalizeForComparison(originalProblem);
  const after = normalizeForComparison(finalProblem);
  return before && after && before !== after;
}

function normalizeForComparison(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function ensureAlgorithmReliabilityContractWithRepair(workspaceId, { problem, algorithm, difficultyInstruction = '', difficultyMode = '', logName = 'problem.log', label = 'algorithm' }) {
  algorithm = sanitizeMarkdownArtifact(algorithm || '');
  try {
    assertAlgorithmReliabilityContract(problem, algorithm);
    return algorithm;
  } catch (initialError) {
    await appendWorkspaceLog(workspaceId, logName, `[${stamp()}] ${label} reliability contract repair needed: ${initialError.message}\n`);
  }

  for (let round = 1; round <= 2; round += 1) {
    emitWorkspaceEvent(workspaceId, 'task:update', {
      stage: 'problem',
      state: 'running',
      message: `正在补强算法契约 ${round}/2`
    });
    const assessment = assessAlgorithmReliability(problem, algorithm);
    const repaired = await callLLM([
      {
        role: 'system',
        content: [
          '你是 OI 联合设计 agent 的算法契约修复器。只修复算法草案，不改题面。',
          '目标不是限制题型，而是让复杂题的满分算法足够具体、可审查、可实现。',
          '必须保留题面要求和目标难度；如果题面是树/图/动态查询/容量/能量/数据结构复合题，可以继续保留，但必须把算法契约讲清楚。',
          '输出 Markdown，必须包含：# 算法草案、## 题目重述、## 难度命中理由、## 约束提取、## 算法选择、## 正确性要点、## 复杂度目标、## 高风险反例。',
          '## 算法选择 必须明确状态含义、转移或合并规则；若用树链剖分/DFN/线段树/倍增维护路径或区间状态，必须说明片段保存信息和合并规则。',
          '## 正确性要点 必须说明不变量、单调性来源或合并可结合/可组合的原因；不能只写“显然正确”。',
          '## 高风险反例 必须列出会打破错误贪心、错误 DFN 顺序假设、边界容量/无解等场景。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          'ALGORITHM_CONTRACT_REPAIR',
          `难度模式: ${difficultyMode}`,
          `难度要求: ${difficultyInstruction}`,
          `可靠性评估: ${JSON.stringify(assessment)}`,
          '',
          '最终题面:',
          problem || '',
          '',
          '当前算法草案:',
          algorithm || ''
        ].join('\n')
      }
    ], {
      temperature: 0.12,
      timeoutMs: 90000,
      maxTokens: 4096,
      retries: 3,
      onComplete: async info => {
        await logLLMComplete(workspaceId, logName, `${label} contract repair ${round}`, info);
      },
      onRetry: async ({ attempt, retries, error }) => {
        await appendWorkspaceLog(workspaceId, logName, `[${stamp()}] ${label} contract repair retry ${attempt + 1}/${retries}: ${error.message}\n`);
      }
    });
    algorithm = sanitizeMarkdownArtifact(repaired);
    try {
      ensureAlgorithmPlanLooksReasonable(algorithm);
    } catch (shapeError) {
      await appendWorkspaceLog(workspaceId, logName, `[${stamp()}] ${label} contract repair ${round} shape warning: ${shapeError.message}\n`);
    }
    try {
      assertAlgorithmReliabilityContract(problem, algorithm);
      return algorithm;
    } catch (error) {
      await appendWorkspaceLog(workspaceId, logName, `[${stamp()}] ${label} contract repair ${round} still incomplete: ${error.message}\n`);
      if (round === 2) throw error;
    }
  }
  return algorithm;
}

async function generateAlignedJointArtifacts(workspaceId, { problem, difficultyInstruction, difficultyMode }) {
  const algorithm = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI 联合设计 agent 的收尾助手。现在题面已经经过审校修订，你必须只基于最终题面重新写算法草案。',
        '算法草案要服务于后续 std.cpp 生成，必须具体、可实现、和题面完全一致。',
        '不要引用旧题面、旧样例或旧变量名。标记为 FINAL_PROBLEM_ALGORITHM。',
        '可靠性硬约束：如果使用容量/能量 DP，必须核算状态总量并保证 N*C 或 事件数*C 不超过 2e7；若超过，必须改用明确可实现的优化算法或指出题面需降低范围。',
        '复杂题必须给出算法契约：状态含义、转移/合并规则、不变量或单调性来源、复杂度推导、反例边界。允许高复杂组合，但不能只写算法名称。',
        '如果用树链剖分、DFN、线段树、倍增等维护路径/区间状态，必须说明每个片段保存的信息、片段合并规则，以及合并为什么可结合/可组合。',
        '输出 Markdown，必须包含：# 算法草案、## 题目重述、## 难度命中理由、## 约束提取、## 算法选择、## 正确性要点、## 复杂度目标、## 高风险反例。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'FINAL_PROBLEM_ALGORITHM',
        `难度模式: ${difficultyMode}`,
        `难度要求: ${difficultyInstruction}`,
        '最终题面:',
        problem || ''
      ].join('\n')
    }
  ], {
    temperature: 0.15,
    maxTokens: 4096,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'problem.log', 'aligned algorithm', info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] aligned algorithm retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
  ensureAlgorithmPlanLooksReasonable(algorithm);
  const reliableAlgorithm = await ensureAlgorithmReliabilityContractWithRepair(workspaceId, {
    problem,
    algorithm,
    difficultyInstruction,
    difficultyMode,
    logName: 'problem.log',
    label: 'aligned algorithm'
  });

  const cppText = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI C++ 标程工程师。只基于最终题面和刚生成的算法草案写满分 C++17 标程。',
        '题面、算法草案、代码必须完全一致。不要沿用任何旧题面的变量或逻辑。',
        '只输出纯 C++17 源码，不要 Markdown 代码块，不要解释。标记为 FINAL_PROBLEM_STD_CPP。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'FINAL_PROBLEM_STD_CPP',
        '最终题面:',
        problem || '',
        '',
        '算法草案:',
        reliableAlgorithm || ''
      ].join('\n')
    }
  ], {
    temperature: 0.12,
    maxTokens: 8192,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'problem.log', 'aligned std seed', info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      await appendWorkspaceLog(workspaceId, 'problem.log', `[${stamp()}] aligned std retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
  const cpp = sanitizeCppCode(cppText);
  assertCppLooksReasonable(cpp);
  return { algorithm: reliableAlgorithm, cpp };
}

function isProviderMethodError(error) {
  return /HTTP Error 405|Method Not Allowed/i.test(String(error?.message || ''));
}

function buildCompactJointDesignPrompt({ source, difficultyMode, difficultyInstruction, adaptationInstruction }) {
  return [
    {
      role: 'system',
      content: [
        '你是 OI 联合设计 agent。一次性设计题面和满分算法草案，后续会继续让你写 std.cpp。',
        '难度和可靠性同等重要：题目必须符合目标难度，也必须能写出清晰可验证的 C++17 满分标程。',
        '不要堆叠多个复杂机制；只增加一个核心难点。题面、算法草案必须一致。',
        '可靠性硬约束：若使用容量/能量 DP，状态数 N*C 或 事件数*C 必须不超过 2e7；若范围更大，必须给出明确可实现的 O(N log N)/O(N log C) 算法。禁止只写“线段树优化/单调队列优化”但没有可验证转移。',
        '算法契约要求：允许树、动态查询、容量/能量、数据结构复合等复杂题型，但算法草案必须写出状态含义、转移/合并规则、不变量或单调性来源、复杂度推导、反例边界。只写 HLD/DFN/线段树/二分/单调队列 等名称不算可验证算法。',
        '若路径/区间结构维护 DP 或贪心状态，必须说明片段信息和合并规则，并说明合并可结合/可组合；若依赖二分或 DFN 顺序，必须说明单调性或顺序性质。',
        '避免多限制叠加：不要同时设计每站至多一次购买、正整数购买、到站截断、跨点倍增等多个高风险机制。',
        '输出只使用以下分段：',
        '<!--PROBLEM_MD-->',
        '# 标题',
        '## 题意',
        '## 输入格式',
        '## 输出格式',
        '## 样例',
        '## 数据范围与提示',
        '<!--PROBLEM_MD_END-->',
        '<!--ALGORITHM_MD-->',
        '# 算法草案',
        '## 题目重述',
        '## 难度命中理由',
        '## 约束提取',
        '## 算法选择',
        '## 正确性要点',
        '## 复杂度目标',
        '## 高风险反例',
        '<!--ALGORITHM_MD_END-->',
        '样例代码块仍需用 <!--SAMPLE_INPUT--> / <!--SAMPLE_OUTPUT--> 标记。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'JOINT_PROBLEM_DESIGN_COMPACT',
        `难度模式: ${difficultyMode}`,
        `用户难度要求: ${difficultyInstruction}`,
        `改编策略: ${adaptationInstruction}`,
        '原题素材:',
        source || ''
      ].join('\n')
    }
  ];
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
    return generateSolutionVerifiedStd(workspaceId);
    try {
      let problem = await safeRead(workspaceId, 'problem/problem.md');
      assertValidText(problem, '题目未生成，无法生成题解');
      const solutionFingerprint = currentProblem => hashText(JSON.stringify({
        version: SOLUTION_PIPELINE_VERSION,
        problem: currentProblem
      }));
      let fingerprint = solutionFingerprint(problem);
      const meta = await getWorkspaceMetaInternal(workspaceId);
      if (
        meta?.jobs?.solution?.fingerprint === fingerprint &&
        (await exists(workspaceId, 'solution/algorithm.md')) &&
        (await exists(workspaceId, 'solution/verification.md')) &&
        (await exists(workspaceId, 'solution/solution.md')) &&
        (await exists(workspaceId, 'solution/std.cpp'))
      ) {
        return {
          algorithm: await readWorkspaceFile(workspaceId, 'solution/algorithm.md'),
          markdown: await readWorkspaceFile(workspaceId, 'solution/solution.md'),
          cpp: await readWorkspaceFile(workspaceId, 'solution/std.cpp'),
          verification: await readWorkspaceFile(workspaceId, 'solution/verification.md'),
          cached: true
        };
      }

      const diffCtx = meta?.difficulty || {};
      const diffInfo = diffCtx.instruction
        ? `目标难度：${diffCtx.instruction}（模式：${diffCtx.mode}${diffCtx.text ? `，说明：${diffCtx.text}` : ''}）`
        : '';

      await setSolutionProgress(workspaceId, '正在读取联合设计产物');
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] start joint-design solution pipeline ${SOLUTION_PIPELINE_VERSION}\n`);

      let algorithm = await safeRead(workspaceId, 'solution/algorithm.md');
      if (!algorithm.trim()) {
        await setSolutionProgress(workspaceId, '正在生成算法草案');
        algorithm = await generateAlgorithmPlan(workspaceId, problem, diffInfo);
      }
      let seedCpp = await safeRead(workspaceId, 'solution/std.cpp');
      algorithm = sanitizeMarkdownArtifact(algorithm);
      algorithm = await ensureAlgorithmReliabilityContractWithRepair(workspaceId, {
        problem,
        algorithm,
        difficultyInstruction: diffCtx.instruction || '',
        difficultyMode: diffCtx.mode || '',
        logName: 'solution.log',
        label: 'solution algorithm'
      });
      await writeWorkspaceFile(workspaceId, 'solution/algorithm.md', algorithm);
      emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'algorithm', text: algorithm });
      let result;
      for (let redesignRound = 0; redesignRound <= SOLUTION_REDESIGN_ROUNDS; redesignRound += 1) {
        try {
          result = await buildVerifiedSolutionArtifacts(workspaceId, {
            problem,
            algorithm,
            diffInfo,
            seedCpp,
            modeLabel: redesignRound ? `redesigned-after-quality-failure-${redesignRound}` : 'full'
          });
          break;
        } catch (qualityError) {
          if (!isDesignRedesignableSolutionFailure(qualityError) || redesignRound >= SOLUTION_REDESIGN_ROUNDS) throw qualityError;
          await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] solution gates failed; redesigning joint problem/algorithm from failure feedback round ${redesignRound + 1}/${SOLUTION_REDESIGN_ROUNDS}\n`);
          await setSolutionProgress(workspaceId, `标程质量门失败，正在回滚重写题面与算法 ${redesignRound + 1}/${SOLUTION_REDESIGN_ROUNDS}`);
        const redesigned = await redesignJointArtifactsAfterSolutionFailure(workspaceId, {
          problem,
          algorithm,
          diffInfo,
          difficultyInstruction: diffCtx.instruction || '',
          difficultyMode: diffCtx.mode || '',
          failure: qualityError.message || ''
        });
          problem = redesigned.problem;
          algorithm = redesigned.algorithm;
          seedCpp = redesigned.cpp;
          fingerprint = solutionFingerprint(problem);
          await writeWorkspaceFile(workspaceId, 'problem/problem.md', problem);
          await writeWorkspaceFile(workspaceId, 'solution/algorithm.md', algorithm);
          if (seedCpp) {
            await writeWorkspaceFile(workspaceId, 'solution/std.cpp', seedCpp);
          }
          await saveJobResult(workspaceId, 'problem', hashText(JSON.stringify({
            version: PROBLEM_PIPELINE_VERSION,
            source: problem,
            redesign: `after-solution-quality-failure-${redesignRound + 1}`
          })), { resultPath: 'problem/problem.md' });
        }
      }
      await persistSolutionArtifacts(workspaceId, fingerprint, result);
      return { ...result, cached: false };
    } catch (error) {
      await setState(workspaceId, 'solution', 'error', error.message || 'solution failed');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'error', message: error.message || 'solution failed' });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] failed: ${error.message}\n`);
      throw error;
    }
  });
}

async function generateSolutionVerifiedStd(workspaceId) {
  try {
    const problem = await safeRead(workspaceId, 'problem/problem.md');
    assertValidText(problem, '题目未生成，无法生成题解');
    const fingerprint = hashText(JSON.stringify({
      version: SOLUTION_PIPELINE_VERSION,
      problem
    }));
    const meta = await getWorkspaceMetaInternal(workspaceId);
    if (
      meta?.jobs?.solution?.fingerprint === fingerprint &&
      (await exists(workspaceId, 'solution/algorithm.md')) &&
      (await exists(workspaceId, 'solution/verification.md')) &&
      (await exists(workspaceId, 'solution/solution.md')) &&
      (await exists(workspaceId, 'solution/std.cpp'))
    ) {
      return {
        algorithm: await readWorkspaceFile(workspaceId, 'solution/algorithm.md'),
        markdown: await readWorkspaceFile(workspaceId, 'solution/solution.md'),
        cpp: await readWorkspaceFile(workspaceId, 'solution/std.cpp'),
        verification: await readWorkspaceFile(workspaceId, 'solution/verification.md'),
        cached: true
      };
    }

    const diffCtx = meta?.difficulty || {};
    const diffInfo = diffCtx.instruction
      ? `目标难度：${diffCtx.instruction}（模式：${diffCtx.mode}${diffCtx.text ? `，说明：${diffCtx.text}` : ''}）`
      : '';

    await setSolutionProgress(workspaceId, '正在验证联合设计标程');
    await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] start verified-std workflow ${SOLUTION_PIPELINE_VERSION}\n`);

    let algorithm = sanitizeMarkdownArtifact(await safeRead(workspaceId, 'solution/algorithm.md'));
    if (!algorithm.trim()) {
      algorithm = await generateAlgorithmPlan(workspaceId, problem, diffInfo);
    }
    ensureAlgorithmPlanLooksReasonable(algorithm);
    await writeWorkspaceFile(workspaceId, 'solution/algorithm.md', algorithm);
    emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'algorithm', text: algorithm });

    const seedCpp = await safeRead(workspaceId, 'solution/std.cpp');
    const result = await buildVerifiedStdWorkflowArtifacts(workspaceId, {
      problem,
      algorithm,
      diffInfo,
      seedCpp
    });
    const finalProblem = await safeRead(workspaceId, 'problem/problem.md') || problem;
    const finalFingerprint = hashText(JSON.stringify({
      version: SOLUTION_PIPELINE_VERSION,
      problem: finalProblem
    }));
    await persistSolutionArtifacts(workspaceId, finalFingerprint, result);
    return { ...result, cached: false };
  } catch (error) {
    await setState(workspaceId, 'solution', 'error', error.message || 'solution failed');
    emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'error', message: error.message || 'solution failed' });
    await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] failed: ${error.message}\n`);
    throw error;
  }
}

async function buildVerifiedStdWorkflowArtifacts(workspaceId, { problem, algorithm, diffInfo, seedCpp = '', modeLabel = 'verified-std' }) {
  let currentAlgorithm = algorithm;
  const attempts = [];
  let lastFailure = '';
  const startedAt = Date.now();
  for (let candidate = 1; candidate <= SOLUTION_MAX_CANDIDATES; candidate += 1) {
    try {
      assertSolutionBudget(startedAt, `before candidate ${candidate}`);
      const usingSeed = candidate === 1 && String(seedCpp || '').trim();
      await setSolutionProgress(workspaceId, usingSeed ? '正在编译联合标程' : `正在重写标程 ${candidate}/${SOLUTION_MAX_CANDIDATES}`);
      const rawCpp = usingSeed
        ? seedCpp
        : await generateStdCppCandidate(workspaceId, {
            problem,
            algorithm: currentAlgorithm,
            diffInfo,
            lastFailure,
            candidate
          });
      let cpp = sanitizeCppCode(rawCpp);
      emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'std', text: cpp });
      assertCppLooksReasonable(cpp);
      cpp = await repairCppCompilation(workspaceId, cpp, problem);
      await setSolutionProgress(workspaceId, '正在做独立代码审查');
      cpp = await crossReviewStdCpp(workspaceId, cpp, problem, null);
      await setSolutionProgress(workspaceId, '正在用独立 oracle 对拍');
      cpp = await verifyWithIndependentOracle(workspaceId, cpp, problem);
      await setSolutionProgress(workspaceId, '正在用标程重算样例');
      await verifySampleWithStd(workspaceId, cpp);
      await setSolutionProgress(workspaceId, '正在由已验证标程生成题解');
      const markdown = await generateFinalSolutionMarkdown(workspaceId, {
        problem: await safeRead(workspaceId, 'problem/problem.md') || problem,
        algorithm: currentAlgorithm,
        cpp,
        diffInfo
      });
      ensureSolutionMarkdownStructure(markdown);
      assertSolutionTextLooksReasonable(markdown, cpp);
      await verifyFullScoreReview(workspaceId, markdown, cpp, await safeRead(workspaceId, 'problem/problem.md') || problem, diffInfo);

      attempts.push({
        candidate,
        state: 'accepted',
        gates: ['compile', 'llm-code-review', `independent-oracle-${INDEPENDENT_ORACLE_CASES}+cases`, 'sample-recomputed', 'solution-from-accepted-std', 'full-ac-review']
      });
      const verification = buildVerificationReport({
        problem: await safeRead(workspaceId, 'problem/problem.md') || problem,
        diffInfo,
        algorithm: currentAlgorithm,
        reliability: { level: 'contract-first', reasons: ['std accepted by executable gates'] },
        attempts,
        acceptedCandidate: candidate,
        cpp,
        modeLabel
      });
      return { algorithm: currentAlgorithm, markdown, cpp, verification };
    } catch (candidateError) {
      lastFailure = String(candidateError?.message || candidateError || '').slice(0, 5000);
      attempts.push({ candidate, state: 'rejected', error: lastFailure });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] candidate ${candidate}/${SOLUTION_MAX_CANDIDATES} failed: ${lastFailure}\n`);
      if (candidate < SOLUTION_MAX_CANDIDATES && isCoreAlgorithmFailureMessage(lastFailure)) {
        await setSolutionProgress(workspaceId, `正在根据失败反馈重写算法合同 ${candidate}/${SOLUTION_MAX_CANDIDATES}`);
        currentAlgorithm = await repairAlgorithmContractAfterStdFailure(workspaceId, {
          problem,
          algorithm: currentAlgorithm,
          diffInfo,
          failure: lastFailure,
          candidate
        });
        await writeWorkspaceFile(workspaceId, 'solution/algorithm.md', currentAlgorithm);
        emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'algorithm', text: currentAlgorithm });
      }
      if (candidate === SOLUTION_MAX_CANDIDATES) {
        const verification = buildVerificationReport({
          problem,
          diffInfo,
          algorithm: currentAlgorithm,
          reliability: { level: 'failed', reasons: ['no candidate passed executable gates'] },
          attempts,
          acceptedCandidate: null,
          cpp: '',
          modeLabel
        });
        await writeWorkspaceFile(workspaceId, 'solution/verification.md', verification);
        const error = new Error(`std verification failed after ${SOLUTION_MAX_CANDIDATES} candidates: ${lastFailure}`);
        error.statusCode = candidateError.statusCode || 422;
        throw error;
      }
    }
  }
  throw new Error('unreachable verified std workflow state');
}

export async function regenerateStdSolution(workspaceId) {
  return withWorkspaceLock(workspaceId, 'solution', async () => {
    try {
      const problem = await safeRead(workspaceId, 'problem/problem.md');
      assertValidText(problem, '题目未生成，无法重生成标程');
      let existingAlgorithm = await safeRead(workspaceId, 'solution/algorithm.md');
      assertValidText(existingAlgorithm, '算法草案未生成，无法只重生成标程');
      const meta = await getWorkspaceMetaInternal(workspaceId);
      const diffCtx = meta?.difficulty || {};
      const diffInfo = diffCtx.instruction
        ? `目标难度：${diffCtx.instruction}（模式：${diffCtx.mode}${diffCtx.text ? `，说明：${diffCtx.text}` : ''}）`
        : '';
      existingAlgorithm = await ensureAlgorithmReliabilityContractWithRepair(workspaceId, {
        problem,
        algorithm: existingAlgorithm,
        difficultyInstruction: diffCtx.instruction || '',
        difficultyMode: diffCtx.mode || '',
        logName: 'solution.log',
        label: 'std-only algorithm'
      });
      const fingerprint = hashText(JSON.stringify({
        version: SOLUTION_PIPELINE_VERSION,
        mode: 'std-only',
        problem,
        algorithm: existingAlgorithm
      }));

      await setSolutionProgress(workspaceId, '正在重生成并验证标程');
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] start std-only regeneration ${SOLUTION_PIPELINE_VERSION}\n`);
      const result = await buildVerifiedStdWorkflowArtifacts(workspaceId, {
        problem,
        algorithm: existingAlgorithm,
        diffInfo,
        seedCpp: '',
        modeLabel: 'std-only'
      });
      await persistSolutionArtifacts(workspaceId, fingerprint, result);
      return { ...result, cached: false };
    } catch (error) {
      await setState(workspaceId, 'solution', 'error', error.message || 'std regeneration failed');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'error', message: error.message || 'std regeneration failed' });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] std-only failed: ${error.message}\n`);
      throw error;
    }
  });
}

async function buildVerifiedSolutionArtifacts(workspaceId, { problem, algorithm, diffInfo, modeLabel = 'full', seedCpp = '' }) {
  let lastFailure = '';
  const attempts = [];
  const startedAt = Date.now();
  const reliability = assessAlgorithmReliability(problem, algorithm);
  const riskGatesEnabled = shouldRunRiskVerification(reliability);
  const dualGateEnabled = shouldRunDualVerification();
  await appendWorkspaceLog(
    workspaceId,
    'solution.log',
    `[${stamp()}] verification config level=${SOLUTION_VERIFICATION_LEVEL} risk_gates=${riskGatesEnabled} dual_gate=${dualGateEnabled} candidates=${SOLUTION_MAX_CANDIDATES} review_rounds=${SOLUTION_REVIEW_ROUNDS} budget_ms=${SOLUTION_TIME_BUDGET_MS} reliability=${JSON.stringify(reliability)}\n`
  );
  for (let candidate = 1; candidate <= SOLUTION_MAX_CANDIDATES; candidate += 1) {
    try {
      assertSolutionBudget(startedAt, `before candidate ${candidate}`);
      const usingSeed = candidate === 1 && String(seedCpp || '').trim();
      await setSolutionProgress(workspaceId, usingSeed ? '正在验证联合设计标程种子' : `正在生成标程候选 ${candidate}/${SOLUTION_MAX_CANDIDATES}`);
      const rawCpp = usingSeed
        ? seedCpp
        : await generateStdCppCandidate(workspaceId, {
            problem,
            algorithm,
            diffInfo,
            lastFailure,
            candidate
          });
      emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'std', text: rawCpp });
      const verified = await validateStdCppCandidate(workspaceId, rawCpp, problem, candidate, {
        startedAt,
        reliability,
        riskGatesEnabled,
        dualGateEnabled
      });
      assertSolutionBudget(startedAt, `before solution markdown for candidate ${candidate}`);
      await setSolutionProgress(workspaceId, '正在根据标程生成最终题解');
      const markdown = await generateFinalSolutionMarkdown(workspaceId, {
        problem,
        algorithm,
        cpp: verified.cpp,
        diffInfo
      });
      ensureSolutionMarkdownStructure(markdown);
      assertSolutionTextLooksReasonable(markdown, verified.cpp);
      await setSolutionProgress(workspaceId, '正在审查题解与标程一致性');
      await verifyFullScoreReview(workspaceId, markdown, verified.cpp, problem, diffInfo);
      await setSolutionProgress(workspaceId, '正在用标程校验样例输出');
      await verifySampleWithStd(workspaceId, verified.cpp);

      attempts.push({
        candidate,
        state: 'accepted',
        gates: usingSeed ? ['joint-design-seed', ...verified.gates] : verified.gates
      });
      const verification = buildVerificationReport({
        problem,
        diffInfo,
        algorithm,
        reliability,
        attempts,
        acceptedCandidate: candidate,
        cpp: verified.cpp,
        modeLabel
      });
      return { algorithm, markdown, cpp: verified.cpp, verification };
    } catch (candidateError) {
      lastFailure = String(candidateError?.message || candidateError || '').slice(0, 4000);
      attempts.push({
        candidate,
        state: 'rejected',
        error: lastFailure
      });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] candidate ${candidate}/${SOLUTION_MAX_CANDIDATES} failed: ${lastFailure}\n`);
      if (candidate === SOLUTION_MAX_CANDIDATES) {
        const verification = buildVerificationReport({
          problem,
          diffInfo,
          algorithm,
          reliability,
          attempts,
          acceptedCandidate: null,
          cpp: '',
          modeLabel
        });
        await writeWorkspaceFile(workspaceId, 'solution/verification.md', verification);
        const error = new Error(`solution quality gates failed after ${SOLUTION_MAX_CANDIDATES} candidates: ${lastFailure}`);
        error.statusCode = candidateError.statusCode || 422;
        throw error;
      }
    }
  }
  throw new Error('unreachable solution generation state');
}

function isDesignRedesignableSolutionFailure(error) {
  const message = String(error?.message || '');
  const status = Number(error?.statusCode || 0);
  return status === 422 && /solution quality gates failed|code review did not reach PASS|full AC review failed|brute oracle verification failed|counterexample verification failed|dual solution verification/i.test(message);
}

function isCoreAlgorithmFailureMessage(message) {
  return /code review did not reach PASS|核心|根本|严重|反例|漏解|状态定义|状态转移|转移.*错误|贪心.*错误|复杂度超限|TLE|不完整|不完备|无法处理|语义.*错误|算法契约/i.test(String(message || ''));
}

async function repairAlgorithmContractAfterStdFailure(workspaceId, { problem, algorithm, diffInfo, failure, candidate }) {
  const repaired = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI 联合设计 agent 的算法合同重写步骤。当前 std.cpp 已被代码审查证明核心算法错误。',
        '不要修改题面，不要降低题型多样性；只重写算法合同，使下一份 std.cpp 能从正确合同实现。',
        '失败报告是硬约束：报告点名错误的状态定义、转移、贪心、复杂度、费用语义、经过不操作等问题，新合同必须逐条消除。',
        '如果原算法合同无法支撑正确实现，必须完全推翻原合同，从题面重新建模。',
        '输出 Markdown，必须包含且只包含这些主章节：',
        '# 算法草案',
        '## 题目重述',
        '## 约束提取',
        '## 算法选择',
        '## 正确性要点',
        '## 复杂度目标',
        '## 高风险反例',
        '算法选择必须写清状态含义、转移/合并规则、边界条件；若涉及容量/燃料/费用/固定手续费，必须明确“经过但不购买”“购买量为 0”“补满/不补满”等决策如何表示，不能只保留两个特殊油量状态，除非证明足够。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'ALGORITHM_CONTRACT_AFTER_STD_FAILURE',
        `候选失败轮次: ${candidate}`,
        diffInfo,
        '',
        '题面:',
        problem || '',
        '',
        '当前算法合同:',
        algorithm || '',
        '',
        'std.cpp 失败报告:',
        String(failure || '').slice(0, 7000)
      ].join('\n')
    }
  ], {
    temperature: 0.12,
    timeoutMs: 120000,
    maxTokens: 8192,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'solution.log', `algorithm contract after std failure ${candidate}`, info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] algorithm contract failure repair retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
  const cleaned = sanitizeMarkdownArtifact(repaired);
  try {
    ensureAlgorithmPlanLooksReasonable(cleaned);
  } catch (shapeError) {
    await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] algorithm contract after std failure ${candidate} shape warning: ${shapeError.message}\n`);
  }
  await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] algorithm contract rewritten after candidate ${candidate} failure\n`);
  return cleaned;
}

async function redesignJointArtifactsAfterSolutionFailure(workspaceId, { problem, algorithm, diffInfo, difficultyInstruction = '', difficultyMode = '', failure = '' }) {
  const redesignText = await callLLM([
    {
      role: 'system',
      content: [
        '你是同一个 OI 联合设计 agent。当前题面、算法草案或 std.cpp 已被质量门证明不一致或不可作为满分正解。',
        '你的任务不是按题型避让，而是基于具体失败原因重新对齐题面、算法草案和 C++17 标程种子。',
        `难度分级参考：${DIFFICULTY_TAXONOMY}`,
        '必须保持用户目标难度；允许保留原模型，也允许调整题面机制，但最终必须能写出可审查、可实现、与题面完全一致的满分标程。',
        '失败报告中指出的复杂度、边界、数学推导、输入输出、无解判定或证明缺口，必须在新设计中逐条消除。',
        '算法草案必须写出状态/转移或合并规则、不变量/单调性来源、复杂度和高风险反例。',
        '输出只使用以下分段：',
        '<!--PROBLEM_MD-->',
        '完整 Markdown 题面',
        '<!--PROBLEM_MD_END-->',
        '<!--ALGORITHM_MD-->',
        '完整算法草案 Markdown',
        '<!--ALGORITHM_MD_END-->',
        '<!--STD_CPP-->',
        '完整 C++17 标程',
        '<!--STD_CPP_END-->',
        '题面必须包含 # 标题、## 题意、## 输入格式、## 输出格式、## 样例、## 数据范围与提示。样例代码块必须保留 SAMPLE_INPUT/SAMPLE_OUTPUT HTML 标记。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'JOINT_REDESIGN_AFTER_SOLUTION_FAILURE',
        diffInfo,
        `难度模式: ${difficultyMode}`,
        `难度要求: ${difficultyInstruction}`,
        '',
        '失败报告:',
        String(failure || '').slice(0, 6000),
        '',
        '上一版题面:',
        problem || '',
        '',
        '上一版算法草案:',
        algorithm || ''
      ].join('\n')
    }
  ], {
    temperature: 0.18,
    timeoutMs: 120000,
    maxTokens: 12000,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'solution.log', 'joint redesign after failure', info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] joint redesign retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
  const design = parseJointDesignBundle(redesignText);
  let newProblem = sanitizeMarkdownArtifact(design.problem);
  newProblem = await completeProblemMarkdown(workspaceId, newProblem, problem, difficultyInstruction, difficultyMode);
  ensureProblemMarkdownStructure(newProblem);
  let newAlgorithm = sanitizeMarkdownArtifact(design.algorithm);
  try {
    ensureAlgorithmPlanLooksReasonable(newAlgorithm);
  } catch (error) {
    await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] redesigned algorithm shape invalid, regenerating plan: ${error.message}\n`);
    newAlgorithm = await generateAlgorithmPlan(workspaceId, newProblem, diffInfo);
  }
  newAlgorithm = await ensureAlgorithmReliabilityContractWithRepair(workspaceId, {
    problem: newProblem,
    algorithm: newAlgorithm,
    difficultyInstruction,
    difficultyMode,
    logName: 'solution.log',
    label: 'redesigned algorithm'
  });
  let newCpp = sanitizeCppCode(design.cpp);
  try {
    assertCppLooksReasonable(newCpp);
  } catch (error) {
    await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] redesigned std seed ignored: ${error.message}\n`);
    newCpp = '';
  }
  emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'problem', text: newProblem });
  emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'algorithm', text: newAlgorithm });
  emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'std', text: newCpp });
  return { problem: newProblem, algorithm: newAlgorithm, cpp: newCpp };
}

function assertSolutionBudget(startedAt, phase) {
  const elapsed = Date.now() - startedAt;
  if (elapsed <= SOLUTION_TIME_BUDGET_MS) return;
  const error = new Error(`solution generation exceeded ${Math.round(SOLUTION_TIME_BUDGET_MS / 1000)}s budget at ${phase}`);
  error.statusCode = 408;
  throw error;
}

async function persistSolutionArtifacts(workspaceId, fingerprint, { algorithm, markdown, cpp, verification }) {
  algorithm = sanitizeMarkdownArtifact(algorithm);
  markdown = sanitizeMarkdownArtifact(markdown);
  verification = sanitizeMarkdownArtifact(verification);
  await writeWorkspaceFile(workspaceId, 'solution/algorithm.md', algorithm);
  await writeWorkspaceFile(workspaceId, 'solution/std.cpp', cpp);
  await writeWorkspaceFile(workspaceId, 'solution/solution.md', markdown);
  await writeWorkspaceFile(workspaceId, 'solution/verification.md', verification);
  await saveJobResult(workspaceId, 'solution', fingerprint, {
    resultPaths: ['solution/algorithm.md', 'solution/std.cpp', 'solution/solution.md', 'solution/verification.md'],
    pipelineVersion: SOLUTION_PIPELINE_VERSION
  });
  await setState(workspaceId, 'solution', 'done', '题解与标程已生成');
  emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'solution', state: 'done', message: '题解与标程已生成' });
  await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] done\n`);
}

async function generateAlgorithmPlan(workspaceId, problem, diffInfo) {
  const plan = await callLLM([
    {
      role: 'system',
      content: [
        '你是严格的 OI 算法设计审稿人。先设计可验证的满分算法草案，不要写代码。标记为 SOLUTION_ALGORITHM。',
        `难度分级参考：${DIFFICULTY_TAXONOMY}`,
        '必须输出 Markdown，并包含以下章节：',
        '# 算法草案',
        '## 题目重述',
        '## 约束提取',
        '## 算法选择',
        '## 正确性要点',
        '## 复杂度目标',
        '## 高风险反例',
        '要求：逐条处理题面中的所有限制；如果存在多解/构造/浮点等非唯一输出风险，必须明确指出。',
        '复杂题必须写出算法契约：状态含义、转移/合并规则、不变量或单调性来源、复杂度推导、反例边界。允许树、动态查询、容量/能量、数据结构复合，但不能只写算法名称。',
        '若路径/区间结构维护 DP 或贪心状态，必须说明片段信息和合并规则，并说明合并可结合/可组合；若依赖二分或 DFN 顺序，必须说明单调性或顺序性质。'
      ].join('\n')
    },
    {
      role: 'user',
      content: ['SOLUTION_ALGORITHM', diffInfo, 'SOURCE_TEXT:', problem || ''].filter(Boolean).join('\n')
    }
  ], {
    temperature: 0.15,
    maxTokens: 8192,
    retries: 5,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'solution.log', 'algorithm plan', info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      emitWorkspaceEvent(workspaceId, 'task:update', {
        stage: 'solution',
        state: 'running',
        message: `算法草案重试 ${attempt + 1}/${retries}`
      });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] algorithm retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
  ensureAlgorithmPlanLooksReasonable(plan);
  return ensureAlgorithmReliabilityContractWithRepair(workspaceId, {
    problem,
    algorithm: plan,
    difficultyInstruction: diffInfo,
    difficultyMode: '',
    logName: 'solution.log',
    label: 'generated algorithm'
  });
}

async function generateStdCppCandidate(workspaceId, { problem, algorithm, diffInfo, lastFailure, candidate }) {
  const system = [
    '你是 OI C++ 标程工程师。只写可独立编译的满分 C++17 标程。标记为 STD_CPP_CANDIDATE。',
    `难度分级参考：${DIFFICULTY_TAXONOMY}`,
    '只输出纯 C++17 源码，不要使用 Markdown 代码块，不要输出题解、解释或任何正文。',
    '标程必须是可独立编译的完整程序，必须包含 int main() 或 signed main() 入口。',
    '标程必须是满分 AC 解法；不要输出部分分、暴力、伪代码或未经证明的贪心。',
    '读入格式必须严格匹配题面。不得忽略任何输入参数、约束或特殊情况。',
    '题面是唯一权威。算法草案只是候选思路；如果算法草案与题面或上一轮失败反馈冲突，必须推翻算法草案并从题面重新推导。',
    '如果上一候选失败，必须从失败根因出发重新设计，不要只做局部补丁。',
    '如果失败反馈点名某个代码模式、递推式、贪心规则或数据结构维护方式错误，新候选严禁继续使用同一模式；必须换成可证明覆盖所有源状态/边界的实现。',
    '对 DP 转移尤其要从“上一层所有合法源状态 + 本步合法决策集合”推导，不能用看似类似完全背包/前缀递推的写法替代，除非能覆盖每个源状态并保持不变量。',
    '若题面存在“至少/不少于/门槛/容量/补给/购买”等限制，购买或补给转移必须显式枚举或等价优化所有 source state 与 purchase amount；不要只从当前层 h[v-1] 递推而漏掉 f[*] 源状态。',
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
    'STD_CPP_CANDIDATE',
    `候选编号: ${candidate}/${SOLUTION_MAX_CANDIDATES}`,
    diffInfo,
    '题面:',
    problem || '',
    '算法草案:',
    algorithm || ''
  ];
  if (lastFailure) {
    user.push(
      'PREVIOUS_CANDIDATE_FAILURE:',
      lastFailure,
      '请根据上述失败原因重新设计题解和标程。若失败原因涉及算法复杂度、DP 转移、贪心正确性、漏解、反例或核心约束，不要沿用原算法框架。',
      '上一失败报告中被点名的错误代码模式必须从新代码中消失；新代码应优先使用更直接、更可证明的状态转移，即使常数稍大。'
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
        message: `标程候选 ${candidate} 重试 ${attempt + 1}/${retries}`
      });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] std candidate ${candidate} retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
  return finalText;
}

async function validateStdCppCandidate(workspaceId, rawCpp, problem, candidate, { startedAt, reliability, riskGatesEnabled = false, dualGateEnabled = false } = {}) {
  let cpp = sanitizeCppCode(rawCpp);
  assertCppLooksReasonable(cpp);
  const gates = [];
  await setSolutionProgress(workspaceId, `正在编译检查标程候选 ${candidate}`);
  cpp = await repairCppCompilation(workspaceId, cpp, problem);
  gates.push('compile');
  if (startedAt) assertSolutionBudget(startedAt, `after compile candidate ${candidate}`);
  await setSolutionProgress(workspaceId, `正在审查标程候选 ${candidate}`);
  cpp = await crossReviewStdCpp(workspaceId, cpp, problem, reliability);
  gates.push('llm-code-review');
  if (startedAt) assertSolutionBudget(startedAt, `after review candidate ${candidate}`);
  if (dualGateEnabled) {
    await setSolutionProgress(workspaceId, `正在双解法对拍候选 ${candidate}`);
    cpp = await verifyWithDualSolution(workspaceId, cpp, problem);
    gates.push('dual-solution-differential');
    if (startedAt) assertSolutionBudget(startedAt, `after dual verification candidate ${candidate}`);
  } else {
    gates.push('skipped-dual-solution-differential');
  }
  if (riskGatesEnabled) {
    await setSolutionProgress(workspaceId, `正在暴力 oracle 对拍候选 ${candidate}`);
    cpp = await verifyWithBruteOracle(workspaceId, cpp, problem);
    gates.push(`brute-oracle-${BRUTE_ORACLE_MIN_CASES}+cases`);
    if (startedAt) assertSolutionBudget(startedAt, `after brute oracle candidate ${candidate}`);
    await setSolutionProgress(workspaceId, `正在反例搜索候选 ${candidate}`);
    await verifyWithCounterexampleSearch(workspaceId, cpp, problem);
    gates.push(`counterexample-search-${COUNTEREXAMPLE_MIN_CASES}+cases`);
  } else {
    gates.push('skipped-brute-oracle');
    gates.push('skipped-counterexample-search');
    await appendWorkspaceLog(
      workspaceId,
      'solution.log',
      `[${stamp()}] risk verification skipped at level=${SOLUTION_VERIFICATION_LEVEL}; high-risk designs enable brute/counterexample gates automatically; set SOLUTION_VERIFICATION_LEVEL=strict to also enable dual gate\n`
    );
  }
  await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] std candidate ${candidate} passed gates: ${gates.join(', ')}\n`);
  return { cpp, gates };
}

async function generateFinalSolutionMarkdown(workspaceId, { problem, algorithm, cpp, diffInfo }) {
  const markdown = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI 题解撰写助手。现在已有通过编译、审查、对拍和反例搜索的 std.cpp。',
        '请基于题面、算法草案和最终 std.cpp 反向生成题解。标记为 SOLUTION_FROM_STD。',
        '只输出 Markdown 题解，不要包含 C++ 代码块。',
        '必须包含 # 题解、## 思路、## 正确性、## 复杂度。',
        '题解算法、复杂度和边界处理必须与给定 std.cpp 一致，不得虚构另一种算法。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'SOLUTION_FROM_STD',
        diffInfo,
        '题面:',
        problem || '',
        '算法草案:',
        algorithm || '',
        '最终 std.cpp:',
        cpp || ''
      ].filter(Boolean).join('\n')
    }
  ], {
    temperature: 0.1,
    timeoutMs: 90000,
    maxTokens: 8192,
    retries: 5,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'solution.log', 'solution from std', info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      emitWorkspaceEvent(workspaceId, 'task:update', {
        stage: 'solution',
        state: 'running',
        message: `最终题解生成重试 ${attempt + 1}/${retries}`
      });
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] solution from std retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
  return stripCppBlock(markdown);
}

function buildVerificationReport({ problem, diffInfo, algorithm, reliability, attempts, acceptedCandidate, cpp, modeLabel = 'full' }) {
  const lines = [
    '# 标程验证报告',
    '',
    `- Pipeline: ${SOLUTION_PIPELINE_VERSION}`,
    `- Mode: ${modeLabel}`,
    `- Generated at: ${stamp()}`,
    `- Accepted candidate: ${acceptedCandidate || 'none'}`,
    diffInfo ? `- ${diffInfo}` : '',
    reliability ? `- Reliability level: ${reliability.level}${reliability.reasons?.length ? ` (${reliability.reasons.join('; ')})` : ''}` : '',
    '',
    '## 候选记录',
    ''
  ].filter(Boolean);
  for (const attempt of attempts) {
    lines.push(`### Candidate ${attempt.candidate}`);
    lines.push(`- State: ${attempt.state}`);
    if (attempt.gates?.length) {
      lines.push(`- Gates: ${attempt.gates.join(', ')}`);
    }
    if (attempt.error) {
      lines.push('- Error:');
      lines.push('```');
      lines.push(String(attempt.error).slice(0, 2000));
      lines.push('```');
    }
    lines.push('');
  }
  lines.push('## 算法草案摘要');
  lines.push('');
  lines.push(String(algorithm || '').slice(0, 2000));
  lines.push('');
  lines.push('## 题面摘要');
  lines.push('');
  lines.push(String(problem || '').slice(0, 2000));
  if (cpp) {
    lines.push('');
    lines.push('## 最终 std.cpp 摘要');
    lines.push('');
    lines.push('```cpp');
    lines.push(String(cpp || '').slice(0, 4000));
    lines.push('```');
  }
  return lines.join('\n');
}

export async function generateDataPlan(workspaceId) {
  return withWorkspaceLock(workspaceId, 'data', async () => {
    return generateDataBundleWorkflow(workspaceId);
    try {
      const solution = await safeRead(workspaceId, 'solution/solution.md');
      assertValidText(solution, '题解未生成，无法生成数据');
      const problemMd = await safeRead(workspaceId, 'problem/problem.md');
      const stdCpp = await safeRead(workspaceId, 'solution/std.cpp');
      const fingerprint = hashText(JSON.stringify({
        version: DATA_PIPELINE_VERSION,
        problemMd,
        solution,
        stdCpp
      }));
      const meta = await getWorkspaceMetaInternal(workspaceId);
      if (
        meta?.jobs?.data?.fingerprint === fingerprint &&
        (await exists(workspaceId, 'data/hack_plan.md')) &&
        (await exists(workspaceId, 'data/gen.py')) &&
        (await exists(workspaceId, 'data/validator.py')) &&
        (await exists(workspaceId, 'data/problem_type.json'))
      ) {
        return {
          plan: await readWorkspaceFile(workspaceId, 'data/hack_plan.md'),
          genPy: await readWorkspaceFile(workspaceId, 'data/gen.py'),
          validatorPy: await readWorkspaceFile(workspaceId, 'data/validator.py'),
          problemType: JSON.parse(await readWorkspaceFile(workspaceId, 'data/problem_type.json')),
          checkerCpp: await safeRead(workspaceId, 'data/checker.cpp'),
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
            + '若题面写了“输入保证”或“保证”类硬约束，所有测试点必须严格满足这些约束；不能为了测试无解而生成违反题面保证的非法输入。'
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
      emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'data', phase: 'plan', text: plan });
      plan = await repairDataPlanOutput(workspaceId, plan, solution, diffInfo);
      ensureDataPlanMarkdownStructure(plan);
      await writeWorkspaceFile(workspaceId, 'data/hack_plan.md', plan);

      const problemType = await analyzeProblemType(workspaceId, { problemMd, solution, diffInfo });
      await writeWorkspaceFile(workspaceId, 'data/problem_type.json', JSON.stringify(problemType, null, 2));

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
            '数据方案中声明的 N 值必须与 gen.py 实际使用的 N 值一致。如果出于合理原因（如防 long long 溢出）需要改小 N，请确保数据方案的说明也随之同步更新，不要出现方案说 N=2e5 但代码实际用 N=5000 的矛盾。',
            '必须严格满足题面所有“输入保证”约束；例如题面保证相邻距离 <= C 时，不得构造 gap > C 的 impossible case。'
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
      emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'data', phase: 'gen', text: genPy });
      genPy = sanitizePythonCode(genPy);
      ensurePythonGeneratorShape(genPy);
      assertDataPlanLooksReasonable(plan, genPy);
      assertDataArtifactsRespectProblemGuarantees(problemMd, plan, genPy, '');
      plan = await validateDataPlanGenConsistency(workspaceId, plan, genPy, diffInfo);

      const validatorPy = await generateInputValidator(workspaceId, {
        problemMd,
        plan,
        genPy,
        diffInfo
      });
      assertDataArtifactsRespectProblemGuarantees(problemMd, plan, genPy, validatorPy);
      let checkerCpp = '';
      if (problemType.requiresChecker) {
        checkerCpp = await generateCheckerCpp(workspaceId, {
          problemMd,
          solution,
          stdCpp,
          problemType,
          diffInfo
        });
        await verifyCheckerCompiles(workspaceId, checkerCpp);
        await writeWorkspaceFile(workspaceId, 'data/checker.cpp', checkerCpp);
      }

      await writeWorkspaceFile(workspaceId, 'data/hack_plan.md', plan);
      await writeWorkspaceFile(workspaceId, 'data/gen.py', genPy);
      await writeWorkspaceFile(workspaceId, 'data/validator.py', validatorPy);
      await saveJobResult(workspaceId, 'data', fingerprint, {
        resultPaths: ['data/hack_plan.md', 'data/gen.py', 'data/validator.py', 'data/problem_type.json', ...(checkerCpp ? ['data/checker.cpp'] : [])],
        pipelineVersion: DATA_PIPELINE_VERSION
      });
      await setState(workspaceId, 'data', 'done', '数据方案与生成器已生成');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'done', message: '数据方案与生成器已生成' });
      await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] done\n`);

      try {
        await runDataGenerator(workspaceId);
      } catch (runError) {
        await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] auto run failed: ${runError.message}\n`);
      }

      return { plan, genPy, validatorPy, problemType, checkerCpp, cached: false };
    } catch (error) {
      await setState(workspaceId, 'data', 'error', error.message || 'data planning failed');
      emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'error', message: error.message || 'data planning failed' });
      await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] failed: ${error.message}\n`);
      throw error;
    }
  });
}

async function generateDataBundleWorkflow(workspaceId) {
  try {
    const solution = await safeRead(workspaceId, 'solution/solution.md');
    assertValidText(solution, '题解未生成，无法生成数据');
    const problemMd = await safeRead(workspaceId, 'problem/problem.md');
    const stdCpp = await safeRead(workspaceId, 'solution/std.cpp');
    const fingerprint = hashText(JSON.stringify({
      version: DATA_PIPELINE_VERSION,
      problemMd,
      solution,
      stdCpp
    }));
    const meta = await getWorkspaceMetaInternal(workspaceId);
    if (
      meta?.jobs?.data?.fingerprint === fingerprint &&
      (await exists(workspaceId, 'data/hack_plan.md')) &&
      (await exists(workspaceId, 'data/gen.py')) &&
      (await exists(workspaceId, 'data/validator.py')) &&
      (await exists(workspaceId, 'data/problem_type.json'))
    ) {
      return {
        plan: await readWorkspaceFile(workspaceId, 'data/hack_plan.md'),
        genPy: await readWorkspaceFile(workspaceId, 'data/gen.py'),
        validatorPy: await readWorkspaceFile(workspaceId, 'data/validator.py'),
        problemType: JSON.parse(await readWorkspaceFile(workspaceId, 'data/problem_type.json')),
        checkerCpp: await safeRead(workspaceId, 'data/checker.cpp'),
        cached: true
      };
    }

    const diffCtx = meta?.difficulty || {};
    const diffInfo = diffCtx.instruction
      ? `目标难度：${diffCtx.instruction}（模式：${diffCtx.mode}${diffCtx.text ? `，说明：${diffCtx.text}` : ''}）`
      : '';

    await setState(workspaceId, 'data', 'running', '正在一次性生成数据合同');
    emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'running', message: '正在一次性生成数据合同' });
    await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] start data bundle workflow ${DATA_PIPELINE_VERSION}\n`);

    const bundleText = await callLLM([
      {
        role: 'system',
        content: [
          '你是 OI 数据工程 agent。一次性交付数据方案、输入生成器、输入 validator、题型判定 JSON，必要时交付 checker.cpp。',
          '数据必须服务于发现错误 std：覆盖边界、随机、退化、最大规模、特殊合法场景，并严格满足题面输入保证。',
          '不要另造输入格式；以题面和已验证 std.cpp 的读入顺序为准。',
          'gen.py 必须在当前目录直接生成若干 .in 文件；validator.py 从 stdin 校验单个测试点。',
          '输出只使用以下分段：',
          '<!--DATA_PLAN_MD-->',
          '# 数据方案',
          '## 点数分布',
          '<!--DATA_PLAN_MD_END-->',
          '<!--PROBLEM_TYPE_JSON-->',
          '{"type":"standard","outputUniqueness":"unique","requiresChecker":false,"reasons":[]}',
          '<!--PROBLEM_TYPE_JSON_END-->',
          '<!--GEN_PY-->',
          '完整 Python3 生成器',
          '<!--GEN_PY_END-->',
          '<!--VALIDATOR_PY-->',
          '完整 Python3 validator',
          '<!--VALIDATOR_PY_END-->',
          '<!--CHECKER_CPP-->',
          '若 requiresChecker=false 可留空；否则输出完整 C++17 checker',
          '<!--CHECKER_CPP_END-->'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          'DATA_BUNDLE',
          diffInfo,
          '',
          '题面:',
          problemMd || '',
          '',
          '已验证题解:',
          solution || '',
          '',
          '已验证 std.cpp:',
          stdCpp || ''
        ].join('\n')
      }
    ], {
      temperature: 0.18,
      timeoutMs: 120000,
      maxTokens: 14000,
      retries: 5,
      onComplete: async info => {
        await logLLMComplete(workspaceId, 'data.log', 'data bundle', info);
      },
      onRetry: async ({ attempt, retries, error }) => {
        emitWorkspaceEvent(workspaceId, 'task:update', {
          stage: 'data',
          state: 'running',
          message: `数据合同重试 ${attempt + 1}/${retries}`
        });
        await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] data bundle retry ${attempt + 1}/${retries}: ${error.message}\n`);
      }
    });

    let plan = sanitizeMarkdownArtifact(extractBetween(bundleText, '<!--DATA_PLAN_MD-->', '<!--DATA_PLAN_MD_END-->'));
    let genPy = sanitizePythonCode(extractBetween(bundleText, '<!--GEN_PY-->', '<!--GEN_PY_END-->'));
    let validatorPy = sanitizePythonCode(extractBetween(bundleText, '<!--VALIDATOR_PY-->', '<!--VALIDATOR_PY_END-->'));
    const problemType = parseJsonOrDefault(
      extractJsonObject(extractBetween(bundleText, '<!--PROBLEM_TYPE_JSON-->', '<!--PROBLEM_TYPE_JSON_END-->')),
      { type: 'unknown', outputUniqueness: 'unknown', requiresChecker: false, reasons: ['invalid problem type json'] }
    );
    let checkerCpp = sanitizeCppCode(extractBetween(bundleText, '<!--CHECKER_CPP-->', '<!--CHECKER_CPP_END-->'));

    ensureDataPlanMarkdownStructure(plan);
    ensurePythonGeneratorShape(genPy);
    ensureValidatorShape(validatorPy);
    assertDataArtifactsRespectProblemGuarantees(problemMd, plan, genPy, validatorPy);
    plan = await validateDataPlanGenConsistency(workspaceId, plan, genPy, diffInfo);
    if (problemType.requiresChecker) {
      if (!checkerCpp) {
        checkerCpp = await generateCheckerCpp(workspaceId, {
          problemMd,
          solution,
          stdCpp,
          problemType,
          diffInfo
        });
      }
      await verifyCheckerCompiles(workspaceId, checkerCpp);
      await writeWorkspaceFile(workspaceId, 'data/checker.cpp', checkerCpp);
    }

    await writeWorkspaceFile(workspaceId, 'data/hack_plan.md', plan);
    await writeWorkspaceFile(workspaceId, 'data/gen.py', genPy);
    await writeWorkspaceFile(workspaceId, 'data/validator.py', validatorPy);
    await writeWorkspaceFile(workspaceId, 'data/problem_type.json', JSON.stringify({
      type: String(problemType.type || 'unknown'),
      outputUniqueness: String(problemType.outputUniqueness || 'unknown'),
      requiresChecker: Boolean(problemType.requiresChecker),
      reasons: Array.isArray(problemType.reasons) ? problemType.reasons.map(String) : []
    }, null, 2));
    await saveJobResult(workspaceId, 'data', fingerprint, {
      resultPaths: ['data/hack_plan.md', 'data/gen.py', 'data/validator.py', 'data/problem_type.json', ...(checkerCpp ? ['data/checker.cpp'] : [])],
      pipelineVersion: DATA_PIPELINE_VERSION
    });
    await setState(workspaceId, 'data', 'done', '数据合同已生成');
    emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'done', message: '数据合同已生成' });
    await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] done\n`);

    try {
      await runDataGenerator(workspaceId);
    } catch (runError) {
      await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] auto run failed: ${runError.message}\n`);
    }

    return { plan, genPy, validatorPy, problemType, checkerCpp, cached: false };
  } catch (error) {
    await setState(workspaceId, 'data', 'error', error.message || 'data planning failed');
    emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'error', message: error.message || 'data planning failed' });
    await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] failed: ${error.message}\n`);
    throw error;
  }
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
    const validatorPy = await safeRead(workspaceId, 'data/validator.py');
    if (!validatorPy.trim()) {
      const error = new Error('validator.py not found');
      error.statusCode = 400;
      throw error;
    }
    const problemTypeText = await safeRead(workspaceId, 'data/problem_type.json');
    const problemType = parseJsonOrDefault(problemTypeText, { requiresChecker: false, type: 'standard' });
    const checkerCpp = await safeRead(workspaceId, 'data/checker.cpp');
    if (problemType.requiresChecker && !checkerCpp.trim()) {
      const error = new Error('checker.cpp required for this problem type but not found');
      error.statusCode = 400;
      throw error;
    }
    const initialFingerprint = hashText(JSON.stringify({
      version: DATA_PIPELINE_VERSION,
      genPy,
      stdCpp,
      validatorPy,
      problemType,
      checkerCpp
    }));
    const meta = await getWorkspaceMetaInternal(workspaceId);
    if (
      meta?.jobs?.run?.fingerprint === initialFingerprint &&
      (await exists(workspaceId, 'data/datas.zip')) &&
      (await exists(workspaceId, 'data/coverage.json')) &&
      (await exists(workspaceId, 'data/stress_report.md'))
    ) {
      return {
        artifact: 'data/datas.zip',
        coverage: JSON.parse(await readWorkspaceFile(workspaceId, 'data/coverage.json')),
        stressReport: await readWorkspaceFile(workspaceId, 'data/stress_report.md'),
        cached: true
      };
    }

    await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] start generator run\n`);
    emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'running', message: '正在运行数据生成器' });

    let currentStdCpp = stdCpp;
    let currentGenPy = genPy;
    const problemMd = await safeRead(workspaceId, 'problem/problem.md');
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await executePythonGenerator(workspaceId, {
          genPy: currentGenPy,
          stdCpp: currentStdCpp,
          validatorPy,
          problemType,
          checkerCpp
        });
        emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'data', phase: 'run', text: (result.stdout || result.stderr || '') });
        assertDataZipLooksValid(result.zipContent);
        await verifyZipArchive(result.zipContent);
        await assertGeneratedInputsRespectProblemGuarantees(problemMd, result.zipContent);
        const finalFingerprint = hashText(JSON.stringify({
          version: DATA_PIPELINE_VERSION,
          genPy: currentGenPy,
          stdCpp: currentStdCpp,
          validatorPy,
          problemType,
          checkerCpp
        }));
        await writeWorkspaceFile(workspaceId, 'data/datas.zip', result.zipContent);
        await writeWorkspaceFile(workspaceId, 'data/coverage.json', JSON.stringify(result.coverage, null, 2));
        await writeWorkspaceFile(workspaceId, 'data/stress_report.md', result.stressReport);
        await saveJobResult(workspaceId, 'run', finalFingerprint, {
          resultPath: 'data/datas.zip',
          coveragePath: 'data/coverage.json',
          stressReportPath: 'data/stress_report.md',
          pipelineVersion: DATA_PIPELINE_VERSION
        });
        await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] run finished\n`);
        emitWorkspaceEvent(workspaceId, 'task:update', { stage: 'data', state: 'done', message: '数据包已生成' });
        return {
          artifact: 'data/datas.zip',
          coverage: result.coverage,
          stressReport: result.stressReport,
          cached: false,
          stdout: result.stdout,
          stderr: result.stderr
        };
      } catch (error) {
        lastError = error;
        const errMsg = error.message || '';
        const isGeneratorError = errMsg.includes('validator failed') || errMsg.includes('gen.py failed') || errMsg.includes('no .in files generated');
        const isStdError = errMsg.includes('timed out') || errMsg.includes('std failed') || errMsg.includes('compile');
        const isRetryable = isGeneratorError || isStdError;
        if (!isRetryable || attempt === 3) break;

        const problem = problemMd;
        if (isGeneratorError) {
          emitWorkspaceEvent(workspaceId, 'task:update', {
            stage: 'data', state: 'running',
            message: `正在修复数据生成器 ${attempt}/3`
          });
          await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] fix gen.py attempt ${attempt}/3: ${errMsg.slice(0, 1000)}\n`);
          currentGenPy = await repairDataGenerator(workspaceId, {
            problem,
            genPy: currentGenPy,
            validatorPy,
            stdCpp: currentStdCpp,
            errorMessage: errMsg,
            attempt
          });
          await writeWorkspaceFile(workspaceId, 'data/gen.py', currentGenPy);
          continue;
        }

        emitWorkspaceEvent(workspaceId, 'task:update', {
          stage: 'data', state: 'running',
          message: `正在修复标程运行错误 ${attempt}/3`
        });
        await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] fix std.cpp attempt ${attempt}/3: ${errMsg.slice(0, 1000)}\n`);

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

async function repairDataGenerator(workspaceId, { problem, genPy, validatorPy, stdCpp, errorMessage, attempt }) {
  const fixed = await callLLM(
    [
      {
        role: 'system',
        content: [
          '你是 Python 数据生成器修复助手。根据 validator/gen.py 的具体错误修正数据生成器。',
          '只输出修正后的完整 Python 代码，不要 Markdown 包裹，不要解释。标记为 GEN_PY_FIX。',
          '必须保证每个生成的 .in 都能通过给定 validator.py。',
          '必须严格遵守题面数据范围；如果错误提到某变量越界，要显式 clamp 或重新设计随机范围。',
          '不要修改输入格式，不要生成子目录，所有 .in 文件直接写入当前工作目录。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          'GEN_PY_FIX',
          `修复轮次: ${attempt}/3`,
          '运行/校验错误:',
          errorMessage || '',
          '',
          '题面:',
          problem || '',
          '',
          'validator.py:',
          validatorPy || '',
          '',
          '当前 gen.py:',
          genPy || '',
          '',
          'std.cpp 读入格式参考:',
          String(stdCpp || '').slice(0, 5000)
        ].join('\n')
      }
    ],
    {
      temperature: 0.12,
      timeoutMs: 90000,
      maxTokens: 8192,
      retries: 3,
      onComplete: async info => {
        await logLLMComplete(workspaceId, 'data.log', `gen fix ${attempt}`, info);
      },
      onRetry: async ({ attempt: ra, retries, error }) => {
        await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] gen fix LLM retry ${ra + 1}/${retries}: ${error.message}\n`);
      }
    }
  );
  const repaired = sanitizePythonCode(fixed);
  ensurePythonGeneratorShape(repaired);
  return repaired;
}

export const __testHooks = {
  verifySampleWithStd,
  verifyWithBruteOracle,
  verifyFullScoreReview,
  sanitizeCppCode,
  sanitizePythonCode,
  reviewPassed,
  sanitizeMarkdownArtifact,
  detectProblemGuarantees,
  assertDataArtifactsRespectProblemGuarantees,
  assessAlgorithmReliability,
  assertAlgorithmReliabilityContract
};

async function executePythonGenerator(workspaceId, { genPy, stdCpp, validatorPy, problemType, checkerCpp }) {
  const root = path.resolve(process.cwd(), 'workspaces', workspaceId);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-${workspaceId}-`));
  const scriptPath = path.join(workDir, 'gen.py');
  await fs.writeFile(scriptPath, genPy, 'utf8');
  const validatorPath = path.join(workDir, 'validator.py');
  await fs.writeFile(validatorPath, validatorPy, 'utf8');
  const stdPath = path.join(workDir, 'std.cpp');
  await fs.writeFile(stdPath, stdCpp, 'utf8');
  await fs.writeFile(path.join(workDir, 'problem_type.json'), JSON.stringify(problemType || {}, null, 2), 'utf8');
  if (checkerCpp) {
    await fs.writeFile(path.join(workDir, 'checker.cpp'), checkerCpp, 'utf8');
  }

  const runner = `
import json, os, subprocess, sys, time, zipfile, pathlib, shutil, textwrap
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

# validate every generated input
validator_results = []
for in_file in in_files:
    with open(in_file, "rb") as inf:
        val_proc = subprocess.run([sys.executable, str(work / "validator.py")], stdin=inf, capture_output=True, text=True, timeout=20)
    validator_results.append({
        "file": in_file.relative_to(out_dir).as_posix(),
        "ok": val_proc.returncode == 0,
        "stderr": val_proc.stderr[-1000:],
    })
    if val_proc.returncode != 0:
        print(f"validator failed on {in_file.relative_to(out_dir)}:\\n" + val_proc.stderr[-2000:], file=sys.stderr)
        sys.exit(1)

# compile std.cpp
compile_proc = subprocess.run(["g++", "-std=c++17", "-O2", "-pipe", "-static", str(work / "std.cpp"), "-o", str(work / "std")], capture_output=True, text=True, timeout=60)
if compile_proc.returncode != 0:
    print("g++ compile failed:\\n" + compile_proc.stderr[-3000:], file=sys.stderr)
    sys.exit(1)

problem_type = json.loads((work / "problem_type.json").read_text())
checker_required = bool(problem_type.get("requiresChecker"))
checker_compiled = False
if checker_required:
    compile_checker = subprocess.run(["g++", "-std=c++17", "-O2", "-pipe", "-static", str(work / "checker.cpp"), "-o", str(work / "checker")], capture_output=True, text=True, timeout=60)
    if compile_checker.returncode != 0:
        print("checker compile failed:\\n" + compile_checker.stderr[-3000:], file=sys.stderr)
        sys.exit(1)
    checker_compiled = True

# run std against each .in to produce .out
case_summaries = []
max_elapsed = 0.0
max_elapsed_file = ""
for in_file in in_files:
    out_file = in_file.with_suffix(".out")
    try:
        start = time.perf_counter()
        with open(in_file) as inf:
            run_proc = subprocess.run([str(work / "std")], stdin=inf, capture_output=True, text=True, timeout=60)
        elapsed = time.perf_counter() - start
    except subprocess.TimeoutExpired:
        print(f"std timed out on {in_file.relative_to(out_dir)} after 60s", file=sys.stderr)
        sys.exit(1)
    if run_proc.returncode != 0:
        print(f"std failed on {in_file.name} (exit {run_proc.returncode}):\\n" + run_proc.stderr[-2000:], file=sys.stderr)
        sys.exit(1)
    out_file.write_text(run_proc.stdout)
    if checker_compiled:
        checker_proc = subprocess.run([str(work / "checker"), str(in_file), str(out_file), str(out_file)], capture_output=True, text=True, timeout=20)
        if checker_proc.returncode != 0:
            print(f"checker rejected std output for {in_file.name}:\\n" + checker_proc.stderr[-2000:] + checker_proc.stdout[-2000:], file=sys.stderr)
            sys.exit(1)
    if elapsed > max_elapsed:
        max_elapsed = elapsed
        max_elapsed_file = in_file.relative_to(out_dir).as_posix()
    raw = in_file.read_text(errors="ignore")
    ints = []
    for tok in raw.replace("\\n", " ").split():
        try:
            ints.append(int(tok))
        except Exception:
            pass
    case_summaries.append({
        "file": in_file.relative_to(out_dir).as_posix(),
        "bytes": in_file.stat().st_size,
        "integerCount": len(ints),
        "maxAbsInteger": max([abs(x) for x in ints], default=0),
        "elapsedMs": round(elapsed * 1000, 3),
    })

coverage = {
    "pipeline": "${DATA_PIPELINE_VERSION}",
    "caseCount": len(in_files),
    "inputFiles": [p.relative_to(out_dir).as_posix() for p in in_files],
    "validator": {
        "caseCount": len(validator_results),
        "allPassed": all(item["ok"] for item in validator_results),
    },
    "checker": {
        "required": checker_required,
        "compiled": checker_compiled,
    },
    "caseSummaries": case_summaries,
    "maxBytes": max([item["bytes"] for item in case_summaries], default=0),
    "maxIntegerCount": max([item["integerCount"] for item in case_summaries], default=0),
    "maxAbsInteger": max([item["maxAbsInteger"] for item in case_summaries], default=0),
    "slowestCase": max_elapsed_file,
    "slowestElapsedMs": round(max_elapsed * 1000, 3),
}

stress_report = "\\n".join([
    "# 数据压力测试报告",
    "",
    f"- Pipeline: ${DATA_PIPELINE_VERSION}",
    f"- Case count: {len(in_files)}",
    f"- Validator: {'PASS' if coverage['validator']['allPassed'] else 'FAIL'}",
    f"- Checker required: {checker_required}",
    f"- Checker compiled: {checker_compiled}",
    f"- Max input bytes: {coverage['maxBytes']}",
    f"- Max integer count: {coverage['maxIntegerCount']}",
    f"- Max abs integer: {coverage['maxAbsInteger']}",
    f"- Slowest case: {coverage['slowestCase'] or 'n/a'}",
    f"- Slowest elapsed ms: {coverage['slowestElapsedMs']}",
    "",
])

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
print("COVERAGE_BEGIN")
print(json.dumps(coverage))
print("COVERAGE_END")
print("STRESS_BEGIN")
print(stress_report)
print("STRESS_END")
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
    coverage: JSON.parse(extractBetween(result.stdout, 'COVERAGE_BEGIN', 'COVERAGE_END').trim() || '{}'),
    stressReport: extractBetween(result.stdout, 'STRESS_BEGIN', 'STRESS_END').trim(),
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
  const regex = new RegExp('```\\s*' + lang + '[^\\n\\r]*[\\r\\n]+([\\s\\S]*?)```', 'gi');
  const matches = Array.from(text.matchAll(regex));
  if (!matches.length) return '';
  const last = matches[matches.length - 1];
  return last[1].trim();
}

function stripCppBlock(text) {
  return text.replace(/```cpp[\s\S]*?```/gi, '').trim();
}

function sanitizeMarkdownArtifact(text) {
  const markers = [
    'PROBLEM_REVISE',
    'PROBLEM_REVIEW',
    'PROBLEM_REWRITE',
    'JOINT_PROBLEM_DESIGN',
    'JOINT_PROBLEM_DESIGN_COMPACT',
    'FINAL_PROBLEM_ALGORITHM',
    'SOLUTION_FROM_STD',
    'SOLUTION_FINAL',
    'SOLUTION_REPAIR',
    'DATA_PLAN',
    'DATA_PLAN_FIX'
  ];
  let content = String(text || '');
  for (const marker of markers) {
    content = content.replace(new RegExp(`^\\s*(?:标记为[:：]?\\s*)?${marker}\\s*$`, 'gmi'), '');
  }
  content = content.replace(/\n{3,}/g, '\n\n').trim();
  return content;
}

function sanitizeCppCode(text) {
  let code = extractCodeBlock(text, 'cpp') || extractCodeBlock(text, 'c\\+\\+') || String(text || '').trim();
  if (!code.includes('\n') && code.includes('\\n')) {
    code = code.replace(/\\n/g, '\n');
  }
  code = code.replace(/^\s*```(?:\s*(?:cpp|c\+\+))?[^\n\r]*[\r\n]+/i, '');
  code = code.replace(/[\r\n]+\s*```\s*$/i, '');
  const includeIdx = code.search(/#\s*include/);
  if (includeIdx > 0) code = code.slice(includeIdx);
  const trailingFence = code.indexOf('\n```');
  if (trailingFence !== -1) code = code.slice(0, trailingFence);
  code = keepLastCompleteCppProgram(code);
  return code.trim();
}

function keepLastCompleteCppProgram(code) {
  const text = String(code || '');
  const includeMatches = Array.from(text.matchAll(/#\s*include\b/g));
  const mainMatches = Array.from(text.matchAll(/\b(?:int|signed)\s+main\s*\(/g));
  if (includeMatches.length <= 1 || mainMatches.length <= 1) return text;
  const lastInclude = includeMatches[includeMatches.length - 1].index;
  const candidate = text.slice(lastInclude).trim();
  if (/#\s*include\b/.test(candidate) && /\b(?:int|signed)\s+main\s*\(/.test(candidate)) {
    return candidate;
  }
  return text;
}

function extractPythonCode(text) {
  const extracted = extractCodeBlock(text, 'python');
  if (extracted) return extracted;
  const generic = extractCodeBlock(text, 'py');
  if (generic) return generic;
  return '';
}

function sanitizePythonCode(text) {
  let code = extractPythonCode(text) || String(text || '').trim();
  if (!code.includes('\n') && code.includes('\\n')) {
    code = code.replace(/\\n/g, '\n');
  }
  code = code.replace(/^\s*```(?:\s*(?:python|py))?[^\n\r]*[\r\n]+/i, '');
  code = code.replace(/[\r\n]+\s*```\s*$/i, '');
  const markers = [
    'TEST_GEN',
    'BRUTE_TEST_GEN',
    'COUNTEREXAMPLE_GEN',
    'GEN_PY',
    'GEN_PY_FIX',
    'VALIDATOR_PY'
  ];
  for (const marker of markers) {
    code = code.replace(new RegExp(`^\\s*(?:标记为[:：]?\\s*)?${marker}\\s*$`, 'gmi'), '');
  }
  const codeStart = code.search(/(?:^|\n)\s*(?:#!.*python|import\s+|from\s+\w+\s+import|def\s+|class\s+)/);
  if (codeStart > 0) {
    code = code.slice(code[codeStart] === '\n' ? codeStart + 1 : codeStart);
  }
  const trailingFence = code.indexOf('\n```');
  if (trailingFence !== -1) code = code.slice(0, trailingFence);
  return code.trim();
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return candidate;
  return candidate.slice(start, end + 1);
}

function extractBetween(text, start, end) {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s === -1 || e === -1 || e <= s) return '';
  return text.slice(s + start.length, e);
}

function parseJsonOrDefault(text, fallback) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return fallback;
  }
}

function reviewPassed(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const conclusion = line.match(/^(?:#{1,6}\s*)?(?:结论|最终结论|verdict|result)\s*[:：]?\s*\*{0,2}(PASS|FAIL)\*{0,2}\b/i);
    if (conclusion) return conclusion[1].toUpperCase() === 'PASS';
    const normalized = line
      .replace(/^#{1,6}\s*/, '')
      .replace(/^`{1,3}|`{1,3}$/g, '')
      .replace(/^\*{1,2}|\*{1,2}$/g, '')
      .trim();
    const standalone = normalized.match(/^(PASS|FAIL)\b/i);
    if (standalone) return standalone[1].toUpperCase() === 'PASS';
  }
  return false;
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
  if (!/##\s*(题意|题目描述|问题描述)/.test(content)) issues.push('缺少 ## 题意/题目描述');
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
  return /<!--SAMPLE_INPUT\d*-->/.test(content) || /#{2,4}\s*(样例\s*)?(输入|input)(\s*(#|编号)?\s*\d+)?/i.test(content) || /输入样例/i.test(content);
}

function hasSampleOutputHeading(content) {
  return /<!--SAMPLE_OUTPUT\d*-->/.test(content) || /#{2,4}\s*(样例\s*)?(输出|output)(\s*(#|编号)?\s*\d+)?/i.test(content) || /输出样例/i.test(content);
}

function buildDifficultyInstruction(mode, text) {
  const raw = String(text || '').trim();
  const normalizedMode = String(mode || 'same').trim();
  if (!raw) {
    return normalizedMode === 'custom' ? '用户未填写具体难度，请自由选择合理难度' : '保持与原题接近';
  }
  return raw;
}

function buildOriginalDifficultyInstruction(text, mode = 'custom') {
  const raw = String(text || '').trim();
  if (raw) return raw;
  if (String(mode || '') === 'custom') return 'CSP-S T3/T4，偏高质量原创题，难度不要低于普及组';
  return 'CSP-S T3/T4，偏高质量原创题，难度不要低于普及组';
}

function buildAdaptationInstruction(mode) {
  if (String(mode || 'same') === 'same') {
    return '同难度改编：参考原题难度与算法量级，保持原题基础算法范式一致；同时尽可能改换背景、故事、对象、题名、变量语义和表述方式；避免保留原题可搜索的关键词、专有名词、样例背景和原句。不要只改题名。';
  }
  return '提升难度改编：按用户输入的目标难度设计，目标难度必须严格命中；算法范式可在原谱系内升级（如普通DP→树形DP），必要时可审慎升级到更高阶范式（如BFS/贪心→DP）。不能降级。背景、变量和叙事可以大幅重写。';
}

function ensureProblemMarkdownStructure(text) {
  ensureMarkdownStructure(text, ['title', '## 输入格式', '## 输出格式', '## 样例', '## 数据范围与提示']);
  if (!/##\s*(题意|题目描述|问题描述)/.test(String(text || ''))) {
    const error = new Error('markdown missing section: ## 题意/题目描述');
    error.statusCode = 422;
    throw error;
  }
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
  emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'solution', phase: 'repair', text: repaired });
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
            content: '你是 C++ 标程修复助手。根据编译错误修正下方的 C++ 代码。标记为 COMPILE_FIX。只输出纯 C++17 源码，不要 Markdown 代码块，不要解释。\n'
              + '⚠️ 必须输出一份完整程序，不要把旧代码和新代码拼接在一起，不要出现重复的 struct、全局变量、函数或 main。\n'
              + '⚠️ 如果链接错误提示 undefined reference to `main`，必须在代码末尾补上完整的 int main() 或 signed main() 函数。',
          },
          {
            role: 'user',
            content: [
              '编译错误:',
              'COMPILE_FIX',
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
      current = sanitizeCppCode(fixed) || current;
    }
  }
  return current;
}

async function crossReviewStdCpp(workspaceId, cpp, problem, reliability = null) {
  let current = String(cpp || '');
  const reviews = [];
  const reliabilityText = reliability
    ? [
        `可靠性评估: ${reliability.level}`,
        reliability.reasons?.length ? `触发因素: ${reliability.reasons.join('；')}` : '',
        reliability.missing?.length ? `算法契约缺口: ${reliability.missing.join('；')}` : ''
      ].filter(Boolean).join('\n')
    : '';
  for (let round = 1; round <= SOLUTION_REVIEW_ROUNDS; round += 1) {
    await setSolutionProgress(workspaceId, `算法审查 ${round}/${SOLUTION_REVIEW_ROUNDS}`);
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
          + '7. 若可靠性评估显示题目含动态路径、容量/能量、数据结构维护 DP/贪心等复杂组合，必须检查代码是否真正实现了算法契约中的状态、合并、不变量或单调性；不能因出现 HLD/线段树/二分等名称就 PASS。\n'
          + '输出第一行只能是 PASS 或 FAIL，第二行开始列出具体问题（含代码行号和原因）。\n'
          + '⚠️ 多轮审查须知：如果之前轮次已报告过的问题，本轮代码中已修复则不应再次报告；如果修复不完整或引入了新问题，指出遗留/新问题即可。'
      },
      {
        role: 'user',
        content: [
          'CODE_REVIEW',
          reliabilityText,
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

    if (reviewPassed(review)) {
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] code review PASS in round ${round}\n`);
      return current;
    }

    await setSolutionProgress(workspaceId, `正在按审查意见修复标程 ${round}/${SOLUTION_REVIEW_ROUNDS}`);
    const fixHistoryText = round > 1
      ? reviews.map((r, i) => `第${i + 1}轮审查意见：${r.slice(0, 400)}`).join('\n\n')
      : '';
    const rootCauseReview = isCoreAlgorithmReviewFailure(review, reviews);
    const fixPrompt = [
      {
        role: 'system',
        content: '你是 C++ 代码修复/重设计助手。根据审查意见处理代码。\n'
          + '判断审查类型：\n'
          + '- 如果审查指出的是变量名错误、边界加减1、类型不匹配、某个转移漏处理等局部问题 → 在原代码上修补，优先保持原有框架\n'
          + '- 如果审查明确指出算法根本性错误（如忽略核心约束、复杂度必然超限、DP 转移漏解、核心贪心无反例证明、数据结构合并不成立），必须从零重新设计，不要在原代码上打补丁\n'
          + (rootCauseReview ? '当前审查属于核心算法正确性失败：必须丢弃当前代码框架，从题面一手推导新算法并输出全新完整程序。\n' : '')
          + '只输出修正/重设计后的纯 C++17 源码，不要 Markdown 代码块，不要解释。\n'
          + '必须输出一份完整但尽量简洁的程序；避免超长模板、重复定义和未闭合括号。\n'
          + '审查意见中提到的反例场景必须正确解决，不可敷衍。\n'
          + '如果审查点名某个递推式/代码行/贪心规则错误，新代码不得继续出现同一错误模式；DP 必须从上一层合法源状态和本步合法决策集合推导，必要时使用枚举、前缀最值、最短路或其它等价优化来保证不漏状态。\n'
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
      temperature: 0.25,
      maxTokens: 8192,
      retries: 3,
      onComplete: async info => {
        await logLLMComplete(workspaceId, 'solution.log', `code fix ${round}`, info);
      },
    });
    current = sanitizeCppCode(fixed) || current;
    try {
      await verifyCppCompiles(workspaceId, current);
    } catch (compileError) {
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] fix ${round} broke compilation, trying compile repair: ${compileError.message.slice(0, 300)}\n`);
      current = await repairCppCompilation(workspaceId, current, problem);
    }
  }
  const error = new Error(`code review did not reach PASS after ${SOLUTION_REVIEW_ROUNDS} rounds\n${reviews.join('\n\n').slice(0, 3500)}`);
  error.statusCode = 422;
  throw error;
}

function isCoreAlgorithmReviewFailure(review, allReviews = []) {
  const text = `${review || ''}\n${(allReviews || []).join('\n')}`;
  if (!/FAIL/i.test(text)) return false;
  return /核心|根本|严重|反例|漏解|错误|不正确|复杂度.*超|必然超限|DP|动态规划|转移|递推|贪心|单调性|不变量|合并|结合律|数据结构|完全背包|状态/.test(text);
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

      let altCpp = sanitizeCppCode(altSol);
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

      const genScript = sanitizePythonCode(testGen);
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

      const newCode = sanitizeCppCode(fixed);
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
  await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] dual: 3 rounds exhausted without full agreement\n`);
  const error = new Error('dual solution verification did not reach agreement after 3 rounds');
  error.statusCode = 422;
  throw error;
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
        `你是 OI 对拍数据生成器编写助手。根据题面写 Python3 脚本，生成至少 ${BRUTE_ORACLE_MIN_CASES} 组小规模合法测试。`,
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

  const oracleCpp = sanitizeCppCode(oracleText);
  const genPy = sanitizePythonCode(generatorText);
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
    if (cases.length < BRUTE_ORACLE_MIN_CASES) {
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
      const detail = disagreements.map(d => [
        `case ${d.index}:`,
        'input:',
        d.input.slice(0, 1200),
        `std: ${d.stdOut.slice(0, 300)}`,
        `oracle: ${d.oracleOut.slice(0, 300)}`
      ].join('\n')).join('\n\n');
      const error = new Error(`brute oracle verification failed with ${disagreements.length} disagreement(s)\n${detail}`);
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

async function verifyWithIndependentOracle(workspaceId, stdCpp, problem) {
  await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] independent oracle verification start cases=${INDEPENDENT_ORACLE_CASES}\n`);
  const bundleText = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI 正确性验证工程师。为给定题目写一个小规模独立 oracle 和一个合法测试生成器，用于对拍候选 std.cpp。',
        'oracle 必须优先正确性，可以暴力枚举、搜索、模拟、Floyd、朴素 DP；不要照抄候选 std.cpp 的算法。',
        `测试生成器至少输出 ${INDEPENDENT_ORACLE_CASES} 组完整合法输入，组间用一行 ===CASE=== 分隔。`,
        '覆盖最小规模、边界值、随机、退化结构、无解/临界可行、多操作类型等题面允许的情况。',
        '输出只使用以下分段：',
        '<!--ORACLE_CPP-->',
        '完整 C++17 oracle',
        '<!--ORACLE_CPP_END-->',
        '<!--TEST_GEN_PY-->',
        '完整 Python3 生成器',
        '<!--TEST_GEN_PY_END-->'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'INDEPENDENT_ORACLE_BUNDLE',
        '题目:',
        problem || '',
        '',
        '候选 std.cpp:',
        stdCpp || ''
      ].join('\n')
    }
  ], {
    temperature: 0.18,
    timeoutMs: 120000,
    maxTokens: 12000,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'solution.log', 'independent oracle bundle', info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] independent oracle retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });

  const oracleCpp = sanitizeCppCode(
    extractBetween(bundleText, '<!--ORACLE_CPP-->', '<!--ORACLE_CPP_END-->') ||
    extractFlexibleSection(bundleText, 'ORACLE_CPP') ||
    bundleText
  );
  const genPy = sanitizePythonCode(
    extractBetween(bundleText, '<!--TEST_GEN_PY-->', '<!--TEST_GEN_PY_END-->') ||
    extractFlexibleSection(bundleText, 'TEST_GEN_PY') ||
    bundleText
  );
  if (!oracleCpp || !genPy) {
    const error = new Error('independent oracle bundle missing oracle.cpp or test generator');
    error.statusCode = 422;
    throw error;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-independent-${workspaceId}-`));
  try {
    const stdPath = path.join(tmpDir, 'std');
    const oraclePath = path.join(tmpDir, 'oracle');
    await fs.writeFile(stdPath + '.cpp', stdCpp, 'utf8');
    await fs.writeFile(oraclePath + '.cpp', oracleCpp, 'utf8');
    await runCommand('g++', ['-std=c++17', '-O2', '-pipe', '-static', stdPath + '.cpp', '-o', stdPath], 60000);
    await runCommand('g++', ['-std=c++17', '-O2', '-pipe', '-static', oraclePath + '.cpp', '-o', oraclePath], 60000);

    const generated = await runPython(genPy, 30000);
    const cases = generated.stdout.split('===CASE===').map(s => s.trim()).filter(Boolean);
    if (cases.length < INDEPENDENT_ORACLE_CASES) {
      const error = new Error(`independent oracle generator produced too few cases (${cases.length})`);
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
      const detail = disagreements.map(d => [
        `case ${d.index}:`,
        'input:',
        d.input.slice(0, 1200),
        `std: ${d.stdOut.slice(0, 300)}`,
        `oracle: ${d.oracleOut.slice(0, 300)}`
      ].join('\n')).join('\n\n');
      await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] independent oracle failed:\n${detail.slice(0, 3000)}\n`);
      const error = new Error(`independent oracle verification failed with ${disagreements.length} disagreement(s)\n${detail}`);
      error.statusCode = 422;
      throw error;
    }

    await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] independent oracle passed ${cases.length} cases\n`);
    return stdCpp;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function verifyWithCounterexampleSearch(workspaceId, stdCpp, problem) {
  emitWorkspaceEvent(workspaceId, 'task:update', {
    stage: 'solution',
    state: 'running',
    message: '正在搜索标程反例'
  });
  await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] counterexample search start\n`);

  const oracleText = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI 暴力正确性 oracle 编写助手。必须写一个只用于小规模测试的朴素 C++17 解法。',
        '优先正确性，不追求效率；可以枚举、搜索、模拟、Floyd、暴力 DP，但必须严格匹配题面输入输出。',
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
      await logLLMComplete(workspaceId, 'solution.log', 'counterexample oracle', info);
    }
  });

  const generatorText = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI 反例搜索数据生成器。根据题面和候选 std.cpp，生成至少 40 组小规模但刁钻的合法测试。',
        '重点覆盖容易让错误算法翻车的边界：最小值、最大的小规模、重复值、相等值、退化图/树、极端操作顺序、无解/临界可行等。',
        '每组测试必须是完整输入，输出到 stdout，组间用一行 ===CASE=== 分隔。',
        '只输出纯 Python 代码，不要 Markdown 包裹。标记为 COUNTEREXAMPLE_GEN。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'COUNTEREXAMPLE_GEN',
        '题目:',
        problem || '',
        '',
        '候选 std.cpp:',
        stdCpp || ''
      ].join('\n')
    }
  ], {
    temperature: 0.35,
    timeoutMs: 90000,
    maxTokens: 8192,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'solution.log', 'counterexample gen', info);
    }
  });

  const oracleCpp = sanitizeCppCode(oracleText);
  const genPy = sanitizePythonCode(generatorText);
  if (!oracleCpp || !genPy) {
    const error = new Error('counterexample oracle or generator missing');
    error.statusCode = 422;
    throw error;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-counter-${workspaceId}-`));
  try {
    const stdPath = path.join(tmpDir, 'std');
    const oraclePath = path.join(tmpDir, 'oracle');
    await fs.writeFile(stdPath + '.cpp', stdCpp, 'utf8');
    await fs.writeFile(oraclePath + '.cpp', oracleCpp, 'utf8');
    await runCommand('g++', ['-std=c++17', '-O2', '-pipe', '-static', stdPath + '.cpp', '-o', stdPath], 60000);
    await runCommand('g++', ['-std=c++17', '-O2', '-pipe', '-static', oraclePath + '.cpp', '-o', oraclePath], 60000);

    const generated = await runPython(genPy, 30000);
    const cases = generated.stdout.split('===CASE===').map(s => s.trim()).filter(Boolean);
    if (cases.length < COUNTEREXAMPLE_MIN_CASES) {
      const error = new Error(`counterexample generator produced too few cases (${cases.length})`);
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
        await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] counterexample ${d.index}: std=${d.stdOut.slice(0, 300)} oracle=${d.oracleOut.slice(0, 300)} input=${d.input.slice(0, 500)}\n`);
      }
      const detail = disagreements.map(d => [
        `case ${d.index}:`,
        'input:',
        d.input.slice(0, 1200),
        `std: ${d.stdOut.slice(0, 300)}`,
        `oracle: ${d.oracleOut.slice(0, 300)}`
      ].join('\n')).join('\n\n');
      const error = new Error(`counterexample verification failed with ${disagreements.length} disagreement(s)\n${detail}`);
      error.statusCode = 422;
      throw error;
    }

    await appendWorkspaceLog(workspaceId, 'solution.log', `[${stamp()}] counterexample search passed ${cases.length} cases\n`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
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
  if (!reviewPassed(review)) {
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

async function recomputeProblemSamplesWithStd(workspaceId, problemMd, stdCpp, { logName = 'problem.log', label = 'candidate' } = {}) {
  const samples = extractProblemSamplePairs(problemMd);
  if (!samples.length) {
    const error = new Error('problem has no extractable sample input/output pair');
    error.statusCode = 422;
    throw error;
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-problem-sample-${workspaceId}-`));
  try {
    const stdBin = path.join(tmpDir, 'std');
    await fs.writeFile(path.join(tmpDir, 'std.cpp'), stdCpp, 'utf8');
    await runCommand('g++', ['-std=c++17', '-O2', '-pipe', '-static', path.join(tmpDir, 'std.cpp'), '-o', stdBin], 45000);
    let result = problemMd;
    for (const sample of [...samples].reverse()) {
      const actualOutput = await runStdWithInput(stdBin, sample.input, 30000);
      const newFence = sample.outputFence.replace(/```(?:\w+)?\n[\s\S]*?\n```/, '```\n' + actualOutput.trimEnd() + '\n```');
      result = result.slice(0, sample.outputStart) + newFence + result.slice(sample.outputEnd);
      await appendWorkspaceLog(workspaceId, logName, `[${stamp()}] ${label} sample ${sample.index}: old='${sample.output.trim()}' new='${actualOutput.trim()}'\n`);
    }
    return stripInternalSampleMarkers(result).replace(/\n{3,}/g, '\n\n').trim();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function extractProblemSamplePairs(problemMd) {
  const text = String(problemMd || '');
  const markerPairs = extractMarkedSamplePairs(text);
  if (markerPairs.length) return markerPairs;
  return extractGenericSamplePairs(text);
}

function extractMarkedSamplePairs(text) {
  const samples = [];
  for (let idx = 1; ; idx += 1) {
    const inTag = idx === 1 ? '<!--SAMPLE_INPUT-->' : `<!--SAMPLE_INPUT${idx}-->`;
    const inEndTag = idx === 1 ? '<!--SAMPLE_INPUT_END-->' : `<!--SAMPLE_INPUT${idx}_END-->`;
    const outTag = idx === 1 ? '<!--SAMPLE_OUTPUT-->' : `<!--SAMPLE_OUTPUT${idx}-->`;
    const outEndTag = idx === 1 ? '<!--SAMPLE_OUTPUT_END-->' : `<!--SAMPLE_OUTPUT${idx}_END-->`;
    const inStart = text.indexOf(inTag);
    if (inStart === -1) break;
    const inEnd = text.indexOf(inEndTag, inStart);
    const outStartTag = text.indexOf(outTag, inEnd);
    const outEnd = text.indexOf(outEndTag, outStartTag);
    if (inEnd === -1 || outStartTag === -1 || outEnd === -1) continue;
    const inputFence = text.slice(inStart, inEnd).match(/```(?:\w+)?\n([\s\S]*?)```/);
    const outputSlice = text.slice(outStartTag, outEnd);
    const outputFence = outputSlice.match(/```(?:\w+)?\n([\s\S]*?)```/);
    if (!inputFence || !outputFence) continue;
    const fenceOffset = outputSlice.indexOf(outputFence[0]);
    samples.push({
      index: idx,
      input: inputFence[1],
      output: outputFence[1],
      outputFence: outputFence[0],
      outputStart: outStartTag + fenceOffset,
      outputEnd: outStartTag + fenceOffset + outputFence[0].length
    });
  }
  return samples;
}

function extractGenericSamplePairs(text) {
  const inputHeading = /(?:样例输入|输入样例|Sample Input)/i.exec(text);
  const outputHeading = /(?:样例输出|输出样例|Sample Output)/i.exec(text);
  if (!inputHeading || !outputHeading || outputHeading.index <= inputHeading.index) return [];
  const inputSlice = text.slice(inputHeading.index, outputHeading.index);
  const outputSlice = text.slice(outputHeading.index);
  const inputFence = inputSlice.match(/```(?:\w+)?\n([\s\S]*?)```/);
  const outputFence = outputSlice.match(/```(?:\w+)?\n([\s\S]*?)```/);
  if (!inputFence || !outputFence) return [];
  const outputStart = outputHeading.index + outputSlice.indexOf(outputFence[0]);
  return [{
    index: 1,
    input: inputFence[1],
    output: outputFence[1],
    outputFence: outputFence[0],
    outputStart,
    outputEnd: outputStart + outputFence[0].length
  }];
}

function stripInternalSampleMarkers(text) {
  return String(text || '')
    .replace(/<!--SAMPLE_INPUT\d*-->/g, '')
    .replace(/<!--SAMPLE_INPUT\d*_END-->/g, '')
    .replace(/<!--SAMPLE_OUTPUT\d*-->/g, '')
    .replace(/<!--SAMPLE_OUTPUT\d*_END-->/g, '');
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
  emitWorkspaceEvent(workspaceId, 'task:partial', { stage: 'data', phase: 'plan-repair', text: repaired });
  return repaired;
}

async function analyzeProblemType(workspaceId, { problemMd, solution, diffInfo }) {
  const raw = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI 题型分类器。判断题目是否标准唯一答案，还是多解/构造/浮点/交互/输出答案题。',
        '只输出 JSON，不要 Markdown。标记为 PROBLEM_TYPE_ANALYSIS。',
        'JSON 字段：type, outputUniqueness, requiresChecker, reasons。',
        'type 只能是 standard, multi_answer, construction, floating, interactive, output_only, unknown。',
        'requiresChecker 为 true 当且仅当固定 .out 不能完整表达判题逻辑，或输出允许多种合法答案。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'PROBLEM_TYPE_ANALYSIS',
        diffInfo,
        '题面:',
        problemMd || '',
        '题解:',
        solution || ''
      ].filter(Boolean).join('\n')
    }
  ], {
    temperature: 0.05,
    timeoutMs: 45000,
    maxTokens: 2048,
    retries: 3,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'data.log', 'problem type analysis', info);
    }
  });
  const parsed = parseJsonOrDefault(extractJsonObject(raw), null);
  if (!parsed || typeof parsed !== 'object') {
    const error = new Error('problem type analysis did not return valid JSON');
    error.statusCode = 422;
    throw error;
  }
  return {
    type: String(parsed.type || 'unknown'),
    outputUniqueness: String(parsed.outputUniqueness || 'unknown'),
    requiresChecker: Boolean(parsed.requiresChecker),
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : []
  };
}

async function generateInputValidator(workspaceId, { problemMd, plan, genPy, diffInfo }) {
  const validator = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI 输入校验器工程师。根据题面、数据方案和 gen.py 写 Python3 输入 validator。标记为 VALIDATOR_PY。',
        'validator 从 stdin 读取单个测试点输入；合法则 exit 0；非法则向 stderr 写明原因并 exit 非 0。',
        '必须检查输入格式、整数范围、数量、图/树结构、去重、连通性、sum constraints 等题面能确定的输入约束。',
        '只输出纯 Python 代码，不要 Markdown 包裹，不要解释。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'VALIDATOR_PY',
        diffInfo,
        '题面:',
        problemMd || '',
        '',
        '数据方案:',
        plan || '',
        '',
        'gen.py:',
        genPy || ''
      ].filter(Boolean).join('\n')
    }
  ], {
    temperature: 0.1,
    timeoutMs: 90000,
    maxTokens: 8192,
    retries: 5,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'data.log', 'validator py', info);
    },
    onRetry: async ({ attempt, retries, error }) => {
      emitWorkspaceEvent(workspaceId, 'task:update', {
        stage: 'data',
        state: 'running',
        message: `输入校验器重试 ${attempt + 1}/${retries}`
      });
      await appendWorkspaceLog(workspaceId, 'data.log', `[${stamp()}] validator retry ${attempt + 1}/${retries}: ${error.message}\n`);
    }
  });
  const code = sanitizePythonCode(validator);
  ensureValidatorShape(code);
  return code;
}

async function generateCheckerCpp(workspaceId, { problemMd, solution, stdCpp, problemType, diffInfo }) {
  const checker = await callLLM([
    {
      role: 'system',
      content: [
        '你是 OI special judge/checker 工程师。为多解/构造/浮点等题写 C++17 checker。标记为 CHECKER_CPP。',
        'checker 命令行参数固定为：argv[1]=input file, argv[2]=expected output file, argv[3]=contestant output file。',
        '合法输出 return 0；非法输出 return 非 0，并向 stderr 输出原因。',
        '不得只比较 expected 和 contestant 字符串；必须按题意验证 contestant output 合法性。',
        '只输出 ```cpp 代码块，不要解释。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'CHECKER_CPP',
        diffInfo,
        '题型判定:',
        JSON.stringify(problemType || {}, null, 2),
        '',
        '题面:',
        problemMd || '',
        '',
        '题解:',
        solution || '',
        '',
        'std.cpp:',
        stdCpp || ''
      ].filter(Boolean).join('\n')
    }
  ], {
    temperature: 0.1,
    timeoutMs: 90000,
    maxTokens: 8192,
    retries: 5,
    onComplete: async info => {
      await logLLMComplete(workspaceId, 'data.log', 'checker cpp', info);
    }
  });
  const code = sanitizeCppCode(checker);
  assertCppLooksReasonable(code);
  return code;
}

async function verifyCheckerCompiles(workspaceId, checkerCpp) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-checker-${workspaceId}-`));
  try {
    const sourcePath = path.join(tmpDir, 'checker.cpp');
    await fs.writeFile(sourcePath, checkerCpp, 'utf8');
    await runCommand('g++', ['-std=c++17', '-O2', '-pipe', '-static', sourcePath, '-o', path.join(tmpDir, 'checker')], 60000);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
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

function ensureValidatorShape(validatorPy) {
  const text = String(validatorPy || '');
  if (text.length < 40 || !text.includes('sys.stdin') || !text.includes('sys.exit')) {
    const error = new Error('validator.py structure looks invalid');
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

function assessAlgorithmReliability(problem, algorithm = '') {
  const problemText = String(problem || '');
  const algorithmText = String(algorithm || '');
  const combined = `${problemText}\n${algorithmText}`;
  const hasTreePath = hasAny(combined, [
    /树链剖分|重链|HLD|heavy-light/i,
    /树上[^。\n]{0,30}(路径|链|询问|查询|修改|更新)/i,
    /(路径|链)[^。\n]{0,30}(LCA|最近公共祖先|dfn|DFS序|树剖)/i
  ]);
  const hasDynamicOps = hasAny(combined, [
    /动态|在线|修改|更新|操作|询问|查询/i,
    /\bQ\b|q\s*[<=≤]|[1-9]\d{4,}\s*次/i
  ]);
  const hasCapacityResource = hasAny(combined, [
    /容量|油量|燃料|汽油|加油|补给|能量|电量|耐久|背包容量/i,
    /capacity|fuel|energy/i
  ]);
  const hasRangeDataStructure = hasAny(combined, [
    /线段树|树状数组|Fenwick|BIT|ST表|倍增|RMQ|分块|平衡树|堆/i,
    /segment\s*tree|binary\s*lifting/i
  ]);
  const hasOptimizationClaim = hasAny(combined, [
    /优化|二分|单调队列|斜率优化|矩阵|转移矩阵|自动机|分治/i,
    /DP|动态规划|贪心/i
  ]);

  const contract = {
    state: hasAny(algorithmText, [/状态|state|dp\s*\[|f\s*\[|定义\s*f|每个节点保存|维护[^。\n]{0,40}(信息|状态)/i]),
    transition: hasAny(algorithmText, [/转移|transition|递推|relax|更新\s*dp|方程|从[^。\n]{0,25}转移/i]),
    invariant: hasAny(algorithmText, [/不变量|单调性|正确性|归纳|交换论证|割性质|最优子结构|为什么|保证/i]),
    complexity: hasAny(algorithmText, [/复杂度|O\s*\(|Θ\s*\(|最坏/i]),
    edgeCases: hasAny(algorithmText, [/反例|边界|特殊|无解|极端|高风险/i]),
    composition: hasAny(algorithmText, [/合并|结合律|可结合|可组合|merge|combine|矩阵乘法|区间信息|片段信息|左右儿子|pushup/i])
  };

  const reasons = [];
  if (hasTreePath) reasons.push('tree/path structure');
  if (hasDynamicOps) reasons.push('dynamic operations');
  if (hasCapacityResource) reasons.push('capacity/resource state');
  if (hasRangeDataStructure) reasons.push('range/path data structure');
  if (hasOptimizationClaim) reasons.push('optimized DP/greedy claim');

  const compositeScore = [hasTreePath, hasDynamicOps, hasCapacityResource, hasRangeDataStructure, hasOptimizationClaim]
    .filter(Boolean).length;
  const missing = [];
  for (const [key, ok] of Object.entries(contract)) {
    if (!ok) missing.push(key);
  }
  const needsComposition = (hasTreePath || hasRangeDataStructure) && (hasDynamicOps || hasCapacityResource || /DP|动态规划|贪心/i.test(combined));
  if (needsComposition && !contract.composition) {
    missing.push('composition');
  }
  const uniqueMissing = [...new Set(missing)];
  const highRisk = compositeScore >= 3 || (hasTreePath && hasDynamicOps && hasCapacityResource);
  const mediumRisk = compositeScore >= 2;
  return {
    level: highRisk ? 'high' : mediumRisk ? 'medium' : 'normal',
    reasons,
    contract,
    missing: uniqueMissing
  };
}

function assertAlgorithmReliabilityContract(problem, algorithm = '') {
  const assessment = assessAlgorithmReliability(problem, algorithm);
  const required = assessment.level === 'high'
    ? ['state', 'transition', 'invariant', 'complexity', 'edgeCases']
    : assessment.level === 'medium'
      ? ['state', 'transition', 'complexity']
      : [];
  if (assessment.level !== 'high' && !required.length) return assessment;
  const missing = required.filter(key => !assessment.contract[key]);
  const needsComposition = assessment.reasons.some(r => /tree\/path|range\/path/.test(r))
    && assessment.reasons.some(r => /dynamic|capacity|optimized/.test(r));
  if (needsComposition && !assessment.contract.composition) missing.push('composition');
  const uniqueMissing = [...new Set(missing)];
  if (!uniqueMissing.length) return assessment;
  const error = new Error(`algorithm reliability contract incomplete for ${assessment.level}-risk design: missing ${uniqueMissing.join(', ')}`);
  error.statusCode = 422;
  throw error;
}

function shouldRunRiskVerification(reliability) {
  return SOLUTION_VERIFICATION_LEVEL === 'strict' || reliability?.level === 'high';
}

function shouldRunDualVerification() {
  return SOLUTION_VERIFICATION_LEVEL === 'strict';
}

function hasAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

function ensureAlgorithmPlanLooksReasonable(plan) {
  const text = String(plan || '');
  const required = ['# 算法草案', '## 题目重述', '## 约束提取', '## 算法选择', '## 正确性要点', '## 复杂度目标', '## 高风险反例'];
  const missing = required.filter(header => !text.includes(header));
  if (text.length < 120 || missing.length) {
    const error = new Error(`algorithm plan looks invalid${missing.length ? `: missing ${missing.join(', ')}` : ''}`);
    error.statusCode = 422;
    throw error;
  }
}

function assertCppLooksReasonable(cpp) {
  const code = String(cpp || '');
  if (code.includes('```')) {
    const error = new Error('std.cpp candidate still contains Markdown fence');
    error.statusCode = 422;
    throw error;
  }
  if (code.length < 40 || !/#include|import\s+</.test(code) || !/\b(main)\s*\(/.test(code)) {
    const error = new Error('std.cpp candidate looks invalid');
    error.statusCode = 422;
    throw error;
  }
  if (/TODO|伪代码|pseudo/i.test(code)) {
    const error = new Error('std.cpp candidate contains placeholder text');
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

function detectProblemGuarantees(problemMd) {
  const text = String(problemMd || '');
  const normalized = text.replace(/\s+/g, ' ');
  return {
    adjacentDistanceLeCapacity: /X_\{?i\}?\s*-\s*X_\{?i-1\}?\s*\\?le|X_i\s*-\s*X_\{?i-1\}?\s*<=|相邻[^。；\n]*(?:不超过|<=|≤)[^。；\n]*C|每段[^。；\n]*(?:不超过|<=|≤)[^。；\n]*C/i.test(normalized),
    finalDistanceLeCapacity: /D\s*-\s*X_\{?N\}?\s*\\?le|D\s*-\s*X_N\s*<=|最后[^。；\n]*(?:不超过|<=|≤)[^。；\n]*C|终点[^。；\n]*(?:不超过|<=|≤)[^。；\n]*C/i.test(normalized)
  };
}

function assertDataArtifactsRespectProblemGuarantees(problemMd, plan, genPy, validatorPy = '') {
  const guarantees = detectProblemGuarantees(problemMd);
  const combined = `${plan || ''}\n${genPy || ''}`;
  if (guarantees.adjacentDistanceLeCapacity || guarantees.finalDistanceLeCapacity) {
    const suspicious = [
      /impossible/i,
      /无解数据/,
      /gap\s*>\s*C/i,
      />\s*C/,
      /C\s*\+\s*random/i,
      /C\s*\+\s*randint/i,
      /距离超过.*C/,
      /大于.*C/
    ];
    if (suspicious.some(re => re.test(combined))) {
      const error = new Error('data plan/gen.py violates problem reachability guarantees');
      error.statusCode = 422;
      throw error;
    }
  }
  if ((guarantees.adjacentDistanceLeCapacity || guarantees.finalDistanceLeCapacity) && validatorPy) {
    const validator = String(validatorPy || '');
    if (/skip hard failing|不会?失败|不检查|skip/i.test(validator) && /gap|距离|X_i|X\[i\]|C/.test(validator)) {
      const error = new Error('validator.py appears to skip problem distance guarantees');
      error.statusCode = 422;
      throw error;
    }
  }
}

async function assertGeneratedInputsRespectProblemGuarantees(problemMd, zipContent) {
  const guarantees = detectProblemGuarantees(problemMd);
  if (!guarantees.adjacentDistanceLeCapacity && !guarantees.finalDistanceLeCapacity) return;
  const zipHex = Buffer.from(zipContent).toString('hex');
  const checker = `
import sys, zipfile, tempfile, pathlib
data = bytes.fromhex(${JSON.stringify(zipHex)})
tmp = pathlib.Path(tempfile.mkdtemp()) / "datas.zip"
tmp.write_bytes(data)
bad = []
with zipfile.ZipFile(tmp) as zf:
    for name in sorted(n for n in zf.namelist() if n.endswith(".in")):
        vals = list(map(int, zf.read(name).decode().split()))
        if len(vals) < 4:
            bad.append(f"{name}: too few tokens")
            continue
        N, D, C, K = vals[:4]
        pairs = list(zip(vals[4::2], vals[5::2]))
        if len(pairs) != N + 1:
            bad.append(f"{name}: station count {len(pairs)} != {N + 1}")
            continue
        X = [x for x, _ in pairs]
        if ${guarantees.adjacentDistanceLeCapacity ? 'True' : 'False'}:
            for i in range(1, len(X)):
                if X[i] - X[i - 1] > C:
                    bad.append(f"{name}: gap {i}={X[i]-X[i-1]} > C={C}")
                    break
        if ${guarantees.finalDistanceLeCapacity ? 'True' : 'False'} and D - X[-1] > C:
            bad.append(f"{name}: final gap {D-X[-1]} > C={C}")
if bad:
    print("\\n".join(bad[:20]), file=sys.stderr)
    sys.exit(1)
`;
  try {
    await runPython(checker, 30000);
  } catch (error) {
    const wrapped = new Error(`generated data violates problem guarantees: ${error.message}`);
    wrapped.statusCode = 422;
    throw wrapped;
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
