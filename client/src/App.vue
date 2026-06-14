<template>
  <div class="ide-shell">
    <header class="titlebar">
      <div class="brand">
        <a href="https://github.com/doing-1024/ai-problem-maker" target="_blank" rel="noopener" class="brand-github" title="GitHub">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
        </a>
        <span class="brand-mark">ASOI</span>
        <span>AI 出题工作台</span>
      </div>
      <div class="titlebar-meta">
        <span>{{ workspaceId || '未选择工作区' }}</span>
        <span>{{ liveEvent ? activeJobMessage || '任务运行中' : '就绪' }}</span>
      </div>
      <div class="titlebar-actions">
        <button class="button" @click="createWorkspace">新建工作区</button>
        <button class="button" @click="refreshAll" :disabled="!workspaceId">刷新</button>
        <button class="button primary" @click="downloadAll" :disabled="!workspaceId">下载整包</button>
      </div>
    </header>

    <main class="ide-layout">
      <aside class="sidebar files-sidebar">
        <div class="pane-head">
          <h2>中间文件</h2>
          <span>{{ files.length }}</span>
        </div>
        <div class="file-tree" v-if="groupedFiles.length">
          <section v-for="group in groupedFiles" :key="group.name" class="file-group">
            <div class="group-name">
              <span v-if="group.isZip" class="zip-toggle" @click.stop="openFile(group.zipPath)">
                {{ group.expanded ? '▼' : '▶' }}
              </span>
              {{ group.name }}
            </div>
            <button
              v-for="file in group.files"
              :key="file"
              class="file-row"
              :class="{ active: selectedFile === file }"
              @click="openFile(file)"
            >
              <span class="file-icon">{{ fileIcon(file) }}</span>
              <span>{{ baseName(file) }}</span>
            </button>
          </section>
        </div>
        <div v-else class="empty">创建工作区后显示文件</div>
      </aside>

      <section class="editor-pane">
        <div class="editor-tabs">
          <button class="editor-tab active">
            {{ selectedFile || defaultFileName }}
            <span v-if="isDirty" class="dirty-dot"></span>
          </button>
          <div class="editor-tools">
            <span class="muted" v-if="livePreview">实时预览</span>
            <span class="muted" v-else>{{ selectedFile ? (canEditSelected ? '可编辑' : '只读') : '等待选择文件' }}</span>
            <button class="button small" @click="saveSelectedFile" :disabled="!canEditSelected || !isDirty">保存</button>
          </div>
        </div>

        <div class="editor-meta" v-if="liveEvent">
          <span>{{ liveEvent.stage }}</span>
          <span>{{ liveEvent.state || liveEvent.phase }}</span>
          <span>{{ activeJobMessage }}</span>
        </div>

        <div v-show="editorIsText" ref="editorHost" class="code-editor"></div>
        <pre v-show="!editorIsText" class="binary-viewer">{{ selectedContent || '该文件不适合直接文本编辑，请下载整包查看。' }}</pre>

        <div v-if="errorMessage" class="status-message error">{{ errorMessage }}</div>
        <div v-if="successMessage" class="status-message ok">{{ successMessage }}</div>
      </section>

      <aside class="sidebar ops-sidebar">
        <section class="ops-section">
          <div class="pane-head">
            <h2>工作区</h2>
            <span>{{ workspaceToken ? 'locked' : 'open' }}</span>
          </div>
          <div class="workspace-card">
            <div class="label">当前 ID</div>
            <div class="mono">{{ workspaceId || '无' }}</div>
          </div>
        </section>

        <section class="ops-section">
          <div class="pane-head">
            <h2>业务流程</h2>
            <span>{{ pipelineDone }}/4</span>
          </div>
          <div class="pipeline">
            <div v-for="step in pipeline" :key="step.key" class="pipeline-step" :class="step.state">
              <div>
                <strong>{{ step.label }}</strong>
                <p>{{ step.message }}</p>
              </div>
              <button class="button small" @click="step.action" :disabled="step.disabled">{{ step.actionLabel }}</button>
            </div>
          </div>
        </section>

        <section class="ops-section">
          <div class="pane-head">
            <h2>难度设置</h2>
            <span>{{ difficultyMode === 'same' ? '同难度' : '自定义' }}</span>
          </div>
          <select v-model="difficultyMode">
            <option value="same">参考原题，强改背景</option>
            <option value="custom">用户自行设定</option>
          </select>
          <input v-model="difficultyText" placeholder="目标难度，如 NOIP T2 / 省选入门" />
          <textarea v-model="problemRaw" class="source-input" placeholder="原题素材，可从 input/problem_raw.md 载入或直接粘贴"></textarea>
          <button class="button primary block" @click="saveProblemRaw">保存原题素材</button>
        </section>

        <section class="ops-section">
          <div class="pane-head">
            <h2>质量报告</h2>
            <span>{{ qualityScore }}/{{ qualityItems.length }}</span>
          </div>
          <div class="quality-list">
            <div v-for="item in qualityItems" :key="item.label" class="quality-row" :class="{ pass: item.pass }">
              <span>{{ item.pass ? 'OK' : 'TODO' }}</span>
              <p>{{ item.label }}</p>
            </div>
          </div>
        </section>

        <section class="ops-section">
          <div class="pane-head">
            <h2>日志</h2>
            <button class="link-button" @click="loadLogs" :disabled="!workspaceId">刷新</button>
          </div>
          <pre class="log-view">{{ logsText || '暂无日志' }}</pre>
        </section>
      </aside>
    </main>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JSZip from 'jszip';

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  }
};

