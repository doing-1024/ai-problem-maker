const streams = new Map();
const HEARTBEAT_INTERVAL = 15000;
const MAX_MISSED_HEARTBEATS = 3;

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

  let missedHeartbeats = 0;
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed || !res.writable) {
      missedHeartbeats = MAX_MISSED_HEARTBEATS;
    }
    if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
      clearInterval(heartbeat);
      cleanup(workspaceId, res, set);
      return;
    }
    try {
      res.write(': ping\n\n');
      missedHeartbeats = 0;
    } catch {
      missedHeartbeats += 1;
    }
  }, HEARTBEAT_INTERVAL);

  res.on('close', () => {
    clearInterval(heartbeat);
    cleanup(workspaceId, res, set);
  });

  function cleanup(wsId, response, connectionSet) {
    clearInterval(heartbeat);
    connectionSet.delete(response);
    if (!connectionSet.size) {
      streams.delete(wsId);
    }
  }
}

export function emitWorkspaceEvent(workspaceId, event, data = {}) {
  const set = streams.get(workspaceId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    if (!res.writableEnded && !res.destroyed && res.writable) {
      try {
        res.write(payload);
      } catch {
        res.destroy();
      }
    }
  }
}