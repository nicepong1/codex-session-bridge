# Codex Session Bridge

**다른 Windows PC에서 실행 중인 공식 Codex 작업을, 내 Windows PC의 공식 Codex 화면으로 이어서 사용합니다.**

호스트 PC의 작업 목록과 본문을 보고, 작업을 선택해 지시를 보냅니다. 실제 코딩과 도구 실행은 호스트의 기존 Codex 작업에서 이어집니다. 바탕 화면 아이콘을 누르면 저장한 연결 설정으로 별도 Codex 창을 엽니다.

> 독립적으로 개발한 실험적 도구입니다. OpenAI 공식 제품이 아니며, Codex 데스크톱의 비공개 연결 규약을 사용합니다. 현재 검증한 Windows 앱 버전만 지원합니다. 설치 전 [호환성 표](docs/COMPATIBILITY.md)를 확인하세요.

**[설치 파일 다운로드](https://github.com/nicepong1/codex-session-bridge/releases/tag/v0.18.3)** · **[사용설명서](docs/USER-GUIDE.md)** · **[문제 해결](docs/TROUBLESHOOTING.md)** · **[앱 개요와 구조](docs/OVERVIEW.md)**

## 할 수 있는 일

- 호스트의 기존 작업과 프로젝트 목록 조회, 작업 선택 및 본문 사전 읽기
- 같은 작업에 텍스트 지시 전송, 새 작업 생성 및 첫 입력 전달
- 모델과 추론 수준 변경, 호스트 프로젝트 등록
- 명령 실행·인터넷·폴더 접근 권한 승인과 일부 Computer Use 앱 사용 승인 전달
- SSH 연결이 끊어졌을 때 재연결, 결과가 불확실한 입력·승인의 자동 재전송 방지
- 사용자별 설치, 여러 호스트 설정 저장, 설정·최근 작업·로그를 호스트별로 분리
- SSH 서버 지문 확인 및 Codex 버전 검사, 바탕 화면 바로가기

## 빠른 시작

1. **두 PC 모두** 검증된 공식 Codex 앱을 설치하고 로그인합니다. 호스트는 Windows에 로그인한 상태로 Codex를 열어 둡니다.
2. 두 PC를 Tailscale 같은 사설망으로 연결하고, 호스트의 Windows OpenSSH Server와 SSH 키 인증을 준비합니다.
3. 같은 릴리스의 Windows x64 ZIP을 두 PC에서 압축 해제합니다. **호스트에서 `Install.cmd` → `2`**, **노트북에서 `Install.cmd` → `1`**을 선택합니다.
4. 노트북 설정 화면에 호스트 주소·사용자·SSH 키 경로를 입력합니다. 호스트의 `Show-HostInfo.cmd`에 나온 **SHA256 지문**을 입력해 연결 대상을 확인합니다.
5. 바탕 화면의 **Codex Session Bridge** 아이콘을 엽니다. 이후에는 그 창에서 작업을 선택하고 사용합니다.

Node.js와 JavaScript 의존성은 릴리스 ZIP에 포함됩니다. Codex, Tailscale, Windows OpenSSH는 별도로 준비해야 합니다. 설치 과정은 SSH 서버·방화벽·업무 폴더 권한을 변경하지 않습니다. SSH 키 설정이 처음이면 [자세한 설치 순서](docs/USER-GUIDE.md)를 따라가세요.

## 지원 범위

| 항목 | 릴리스 0.18.3 |
|---|---|
| 노트북/호스트 OS | Windows x64 |
| 노트북 Codex 앱 | 26.901.5280.0, 26.901.6511.0, 26.908.4834.0 |
| 호스트 Codex 앱 | 26.901.5280.0, 26.901.6511.0, 26.903.8094.0 |
| 호스트 공식 CLI | codex-cli 0.153.4 |
| Android | 공식 ChatGPT Remote를 별도로 사용. 이 ZIP의 설치 대상 아님 |
| macOS/Linux/Windows ARM64 | 미지원 |
| 여러 호스트 | 설정 저장 및 전환 지원. 한 사용자에게 연결 창 하나만 실행 |

**파일 변경 승인, 범용 플러그인 질문·인증, 대기 메시지 추가·실행, 실행 중 중지·개입, 첨부파일·원격 파일/터미널 패널은 아직 완전하게 지원하지 않습니다.** 해당 요청은 호스트 공식 앱에서 처리하세요. 자세한 범위는 [승인·질문 지원표](docs/APPROVALS.md)를 참고하세요.

## 개발

Windows x64, Node.js 24 이상, Windows .NET Framework C# 컴파일러가 필요합니다.

```powershell
npm ci --ignore-scripts
.\Build-Guard.ps1
npm test
npm run audit
.\scripts\Build-Release.ps1
```

빌드 스크립트는 고정된 공식 Node.js 런타임을 다운로드하고 SHA256을 검증합니다. ZIP 내부 파일 명세와 ZIP 체크섬을 생성합니다. 배포 시 Codex 앱 파일·계정·대화·사용자 설정을 포함하지 않습니다.

[기여 안내](CONTRIBUTING.md) · [보안 안내](SECURITY.md) · [변경 기록](CHANGELOG.md) · [MIT License](LICENSE)
