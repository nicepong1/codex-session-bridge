import {prepareRemoteProfile} from './remote-installation.mjs';
await prepareRemoteProfile();
import {parseArgs} from 'node:util';
import {SshWorker} from './ssh-worker.mjs';
import {GPU_THREAD} from './guard-policy.mjs';
const {values} = parseArgs({options: {json: {type: 'boolean'}, cursor: {type: 'string'}, limit: {type: 'string', default: '30'}}});
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be 1 to 100');
const worker = new SshWorker({threadId: GPU_THREAD, seconds: 60, mode: 'catalog'});
try {
  const result = await worker.request('catalog', {limit, cursor: values.cursor});
  if (values.json) console.log(JSON.stringify(result));
  else {
    console.table(result.tasks.map((t, i) => ({번호: i + 1, 작업: t.title, ID: t.id})));
    if (result.nextCursor) console.log('추가 작업이 있습니다. --cursor로 다음 페이지를 조회할 수 있습니다.');
    console.log('연결할 작업은 GPU 공식 앱에 열려 있어야 합니다. 선택: Start-GpuCodex.ps1 -ThreadId <ID>');
  }
} catch (error) { console.error('GPU 작업 목록 조회 실패: ' + error.message); process.exitCode = 2; }
finally { worker.close(); }
