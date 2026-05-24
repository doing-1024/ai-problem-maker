const locks = new Map();

export async function withWorkspaceLock(workspaceId, taskKey, fn) {
  const key = `${workspaceId}:${taskKey}`;
  if (locks.has(key)) {
    const error = new Error('task already running');
    error.statusCode = 409;
    throw error;
  }
  locks.set(key, true);
  try {
    return await fn();
  } finally {
    locks.delete(key);
  }
}

export function isTaskLocked(workspaceId, taskKey) {
  return locks.has(`${workspaceId}:${taskKey}`);
}
