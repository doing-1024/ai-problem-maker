const hasRealLLM = Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL_NAME);
const RATE_LIMIT_RETRY_BASE_MS = envInt('LLM_RATE_LIMIT_RETRY_BASE_MS', 60_000);
const RATE_LIMIT_RETRY_MAX_MS = envInt('LLM_RATE_LIMIT_RETRY_MAX_MS', 180_000);
const RATE_LIMIT_MAX_ATTEMPTS = Math.max(1, envInt('LLM_RATE_LIMIT_MAX_ATTEMPTS', 3));
const RATE_LIMIT_COOLDOWN_MS = envInt('LLM_RATE_LIMIT_COOLDOWN_MS', 5 * 60_000);
let rateLimitBlockedUntil = 0;

const MOCK_CPP = `#include <bits/stdc++.h>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  long long n;
  if (!(cin >> n)) return 0;
  long long sum = 0;
  for (long long i = 0; i < n; ++i) {
    long long x;
    cin >> x;
    sum += x;
  }
  cout << sum << '\\n';
  return 0;
}
`;

export async function callLLM(messages, options = {}) {
  if (!hasRealLLM) {
    return mockLLM(messages, options);
  }
  throwIfRateLimitCoolingDown();

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
          const retryAfter = response.headers.get('retry-after');
          const body = await response.text();
          const error = new Error(`LLM request failed: ${response.status} ${body}`);
          error.statusCode = response.status;
          error.retryAfterMs = parseRetryAfterMs(retryAfter);
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
      const maxAttempts = isRateLimitError(error) ? Math.min(retries, RATE_LIMIT_MAX_ATTEMPTS) : retries;
      if (attempt < maxAttempts && isRetryableLLMError(error, options)) {
        if (typeof options.onRetry === 'function') {
          const waitMs = retryWaitMs(error, attempt);
          await options.onRetry({
            attempt,
            retries,
            error,
            waitMs
          });
        }
        await sleep(retryWaitMs(error, attempt));
        continue;
      }
      break;
    }
  }
  if (isRateLimitError(lastError)) {
    rateLimitBlockedUntil = Math.max(
      rateLimitBlockedUntil,
      Date.now() + Math.max(Number(lastError?.retryAfterMs || 0), RATE_LIMIT_COOLDOWN_MS)
    );
    throw buildRateLimitError(lastError);
  }
  throw lastError || new Error('LLM failed');
}

