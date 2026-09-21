import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {SnapshotSender,SnapshotReceiver} from '../src/snapshot-wire.mjs';
import {encodeSshFrame,SshFrameDecoder} from '../src/ssh-framing.mjs';
import {TransportLiveness} from '../src/transport-liveness.mjs';
import {MAX_FRAME_BYTES} from '../src/framing.mjs';
const id='00000000-0000-4000-8000-000000000001';
const snapshot=(revision,state)=>({type:'snapshot',threadId:id,ownerClientId:'owner',appVersion:'tested',revision,state:{id,...state}});
function carrier(message) {
  const decoder = new SshFrameDecoder(), out = [], wire = Buffer.from(encodeSshFrame(message));
  for (let i=0;i<wire.length;i+=4093) decoder.push(wire.subarray(i,i+4093),m=>out.push(m));
  assert.equal(decoder.pending,false); assert.equal(out.length,1);
  return out[0];
}
test('multi-megabyte image history transfers once; text deltas reconstruct the exact state',()=>{
  const sender=new SnapshotSender(),receiver=new SnapshotReceiver();
  const image=randomBytes(7*1024*1024).toString('base64');
  let state={turns:[{items:[{image},{text:'처음'}]}],requests:[]};
  const first=snapshot(1,state);
  assert.deepEqual(receiver.decode(carrier(sender.encode({id:'watch',result:first}))).result,first);
  for(let revision=2;revision<=12;revision++){
    state=structuredClone(state);state.turns[0].items[1].text+=' 새로운 답변';
    const full=snapshot(revision,state),wire=sender.encode(full);
    assert.equal(wire.type,'snapshot-delta');assert.ok(encodeSshFrame(wire).length<1500);
    assert.deepEqual(receiver.decode(carrier(wire)),full);
  }
});
test('snapshot deltas preserve additions, deletions and coalesced revisions',()=>{
  const sender=new SnapshotSender(),receiver=new SnapshotReceiver();
  const states=[{a:[1,2,3],b:{c:1}}, {a:[1],b:{d:2}}, {a:[1,{},null,4]}, {a:{changed:true}}, {a:null}];
  for(const [i,state]of states.entries()){
    const full=snapshot(i*100,state);assert.deepEqual(receiver.decode(carrier(sender.encode(full))),full);
  }
});
test('baseline gaps, changed owners, and unsafe patches fail instead of showing stale success',()=>{
  const sender=new SnapshotSender(),receiver=new SnapshotReceiver();
  receiver.decode(sender.encode(snapshot(1,{a:1})));
  const wire=sender.encode(snapshot(3,{a:2}));
  assert.throws(()=>new SnapshotReceiver().decode(wire),/baseline/);
  assert.throws(()=>receiver.decode({...wire,baseRevision:2}),/baseline/);
  assert.throws(()=>receiver.decode({...wire,ownerClientId:'other'}),/baseline/);
  assert.throws(()=>receiver.decode({...wire,patches:[{op:'add',path:['__proto__','bad'],value:1}]}),/Unsafe/);
  assert.deepEqual(receiver.decode(wire),snapshot(3,{a:2}));
  assert.equal(new SnapshotSender().encode(snapshot(3,{a:2})).type,'snapshot');
});
test('compressed carrier rejects expansion beyond the frame limit and noncanonical base64',()=>{
  const bomb='z:'+deflateRawSync(Buffer.alloc(MAX_FRAME_BYTES+5)).toString('base64')+'\n';
  for(const wire of [bomb,'A===\n','z:AAAA\n'])assert.throws(()=>new SshFrameDecoder().push(Buffer.from(wire),()=>assert.fail()));
});
test('large fragmented transfer stays live; silence and a never-ending frame still expire',()=>{
  const live=new TransportLiveness(0);live.received(100,true,false);
  for(let t=10000;t<=110000;t+=10000){live.received(t,true,false);assert.equal(live.expired(t),false);}
  assert.equal(live.expired(120101),true);
  live.received(120102,false,true);assert.equal(live.expired(120103),false);
  assert.equal(live.expired(135103),true);
});
