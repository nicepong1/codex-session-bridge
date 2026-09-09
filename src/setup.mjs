import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {listProfiles,saveProfile,selectProfile,validateProfile,verifyHostKeys,profilePaths} from './connection-config.mjs';
import {diagnose} from './doctor.mjs';
const execute=promisify(execFile);
const rl=createInterface({input:process.stdin,output:process.stdout});
const ask=async(q,defaultValue='')=>(await rl.question(q+(defaultValue?' ['+defaultValue+']':'')+': ')).trim()||defaultValue;
try{
 console.log('\nCodex Session Bridge — 연결 설정\n호스트 PC에 먼저 Install.cmd를 실행하고 Host를 선택하세요.\n개인 키와 비밀번호는 다른 사람에게 보내지 않습니다.\n');
 const profiles=listProfiles();
 if(profiles.length){console.table(profiles.map((p,i)=>({번호:i+1,연결:p.label,주소:p.hostname})));const choice=await ask('기존 연결 번호 또는 새 연결 N','N');
  if(/^\d+$/.test(choice)&&profiles[Number(choice)-1]){const p=profiles[Number(choice)-1];console.log(JSON.stringify(await diagnose(p),null,2));selectProfile(p.id);console.log('기본 연결을 변경했습니다. 기존 연결 창을 종료한 뒤 아이콘을 여세요.');process.exitCode=0;rl.close();process.exit(0)}
  if(choice.toLowerCase()!=='n')throw Error('Invalid selection');
 }
 const profile={version:1,id:randomUUID(),label:await ask('연결 이름','My remote PC'),hostname:await ask('호스트의 Tailscale IPv4 또는 DNS 이름'),username:await ask('호스트 Windows 사용자명'),port:Number(await ask('SSH 포트','22')),identityFile:'',remoteInstallPath:''};
 profile.identityFile=await ask('SSH 개인 키 전체 경로 (ssh-agent 사용 시 Enter)');
 profile.remoteInstallPath=await ask('호스트 사용자별 기본 설치를 사용하려면 Enter (고급: 설치 경로)');
 const p=validateProfile(profile);
 if(p.identityFile&&!fs.existsSync(p.identityFile))throw Error('SSH private key file not found');
 console.log('호스트 PC에서 Show-HostInfo.cmd를 실행하고 표시된 SHA256 지문을 확인하세요.');
 const fingerprint=await ask('호스트 화면에 표시된 SSH SHA256 지문');
 let scan;
 try{({stdout:scan}=await execute('ssh-keyscan',['-T','8','-p',String(p.port),p.hostname],{windowsHide:true,timeout:15000,maxBuffer:65536}))}
 catch(e){if(e.stdout)scan=e.stdout;else throw Error('SSH server unreachable. Check Tailscale and OpenSSH Server.')}
 const keys=verifyHostKeys(scan,fingerprint,p.hostname,p.port);
 saveProfile(p,keys);
 console.log('호스트 지문 확인 완료. 키 인증 및 Codex 연결을 검사합니다...');
 const result=await diagnose(p);console.log(JSON.stringify(result,null,2));
 selectProfile(p.id);
 if(result.ready)console.log('설정 완료. 바탕 화면의 Codex Session Bridge 아이콘으로 연결하세요.');
 else console.log('설정은 저장했습니다. docs/TROUBLESHOOTING.md의 안내를 처리한 뒤 Diagnose.cmd로 다시 검사하세요.');
 console.log('설정 경로: '+profilePaths(p.id).config);
}catch(error){console.error('설정 실패: '+error.message);process.exitCode=2}
finally{rl.close()}
