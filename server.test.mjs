import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {openQueue,pdfBytes,MAX_PDF_BYTES} from './queue.mjs';
import {createPrintServer, validateConfig} from './server.mjs';
import {createPrintClient, serverUrl} from './print-client.mjs';

const config = {adminToken:'synthetic-admin-'.padEnd(40,'a'),agents:[
  {agentId:'office-a-pc',printerId:'office-a',token:'synthetic-office-a-'.padEnd(40,'h')},
  {agentId:'office-b-pc',printerId:'office-b',token:'synthetic-office-b-'.padEnd(40,'k')},
]};
const pdf = Buffer.from('%PDF-1.4\nSYNTHETIC TEST ONLY, NOT A WAYBILL\n%%EOF');
const job = (id='test-job',printerId='office-a',bytes=pdf) => ({id,printerId,pdfBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')});
test('maximum-size PDF validates without regex recursion overflow; noncanonical base64 rejected',()=>{
  const bytes=Buffer.alloc(MAX_PDF_BYTES,32);bytes.write('%PDF-');
  assert.equal(pdfBytes(bytes.toString('base64'),createHash('sha256').update(bytes).digest('hex')).length,MAX_PDF_BYTES);
  const uncanonical=Buffer.from('%PDF-');
  assert.throws(()=>pdfBytes(uncanonical.toString('base64').slice(0,-2)+'1=',createHash('sha256').update(uncanonical).digest('hex')));
});
function fixture(t, options) {
  const directory=mkdtempSync(join(tmpdir(),'remote-print-queue-'));
  const queue=openQueue(directory,options);
  t.after(()=>{queue.close();rmSync(directory,{recursive:true,force:true});});
  return {queue,directory};
}
async function httpFixture(t) {
  const {queue,directory}=fixture(t);
  const server=createPrintServer(config,queue);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const url=`http://127.0.0.1:${server.address().port}`;
  const request=(path,token,body,method=body===undefined?'GET':'POST')=>fetch(url+path,{method,
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {queue,directory,url,request};
}

test('the web shell serves only explicit assets; submitting still requires the owner token', async t => {
  const {url, request} = await httpFixture(t);
  const home = await fetch(url);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.match(await home.text(), /旧打印机远程打印/);
  assert.equal((await fetch(url + '/print.js')).status, 200);
  assert.equal((await fetch(url + '/.env')).status, 401);
  assert.equal((await fetch(url + '/server-state/queue.json')).status, 401);
  assert.equal((await request('/v1/jobs', config.agents[0].token, job())).status, 401);
  assert.equal((await request('/v1/jobs', config.adminToken, job())).status, 201);
});

test('queue deduplicates exact job, rejects changed PDF/printer and persists across restart',t=>{
  const {queue,directory}=fixture(t);
  assert.equal(queue.enqueue(job()).created,true);
  assert.equal(queue.enqueue(job()).created,false);
  assert.throws(()=>queue.enqueue(job('test-job','office-b')),/IDEMPOTENCY_CONFLICT/);
  assert.throws(()=>queue.enqueue(job('test-job','office-a',Buffer.from('%PDF-different'))),/IDEMPOTENCY_CONFLICT/);
  queue.close();const reopened=openQueue(directory);
  try { assert.equal(reopened.get('test-job').status,'queued'); } finally { reopened.close(); }
});
test('only correct printer receives job and claim is single-use',t=>{
  const {queue}=fixture(t);queue.enqueue(job());
  assert.equal(queue.claim(config.agents[1]),null);
  assert.equal(queue.claim(config.agents[0]).id,'test-job');
  assert.equal(queue.claim(config.agents[0]),null);
});
test('lost claim response expires unknown, never silently returns to print queue',t=>{
  let now=1000;const {queue}=fixture(t,{now:()=>now,claimTimeoutMs:100});
  queue.enqueue(job());queue.claim(config.agents[0]);now+=100;
  assert.equal(queue.claim(config.agents[0]),null);
  assert.equal(queue.get('test-job').status,'unknown');
  assert.equal(queue.enqueue(job()).created,false);
  assert.equal(queue.claim(config.agents[0]),null);
});
test('result retries are idempotent; submitted is not physical paper proof; purge PDF',t=>{
  const {queue,directory}=fixture(t);queue.enqueue(job());queue.claim(config.agents[0]);
  const input={agentId:'office-a-pc',status:'submitted'};
  const a=queue.result(config.agents[0],'test-job',input),b=queue.result(config.agents[0],'test-job',input);
  assert.deepEqual(a,b);assert.equal(a.physicalOutput,'NOT_OBSERVED');
  assert.equal(JSON.parse(readFileSync(join(directory,'queue.json'))).jobs[0].pdfBase64,undefined);
  assert.throws(()=>queue.result(config.agents[0],'test-job',{...input,status:'unknown'}),/RESULT_CONFLICT/);
});
test('late successful ACK reconciles unknown for the original agent only',t=>{
  let now=0;const {queue}=fixture(t,{now:()=>now,claimTimeoutMs:10});queue.enqueue(job());queue.claim(config.agents[0]);now=11;
  assert.equal(queue.get('test-job').status,'unknown');
  assert.throws(()=>queue.result(config.agents[1],'test-job',{agentId:'office-b-pc',status:'submitted'}),/JOB_NOT_FOUND/);
  assert.equal(queue.result(config.agents[0],'test-job',{agentId:'office-a-pc',status:'submitted'}).status,'submitted');
});
test('invalid PDF/hash/identities are rejected before queue mutation',t=>{
  const {queue}=fixture(t);
  for(const input of [{...job(),sha256:'0'.repeat(64)},{...job(),pdfBase64:'not a PDF'},job('../path'),
    {...job(),extra:'untrusted'},{...job(),pdfBase64:Buffer.from('hello').toString('base64')},null])assert.throws(()=>queue.enqueue(input));
  assert.equal(queue.claim(config.agents[0]),null);
});
test('exclusive state lock and malformed persisted data fail closed',t=>{
  const {queue,directory}=fixture(t);
  assert.throws(()=>openQueue(directory),/SERVER_STATE_LOCKED/);
  queue.close();writeFileSync(join(directory,'queue.json'),'{broken');
  assert.throws(()=>openQueue(directory));
  writeFileSync(join(directory,'queue.json'),JSON.stringify({version:1,jobs:[{...job(),status:'queued',createdAt:0},{...job(),status:'queued',createdAt:0}]}));
  assert.throws(()=>openQueue(directory),/CORRUPT_QUEUE/);
});
test('credential overlap and duplicate printer agent bindings rejected',()=>{
  assert.throws(()=>validateConfig({...config,adminToken:'short'}));
  assert.throws(()=>validateConfig({...config,agents:[{...config.agents[0],token:config.adminToken}]}));
  assert.throws(()=>validateConfig({...config,agents:[config.agents[0],{...config.agents[1],printerId:'office-a'}]}));
});
test('HTTP submit -> routed agent claim -> result -> status readback',async t=>{
  const {url,request}=await httpFixture(t);
  const client=createPrintClient({url,token:config.adminToken});
  const input={jobId:'print-test-1',printerId:'office-a',pdf};
  assert.equal((await client.enqueuePdf(input)).created,true);
  assert.equal((await client.enqueuePdf(input)).created,false);
  assert.equal((await request('/v1/agent/claim',config.agents[1].token,{agentId:'office-b-pc'})).status,204);
  const claimed=await (await request('/v1/agent/claim',config.agents[0].token,{agentId:'office-a-pc'})).json();
  assert.equal(claimed.id,input.jobId);assert.equal(claimed.pdfBase64,pdf.toString('base64'));
  assert.equal((await request(`/v1/agent/jobs/${claimed.id}/result`,config.agents[0].token,{agentId:'office-a-pc',status:'submitted'})).status,200);
  const read=await client.getJob(input.jobId);assert.equal(read.job.status,'submitted');assert.equal(read.job.physicalOutput,'NOT_OBSERVED');assert.equal(read.job.pdfBase64,undefined);
  assert.equal((await request('/v1/agent/claim',config.agents[0].token,{agentId:'office-a-pc'})).status,204);
});
test('HTTP wrong tokens, role escalation, printer spoof and injected fields blocked',async t=>{
  const {request}=await httpFixture(t),h=config.agents[0],k=config.agents[1];
  assert.equal((await request('/v1/jobs','invalid',job())).status,401);
  assert.equal((await request('/v1/jobs',h.token,job())).status,401);
  assert.equal((await request('/v1/agent/claim',config.adminToken,{agentId:h.agentId})).status,401);
  assert.equal((await request('/v1/agent/claim',k.token,{agentId:h.agentId})).status,403);
  assert.equal((await request('/v1/agent/claim',h.token,{agentId:h.agentId,printerId:'office-b'})).status,403);
  assert.equal((await request('/v1/jobs',config.adminToken,job('x','missing'))).status,400);
  await request('/v1/jobs',config.adminToken,job());
  await request('/v1/agent/claim',h.token,{agentId:h.agentId});
  assert.equal((await request('/v1/agent/jobs/test-job/result',k.token,{agentId:k.agentId,status:'submitted'})).status,404);
  assert.equal((await request('/v1/agent/jobs/test-job/result',h.token,{agentId:h.agentId,status:'submitted',pdfBase64:'bad'})).status,400);
});
test('client refuses insecure remote URLs and disallows redirects/credential forwarding',async()=>{
  for(const url of ['http://remote.example','https://u:p@remote.example','https://remote.example/path','https://remote.example/?secret=x'])assert.throws(()=>serverUrl(url));
  assert.equal(serverUrl('https://remote.example'),'https://remote.example');
  const client=createPrintClient({url:'https://remote.example',token:config.adminToken,fetchImpl:async(url,init)=>{
    assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,`Bearer ${config.adminToken}`);throw new Error('synthetic secret must not escape');}});
  await assert.rejects(client.enqueuePdf({jobId:'x',printerId:'office-a',pdf}),/RETRY_SAME_JOB_ID/);
});
