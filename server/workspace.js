import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import archiver from 'archiver';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import { spawn } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.WORKSPACE_STORAGE || path.join(ROOT, 'workspaces');

export async function ensureAppDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function workspaceDir(id) {
  return path.join(DATA_DIR, id);
}

function metaPath(id) {
  return path.join(workspaceDir(id), 'meta.json');
}

function now() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID().replace(/-/g, '');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function baseMeta(id) {
  const token = crypto.randomBytes(24).toString('hex');
  return {
    workspaceId: id,
    accessToken: token,
    createdAt: now(),
    updatedAt: now(),
    currentStep: 'problem',
    status: {
      problem: { state: 'idle', message: '', updatedAt: now() },
      solution: { state: 'idle', message: '', updatedAt: now() },
      data: { state: 'idle', message: '', updatedAt: now() }
    },
    jobs: {
      problem: { fingerprint: '', updatedAt: '', resultPath: 'problem/problem.md' },
      solution: {
        fingerprint: '',
        updatedAt: '',
        resultPaths: ['solution/algorithm.md', 'solution/std.cpp', 'solution/solution.md', 'solution/verification.md']
      },
      data: {
        fingerprint: '',
        updatedAt: '',
        resultPaths: ['data/hack_plan.md', 'data/gen.py', 'data/validator.py', 'data/problem_type.json', 'data/checker.cpp', 'data/coverage.json', 'data/stress_report.md']
      },
      run: { fingerprint: '', updatedAt: '', resultPath: 'data/datas.zip' }
    },
    files: []
  };
}

export function publicWorkspaceMeta(meta) {
  if (!meta) return null;
  const { accessToken, ...safe } = meta;
  return safe;
}

export async function createWorkspace() {
  const id = newId();
  const dir = workspaceDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, 'input'), { recursive: true });
  await fs.mkdir(path.join(dir, 'problem'), { recursive: true });
  await fs.mkdir(path.join(dir, 'solution'), { recursive: true });
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  await fs.mkdir(path.join(dir, 'logs'), { recursive: true });
  const meta = baseMeta(id);
  await writeJson(metaPath(id), meta);
  return meta;
}

export async function listWorkspaces() {
  const dirs = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const metas = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const metaFile = metaPath(dir.name);
    if (await exists(metaFile)) {
      metas.push(publicWorkspaceMeta(await readJson(metaFile)));
    }
  }
  return metas.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getWorkspaceMeta(id) {
  const file = metaPath(id);
  if (!(await exists(file))) return null;
  return publicWorkspaceMeta(await readJson(file));
}

export async function getWorkspaceSecret(id) {
  const file = metaPath(id);
  if (!(await exists(file))) return null;
  const meta = await readJson(file);
  return meta.accessToken || null;
}

export async function getWorkspaceMetaInternal(id) {
  const file = metaPath(id);
  if (!(await exists(file))) return null;
  return readJson(file);
}

export async function updateWorkspaceMeta(id, patch) {
  const current = await getWorkspaceMetaInternal(id);
  if (!current) throw new Error('workspace not found');
  const next = {
    ...current,
    ...patch,
    status: patch.status
      ? {
          ...current.status,
          ...Object.fromEntries(
            Object.entries(patch.status).map(([key, value]) => [
              key,
              typeof value === 'object' && value !== null
                ? { ...current.status[key], ...value }
                : { ...(current.status[key] || {}), state: value }
            ])
          )
        }
      : current.status,
    jobs: patch.jobs ? { ...current.jobs, ...patch.jobs } : current.jobs,
    updatedAt: now()
  };
  await writeJson(metaPath(id), next);
  return publicWorkspaceMeta(next);
}

function safeRelativePath(rel) {
  const normalized = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error('invalid path');
  }
  return normalized;
}

export async function writeWorkspaceFile(id, rel, content) {
  const dir = workspaceDir(id);
  if (!(await exists(dir))) throw new Error('workspace not found');
  const safeRel = safeRelativePath(rel);
  if (!allowedUserWritePath(safeRel)) {
    throw new Error('path not allowed');
  }
  const isZip = safeRel.endsWith('.zip');
  const maxBytes = isZip ? 200 * 1024 * 1024 : 2 * 1024 * 1024;
  const size = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content), 'utf8');
  if (size > maxBytes) {
    throw new Error('content too large');
  }
  const abs = path.join(dir, safeRel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, isZip ? null : 'utf8');
  await refreshWorkspaceMeta(id);
}

export async function readWorkspaceFile(id, rel) {
  const safeRel = safeRelativePath(rel);
  const abs = path.join(workspaceDir(id), safeRel);
  const isZip = safeRel.endsWith('.zip');
  const data = await fs.readFile(abs, isZip ? null : 'utf8');
  return data;
}

export async function readDatasPreview(id) {
  const zipPath = path.join(workspaceDir(id), 'data', 'datas.zip');
  if (!(await exists(zipPath))) return null;
  const script = [
    'import json, sys, zipfile',
    'zp = sys.argv[1]',
    'with zipfile.ZipFile(zp, "r") as zf:',
    '    names = sorted(zf.namelist())',
    '    files = [{"name": n, "size": zf.getinfo(n).file_size} for n in names]',
    '    contents = {}',
    '    for n in names:',
    '        try:',
    '            contents[n] = zf.read(n).decode("utf-8")',
    '        except:',
    '            contents[n] = None',
    '    print(json.dumps({"files": files, "contents": contents}))'
  ].join('\n');
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script, zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(err || `python exited ${code}`));
      else resolve(out);
    });
  });
  return JSON.parse(stdout);
}

