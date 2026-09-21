import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {UUID} from './guard-policy.mjs';

const ROLLOUT = /^rollout-.+-([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\.jsonl$/i;
const INTERACTIVE_SOURCES = new Set(['cli', 'vscode', 'appServer', 'unknown']);
const NON_ROOT_THREAD_SOURCES = new Set(['subagent', 'guardian_review']);

function entries(directory) {
  try { return fs.readdirSync(directory, {withFileTypes: true}); }
  catch { return []; }
}

function activePath(root, file) {
  if (typeof file !== 'string' || !file) return false;
  const strip = value => value.startsWith('\\\\?\\') ? value.slice(4) : value;
  const base = path.win32.resolve(strip(root));
  const candidate = path.win32.resolve(strip(file));
  const relative = path.win32.relative(base, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.win32.isAbsolute(relative);
}

// Inspect names and timestamps only. Conversation JSONL contents are never read.
export function recentRollouts(root = path.join(os.homedir(), '.codex', 'sessions'), {maxDays = 45, maxFiles = 128} = {}) {
  const days = [];
  for (const year of entries(root).filter(item => item.isDirectory() && /^\d{4}$/.test(item.name))) {
    const yearPath = path.join(root, year.name);
    for (const month of entries(yearPath).filter(item => item.isDirectory() && /^\d{2}$/.test(item.name))) {
      const monthPath = path.join(yearPath, month.name);
      for (const day of entries(monthPath).filter(item => item.isDirectory() && /^\d{2}$/.test(item.name)))
        days.push({key: `${year.name}-${month.name}-${day.name}`, directory: path.join(monthPath, day.name)});
    }
  }
  const files = [];
  for (const {directory} of days.sort((a, b) => b.key.localeCompare(a.key)).slice(0, maxDays)) {
    for (const item of entries(directory)) {
      if (!item.isFile() || item.isSymbolicLink()) continue;
      const match = ROLLOUT.exec(item.name); if (!match || !UUID.test(match[1])) continue;
      const file = path.join(directory, item.name);
      try { files.push({id: match[1].toLowerCase(), mtimeMs: fs.statSync(file).mtimeMs}); } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id));
  const seen = new Set();
  return files.filter(item => !seen.has(item.id) && seen.add(item.id)).slice(0, maxFiles);
}

export function recentRolloutIds(root = path.join(os.homedir(), '.codex', 'sessions'), options = {}) {
  return recentRollouts(root, options).map(item => item.id);
}

function eligibleQuery(params = {}) {
  return params.cursor == null && params.archived !== true && params.sectionId == null && params.cwd == null &&
    params.projectId == null && params.searchTerm == null;
}

export async function recoverMissingAgentThreads({page, params, readThread,
  sessionsRoot = path.join(os.homedir(), '.codex', 'sessions'), maxCandidates = 64, maxRecovered = 24} = {}) {
  if (!eligibleQuery(params) || !Array.isArray(page?.data) || typeof readThread !== 'function') return page;
  const rollouts = recentRollouts(sessionsRoot);
  const activity = new Map(rollouts.map(item => [item.id, Math.floor(item.mtimeMs / 1000)]));
  const visible = new Set(page.data.map(thread => thread?.id).filter(UUID.test.bind(UUID)));
  const candidates = rollouts.filter(item => !visible.has(item.id)).slice(0, maxCandidates);
  const results = await Promise.allSettled(candidates.map(item => readThread(item.id)));
  const recovered = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const thread = result.status === 'fulfilled' ? result.value?.thread : null;
    if (!thread || !UUID.test(thread.id ?? '') || visible.has(thread.id) || thread.ephemeral ||
        NON_ROOT_THREAD_SOURCES.has(thread.threadSource ?? '') || !INTERACTIVE_SOURCES.has(thread.source ?? 'unknown') ||
        !activePath(sessionsRoot, thread.path) || !Number.isFinite(thread.updatedAt)) continue;
    visible.add(thread.id);
    recovered.push({...thread, updatedAt: Math.max(thread.updatedAt, Math.floor(candidates[index].mtimeMs / 1000))});
  }
  const current = page.data.map(thread => {
    const observed = activity.get(thread?.id);
    return Number.isFinite(observed) && observed > (thread.updatedAt ?? 0) ? {...thread, updatedAt: observed} : thread;
  });
  if (!recovered.length && current.every((thread, index) => thread === page.data[index])) return page;
  recovered.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
  const data = [...current, ...recovered.slice(0, maxRecovered)]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || String(b.id).localeCompare(String(a.id)));
  return {...page, data};
}
