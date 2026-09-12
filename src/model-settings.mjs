// Only model/reasoning choices cross this boundary. Workspace, permissions,
// system instructions and provider configuration always stay with the GPU owner.
const plain = value => value != null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('gpu-guard-denied: invalid model settings'); };
const modelName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value);
const effortName = value => value === null || (typeof value === 'string' && /^[a-z][a-zA-Z0-9_-]{0,31}$/.test(value));

export function modelSettings(value, {empty = false, desktop = false} = {}) {
  if (!plain(value)) fail();
  for (const key of Object.keys(value)) {
    if (['model', 'effort'].includes(key)) continue;
    // The installed selector includes its app-wide mode; this is not a user
    // request to change that setting and must not overwrite the GPU setting.
    if (desktop && key === 'multiAgentMode' && value[key] === 'explicitRequestOnly') continue;
    fail();
  }
  const result = {};
  if (Object.hasOwn(value, 'model')) { if (!modelName(value.model)) fail(); result.model = value.model; }
  if (Object.hasOwn(value, 'effort')) { if (!effortName(value.effort)) fail(); result.effort = value.effort; }
  if (!empty && !Object.keys(result).length) fail();
  return result;
}

export function defaultModelWrite(params) {
  if (!plain(params) || Object.keys(params).some(k => !['edits', 'filePath', 'expectedVersion', 'reloadUserConfig'].includes(k)) ||
      params.filePath != null || params.expectedVersion != null || params.reloadUserConfig !== true ||
      !Array.isArray(params.edits) || params.edits.length !== 2) fail();
  let prefix, model, effort;
  for (const edit of params.edits) {
    if (!plain(edit) || Object.keys(edit).some(k => !['keyPath', 'value', 'mergeStrategy'].includes(k)) || edit.mergeStrategy !== 'upsert') fail();
    const match = /^(profiles\.[a-zA-Z0-9_-]{1,128}\.)?(model|model_reasoning_effort)$/.exec(edit.keyPath);
    if (!match || (prefix !== undefined && prefix !== (match[1] ?? ''))) fail();
    prefix = match[1] ?? '';
    if (match[2] === 'model') { if (model !== undefined) fail(); model = edit.value; }
    else { if (effort !== undefined) fail(); effort = edit.value; }
  }
  const settings = modelSettings({model, effort});
  return {settings, profile: prefix ? prefix.slice(9, -1) : null, params: {
    edits: [{keyPath: prefix + 'model', value: model, mergeStrategy: 'upsert'},
      {keyPath: prefix + 'model_reasoning_effort', value: effort, mergeStrategy: 'upsert'}],
    filePath: null, expectedVersion: null, reloadUserConfig: true}};
}

export function settingsFromFollower(message, id) {
  if (message?.method !== 'thread-follower-update-thread-settings' || ![1, 2].includes(message.version) || message.params?.conversationId !== id) fail();
  const p = message.params;
  if (Object.keys(p).some(k => !['conversationId', 'hostId', 'threadSettings', 'activeTurnId', 'condition'].includes(k)) ||
      (p.hostId != null && p.hostId !== 'local') || p.activeTurnId != null || (message.version === 1 && p.condition != null)) fail();
  return {settings: modelSettings(p.threadSettings, {desktop: true}), condition: modelCondition(p.condition)};
}

export function modelCondition(value) {
  if (value == null) return null;
  if (!plain(value) || Object.keys(value).some(k => !['ifEffortEquals', 'ifModelEquals'].includes(k)) ||
      !Object.hasOwn(value, 'ifEffortEquals') || !effortName(value.ifEffortEquals) ||
      (value.ifModelEquals != null && !modelName(value.ifModelEquals))) fail();
  return {ifEffortEquals: value.ifEffortEquals, ...(value.ifModelEquals != null ? {ifModelEquals: value.ifModelEquals} : {})};
}

export function modelFollowerResult(version, result) {
  if (![1, 2].includes(version) || typeof result?.applied !== 'boolean') fail();
  if (version === 2) return {applied: result.applied};
  if (!result.applied) throw Error('GPU model settings were not applied');
  return {ok: true};
}

export function settingsFromTurn(request) {
  const result = {};
  if (request?.model != null) result.model = request.model;
  if (request?.effort !== undefined) result.effort = request.effort;
  const mode = request?.collaborationMode;
  if (mode != null) {
    const selection = modelSettings({model: mode.settings?.model, effort: mode.settings?.reasoning_effort});
    if ((result.model != null && result.model !== selection.model) ||
        (result.effort != null && result.effort !== selection.effort)) fail();
    Object.assign(result, selection);
  }
  return modelSettings(result, {empty: true});
}

export function modelTurnOverrides(state, selection) {
  const settings = modelSettings(selection, {empty: true});
  if (!Object.keys(settings).length) return {};
  const mode = state.latestThreadSettings?.collaborationMode ?? state.latestCollaborationMode;
  return {...settings, ...(mode?.settings ? {collaborationMode: {...structuredClone(mode), settings: {
    ...structuredClone(mode.settings), ...(settings.model ? {model: settings.model} : {}),
    ...(Object.hasOwn(settings, 'effort') ? {reasoning_effort: settings.effort} : {})}}} : {})};
}

export class GpuModelSettings {
  constructor(request) { this.request = request; this.pending = Promise.resolve(); }
  async validate(selection, currentModel) {
    const settings = modelSettings(selection, {empty: true});
    if (!Object.keys(settings).length) return settings;
    let cursor = null, chosen;
    for (let page = 0; page < 10; page++) {
      const result = await this.request('model/list', {limit: 100, cursor, includeHidden: true});
      chosen = result.data?.find(m => m.model === (settings.model ?? currentModel));
      if (chosen || !result.nextCursor) break;
      if (result.nextCursor === cursor) throw new Error('Invalid GPU model catalog cursor');
      cursor = result.nextCursor;
    }
    if (!chosen) throw new Error('GPU에서 사용할 수 없는 모델입니다');
    if (settings.effort != null && !chosen.supportedReasoningEfforts?.some(e => e.reasoningEffort === settings.effort))
      throw new Error('이 GPU 모델에서 지원하지 않는 추론 수준입니다');
    return settings;
  }
  write(params) {
    const write = defaultModelWrite(params);
    const pending = this.pending.catch(() => {}).then(async () => {
      await this.validate(write.settings);
      if (write.profile) {
        const result = await this.request('config/read', {includeLayers: false});
        if (!Object.hasOwn(result.config?.profiles ?? {}, write.profile)) throw new Error('Unknown GPU configuration profile');
      }
      // Official config service preserves unrelated settings and reports errors.
      return this.request('config/batchWrite', write.params);
    });
    this.pending = pending;
    return pending;
  }
}