const workspaceId = ref(localStorage.getItem('workspaceId') || '');
const workspaceToken = ref(localStorage.getItem('workspaceToken') || '');
const files = ref([]);
const selectedFile = ref('');
const selectedContent = ref('');
const editorContent = ref('');
const editorHost = ref(null);
const problemRaw = ref('');
const difficultyMode = ref('same');
const difficultyText = ref('');
const errorMessage = ref('');
const successMessage = ref('');
const logsText = ref('');
const liveEvent = ref(null);
const activeJobMessage = ref('');
const livePreview = ref(false);
const status = ref({
  problem: { state: 'idle', message: '' },
  solution: { state: 'idle', message: '' },
  data: { state: 'idle', message: '' }
});

const zipContents = ref(new Map());
const expandedZips = ref(new Set());

let eventSource = null;
let monacoEditor = null;
let monacoChangeSubscription = null;
let settingEditorValue = false;

const writableFiles = new Set([
  'input/problem_raw.md',
  'problem/problem.md',
  'solution/solution.md',
  'solution/std.cpp',
  'data/hack_plan.md',
  'data/gen.py'
]);

const defaultFileName = computed(() => selectedFile.value || 'problem/problem.md');
const isZipInternalFile = computed(() => selectedFile.value && selectedFile.value.includes('::'));
const canEditSelected = computed(() => Boolean(selectedFile.value && writableFiles.has(selectedFile.value) && !isZipInternalFile.value));
const editorIsText = computed(() => !selectedFile.value || !selectedFile.value.endsWith('.zip') || isZipInternalFile.value);
const isDirty = computed(() => editorContent.value !== selectedContent.value && canEditSelected.value && !livePreview.value);

const groupedFiles = computed(() => {
  const buckets = new Map();
  for (const file of files.value) {
    const [group = 'root'] = file.split('/');
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group).push(file);
  }
  const groups = Array.from(buckets.entries()).map(([name, groupFiles]) => ({
    name,
    files: groupFiles.sort()
  }));

  for (const zipFile of files.value.filter(f => f.endsWith('.zip'))) {
    const contents = zipContents.value.get(zipFile) || [];
    if (contents.length > 0) {
      const zipGroupName = `${zipFile} [zip]`;
      const isExpanded = expandedZips.value.has(zipFile);
      groups.push({
        name: zipGroupName,
        files: isExpanded ? contents.map(c => `${zipFile}::${c}`) : [],
        isZip: true,
        zipPath: zipFile,
        expanded: isExpanded
      });
    }
  }

  return groups;
});

