# 문제 해결

먼저 설치 폴더의 `Diagnose.cmd`를 실행합니다. 설정을 바꾸려면 `Configure.cmd`, 호스트 정보는 호스트의 `Show-HostInfo.cmd`를 사용합니다.

| 증상 | 확인할 내용 |
|---|---|
| `SSH key authentication failed` | SSH 사용자명, 개인 키, 호스트 공개 키 등록 위치와 ACL. 암호문 키는 ssh-agent 등록 여부 |
| `SSH host key changed or is missing` | 호스트의 실제 지문 확인. 변경이 정상이라면 새 연결로 다시 등록. 기존 검사를 무시하지 않음 |
| `Host unavailable` | Tailscale 연결, 호스트 전원·SSH 서비스·포트·방화벽, 호스트 설치 여부 |
| `Install the same bridge release` | 양쪽 ZIP 버전을 동일하게 설치 |
| `client.compatible: false` | 노트북 Codex 앱 버전과 설치 형태 확인 |
| `host.appCompatible: false` | 호스트 Codex 앱 실행 여부, SSH와 같은 Windows 사용자, 지원 버전 확인 |
| `cliCompatible: false` | 호스트 공식 앱을 열어 CLI 캐시가 준비됐는지 확인. 지원 버전 확인 |
| `ipcReady: false` | 호스트 공식 앱을 로그인한 채로 열어 두었는지 확인 |
| 다른 호스트로 전환되지 않음 | 기존 연결용 앱을 종료한 뒤 Configure.cmd에서 선택하고 다시 실행 |
| 본문은 보이지만 입력이 안 됨 | 사전 읽기 화면일 수 있음. 실제 호스트 작업 연결까지 대기 |
| 프로젝트 폴더를 찾지 못함 | 노트북 로컬 경로와 호스트 경로 구분, 공유 서버 이름과 연결 주소 일치 여부 |
| 승인 버튼이 반응하지 않음 | [지원표](APPROVALS.md) 확인 후 미지원 요청은 호스트 공식 앱에서 처리 |
| 연결은 됐는데 실행기 초기화 오류 | 호스트 샌드박스·도구 설치·폴더 권한 문제를 별도로 확인 |

기본 연결이 아직 없으면 바탕 화면 아이콘이 최초 설정을 엽니다. 연결 시작이 실패하면 안내 창을 표시합니다. 임시 네트워크 문제는 재연결을 시도할 수 있지만 입력·승인 결과가 불확실하면 자동 재전송하지 않습니다.

개발자에게 이슈를 보낼 때는 OS, 양쪽 앱 버전, 브리지 버전, 오류 종류, 재현 순서만 먼저 공유하세요. `reports`, 임시 공식 앱 프로필, SSH 키, 계정 파일 또는 업무 대화를 통째로 올리지 마세요.
