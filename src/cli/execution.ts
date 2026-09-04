import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export function createExecutionDirectory(outputRoot: string): { id: string; path: string; startedAt: string } {
  const startedAt = new Date().toISOString();
  const timestamp = startedAt.replace(/[.:]/g, '-');
  const id = `${timestamp}-${randomUUID().slice(0, 8)}`;
  const path = join(outputRoot, id);
  mkdirSync(path, { recursive: true });
  return { id, path, startedAt };
}
