const hasRealLLM = Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL_NAME);

export async function callLLM(messages, options = {}) {
  if (!hasRealLLM) {
    return mockLLM(messages, options);
  }

  const retries = Number.isInteger(options.retries) ? options.retries : 5;
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
      try {
        const response = await fetch(`${process.env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.LLM_API_KEY}`,
            'Content-Type': 'application/json'
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: process.env.LLM_MODEL_NAME,
            messages,
            temperature: options.temperature ?? 0.2,
            max_tokens: options.maxTokens ?? 4096
          })
        });

        if (!response.ok) {
          const body = await response.text();
          const error = new Error(`LLM request failed: ${response.status} ${body}`);
          error.statusCode = response.status;
          throw error;
        }

        const data = await response.json();
        const choice = data?.choices?.[0];
        const content = choice?.message?.content;
        if (!content) throw new Error('LLM response missing content');
        if (typeof options.onComplete === 'function') {
          await options.onComplete({
            finishReason: choice?.finish_reason || '',
            usage: data?.usage || null,
            contentLength: content.length
          });
        }
        if (choice?.finish_reason === 'length') {
          const error = new Error('LLM response hit max_tokens before completion');
          error.statusCode = 502;
          error.retryable = true;
          error.finishReason = choice.finish_reason;
          throw error;
        }
        return content;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries && isRetryableLLMError(error)) {
        if (typeof options.onRetry === 'function') {
          await options.onRetry({
            attempt,
            retries,
            error,
            waitMs: Math.min(1000 * attempt, 3000)
          });
        }
        await sleep(Math.min(1000 * attempt, 3000));
        continue;
      }
      break;
    }
  }
  throw lastError || new Error('LLM failed');
}

function mockLLM(messages, options = {}) {
  const joined = messages.map(item => `${item.role}: ${item.content}`).join('\n');
  if (joined.includes('PROBLEM_REWRITE')) {
    return `# 改编题目\n\n> 这里是本地开发用的占位改编结果。\n\n${extractSourceHint(joined)}\n\n## 题意\n给定一个由用户素材改编的新问题，请根据用户难度要求选择合适的算法模型。\n\n## 输入格式\n第一行一个整数 n。\n第二行 n 个整数。\n\n## 输出格式\n输出一个整数。\n\n## 样例\n\n### 样例输入\n\`\`\`\n3\n1 2 3\n\`\`\`\n\n### 样例输出\n\`\`\`\n6\n\`\`\`\n\n## 数据范围与提示\n- 数据范围应与用户要求的难度一致。\n- 可以使用与原题不同的算法和建模方式。\n`;
  }

  if (
    joined.includes('Markdown 修复助手') ||
    joined.includes('题面补全助手') ||
    joined.includes('题面重写与补全助手') ||
    joined.includes('题目难度调节助手')
  ) {
    const source = extractSourceHint(joined);
    return `# 改编题目\n\n> 本地开发占位输出，已补齐结构。\n\n${source || '原题面'}\n\n## 题意\n给定一个整数序列，请设计一个与用户难度要求一致的改编题。\n\n## 输入格式\n第一行一个整数 n。\n第二行 n 个整数。\n\n## 输出格式\n输出一个整数。\n\n## 样例\n\n### 样例输入\n\`\`\`\n3\n1 2 3\n\`\`\`\n\n### 样例输出\n\`\`\`\n6\n\`\`\`\n\n## 数据范围与提示\n- 题目难度、数据范围与题意描述保持和用户要求一致。\n- 仅做结构补全，不额外替用户压低或抬高难度。\n`;
  }

  if (joined.includes('SOLUTION_DRAFT')) {
    return `# 题解\n\n这是本地开发占位题解。\n\n## 思路\n先分析题意，再构造可行算法。\n\n## 正确性\n由于实现为占位内容，此处后续由真实 AI 补充。\n\n## 复杂度\n$O(n \\log n)$\n\n---\n\n\`\`\`cpp\n#include <bits/stdc++.h>\nusing namespace std;\nint main() { return 0; }\n\`\`\`\n`;
  }

  if (joined.includes('SOLUTION_CRITIC')) {
    return `- 需要确认题意边界。\n- 需要检查复杂度陈述。\n- 需要保证标程与题解一致。`;
  }

  if (joined.includes('SOLUTION_FINAL')) {
    return `# 题解\n\n## 思路\n先分析题意，再构造可行算法。\n\n## 正确性\n通过逐步分析约束可得算法正确。\n\n## 复杂度\n$O(n \\log n)$\n\n\`\`\`cpp\n#include <bits/stdc++.h>\nusing namespace std;\nint main() { return 0; }\n\`\`\`\n`;
  }

  if (joined.includes('DATA_PLAN')) {
    return `# 数据方案\n\n- 构造极小值、极大值、随机值\n- 构造链式、星形、分块结构\n- 构造边界重复值与特殊退化结构\n\n## 点数分布\n- 10%: 小规模样例\n- 40%: 普通随机\n- 30%: 极端退化\n- 20%: 大规模压力\n`;
  }

  if (joined.includes('GEN_PY')) {
    return `import random\n\nrandom.seed(0)\nprint(1)\nprint(1)\n`;
  }

  return options.fallback ?? 'mock response';
}

function extractSourceHint(joined) {
  const marker = 'SOURCE_TEXT:\n';
  const idx = joined.indexOf(marker);
  if (idx === -1) return '';
  return joined.slice(idx + marker.length).slice(0, 200);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableLLMError(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  if (status >= 500 || status === 429) return true;
  if (error?.retryable) return true;
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('fetch failed')) return true;
  if (message.includes('network') || message.includes('timeout') || message.includes('abort')) return true;
  return false;
}
