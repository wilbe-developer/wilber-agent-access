import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm,stat,symlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {renewScopedCredential} from '../../plugins/wilber-agent-access/bin/scoped-renewal.mjs';

const id='11111111-1111-4111-8111-111111111111';
async function fixture(run){
  const directory=await mkdtemp(path.join(os.tmpdir(),'wilber-renewal-'));
  let handle;const bodies=[];
  const server=createServer(async(req,res)=>{
    assert.equal(req.url,'/api/wilber/agent-connection');
    let body='';for await(const c of req)body+=c;
    const value=JSON.parse(body);bodies.push(value);
    res.setHeader('Content-Type','application/json');await handle(value,res);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const endpoint=`http://127.0.0.1:${server.address().port}/api/wilber/mcp`;
  const file=path.join(directory,'credentials.json');
  const saveCredential=c=>writeFile(file,JSON.stringify(c),{mode:0o600});
  const readCredential=async()=>JSON.parse(await readFile(file,'utf8'));
  const make=extra=>({kind:'scoped',connectionId:id,audience:'captain',endpoint,accessToken:`wb_agent_${'a'.repeat(64)}`,expiresAt:new Date(Date.now()+86400000).toISOString(),...extra});
  const ok=res=>res.end(JSON.stringify({connection_id:id,audience:'captain',permissions:['access.get'],expires_at:new Date(Date.now()+3600000).toISOString(),refresh_expires_at:new Date(Date.now()+90*86400000).toISOString()}));
  const renew=async(options={})=>renewScopedCredential({credential:await readCredential(),directory,readCredential,saveCredential,endpoint,...options});
  try{await run({make,saveCredential,readCredential,renew,bodies,ok,directory,file,setHandle:h=>handle=h});}
  finally{await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
}

test('existing legacy connection upgrades in place, stays private, and fresh credential makes no network request',()=>fixture(async f=>{
  await f.saveCredential(f.make());f.setHandle((body,res)=>{assert.equal(body.action,'renew');assert.equal(body.credential,`wb_agent_${'a'.repeat(64)}`);f.ok(res);});
  const next=await f.renew();assert.equal(next.connectionId,id);assert.equal(next.audience,'captain');assert.match(next.refreshToken,/^wb_refresh_/);assert.notEqual(next.accessToken,`wb_agent_${'a'.repeat(64)}`);
  assert.equal(next.pendingRenewal,undefined);assert.equal((await stat(f.file)).mode&0o777,0o600);
  assert.equal((await f.renew()).accessToken,next.accessToken);assert.equal(f.bodies.length,1);
}));

test('legacy client-side expiry does not prevent server-authorized migration; inactive renewal cannot be revived locally',()=>fixture(async f=>{
  await f.saveCredential(f.make({expiresAt:new Date(Date.now()-86400000).toISOString()}));f.setHandle((body,res)=>f.ok(res));
  await f.renew();assert.equal(f.bodies.length,1);
  await f.saveCredential(f.make({refreshToken:`wb_refresh_${'b'.repeat(64)}`,refreshExpiresAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()}));
  await assert.rejects(f.renew(),{code:'connection_expired'});assert.equal(f.bodies.length,1);
}));

test('expired access refreshes without browser login or permission request',()=>fixture(async f=>{
  await f.saveCredential(f.make({refreshToken:`wb_refresh_${'b'.repeat(64)}`,refreshExpiresAt:new Date(Date.now()+86400000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()}));
  f.setHandle((body,res)=>{assert.equal(body.credential,`wb_refresh_${'b'.repeat(64)}`);assert.deepEqual(Object.keys(body).sort(),['access_token','action','credential','refresh_token','rotation_id']);f.ok(res);});
  const next=await f.renew();assert.equal(next.connectionId,id);assert.ok(Date.parse(next.expiresAt)>Date.now());
}));

test('lost response retains exact pending rotation across client restarts',()=>fixture(async f=>{
  await f.saveCredential(f.make());let first;
  f.setHandle((body,res)=>{if(!first){first=body;res.statusCode=503;res.end('{}');}else{assert.deepEqual(body,first);f.ok(res);}});
  await assert.rejects(f.renew(),{code:'connection_renewal_pending'});
  const pending=(await f.readCredential()).pendingRenewal;assert.ok(pending);
  const next=await f.renew();assert.equal(next.accessToken,pending.accessToken);assert.equal(next.refreshToken,pending.refreshToken);assert.equal(f.bodies.length,2);
}));

test('reopening hours after a lost response adopts valid refresh and rotates again before returning access',()=>fixture(async f=>{
  await f.saveCredential(f.make());let first;let calls=0;
  f.setHandle((body,res)=>{
    calls++;
    if(calls===1){first=body;res.statusCode=503;res.end('{}');return;}
    if(calls===2){assert.deepEqual(body,first);res.end(JSON.stringify({connection_id:id,audience:'captain',permissions:['access.get'],expires_at:new Date(Date.now()-3600000).toISOString(),refresh_expires_at:new Date(Date.now()+86400000).toISOString()}));return;}
    assert.equal(body.credential,first.refresh_token);assert.notEqual(body.rotation_id,first.rotation_id);f.ok(res);
  });
  await assert.rejects(f.renew(),{code:'connection_renewal_pending'});
  const next=await f.renew();assert.ok(Date.parse(next.expiresAt)>Date.now());assert.equal(calls,3);assert.equal(next.pendingRenewal,undefined);
}));

test('pending renewable rotation may recover after its old refresh deadline; server remains authoritative',()=>fixture(async f=>{
  const pending={rotationId:id,accessToken:`wb_agent_${'d'.repeat(64)}`,refreshToken:`wb_refresh_${'e'.repeat(64)}`};
  await f.saveCredential(f.make({refreshToken:`wb_refresh_${'b'.repeat(64)}`,expiresAt:new Date(Date.now()-1000).toISOString(),refreshExpiresAt:new Date(Date.now()-1000).toISOString(),pendingRenewal:pending}));
  f.setHandle((body,res)=>{assert.equal(body.rotation_id,id);assert.equal(body.refresh_token,pending.refreshToken);f.ok(res);});
  assert.equal((await f.renew()).refreshToken,pending.refreshToken);
}));

test('separate process and path alias share renewal; kernel releases coordination after process death', {timeout:15000},()=>fixture(async f=>{
  await f.saveCredential(f.make());
  const alias=`${f.directory}-alias`;await symlink(f.directory,alias,process.platform==='win32'?'junction':'dir');
  const worker=path.join(f.directory,'worker.mjs');
  const moduleUrl=pathToFileURL(path.resolve('plugins/wilber-agent-access/bin/scoped-renewal.mjs')).href;
  await writeFile(worker,`import {readFile,writeFile,rename} from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';import {renewScopedCredential} from ${JSON.stringify(moduleUrl)};const directory=process.argv[2];const file=path.join(directory,'credentials.json');const readCredential=async()=>JSON.parse(await readFile(file,'utf8'));const saveCredential=async(c)=>{const tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(c),{mode:0o600});await rename(tmp,file);};try{const credential=await readCredential();await renewScopedCredential({credential,directory,readCredential,saveCredential,endpoint:credential.endpoint});process.stdout.write('renewed');}catch{process.exitCode=1;}`);
  let ready;const firstRequest=new Promise(resolve=>ready=resolve);let initial;
  f.setHandle((body,res)=>{if(!initial){initial=body;ready();return;}assert.deepEqual(body,initial);f.ok(res);});
  const start=directory=>{const child=spawn(process.execPath,[worker,directory],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);const done=new Promise(resolve=>child.on('close',code=>resolve({code,output})));return {child,done};};
  const owner=start(f.directory);let waiter;
  try{
    await firstRequest;waiter=start(alias);
    await new Promise(r=>setTimeout(r,150));assert.equal(f.bodies.length,1,'alias must wait for the same credential-store lock');
    owner.child.kill('SIGKILL');await owner.done;
    const result=await waiter.done;assert.equal(result.code,0);assert.equal(result.output,'renewed');assert.equal(f.bodies.length,2);assert.equal((await f.readCredential()).pendingRenewal,undefined);
  }finally{owner.child.kill('SIGKILL');waiter?.child.kill('SIGKILL');await rm(alias,{force:true,recursive:true});}
}));

test('simultaneous CLI and MCP consumers share one rotation and reread durable credential',()=>fixture(async f=>{
  await f.saveCredential(f.make());f.setHandle(async(body,res)=>{await new Promise(r=>setTimeout(r,75));f.ok(res);});
  const old=await f.readCredential();const [a,b]=await Promise.all([f.renew({credential:old}),f.renew({credential:old})]);
  assert.equal(a.accessToken,b.accessToken);assert.equal(a.refreshToken,b.refreshToken);assert.equal(f.bodies.length,1);
}));

test('revoked/changed-role connection fails without widening access or leaking server content',()=>fixture(async f=>{
  await f.saveCredential(f.make());f.setHandle((body,res)=>{res.statusCode=401;res.end(JSON.stringify({error:'PRIVATE_SENTINEL'}));});
  await assert.rejects(f.renew(),e=>e.code==='connection_expired'&&!e.message.includes('PRIVATE_SENTINEL'));
  assert.equal((await f.readCredential()).accessToken,`wb_agent_${'a'.repeat(64)}`);
}));

test('wrong identity response cannot replace stored connection',()=>fixture(async f=>{
  await f.saveCredential(f.make());f.setHandle((body,res)=>res.end(JSON.stringify({connection_id:'22222222-2222-4222-8222-222222222222',audience:'captain',permissions:[],expires_at:new Date(Date.now()+3600000).toISOString(),refresh_expires_at:new Date(Date.now()+86400000).toISOString()})));
  await assert.rejects(f.renew(),{code:'connection_renewal_pending'});assert.equal((await f.readCredential()).accessToken,`wb_agent_${'a'.repeat(64)}`);
}));

test('older server compatibility keeps only an unexpired legacy credential',()=>fixture(async f=>{
  f.setHandle((body,res)=>{res.statusCode=404;res.end('{}');});await f.saveCredential(f.make());
  const old=await f.renew();assert.equal(old.refreshToken,undefined);assert.equal(old.pendingRenewal,undefined);
  await f.saveCredential(f.make({expiresAt:new Date(Date.now()-1000).toISOString()}));await assert.rejects(f.renew(),{code:'connection_expired'});
}));
