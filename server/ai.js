const hasRealLLM = Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL_NAME);

export async function callLLM(messages, options = {}) {
  if (!hasRealLLM) {
    return mockLLM(messages, options);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
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
      temperature: options.temperature ?? 0.2
    })
  });
  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM response missing content');
  return content;
}

function mockLLM(messages, options = {}) {
  const joined = messages.map(item => `${item.role}: ${item.content}`).join('\n');
  if (joined.includes('PROBLEM_REWRITE')) {
    return `# 改编题目\n\n> 这里是本地开发用的占位改编结果。\n\n${extractSourceHint(joined)}\n\n## 题意\n给定一个整数序列，请设计一个满足约束的算法。\n\n## 输入格式\n略。\n\n## 输出格式\n略。\n`;
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