const pipeline = computed(() => [
  {
    key: 'input',
    label: '原题素材',
    state: problemRaw.value.trim() ? 'done' : 'idle',
    message: problemRaw.value.trim() ? '已准备输入素材' : '粘贴或编辑原题素材',
    actionLabel: '保存',
    action: saveProblemRaw,
    disabled: !workspaceId.value && !problemRaw.value.trim()
  },
  {
    key: 'problem',
    label: '改编题面',
    state: status.value.problem?.state || 'idle',
    message: status.value.problem?.message || '生成 problem.md',
    actionLabel: '生成',
    action: generateProblem,
    disabled: !workspaceId.value
  },
  {
    key: 'solution',
    label: '题解标程',
    state: status.value.solution?.state || 'idle',
    message: status.value.solution?.message || '生成 solution.md 与 std.cpp',
    actionLabel: '生成',
    action: generateSolution,
    disabled: !workspaceId.value || !files.value.includes('problem/problem.md')
  },
  {
    key: 'data',
    label: '数据打包',
    state: files.value.includes('data/datas.zip') ? 'done' : status.value.data?.state || 'idle',
    message: status.value.data?.message || '生成数据方案并运行 gen.py',
    actionLabel: files.value.includes('data/gen.py') ? '运行' : '生成',
    action: files.value.includes('data/gen.py') ? runData : generateDataPlan,
    disabled: !workspaceId.value || !files.value.includes('solution/solution.md')
  }
]);

const pipelineDone = computed(() => pipeline.value.filter(step => step.state === 'done').length);
const qualityItems = computed(() => [
  { label: '题面已生成', pass: files.value.includes('problem/problem.md') },
  { label: '题解已生成', pass: files.value.includes('solution/solution.md') },
  { label: '标程已生成并通过编译流程', pass: files.value.includes('solution/std.cpp') && status.value.solution?.state === 'done' },
  { label: '数据方案已生成', pass: files.value.includes('data/hack_plan.md') },
  { label: '数据生成器已生成', pass: files.value.includes('data/gen.py') },
  { label: '数据包已生成并通过 zip 校验', pass: files.value.includes('data/datas.zip') && status.value.data?.state === 'done' }
]);
const qualityScore = computed(() => qualityItems.value.filter(item => item.pass).length);

function persistWorkspace(meta) {
  workspaceId.value = meta.workspaceId;
  workspaceToken.value = meta.accessToken || workspaceToken.value || '';
  localStorage.setItem('workspaceId', workspaceId.value);
  if (workspaceToken.value) localStorage.setItem('workspaceToken', workspaceToken.value);
}

async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (workspaceToken.value) headers['x-workspace-token'] = workspaceToken.value;
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) throw new Error(data.error || text || 'request failed');
  return data;
}

async function createWorkspace() {
  clearMessages();
  const meta = await api('/api/workspaces', { method: 'POST' });
  persistWorkspace(meta);
  connectLiveFeed();
  await loadWorkspace();
}

async function loadWorkspace() {
  if (!workspaceId.value || !workspaceToken.value) return;
  const meta = await api(`/api/workspaces/${workspaceId.value}`);
  status.value = meta.status || status.value;
  const fileResp = await api(`/api/workspaces/${workspaceId.value}/files`);
  files.value = fileResp.files || [];
  zipContents.value.clear();
  expandedZips.value.clear();
  await loadProblemRaw();
  await loadLogs();
}

async function refreshAll() {
  clearMessages();
  await loadWorkspace();
}

