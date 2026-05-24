<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">AI</div>
        <div class="title">AI 出题工作台</div>
        <div class="subtitle">改编题目、题解、数据一体化工作流</div>
      </div>
      <div class="statusbar">
        <span class="status-pill live">LIVE</span>
        <span class="status-pill">{{ workspaceId ? 'workspace ready' : 'no workspace' }}</span>
        <span class="status-pill">{{ workspaceToken ? 'locked' : 'open' }}</span>
      </div>
      <div class="actions">
        <button class="btn" @click="createWorkspace">新建工作区</button>
        <button class="btn" @click="downloadAll" :disabled="!workspaceId">下载整包</button>
        <button class="btn primary" @click="refreshAll" :disabled="!workspaceId">刷新</button>
      </div>
    </header>

    <main class="layout">
      <aside class="sidebar">
        <div class="section">
          <div class="section-title">当前工作区</div>
          <div class="workspace-id">{{ workspaceId || '未选择' }}</div>
          <div class="subtitle" v-if="workspaceToken">已绑定访问令牌</div>
        </div>

        <div class="section">
          <button
            v-for="item in tabs"
            :key="item.key"
            class="tab"
            :class="{ active: tab === item.key }"
            @click="tab = item.key"
          >
            {{ item.label }}
          </button>
        </div>

        <div class="section">
          <div class="section-title">状态</div>
          <div v-for="(item, key) in status" :key="key" class="status-line">
            <span>{{ key }}</span>
            <b>{{ item.state }}</b>
          </div>
          <div class="subtitle" v-if="status.problem.message || status.solution.message || status.data.message">
            {{ status.problem.message || status.solution.message || status.data.message }}
          </div>
        </div>

        <div class="section">
          <div class="section-title">文件</div>
          <div v-for="file in files" :key="file" class="file-item" @click="openFile(file)">
            {{ file }}
          </div>
        </div>

        <div class="section">
          <div class="section-title">日志</div>
          <div class="file-item" @click="loadLogs">刷新日志</div>
        </div>
      </aside>

      <section class="content">
        <div v-if="errorMessage" class="alert">{{ errorMessage }}</div>

        <div v-if="tab === 'problem'" class="panel">
          <div class="panel-head">
            <h2>出题</h2>
            <span class="panel-chip">problem.md</span>
          </div>
          <textarea v-model="problemRaw" placeholder="粘贴题面"></textarea>
          <div class="row">
            <select v-model="difficultyMode">
              <option value="same">难度不变</option>
              <option value="custom">用户自行设定</option>
            </select>
            <input v-model="difficultyText" placeholder="自定义难度说明" />
          </div>
          <div class="row">
            <button class="btn primary" @click="saveProblemRaw">保存题面</button>
            <button class="btn" @click="generateProblem" :disabled="!workspaceId">开始改编</button>
          </div>
          <pre>{{ selectedContent || problemPreview }}</pre>
        </div>

        <div v-else-if="tab === 'solution'" class="panel">
          <div class="panel-head">
            <h2>题解</h2>
            <span class="panel-chip">solution.md + std.cpp</span>
          </div>
          <div class="row">
            <button class="btn primary" @click="generateSolution" :disabled="!workspaceId">生成题解</button>
          </div>
          <pre>{{ selectedContent }}</pre>
        </div>

        <div v-else class="panel">
          <div class="panel-head">
            <h2>数据</h2>
            <span class="panel-chip">hack_plan.md + gen.py</span>
          </div>
          <div class="row">
            <button class="btn primary" @click="generateDataPlan" :disabled="!workspaceId">生成数据方案</button>
            <button class="btn" @click="runData" :disabled="!workspaceId">Run</button>
          </div>
          <pre>{{ selectedContent }}</pre>
        </div>

        <div class="panel" v-if="logsText">
          <div class="panel-head">
            <h2>日志</h2>
            <span class="panel-chip">activity</span>
          </div>
          <pre>{{ logsText }}</pre>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';

const tabs = [
  { key: 'problem', label: '出题' },
  { key: 'solution', label: '题解' },
  { key: 'data', label: '数据' }
];

const tab = ref('problem');
const workspaceId = ref(localStorage.getItem('workspaceId') || '');
const workspaceToken = ref(localStorage.getItem('workspaceToken') || '');
const files = ref([]);
const selectedContent = ref('');
const problemRaw = ref('');
const problemPreview = ref('');
const difficultyMode = ref('same');
const difficultyText = ref('');
const errorMessage = ref('');
const logsText = ref('');
const status = ref({
  problem: { state: 'idle' },
  solution: { state: 'idle' },
  data: { state: 'idle' }
});

