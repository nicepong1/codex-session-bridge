import {UUID} from './guard-policy.mjs';

// Only fields needed to display existing GPU projects in a fresh desktop profile.
// Never copy the GPU's global state, authentication, plugins or local preferences.
export async function readProjectCatalog(read) {
  const projects = [], ids = new Set(), cursors = new Set(); let cursor = null;
  do {
    const page = await read('project/list', {limit: 100, cursor});
    if (!Array.isArray(page?.data) || page.data.length > 100 || !(page.nextCursor == null || typeof page.nextCursor === 'string'))
      throw new Error('Invalid GPU project page');
    for (const p of page.data) {
      if (!UUID.test(p?.id ?? '') || ids.has(p.id) || typeof p.name !== 'string' || p.name.length > 1024 ||
          !Array.isArray(p.roots) || p.roots.length < 1 || p.roots.length > 100 ||
          p.roots.some(r => typeof r?.path !== 'string' || r.path.length > 4096 || !/^[a-z]:[\\/]/i.test(r.path)) ||
          !Number.isFinite(p.createdAt) || !Number.isFinite(p.updatedAt)) throw new Error('Invalid GPU project metadata');
      ids.add(p.id);
      projects.push({id: p.id, name: p.name, rootPaths: p.roots.map(r => r.path),
        createdAt: p.createdAt * 1000, updatedAt: p.updatedAt * 1000,
        position: Number.isFinite(p.position) ? p.position : projects.length});
    }
    cursor = page.nextCursor ?? null;
    if (cursor && (cursor.length > 4096 || cursors.has(cursor))) throw new Error('Invalid GPU project cursor');
    if (cursor) cursors.add(cursor);
    if (cursor && projects.length >= 1000) throw new Error('GPU project limit exceeded');
  } while (cursor);
  projects.sort((a,b) => a.position - b.position);
  return projects;
}

export function projectDisplayState(projects) {
  return {'local-projects': Object.fromEntries(projects.map(({position, ...project}) => [project.id, project])),
    'project-order': projects.map(p => p.id),
    // A fresh isolated profile has no per-project preference; the native app
    // expands it by default. Seed only these display preferences, not GPU state.
    'electron-persisted-atom-state': Object.fromEntries(projects.map(p => [
      'sidebar-project-expanded-v1-codex:' + p.id, false]))};
}

export function orderProjectsByActivity(projects, threads) {
  const normalize = value => String(value ?? '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const byId = new Map(projects.map(p => [p.id,p]));
  const ranked = new Map();
  const recent = [...threads].sort((a,b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  for (const thread of recent) {
    const project = byId.get(thread.projectId) ?? projects.find(p => p.rootPaths.some(root => normalize(root) === normalize(thread.cwd)));
    if (project && !ranked.has(project.id)) ranked.set(project.id,ranked.size);
  }
  return [...projects].sort((a,b) => (ranked.get(a.id) ?? Infinity) - (ranked.get(b.id) ?? Infinity) || a.position - b.position);
}
