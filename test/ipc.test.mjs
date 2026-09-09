import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DesktopIpc, TEST_CHAT_TEXT } from '../src/ipc.mjs';
import { encodeFrame, FrameDecoder } from '../src/framing.mjs';
import { SessionState } from '../src/state.mjs';
import {pendingCommand,COMMAND_APPROVAL_METHOD} from '../src/command-approval.mjs';
import {pendingComputerApproval,COMPUTER_APPROVAL_METHOD} from '../src/computer-approval.mjs';

// Isolated fake router: these tests never connect to the real Codex pipe.
async function fixture(t, handle, options = {}) {
  const sockets = new Set();
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-bridge-test-${randomUUID()}` : join(tmpdir(), `cb-${randomUUID()}.sock`);
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const decoder = new FrameDecoder();
    socket.on('data', chunk => decoder.push(chunk, message => {
      const respond = (result, handledByClientId = 'owner', method = message.method) => socket.write(encodeFrame({
        type: 'response', requestId: message.requestId, method, resultType: 'success', handledByClientId, result,
      }));
      if (message.method === 'initialize') respond({ clientId: 'probe' }, 'router');
      else handle(message, respond, socket);
    }));
  });
  const client = new DesktopIpc(options);
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(endpoint);
  await once(server, 'listening');
  await client.connect({ path: endpoint });
  return client;
}

test('command approval sends the exact once-only decision to the verified GPU owner', async t => {
  const id=randomUUID(),owner=randomUUID(),turn=randomUUID(), received=[];
  const client=await fixture(t,(message,respond)=>{if(message.type==='request'){received.push(message);respond({ok:true},owner);}},
    {allowRemoteInput:true,allowedThreadId:id});
  const session=new SessionState(id,owner);session.state={id,sessionId:id,turns:[{turnId:turn,status:'inProgress'}],requests:[
    {id:76,method:'item/commandExecution/requestApproval',params:{threadId:id,turnId:turn,itemId:'exec-example',
      command:'Get-Content AGENTS.md',cwd:'C:\\project',availableDecisions:['accept','cancel']}}]};
  session.stale=false;session.receivedAt=Date.now();client.follow(id,owner);
  const approval={...pendingCommand(session.state,id,76,'accept'),ownerClientId:owner};
  const args={session,approval,appVersion:'26.901.5280.0'};
  assert.throws(()=>client.replyCommandApproval({...args,appVersion:'different'}));
  assert.throws(()=>client.replyCommandApproval({...args,approval:{...approval,ownerClientId:randomUUID()}}));
  assert.deepEqual(await client.replyCommandApproval(args),{ok:true});
  assert.equal(received.length,1);assert.equal(received[0].method,COMMAND_APPROVAL_METHOD);
  assert.equal(received[0].version,1);assert.equal(received[0].targetClientId,owner);
  assert.deepEqual(received[0].params,{conversationId:id,requestId:76,decision:'accept'});
  assert.throws(()=>client.replyCommandApproval(args));
});

test('Computer Use response goes to the original GPU handler exactly once, retaining conversation scope', async t => {
  const id=randomUUID(),owner=randomUUID(),turn=randomUUID(),received=[];
  const client=await fixture(t,(message,respond)=>{if(message.type==='request'){received.push(message);respond({ok:true},owner);}},
    {allowRemoteInput:true,allowedThreadId:id});
  const session=new SessionState(id,owner);session.state={id,sessionId:id,turns:[{turnId:turn,status:'inProgress'}],requests:[
    {id:79,method:'mcpServer/elicitation/request',params:{threadId:id,turnId:turn,serverName:'node_repl',mode:'form',
      requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',
        persist:['session','always'],tool_params:{app:'Example'}}}}]};
  session.stale=false;session.receivedAt=Date.now();client.follow(id,owner);
  const response={action:'accept',content:{},_meta:{persist:'session'}};
  const approval={...pendingComputerApproval(session.state,id,79,response),ownerClientId:owner};
  const args={session,approval,appVersion:'26.901.5280.0'};
  assert.throws(()=>client.replyComputerApproval({...args,appVersion:'different'}));
  assert.throws(()=>client.replyComputerApproval({...args,approval:{...approval,ownerClientId:randomUUID()}}));
  assert.deepEqual(await client.replyComputerApproval(args),{ok:true});
  assert.equal(received.length,1);assert.equal(received[0].method,COMPUTER_APPROVAL_METHOD);
  assert.equal(received[0].version,1);assert.equal(received[0].targetClientId,owner);
  assert.deepEqual(received[0].params,{conversationId:id,requestId:79,response});
  assert.throws(()=>client.replyComputerApproval(args));
});

test('one fixed probe is delivered to the subscribed owner and cannot be retried on the connection', async t => {
  const received = [];
  const client = await fixture(t, (message, respond) => {
    received.push(message);
    if (message.type === 'request') respond(message.method === 'thread-owner-discovery'
      ? { supportsUntrustedAppInput: true } : { result: { turnId: 'turn' } });
  }, { allowProbeWrite: true });
  const owner = await client.request('thread-owner-discovery', { hostId: 'local', conversationId: 'thread' });
  client.follow('thread', owner.handledByClientId);
  const session = new SessionState('thread', 'owner');
  session.accept({ method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner',
    params: { hostId: 'local', conversationId: 'thread', change: { type: 'snapshot', revision: 1,
      conversationState: { id: 'thread', turns: [{ turnId: 'turn', status: 'inProgress' }] } } } });
  const args = { session, expectedTurnId: 'turn', appVersion: '26.901.5280.0', nonce: 'a'.repeat(24) };
  const response = await client.sendProbe(args);
  assert.equal(response.result.result.turnId, 'turn');
  assert.throws(() => client.sendProbe(args), /already attempted/);
  const writes = received.filter(message => message.method === 'thread-follower-steer-turn');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].targetClientId, 'owner');
  assert.equal(writes[0].params.conversationId, 'thread');
  assert.equal(writes[0].params.input[0].text,
    `[Codex Session Bridge 연결 검증 ${'a'.repeat(24)}] 사용자 요청에 따른 동일 세션 입력 전달 시험 메시지입니다.`);
});

test('response correlation refuses another owner or method, and a timeout is never retried', async t => {
  let requests = 0;
  const client = await fixture(t, (message, respond) => {
    if (message.type !== 'request') return;
    requests++;
    if (message.params.case === 'owner') respond({}, 'different-owner');
    if (message.params.case === 'method') respond({}, 'owner', 'wrong-method');
  });
  await assert.rejects(client.request('thread-owner-discovery', { case: 'owner' }, { targetClientId: 'owner' }), /owner mismatch/);
  await assert.rejects(client.request('thread-owner-discovery', { case: 'method' }), /method mismatch/);
  await assert.rejects(client.request('thread-owner-discovery', { case: 'timeout' }, { timeoutMs: 30 }), /timed out/);
  assert.equal(requests, 3);
});

test('disconnect rejects pending operations instead of leaving a successful-looking request', async t => {
  const client = await fixture(t, (_message, _respond, socket) => socket.destroy());
  const disconnected = once(client, 'disconnected');
  await assert.rejects(client.request('thread-owner-discovery', {}), /closed/);
  await disconnected;
});

test('idle probe targets only the designated test chat, inherits settings, and is attempted once', async t => {
  const requests = [];
  const client = await fixture(t, (message, respond) => {
    if (message.type === 'request') { requests.push(message); respond({ result: { turn: { id: 'new-turn' } } }); }
  }, { allowProbeWrite: true });
  client.follow('thread', 'owner');
  const state = new SessionState('thread', 'owner');
  state.accept({ method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner',
    params: { hostId: 'local', conversationId: 'thread', change: { type: 'snapshot', revision: 1,
      conversationState: { id: 'thread', threadRuntimeStatus: { type: 'idle' }, turns: [
        { turnId: 'old-turn', status: 'completed', params: { input: [{ type: 'text', text: TEST_CHAT_TEXT }] } },
      ] } } } });
  const args = { session: state, expectedLastTurnId: 'old-turn', appVersion: '26.901.5280.0', nonce: 'a'.repeat(24) };
  await client.startIdleProbe(args);
  assert.throws(() => client.startIdleProbe(args), /already attempted/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'thread-follower-start-turn');
  assert.equal(requests[0].version, 2);
  assert.equal(requests[0].targetClientId, 'owner');
  assert.equal(requests[0].params.turnStart.request.threadId, 'thread');
  assert.deepEqual(Object.keys(requests[0].params.turnStart.request).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.equal(requests[0].params.turnStart.context.inheritThreadSettings, true);
});

test('idle writes reject active work, a changed last turn, and an unrelated chat', () => {
  const client = new DesktopIpc({ allowProbeWrite: true });
  const session = { state: { turns: [{ turnId: 'old', status: 'completed', params: { input: [] } }] },
    receivedAt: Date.now(), summary: () => ({ stale: false, runtimeStatus: 'active', activeTurnIds: ['active'] }) };
  const args = { session, expectedLastTurnId: 'old', appVersion: '26.901.5280.0', nonce: 'a'.repeat(24) };
  assert.throws(() => client.startIdleProbe(args), /Idle/);
  session.summary = () => ({ stale: false, runtimeStatus: 'idle', activeTurnIds: [] });
  assert.throws(() => client.startIdleProbe({ ...args, expectedLastTurnId: 'different' }), /Last completed/);
  assert.throws(() => client.startIdleProbe(args), /test chat marker/);
});

test('selected-task text input keeps the caller message ID and cannot target another task', async t => {
  const selected = '714adca2-1120-4134-83ad-82c84799ea63';
  const messageId = randomUUID(), received = [];
  const client = await fixture(t, (message, respond) => {
    if (message.type === 'request') { received.push(message); respond({result: {turn: {id: 'gpu-result'}}}); }
  }, {allowRemoteInput: true, allowedThreadId: selected});
  client.follow(selected, 'owner');
  const session = new SessionState(selected, 'owner');
  session.accept({method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', params: {
    hostId: 'local', conversationId: selected, change: {type: 'snapshot', revision: 1,
      conversationState: {id: selected, sessionId: selected, threadRuntimeStatus: {type: 'idle'}, turns: [{turnId: 'old', status: 'completed'}]}}}});
  const args = {session, text: '선택한 작업에서만 실행', clientUserMessageId: messageId, appVersion: '26.901.5280.0'};
  assert.throws(() => client.startTextTurn({...args, session: {...session, threadId: '814adca2-1120-4134-83ad-82c84799ea63'}}), /scope/);
  await client.startTextTurn(args);
  assert.equal(received.length, 1); assert.equal(received[0].targetClientId, 'owner');
  assert.equal(received[0].params.turnStart.request.threadId, selected);
  assert.equal(received[0].params.turnStart.request.clientUserMessageId, messageId);
  assert.throws(() => client.startTextTurn(args), /already attempted/);
});
