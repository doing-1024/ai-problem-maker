import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { stat } from 'fs/promises';
import { ensureAppDirs, listWorkspaces, createWorkspace, getWorkspaceMeta, getWorkspaceMetaInternal, readWorkspaceFile, writeWorkspaceFile, listWorkspaceFiles, downloadWorkspaceZip, isAllowedReadablePath } from './workspace.js';
import { generateProblem, generateSolution, generateDataPlan, runDataGenerator } from './tasks.js';
import { subscribeWorkspace } from './events.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 7860);
const CLIENT_DIST = path.join(ROOT, 'dist');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/workspaces', async (_req, res) => {
  res.json({ workspaces: await listWorkspaces() });
});

app.post('/api/workspaces', async (_req, res) => {
  const workspace = await createWorkspace();
  res.status(201).json(workspace);
});

app.get('/api/workspaces/:id', async (req, res) => {
  const meta = await getWorkspaceMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'workspace not found' });
  res.json(meta);
});

app.get('/api/workspaces/:id/files', async (req, res) => {
  try {
    await requireWorkspaceAccess(req, req.params.id);
    res.json({ files: await listWorkspaceFiles(req.params.id) });
  } catch (error) {
    res.status(error.statusCode || 404).json({ error: error.message });
  }
});

app.get(/^\/api\/workspaces\/([^/]+)\/files\/(.+)$/, async (req, res) => {
  try {
    const id = req.params[0];
    const rel = req.params[1];
    await requireWorkspaceAccess(req, id);
    if (!isAllowedReadablePath(rel)) {
      const error = new Error('path not allowed');
      error.statusCode = 403;
      throw error;
    }
    const content = await readWorkspaceFile(id, rel);
    const isBinary = /\.zip$|\.gz$|\.tar$|\.bz2$|\.xz$|\.7z$/.test(rel);
    if (isBinary && typeof content === 'string') {
      const buf = Buffer.from(content, 'latin1');
      res.type('application/octet-stream').send(buf);
    } else {
      res.type('text/plain').send(content);
    }
  } catch (error) {
    res.status(error.statusCode || 404).json({ error: error.message });
  }
});

app.put(/^\/api\/workspaces\/([^/]+)\/files\/(.+)$/, async (req, res) => {
  try {
    const id = req.params[0];
    const rel = req.params[1];
    await requireWorkspaceAccess(req, id);
    const { content = '' } = req.body || {};
    await writeWorkspaceFile(id, rel, String(content));
    res.json({ ok: true });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get('/api/workspaces/:id/download', async (req, res) => {
  try {
    await requireWorkspaceAccess(req, req.params.id);
    const zipPath = await downloadWorkspaceZip(req.params.id);
    res.download(zipPath, `${req.params.id}.zip`);
  } catch (error) {
    res.status(error.statusCode || 404).json({ error: error.message });
  }
});

app.get('/api/workspaces/:id/logs', async (req, res) => {
  try {
    await requireWorkspaceAccess(req, req.params.id);
    const files = ['logs/problem.log', 'logs/solution.log', 'logs/data.log'];
    const logs = {};
    for (const file of files) {
      try {
        logs[file] = await readWorkspaceFile(req.params.id, file);
      } catch {
        logs[file] = '';
      }
    }
    res.json({ logs });
  } catch (error) {
    res.status(error.statusCode || 404).json({ error: error.message });
  }
});

app.get('/api/workspaces/:id/events', async (req, res) => {
  try {
    await requireWorkspaceAccess(req, req.params.id);
    subscribeWorkspace(req.params.id, res);
  } catch (error) {
    res.status(error.statusCode || 404).json({ error: error.message });
  }
});

app.post('/api/workspaces/:id/problem', async (req, res) => {
  try {
    await requireWorkspaceAccess(req, req.params.id);
    const result = await generateProblem(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.post('/api/workspaces/:id/solution', async (req, res) => {
  try {
    await requireWorkspaceAccess(req, req.params.id);
    const result = await generateSolution(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.post('/api/workspaces/:id/data/plan', async (req, res) => {
  try {
    await requireWorkspaceAccess(req, req.params.id);
    const result = await generateDataPlan(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.post('/api/workspaces/:id/data/run', async (req, res) => {
  try {
    await requireWorkspaceAccess(req, req.params.id);
    const result = await runDataGenerator(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

const clientExists = await stat(CLIENT_DIST).then(() => true).catch(() => false);
if (process.env.NODE_ENV === 'production' && clientExists) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ensureAppDirs();
  app.listen(PORT, () => {
    console.log(`server listening on http://localhost:${PORT}`);
  });
}

export { app };

function getRequestToken(req) {
  const header = req.header('x-workspace-token');
  if (header) return header;
  if (req.method === 'GET') {
    const queryToken = req.query.token;
    if (typeof queryToken === 'string') return queryToken;
  }
  return '';
}

async function requireWorkspaceAccess(req, id) {
  const meta = await getWorkspaceMetaInternal(id);
  if (!meta) {
    const error = new Error('workspace not found');
    error.statusCode = 404;
    throw error;
  }
  const token = getRequestToken(req);
  if (!token || token !== meta.accessToken) {
    const error = new Error('unauthorized workspace access');
    error.statusCode = 403;
    throw error;
  }
}
