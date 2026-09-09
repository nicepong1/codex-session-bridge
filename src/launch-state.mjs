import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {UUID} from './guard-policy.mjs';

export function readLastTask(file) {
  try {
    if (fs.statSync(file).size > 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.version === 1 && UUID.test(value.threadId ?? '') ? value.threadId : null;
  } catch { return null; }
}
export function saveLastTask(file, threadId) {
  if (!UUID.test(threadId ?? '')) throw new Error('Invalid last task ID');
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.mkdirSync(path.dirname(file), {recursive: true});
  try {
    fs.writeFileSync(temp, JSON.stringify({version: 1, threadId, updatedAt: new Date().toISOString()}), {flag: 'wx'});
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
