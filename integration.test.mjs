import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {openQueue} from './queue.mjs';
import {createPrintServer} from './server.mjs';
import {createPrintClient} from './print-client.mjs';
import {runAgent, request as agentRequest} from './agent-core.mjs';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'remote-print-integrated-'));
  const config={adminToken:'synthetic-admin-'.padEnd(40,'a'),agents:[
    {agentId:'office-a-pc',printerId:'office-a',token:'synthetic-office-a-'.padEnd(40,'h')},
    {agentId:'office-b-pc',printerId:'office-b',token:'synthetic-office-b-'.padEnd(40,'k')}]};
  const queue=openQueue(join(dir,'server'));
  const server=createPrintServer(config,queue);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));queue.close();await rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`, client=createPrintClient({url,token:config.adminToken});
  const agentConfig=i=>({serverUrl:url,agentId:config.agents[i].agentId,printerId:config.agents[i].printerId,
    printerName:'Synthetic Printer',pollIntervalMs:1000,stateDir:join(dir,config.agents[i].agentId)});
  const deps=(i,print)=>({getPrinters:async()=>[{name:agentConfig(i).printerName}],readToken:async()=>config.agents[i].token,print});
  return {dir,client,agentConfig,deps};
}
const pdf=Buffer.from('%PDF-1.4\nSYNTHETIC SHIPPING LABEL TEST; NO REAL PERSON OR TRACKING\n%%EOF');
test('real HTTP queue -> agent -> mock Windows print -> ACK -> readback, per printer',async t=>{
  const f=await fixture(t);const prints=[[],[]];
  for(const [i,printerId]of ['office-a','office-b'].entries())await f.client.enqueuePdf({jobId:`synthetic-${i}`,printerId,pdf});
  for(const i of [1,0]){
    await runAgent(f.agentConfig(i),f.deps(i,async(file,options)=>{assert.deepEqual(await readFile(file),pdf);assert.equal(options.printer,f.agentConfig(i).printerName);assert.equal(options.scale,'noscale');assert.equal(options.copies,1);prints[i].push(file);}),{once:true});
    assert.equal((await f.client.getJob(`synthetic-${i}`)).job.status,'submitted');
    // Restart with same ledger must not print the completed job a second time.
    await runAgent(f.agentConfig(i),f.deps(i,async()=>assert.fail('duplicate real print')),{once:true});
  }
  assert.deepEqual(prints.map(p=>p.length),[1,1]);
});
test('ACK response lost after server accepted: restart reconciles, never prints again',async t=>{
  const f=await fixture(t);await f.client.enqueuePdf({jobId:'ack-lost',printerId:'office-a',pdf});let prints=0;
  const deps={...f.deps(0,async()=>{prints++;}),request:async(config,route,body,token)=>{
    const result=await agentRequest(config,route,body,token);
    if(route.endsWith('/result'))throw new Error('SYNTHETIC_ACK_RESPONSE_LOST');return result;
  }};
  await assert.rejects(runAgent(f.agentConfig(0),deps,{once:true}),/SYNTHETIC_ACK_RESPONSE_LOST/);
  assert.equal((await f.client.getJob('ack-lost')).job.status,'submitted');
  await runAgent(f.agentConfig(0),f.deps(0,async()=>{prints++;}),{once:true});
  assert.equal(prints,1);
});
test('driver outcome unknown stays unknown and has no automatic retry',async t=>{
  const f=await fixture(t);await f.client.enqueuePdf({jobId:'driver-error',printerId:'office-a',pdf});let attempts=0;
  const deps=f.deps(0,async()=>{attempts++;throw new Error('SYNTHETIC_DRIVER_ERROR');});
  await runAgent(f.agentConfig(0),deps,{once:true});
  const state=(await f.client.getJob('driver-error')).job;assert.equal(state.status,'unknown');assert.equal(state.physicalOutput,'NOT_OBSERVED');
  await runAgent(f.agentConfig(0),deps,{once:true});assert.equal(attempts,1);
});
test('dry run does not consume a queued job',async t=>{
  const f=await fixture(t);await f.client.enqueuePdf({jobId:'dry',printerId:'office-a',pdf});
  await runAgent(f.agentConfig(0),f.deps(0,async()=>assert.fail('dry run printed')),{dryRun:true,once:true});
  assert.equal((await f.client.getJob('dry')).job.status,'queued');
});
