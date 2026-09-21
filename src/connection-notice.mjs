import {turnsOf} from './state.mjs';

// Only fixed categories leave the bounded diagnostic buffer. Never persist or
// show raw stderr (which can contain paths, usernames, or SSH command text).
export function connectionFailureKind(text) {
  if (/Unsupported host Codex build|unsupported-host-app/i.test(text)) return 'unsupported-host-app';
  if (/Compatible official Codex CLI cache not found|unsupported-host-cli/i.test(text)) return 'unsupported-host-cli';
  if (/host key verification|REMOTE HOST IDENTIFICATION|host-key/i.test(text)) return 'host-key';
  if (/permission denied|authentication failed|authentication-or-access/i.test(text)) return 'authentication-or-access';
  if (/timed out|timeout|heartbeat expired/i.test(text)) return 'timeout';
  if (/reset|broken pipe|closed by remote|connection.*closed|connection-closed/i.test(text)) return 'connection-closed';
  if (/refused|unreachable|no route/i.test(text)) return 'unreachable';
  return 'unknown';
}

export class ConnectionFailureClassifier {
  #tail = '';
  kind = 'unknown';
  accept(chunk) {
    this.#tail = (this.#tail + String(chunk)).slice(-2048);
    const next = connectionFailureKind(this.#tail);
    if (next !== 'unknown' && !this.kind.startsWith('unsupported-')) this.kind = next;
    return this.kind;
  }
}

const explanations = {
  'unsupported-host-app': 'GPU의 Codex 앱이 현재 브리지에서 지원하지 않는 버전입니다. 양쪽 브리지를 호환되는 릴리스로 업데이트해 주세요.',
  'unsupported-host-cli': 'GPU의 Codex 실행기 버전이 현재 브리지와 호환되지 않습니다. 양쪽 브리지를 호환되는 릴리스로 업데이트해 주세요.',
  'host-key': 'GPU의 SSH 호스트 키를 확인할 수 없습니다. Diagnose.cmd에서 연결 설정을 확인해 주세요.',
  'authentication-or-access': 'GPU의 SSH 인증 또는 접근 권한을 확인해 주세요.',
  'timeout': 'GPU 응답이 지연되고 있습니다. 네트워크와 Tailscale 연결을 확인해 주세요.',
  'connection-closed': 'GPU 연결이 끊겼습니다. 네트워크와 GPU의 Codex 실행 상태를 확인해 주세요.',
  'unreachable': 'GPU에 연결할 수 없습니다. GPU 전원과 Tailscale 연결을 확인해 주세요.',
  'unknown': 'GPU의 최신 상태를 받지 못했습니다. 연결이 복구되지 않으면 Diagnose.cmd에서 확인해 주세요.',
};

export function connectionNoticeState(state, reason) {
  if (!reason || !state) return state;
  const copy = structuredClone(state), turn = turnsOf(copy).at(-1);
  if (!turn || !Array.isArray(turn.items)) return state;
  turn.items.push({type: 'agentMessage', id: 'session-bridge-connection-guidance', phase: 'commentary',
    text: '**Session Bridge 연결 끊김 — 이 창에만 표시**\n\n이 본문은 마지막으로 받은 내용이며, GPU에서 이후 작업한 내용이 반영되지 않았을 수 있습니다.\n\n' +
      explanations[connectionFailureKind(reason)] + '\n\n최신 상태를 다시 받기 전에는 이 창에서 입력을 전달하지 않습니다.'});
  return copy;
}
