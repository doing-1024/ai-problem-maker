const streams = new Map();

export function subscribeWorkspace(workspaceId, res) {
  const set = streams.get(workspaceId) || new Set();
  streams.set(workspaceId, set);
  set.add(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  res.write('retry: 2000\n\n');
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (!set.size) streams.delete(workspaceId);
  });
}

export function emitWorkspaceEvent(workspaceId, event, data = {}) {
  const set = streams.get(workspaceId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    if (!res.writableEnded) {
      res.write(payload);
    }
  }
}
