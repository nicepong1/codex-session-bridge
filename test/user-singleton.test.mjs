import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import {singletonPipeForSid,currentWindowsSid,acquireUserSingleton} from '../src/user-singleton.mjs';

test('the singleton derives only from a validated SID, not the selected host or user name',()=>{
 const a='S-1-5-21-1-2-3-1001',b='S-1-5-21-1-2-3-1002';
 assert.equal(singletonPipeForSid(a),singletonPipeForSid(a));assert.notEqual(singletonPipeForSid(a),singletonPipeForSid(b));
 for(const value of ['',null,'user','S-1-5\\other','S-1-5\n',1])assert.throws(()=>singletonPipeForSid(value));
});
test('same SID collides, distinct SID names coexist and release allows reopening',{skip:process.platform!=='win32'},async()=>{
 const sid='S-1-5-21-'+randomInt(1,1000000000)+'-2-3-1001',other=sid.slice(0,-4)+'1002';
 const first=await acquireUserSingleton(sid),second=await acquireUserSingleton(other);
 try{await assert.rejects(acquireUserSingleton(sid),/Another connection/)}finally{await Promise.all([first,second].map(s=>new Promise(resolve=>s.close(resolve))))}
 const reopened=await acquireUserSingleton(sid);await new Promise(resolve=>reopened.close(resolve));
});
test('actual Windows token SID can be resolved without trusting environment user names',{skip:process.platform!=='win32'},()=>{
 assert.match(currentWindowsSid(),/^S-1-\d+(?:-\d+)+$/);
});
