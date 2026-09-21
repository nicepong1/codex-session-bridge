import {projectRoot} from './project-write-policy.mjs';
import {modelSettings, settingsFromTurn} from './model-settings.mjs';
import {turnImageInput} from './image-input.mjs';
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fail = text => {throw new Error('gpu-guard-denied: '+text);};

// New tasks start in an existing registered GPU project. The original GPU app
// supplies tools/instructions when adopting the empty task; laptop setup does
// not carry local MCP servers, environment variables, or writable roots across.
export function newTaskParams(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.ephemeral === true ||
      (raw.threadSource != null && raw.threadSource !== 'user')) fail('Only a persistent user task is supported');
  const cwd = projectRoot(raw.cwd);
  if (raw.projectId != null && !UUID.test(raw.projectId)) fail('Invalid GPU project identity');
  const result = {cwd, ephemeral:false, threadSource:'user', historyMode:'legacy',
    ...(raw.projectId ? {projectId:raw.projectId} : {})};
  if (raw.model != null) result.model = modelSettings({model:raw.model}).model;
  if (raw.modelProvider != null && raw.modelProvider !== 'openai') fail('Unsupported model provider');
  if (raw.permissions != null) {
    if (![':read-only',':workspace',':danger-full-access'].includes(raw.permissions)) fail('Unsupported permission profile');
    result.permissions = raw.permissions;
  }
  if (raw.sandbox != null) {
    if (raw.permissions != null || !['read-only','workspace-write','danger-full-access'].includes(raw.sandbox)) fail('Unsupported sandbox');
    result.sandbox=raw.sandbox;
  }
  for (const [key,values] of [['approvalPolicy',['untrusted','on-failure','on-request','never']],['approvalsReviewer',['user','auto_review','guardian_subagent']],['serviceTier',['default','fast','flex']]]) {
    if (raw[key] != null) {if (!values.includes(raw[key])) fail('Unsupported '+key);result[key]=raw[key];}
  }
  return result;
}

export function firstTaskTurn(raw) {
  if (!UUID.test(raw?.threadId??'') || !UUID.test(raw?.clientUserMessageId??'')) fail('Stable GPU task and message IDs required');
  const {text,localImages}=turnImageInput(raw.input);
  if (raw.toolOutput!=null || raw.outputSchema!=null || raw.additionalContext!=null || raw.environments?.length)
    fail('Additional first-turn input is unsupported');
  if (raw.collaborationMode?.mode != null && raw.collaborationMode.mode!=='default') fail('Only the default work mode is supported for new tasks');
  return {threadId:raw.threadId,operationId:raw.clientUserMessageId,text,settings:settingsFromTurn(raw),...(localImages.length?{localImages}:{})};
}