function mockLLM(messages, options = {}) {
  const joined = messages.map(item => `${item.role}: ${item.content}`).join('\n');
  if (joined.includes('SIMPLE_JOINT_CONTRACT')) {
    return `<!--PROBLEM_MD-->
# 改编题目

## 题意
给定一个整数序列，求所有整数之和。

## 输入格式
第一行一个整数 n。
第二行 n 个整数。

## 输出格式
输出一个整数，表示所有整数之和。

## 样例

<!--SAMPLE_INPUT-->
\`\`\`
3
1 2 3
\`\`\`
<!--SAMPLE_INPUT_END-->
<!--SAMPLE_OUTPUT-->
\`\`\`
6
\`\`\`
<!--SAMPLE_OUTPUT_END-->

## 数据范围与提示
保证 1 <= n <= 100000，所有整数的绝对值不超过 1000000000。
<!--PROBLEM_MD_END-->
<!--ALGORITHM_MD-->
# 算法草案

## 题目重述
读入 n 个整数并输出它们的总和。

## 约束提取
n 最大为 100000，数值和可能超过 32 位整数。

## 算法选择
使用 long long 变量 ans 维护前缀和，顺序读入每个数 x 后执行 ans += x。

## 正确性要点
不变量：处理前 i 个数后，ans 等于这 i 个数的和。初始为 0，读入一个数后加到 ans 中，不变量保持。处理完 n 个数后 ans 即为全部数之和。

## 复杂度目标
时间复杂度 O(n)，空间复杂度 O(1)。

## 高风险反例
n=1、存在负数、正负抵消、总和超过 int。
<!--ALGORITHM_MD_END-->
<!--STD_CPP-->
${MOCK_CPP}
<!--STD_CPP_END-->`;
  }

  if (joined.includes('INDEPENDENT_ORACLE_BUNDLE')) {
    return `<!--ORACLE_CPP-->
${MOCK_CPP}
<!--ORACLE_CPP_END-->
<!--TEST_GEN_PY-->
cases = [
    "3\\n1 2 3",
    "1\\n7",
    "5\\n-1 0 1 2 3",
    "4\\n10 20 30 40",
    "2\\n-5 5",
]
for i in range(80):
    if i:
        print("===CASE===")
    print(cases[i % len(cases)])
<!--TEST_GEN_PY_END-->`;
  }

  if (joined.includes('DATA_BUNDLE')) {
    return `<!--DATA_PLAN_MD-->
# 数据方案

## 点数分布
- 20%: n=1 的最小规模和单个负数。
- 30%: 小规模含正负抵消。
- 30%: 普通随机。
- 20%: 较大数值，覆盖 long long。
<!--DATA_PLAN_MD_END-->
<!--PROBLEM_TYPE_JSON-->
{
  "type": "standard",
  "outputUniqueness": "unique",
  "requiresChecker": false,
  "reasons": ["本地 mock 默认生成唯一答案题。"]
}
<!--PROBLEM_TYPE_JSON_END-->
<!--GEN_PY-->
import pathlib

cases = [
    "3\\n1 2 3\\n",
    "1\\n7\\n",
    "5\\n-1 0 1 2 3\\n",
]

for i, case in enumerate(cases, 1):
    with open(f"{i}.in", "w", encoding="utf-8") as f:
        f.write(case)
<!--GEN_PY_END-->
<!--VALIDATOR_PY-->
import sys

data = sys.stdin.read().strip().split()
if not data:
    print("empty input", file=sys.stderr)
    sys.exit(1)
try:
    n = int(data[0])
    values = [int(x) for x in data[1:]]
except Exception as exc:
    print(f"non-integer token: {exc}", file=sys.stderr)
    sys.exit(1)
if n < 1:
    print("n must be positive", file=sys.stderr)
    sys.exit(1)
if len(values) != n:
    print(f"expected {n} values, got {len(values)}", file=sys.stderr)
    sys.exit(1)
sys.exit(0)
<!--VALIDATOR_PY_END-->
<!--CHECKER_CPP-->
<!--CHECKER_CPP_END-->`;
  }

  if (joined.includes('PROBLEM_REVIEW')) {
    return 'PASS\n- 本地 mock 跳过难度与算法范式审校。';
  }

  if (joined.includes('PROBLEM_REVISE')) {
    return `# 修订题目\n\n## 题意\n给定一个由用户素材改编的新问题，请根据用户难度要求选择同一算法谱系内的合适模型。\n\n## 输入格式\n第一行一个整数 n。\n第二行 n 个整数。\n\n## 输出格式\n输出一个整数。\n\n## 样例\n\n### 样例输入\n\`\`\`\n3\n1 2 3\n\`\`\`\n\n### 样例输出\n\`\`\`\n6\n\`\`\`\n\n## 数据范围与提示\n- 数据范围应与用户要求的难度一致。\n- 改编应保持原题基础算法范式。\n`;
  }

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
    return `# 题解\n\n这是本地开发占位题解。\n\n## 思路\n读入整数个数 n，再顺序读入 n 个整数并累计总和。\n\n## 正确性\n算法对输入中的每个整数恰好加入答案一次，因此得到的结果等于全部整数之和，符合题意。\n\n## 复杂度\n时间复杂度 $O(n)$，空间复杂度 $O(1)$。\n\n---\n\n\`\`\`cpp\n${MOCK_CPP}\`\`\`\n`;
  }

  if (joined.includes('SOLUTION_ALGORITHM')) {
    return `# 算法草案

## 题目重述
给定整数个数 n 和 n 个整数，输出所有整数之和。

## 约束提取
- 输入第一行包含 n。
- 第二行包含 n 个整数。
- 需要处理负数和零。

## 算法选择
顺序扫描所有输入整数并累加。

## 正确性要点
每个输入数恰好被加入答案一次，因此最终和等于题目要求的总和。

## 复杂度目标
时间复杂度 O(n)，空间复杂度 O(1)。

## 高风险反例
- n=1。
- 所有数为负数。
- 正负数抵消为 0。
`;
  }

  if (joined.includes('FINAL_PROBLEM_ALGORITHM')) {
    return `# 算法草案

## 题目重述
给定整数个数 n 和 n 个整数，输出所有整数之和。

## 难度命中理由
本地 mock 使用顺序扫描模型，重点验证流程对齐逻辑。

## 约束提取
- 输入第一行包含 n。
- 第二行包含 n 个整数。

## 算法选择
顺序读入并累加所有整数。

## 正确性要点
每个整数被加入答案一次且仅一次。

## 复杂度目标
时间复杂度 O(n)，空间复杂度 O(1)。

## 高风险反例
- n=1。
- 存在负数或零。
`;
  }

  if (joined.includes('FINAL_PROBLEM_STD_CPP')) {
    return `\`\`\`cpp
${MOCK_CPP}\`\`\`
`;
  }

  if (joined.includes('STD_CPP_CANDIDATE')) {
    return `\`\`\`cpp
${MOCK_CPP}\`\`\`
`;
  }

  if (joined.includes('SOLUTION_FROM_STD')) {
    return `# 题解

## 思路
读入整数个数 n，再顺序读入 n 个整数并累计总和。

## 正确性
每个输入整数都会被访问一次并加入同一个累加变量，没有遗漏或重复。因此最终输出值正好是所有输入整数的和。

## 复杂度
时间复杂度 $O(n)$，空间复杂度 $O(1)$。
`;
  }

  if (joined.includes('SOLUTION_CRITIC')) {
    return `- 需要确认题意边界。\n- 需要检查复杂度陈述。\n- 需要保证标程与题解一致。`;
  }

  if (joined.includes('SOLUTION_FINAL')) {
    return `# 题解\n\n## 思路\n读入整数个数 n，再顺序读入 n 个整数并累计总和。\n\n## 正确性\n每个输入整数都会被访问一次并加入同一个累加变量，没有遗漏或重复。因此最终输出值正好是所有输入整数的和。\n\n## 复杂度\n时间复杂度 $O(n)$，空间复杂度 $O(1)$。\n\n\`\`\`cpp\n${MOCK_CPP}\`\`\`\n`;
  }

  if (joined.includes('SOLUTION_REPAIR')) {
    return `# 题解\n\n## 思路\n读入整数个数 n，再顺序读入 n 个整数并累计总和。\n\n## 正确性\n每个输入整数都会被访问一次并加入同一个累加变量，没有遗漏或重复。因此最终输出值正好是所有输入整数的和。\n\n## 复杂度\n时间复杂度 $O(n)$，空间复杂度 $O(1)$。\n\n\`\`\`cpp\n${MOCK_CPP}\`\`\`\n`;
  }

  if (joined.includes('CODE_REVIEW')) {
    return 'PASS\n- 本地 mock 跳过算法代码审查。';
  }

  if (joined.includes('FULL_AC_REVIEW')) {
    return 'PASS\n- 本地 mock 跳过满分复杂度终审。';
  }

  if (joined.includes('COMPILE_FIX') || joined.includes('CODE_FIX') || joined.includes('ALT_SOL') || joined.includes('DUAL_FIX') || joined.includes('BRUTE_ORACLE')) {
    return `\`\`\`cpp\n${MOCK_CPP}\`\`\`\n`;
  }

  if (joined.includes('TEST_GEN') || joined.includes('BRUTE_TEST_GEN') || joined.includes('COUNTEREXAMPLE_GEN')) {
    return `cases = [
    "3\\n1 2 3",
    "1\\n7",
    "5\\n-1 0 1 2 3",
    "4\\n10 20 30 40",
    "2\\n-5 5",
]
for i in range(220):
    if i:
        print("===CASE===")
    print(cases[i % len(cases)])
`;
  }

  if (joined.includes('DATA_PLAN')) {
    return `# 数据方案\n\n- 构造极小值、极大值、随机值\n- 构造链式、星形、分块结构\n- 构造边界重复值与特殊退化结构\n\n## 点数分布\n- 10%: 小规模样例\n- 40%: 普通随机\n- 30%: 极端退化\n- 20%: 大规模压力\n`;
  }

  if (joined.includes('PROBLEM_TYPE_ANALYSIS')) {
    return JSON.stringify({
      type: 'standard',
      outputUniqueness: 'unique',
      requiresChecker: false,
      reasons: ['本地 mock 默认生成唯一答案题。']
    }, null, 2);
  }

  if (joined.includes('VALIDATOR_PY')) {
    return `import sys

data = sys.stdin.read().strip().split()
if not data:
    print("empty input", file=sys.stderr)
    sys.exit(1)
try:
    n = int(data[0])
    values = [int(x) for x in data[1:]]
except Exception as exc:
    print(f"non-integer token: {exc}", file=sys.stderr)
    sys.exit(1)
if n < 0:
    print("n must be non-negative", file=sys.stderr)
    sys.exit(1)
if len(values) != n:
    print(f"expected {n} values, got {len(values)}", file=sys.stderr)
    sys.exit(1)
sys.exit(0)
`;
  }

  if (joined.includes('CHECKER_CPP')) {
    return `\`\`\`cpp
#include <bits/stdc++.h>
using namespace std;
static string readAll(const char* path) {
  ifstream in(path);
  return string((istreambuf_iterator<char>(in)), istreambuf_iterator<char>());
}
static vector<string> toks(string s) {
  stringstream ss(s);
  vector<string> v;
  string x;
  while (ss >> x) v.push_back(x);
  return v;
}
int main(int argc, char** argv) {
  if (argc < 4) return 2;
  return toks(readAll(argv[2])) == toks(readAll(argv[3])) ? 0 : 1;
}
\`\`\`
`;
  }

  if (joined.includes('GEN_PY_FIX')) {
    return `import pathlib

cases = [
    "3\\n1 2 3\\n",
    "1\\n7\\n",
    "5\\n-1 0 1 2 3\\n",
]

for i, case in enumerate(cases, 1):
    with open(f"{i}.in", "w", encoding="utf-8") as f:
        f.write(case)
`;
  }

  if (joined.includes('GEN_PY')) {
    return `import pathlib

cases = [
    "3\\n1 2 3\\n",
    "1\\n7\\n",
    "5\\n-1 0 1 2 3\\n",
]

for i, case in enumerate(cases, 1):
    with open(f"{i}.in", "w", encoding="utf-8") as f:
        f.write(case)
`;
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

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseRetryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
}