async function loadProblemRaw() {
  if (!files.value.includes('input/problem_raw.md')) return;
  const text = await readFile('input/problem_raw.md');
  problemRaw.value = text;
  if (!selectedFile.value) {
    selectedFile.value = 'input/problem_raw.md';
    selectedContent.value = text;
    editorContent.value = text;
  }
}

async function readFile(file) {
  const res = await fetch(`/api/workspaces/${workspaceId.value}/files/${file}`, {
    headers: { 'x-workspace-token': workspaceToken.value }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || 'open failed');
  return text;
}

async function loadZipContents(zipPath) {
  if (zipContents.value.has(zipPath)) return;
  try {
    const res = await fetch(`/api/workspaces/${workspaceId.value}/files/${zipPath}`, {
      headers: { 'x-workspace-token': workspaceToken.value }
    });
    if (!res.ok) throw new Error('failed to fetch zip');
    const arrayBuffer = await res.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const entries = Object.keys(zip.files)
      .filter(name => !zip.files[name].dir)
      .sort();
    zipContents.value.set(zipPath, entries);
  } catch (error) {
    console.error('Failed to load zip contents:', error);
    zipContents.value.set(zipPath, []);
  }
}

async function readZipFile(zipPath, innerPath) {
  try {
    const res = await fetch(`/api/workspaces/${workspaceId.value}/files/${zipPath}`, {
      headers: { 'x-workspace-token': workspaceToken.value }
    });
    if (!res.ok) throw new Error('failed to fetch zip');
    const arrayBuffer = await res.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const file = zip.files[innerPath];
    if (!file) throw new Error('file not found in zip');
    return await file.async('text');
  } catch (error) {
    throw new Error(`Failed to read zip file: ${error.message}`);
  }
}

async function openFile(file) {
  clearMessages();
  try {
    selectedFile.value = file;
    livePreview.value = false;

    if (file.includes('::')) {
      const [zipPath, innerPath] = file.split('::', 2);
      const text = await readZipFile(zipPath, innerPath);
      selectedContent.value = text;
      editorContent.value = text;
      return;
    }

    if (file.endsWith('.zip')) {
      if (expandedZips.value.has(file)) {
        expandedZips.value.delete(file);
      } else {
        expandedZips.value.add(file);
        await loadZipContents(file);
      }
      selectedContent.value = `ZIP 文件: ${file}\n点击展开查看内部文件 (${(zipContents.value.get(file) || []).length} 个文件)`;
      editorContent.value = selectedContent.value;
      return;
    }

    const text = await readFile(file);
    selectedContent.value = text;
    editorContent.value = text;
    if (file === 'input/problem_raw.md') problemRaw.value = text;
  } catch (error) {
    errorMessage.value = error.message;
  }
}

async function saveSelectedFile() {
  if (!canEditSelected.value) return;
  clearMessages();
  try {
    await writeFile(selectedFile.value, editorContent.value);
    selectedContent.value = editorContent.value;
    if (selectedFile.value === 'input/problem_raw.md') problemRaw.value = editorContent.value;
    successMessage.value = '已保存';
    await refreshAll();
  } catch (error) {
    errorMessage.value = error.message;
  }
}

async function writeFile(file, content) {
  await api(`/api/workspaces/${workspaceId.value}/files/${file}`, {
    method: 'PUT',
    body: JSON.stringify({ content })
  });
}

async function saveProblemRaw() {
  clearMessages();
  try {
    if (!workspaceId.value) await createWorkspace();
    if (problemRaw.value.length > 2 * 1024 * 1024) throw new Error('题面过大');
    await writeFile('input/problem_raw.md', problemRaw.value);
    selectedFile.value = 'input/problem_raw.md';
    selectedContent.value = problemRaw.value;
    editorContent.value = problemRaw.value;
    successMessage.value = '原题素材已保存';
    await refreshAll();
  } catch (error) {
    errorMessage.value = error.message;
  }
}

async function generateProblem() {
  clearMessages();
  try {
    selectedFile.value = 'problem/problem.md';
    livePreview.value = true;
    const result = await api(`/api/workspaces/${workspaceId.value}/problem`, {
      method: 'POST',
      body: JSON.stringify({
        difficultyMode: difficultyMode.value,
        difficultyText: difficultyText.value,
        sourceText: problemRaw.value
      })
    });
    setEditorResult(result.path || 'problem/problem.md', result.content);
    if (result.cached) successMessage.value = '题目已命中缓存';
    await refreshAll();
  } catch (error) {
    livePreview.value = false;
    errorMessage.value = error.message;
  }
}

async function generateSolution() {
  clearMessages();
  try {
    selectedFile.value = 'solution/solution.md';
    livePreview.value = true;
    const result = await api(`/api/workspaces/${workspaceId.value}/solution`, { method: 'POST' });
    setEditorResult('solution/solution.md', result.markdown);
    if (result.cached) successMessage.value = '题解已命中缓存';
    await refreshAll();
  } catch (error) {
    livePreview.value = false;
    errorMessage.value = error.message;
  }
}

async function generateDataPlan() {
  clearMessages();
  try {
    selectedFile.value = 'data/hack_plan.md';
    livePreview.value = true;
    const result = await api(`/api/workspaces/${workspaceId.value}/data/plan`, { method: 'POST' });
    setEditorResult('data/hack_plan.md', result.plan);
    if (result.cached) successMessage.value = '数据方案已命中缓存';
    await refreshAll();
  } catch (error) {
    livePreview.value = false;
    errorMessage.value = error.message;
  }
}

async function runData() {
  clearMessages();
  try {
    selectedFile.value = 'data/datas.zip';
    livePreview.value = true;
    const result = await api(`/api/workspaces/${workspaceId.value}/data/run`, { method: 'POST' });
    setEditorResult('data/datas.zip', JSON.stringify(result, null, 2));
    if (result.cached) successMessage.value = '数据包已命中缓存';
    await refreshAll();
  } catch (error) {
    livePreview.value = false;
    errorMessage.value = error.message;
  }
}

async function loadLogs() {
  if (!workspaceId.value || !workspaceToken.value) return;
  try {
    const result = await api(`/api/workspaces/${workspaceId.value}/logs`);
    logsText.value = Object.entries(result.logs || {})
      .map(([name, content]) => `== ${name} ==\n${content || ''}`)
      .join('\n\n');
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

function setEditorResult(file, content) {
  selectedFile.value = file;
  selectedContent.value = content || '';
  editorContent.value = content || '';
  livePreview.value = false;
}

function createMonacoEditor() {
  if (!editorHost.value || monacoEditor) return;
  monacoEditor = monaco.editor.create(editorHost.value, {
    value: editorContent.value,
    language: editorLanguage(selectedFile.value),
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontFamily: "Consolas, 'SFMono-Regular', Menlo, Monaco, monospace",
    fontSize: 13,
    lineHeight: 21,
    tabSize: 2,
    wordWrap: 'on',
    readOnly: editorReadOnly(),
    renderWhitespace: 'selection',
    fixedOverflowWidgets: true,
    padding: { top: 14, bottom: 14 }
  });
  monacoChangeSubscription = monacoEditor.onDidChangeModelContent(() => {
    if (settingEditorValue) return;
    editorContent.value = monacoEditor.getValue();
  });
}

function syncMonacoValue(value) {
  if (!monacoEditor || monacoEditor.getValue() === value) return;
  settingEditorValue = true;
  monacoEditor.setValue(value);
  settingEditorValue = false;
}

function syncMonacoOptions() {
  if (!monacoEditor) return;
  const model = monacoEditor.getModel();
  if (model) {
    monaco.editor.setModelLanguage(model, editorLanguage(selectedFile.value));
  }
  monacoEditor.updateOptions({ readOnly: editorReadOnly() });
  nextTick(() => monacoEditor?.layout());
}

function editorReadOnly() {
  return !canEditSelected.value || livePreview.value || !editorIsText.value;
}

function editorLanguage(file) {
  const cleanFile = file.includes('::') ? file.split('::')[1] : file;
  if (cleanFile.endsWith('.md')) return 'markdown';
  if (cleanFile.endsWith('.cpp') || cleanFile.endsWith('.cc') || cleanFile.endsWith('.h')) return 'cpp';
  if (cleanFile.endsWith('.py')) return 'python';
  if (cleanFile.endsWith('.json')) return 'json';
  if (cleanFile.endsWith('.log')) return 'plaintext';
  return 'plaintext';
}

function clearMessages() {
  errorMessage.value = '';
  successMessage.value = '';
}

function baseName(file) {
  const cleanFile = file.includes('::') ? file.split('::')[1] : file;
  return cleanFile.split('/').pop();
}

function fileIcon(file) {
  const cleanFile = file.includes('::') ? file.split('::')[1] : file;
  if (cleanFile.endsWith('.md')) return 'MD';
  if (cleanFile.endsWith('.cpp') || cleanFile.endsWith('.cc') || cleanFile.endsWith('.h')) return 'C++';
  if (cleanFile.endsWith('.py')) return 'PY';
  if (cleanFile.endsWith('.zip')) return 'ZIP';
  if (cleanFile.endsWith('.json')) return 'JSON';
  if (cleanFile.endsWith('.log')) return 'LOG';
  if (cleanFile.endsWith('.in')) return 'IN';
  if (cleanFile.endsWith('.out')) return 'OUT';
  return 'TXT';
}

function fileForEvent(data) {
  if (data.stage === 'solution') return 'solution/solution.md';
  if (data.stage === 'data') {
    if (data.phase === 'gen') return 'data/gen.py';
    if (data.phase === 'run') return 'data/datas.zip';
    return 'data/hack_plan.md';
  }
  return 'problem/problem.md';
}

function connectLiveFeed() {
  if (!workspaceId.value || !workspaceToken.value) return;
  if (eventSource) eventSource.close();
  const url = new URL(`/api/workspaces/${workspaceId.value}/events`, window.location.origin);
  url.searchParams.set('token', workspaceToken.value);
  eventSource = new EventSource(url.toString());
  eventSource.addEventListener('task:update', ev => {
    const data = JSON.parse(ev.data);
    liveEvent.value = data;
    activeJobMessage.value = data.message || '';
    if (data.stage && status.value[data.stage]) {
      status.value[data.stage] = {
        ...(status.value[data.stage] || {}),
        state: data.state || status.value[data.stage].state,
        message: data.message || status.value[data.stage].message || ''
      };
    }
  });
  eventSource.addEventListener('task:partial', ev => {
    const data = JSON.parse(ev.data);
    const text = data.text || '';
    liveEvent.value = data;
    selectedFile.value = fileForEvent(data);
    selectedContent.value = text ? `${text}\n\n[实时预览 ${text.length} 字，完整文件以最终生成结果为准]` : '';
    editorContent.value = selectedContent.value;
    livePreview.value = true;
  });
  eventSource.onerror = () => {
    activeJobMessage.value = '事件流重连中';
  };
}

onMounted(async () => {
  await nextTick();
  createMonacoEditor();
  if (!workspaceId.value || !workspaceToken.value) return;
  try {
    connectLiveFeed();
    await loadWorkspace();
  } catch (error) {
    errorMessage.value = error.message;
  }
});

watch(editorContent, value => {
  syncMonacoValue(value);
});

watch([selectedFile, canEditSelected, livePreview, editorIsText], () => {
  syncMonacoOptions();
});

onBeforeUnmount(() => {
  if (eventSource) eventSource.close();
  monacoChangeSubscription?.dispose();
  monacoEditor?.dispose();
});
</script>
