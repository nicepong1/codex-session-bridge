import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {projectWriteRoute, projectRoot} from './project-write-policy.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

// GPU only. Use official app-server registration, never edit its database or
// global preferences. A durable server key survives SSH/client loss.
export class GpuProjectWriter {
  constructor({request, journalDirectory, stat = fs.promises.stat, userHome}) {
    Object.assign(this, {request, journalDirectory, stat, userHome});
    this.pending = new Map();
  }
  async handle(method, raw) {
    const {params} = projectWriteRoute(method, raw);
    if (method === 'project/move') {
      const marker = path.join(this.journalDirectory, 'created-' + params.projectId + '.json');
      if (!fs.existsSync(marker)) throw new Error('gpu-guard-denied: 이 연결에서 생성한 프로젝트만 순서를 변경할 수 있습니다');
      return this.request(method, params);
    }
    const content = JSON.stringify({name: params.name, roots: params.roots.map(r => r.path.toLowerCase()),
      metadata: Object.fromEntries(Object.entries(params.metadata).sort(([a],[b]) => a.localeCompare(b)))});
    const fingerprint = hash(content);
    fs.mkdirSync(this.journalDirectory, {recursive: true});
    // Immutable records reject reuse of a UI operation key with changed data.
    this.record('request-' + hash(params.idempotencyKey), {fingerprint});
    if (!this.pending.has(fingerprint)) {
      const pending = this.create(params, fingerprint).finally(() => this.pending.delete(fingerprint));
      this.pending.set(fingerprint, pending);
    }
    return structuredClone(await this.pending.get(fingerprint));
  }
  record(key, value) {
    const file = path.join(this.journalDirectory, key + '.json'), text = JSON.stringify(value);
    let fd;
    try { fd = fs.openSync(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (fs.statSync(file).size > 4096 || fs.readFileSync(file, 'utf8') !== text)
        throw new Error('프로젝트 요청 기록이 일치하지 않습니다. 새 요청으로 다시 시도해 주세요');
      return;
    }
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  async create(params, fingerprint) {
    for (const root of params.roots) {
      // The native picker can select a notebook-only folder. Never guess which
      // GPU user's folder it should refer to or create a replacement directory.
      const profile = /^([a-z]:\\Users\\[^\\]+)(?:\\|$)/i.exec(root.path)?.[1];
      if (profile && this.userHome && profile.toLowerCase() !== projectRoot(this.userHome).toLowerCase())
        throw new Error('노트북 사용자 폴더는 GPU 폴더로 자동 변환하지 않습니다. GPU PC의 실제 폴더를 선택해 주세요: ' + root.path);
      let folder;
      try { folder = await this.stat(root.path); }
      catch { throw new Error('GPU PC에서 소스 폴더를 찾을 수 없습니다: ' + root.path); }
      if (!folder.isDirectory()) throw new Error('GPU PC의 소스 경로가 폴더가 아닙니다: ' + root.path);
    }
    // Same content with different UI UUIDs still has one server operation key.
    const result = await this.request('project/create', {...params,
      idempotencyKey: 'codex-session-bridge:project:' + fingerprint});
    const project = result?.project;
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(project?.id ?? '') ||
        project.name !== params.name || !Array.isArray(project.roots) || project.roots.length !== params.roots.length ||
        project.roots.some((r,i) => projectRoot(r.path).toLowerCase() !== params.roots[i].path.toLowerCase()))
      throw new Error('GPU 프로젝트 생성 응답을 확인하지 못했습니다. 같은 내용으로 다시 시도해 주세요');
    this.record('created-' + project.id, {fingerprint});
    return result;
  }
}