function persistWorkspace(meta) {
  workspaceId.value = meta.workspaceId;
  workspaceToken.value = meta.accessToken || workspaceToken.value || '';
  localStorage.setItem('workspaceId', workspaceId.value);
  if (workspaceToken.value) {
    localStorage.setItem('workspaceToken', workspaceToken.value);
  }
}

async function api(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (workspaceToken.value) {
    headers['x-workspace-token'] = workspaceToken.value;
  }
  const res = await fetch(url, {
    ...options,
    headers
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
    throw new Error(data.error || text || 'request failed');
  }
  return data;
}

async function loadWorkspace() {
  if (!workspaceId.value || !workspaceToken.value) return;
  const meta = await api(`/api/workspaces/${workspaceId.value}`);
  status.value = meta.status || status.value;
  const fileResp = await api(`/api/workspaces/${workspaceId.value}/files`);
  files.value = fileResp.files || [];
  await loadLogs();
}

async function createWorkspace() {
  const meta = await api('/api/workspaces', { method: 'POST' });
  persistWorkspace(meta);
  await loadWorkspace();
}

async function refreshAll() {
  errorMessage.value = '';
  await loadWorkspace();
}

async function loadLogs() {
  if (!workspaceId.value || !workspaceToken.value) return;
  try {
    const result = await api(`/api/workspaces/${workspaceId.value}/logs`);
    logsText.value = Object.entries(result.logs || {})
      .map(([name, content]) => `== ${name} ==\n${content || ''}`)
      .join('\n');
  } catch (error) {
    errorMessage.value = error.message;
  }
}

async function saveProblemRaw() {
  errorMessage.value = '';
  try {
    if (!workspaceId.value) await createWorkspace();
    if (problemRaw.value.length > 2 * 1024 * 1024) {
      throw new Error('题面过大');
    }
    await fetch(`/api/workspaces/${workspaceId.value}/files/input/problem_raw.md`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-workspace-token': workspaceToken.value
      },
      body: JSON.stringify({ content: problemRaw.value })
    }).then(async res => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'save failed');
      }
    });
    await refreshAll();
    selectedContent.value = problemRaw.value;
  } catch (error) {
    errorMessage.value = error.message;
  }
}

async function generateProblem() {
  errorMessage.value = '';
  const result = await api(`/api/workspaces/${workspaceId.value}/problem`, {
    method: 'POST',
    body: JSON.stringify({
      difficultyMode: difficultyMode.value,
      difficultyText: difficultyText.value,
      sourceText: problemRaw.value
    })
  });
  selectedContent.value = result.content;
  if (result.cached) {
    errorMessage.value = '题目已命中缓存';
  }
  await refreshAll();
}

async function generateSolution() {
  errorMessage.value = '';
  const result = await api(`/api/workspaces/${workspaceId.value}/solution`, { method: 'POST' });
  selectedContent.value = result.markdown;
  if (result.cached) {
    errorMessage.value = '题解已命中缓存';
  }
  await refreshAll();
}

async function generateDataPlan() {
  errorMessage.value = '';
  const result = await api(`/api/workspaces/${workspaceId.value}/data/plan`, { method: 'POST' });
  selectedContent.value = result.plan;
  if (result.cached) {
    errorMessage.value = '数据方案已命中缓存';
  }
  await refreshAll();
}

async function runData() {
  errorMessage.value = '';
  try {
    const result = await api(`/api/workspaces/${workspaceId.value}/data/run`, { method: 'POST' });
    selectedContent.value = JSON.stringify(result, null, 2);
    if (result.cached) {
      errorMessage.value = '数据包已命中缓存';
    }
    await refreshAll();
  } catch (error) {
    errorMessage.value = error.message;
  }
}

async function openFile(file) {
  errorMessage.value = '';
  try {
    const res = await fetch(`/api/workspaces/${workspaceId.value}/files/${file}`, {
      headers: {
        'x-workspace-token': workspaceToken.value
      }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || 'open failed');
    selectedContent.value = text;
  } catch (error) {
    errorMessage.value = error.message;
  }
}

async function downloadAll() {
  if (!workspaceId.value) return;
  const url = new URL(`/api/workspaces/${workspaceId.value}/download`, window.location.origin);
  url.searchParams.set('token', workspaceToken.value);
  window.open(url.toString(), '_blank');
}

onMounted(async () => {
  if (!workspaceId.value || !workspaceToken.value) return;
  try {
    await loadWorkspace();
    const res = await fetch(`/api/workspaces/${workspaceId.value}/files/input/problem_raw.md`, {
      headers: {
        'x-workspace-token': workspaceToken.value
      }
    });
    if (res.ok) {
      problemRaw.value = await res.text();
    }
  } catch (error) {
    errorMessage.value = error.message;
  }
});
</script>