export async function listWorkspaceFiles(id) {
  const root = workspaceDir(id);
  if (!(await exists(root))) throw new Error('workspace not found');
  const files = [];
  async function walk(current, prefix = '') {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else {
        files.push(rel);
      }
    }
  }
  await walk(root);
  return files.sort();
}

export async function downloadWorkspaceZip(id) {
  const root = workspaceDir(id);
  if (!(await exists(root))) throw new Error('workspace not found');

  const readme = [
    '# ASOI 竞赛题数据包',
    '',
    '## 文件说明',
    '',
    '### 题目相关',
    '',
    '- `input/problem_raw.md` — **原题素材**，你提交给 AI 的原始题目，供参考对比。',
    '- `problem/problem.md` — **最终题面**，AI 改编后生成的新竞赛题 Markdown，可直接用于比赛或练习。',
    '',
    '### 题解与标程',
    '',
    '- `solution/solution.md` — **题解**，包含解题思路、正确性证明和复杂度分析。',
    '- `solution/algorithm.md` — **算法草案**，记录进入标程生成前的约束分析和算法设计。',
    '- `solution/std.cpp` — **C++ 标准程序**（标程），用于对拍或评测。',
    '- `solution/verification.md` — **标程验证报告**，记录候选程序、对拍和反例搜索等校验结果。',
    '',
    '### 数据相关',
    '',
    '- `data/hack_plan.md` — **数据构造方案**，说明各测试点的规模、边界条件和构造目的。',
    '- `data/gen.py` — **数据生成器**，Python 脚本，可根据题面随机生成测试数据。',
    '- `data/validator.py` — **输入校验器**，用于验证每个 `.in` 文件是否符合题面格式与约束。',
    '- `data/problem_type.json` — **题型判定**，标记是否为多解/构造/浮点等需要 checker 的题型。',
    '- `data/checker.cpp` — **Special Judge**，仅在多解/构造等题型需要时生成。',
    '- `data/coverage.json` — **数据覆盖率报告**，记录数据文件数量、规模摘要和校验结果。',
    '- `data/stress_report.md` — **压力测试报告**，记录最大数据运行耗时等信息。',
    '- `data/datas.zip` — **测试数据压缩包**，包含所有测试点的输入（`.in`）和输出（`.out`）文件，可直接用于评测。',
    '',
    '### 其他',
    '',
    '- `logs/` — AI 生成过程日志，便于排查问题。',
    '- `meta.json` — 工作区元数据，包含状态和生成时间等。',
    '',
    '## 使用建议',
    '',
    '1. 比赛发布：使用 `problem/problem.md` 作为题面，`data/datas.zip` 中的数据进行评测。',
    '2. 练习自测：用 `data/gen.py` 生成随机数据，配合 `solution/std.cpp` 对拍。',
    '3. 学习参考：阅读 `solution/solution.md` 了解解题思路。',
    '',
  ].join('\n');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `apm-readme-`));
  const readmePath = path.join(tmpDir, 'README.md');
  await fs.writeFile(readmePath, readme, 'utf8');

  const zipPath = path.join(os.tmpdir(), `${id}.zip`);
  try {
    await fs.unlink(zipPath);
  } catch {}

  await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(root, false);
    archive.file(readmePath, { name: 'README.md' });
    archive.finalize();
  });

  await fs.rm(tmpDir, { recursive: true, force: true });
  return zipPath;
}

export async function appendWorkspaceLog(id, name, content) {
  const dir = workspaceDir(id);
  if (!(await exists(dir))) throw new Error('workspace not found');
  const safeName = safeRelativePath(path.join('logs', name));
  if (!safeName.startsWith('logs/')) throw new Error('invalid log path');
  const abs = path.join(dir, safeName);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, content, 'utf8');
  await refreshWorkspaceMeta(id);
}

async function refreshWorkspaceMeta(id) {
  const meta = await getWorkspaceMetaInternal(id);
  if (!meta) return;
  const files = await listWorkspaceFiles(id);
  await writeJson(metaPath(id), {
    ...meta,
    files,
    updatedAt: now()
  });
}

function allowedUserWritePath(rel) {
  return new Set([
    'input/problem_raw.md',
    'problem/problem.md',
    'solution/solution.md',
    'solution/algorithm.md',
    'solution/std.cpp',
    'solution/verification.md',
    'data/hack_plan.md',
    'data/gen.py',
    'data/validator.py',
    'data/problem_type.json',
    'data/checker.cpp',
    'data/coverage.json',
    'data/stress_report.md',
    'data/datas.zip'
  ]).has(rel);
}

export function isAllowedReadablePath(rel) {
  return new Set([
    'input/problem_raw.md',
    'problem/problem.md',
    'solution/solution.md',
    'solution/algorithm.md',
    'solution/std.cpp',
    'solution/verification.md',
    'data/hack_plan.md',
    'data/gen.py',
    'data/validator.py',
    'data/problem_type.json',
    'data/checker.cpp',
    'data/coverage.json',
    'data/stress_report.md',
    'data/datas.zip',
    'logs/problem.log',
    'logs/solution.log',
    'logs/data.log',
    'meta.json'
  ]).has(rel);
}