function throwIfRateLimitCoolingDown() {
  if (Date.now() >= rateLimitBlockedUntil) return;
  throw buildRateLimitError(null);
}

function buildRateLimitError(cause) {
  const remainingMs = Math.max(0, rateLimitBlockedUntil - Date.now());
  const suffix = remainingMs > 0 ? `预计 ${Math.ceil(remainingMs / 1000)} 秒后可重试。` : '请稍后重试。';
  const error = new Error(`AI 供应商当前限流，${suffix}系统已减少无效重试以避免长时间卡住。`);
  error.statusCode = 503;
  if (cause) error.cause = cause;
  return error;
}

function isRetryableLLMError(error, options = {}) {
  const status = Number(error?.statusCode || error?.status || 0);
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('http error 405') || message.includes('method not allowed')) {
    return options.retryMethodErrors !== false;
  }
  if (status >= 500 || status === 429) return true;
  if (error?.retryable) return true;
  if (message.includes('fetch failed')) return true;
  if (message.includes('network') || message.includes('timeout') || message.includes('abort')) return true;
  if (message.includes('missing content') || message.includes('empty')) return true;
  return false;
}

function isRateLimitError(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  const message = String(error?.message || '').toLowerCase();
  return status === 429 || message.includes('http error 429') || message.includes('too many requests');
}

function retryWaitMs(error, attempt) {
  if (isRateLimitError(error)) {
    return Math.max(
      Number(error?.retryAfterMs || 0),
      Math.min(RATE_LIMIT_RETRY_BASE_MS * attempt, RATE_LIMIT_RETRY_MAX_MS)
    );
  }
  return Math.min(1000 * attempt, 3000);
}
