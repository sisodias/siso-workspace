import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFleet } from "./fleet.js";

const dir = process.env.SISO_TEST_DIR;
if (!dir) throw new Error("SISO_TEST_DIR must be an isolated fixture with caller-owned cleanup");
const configPath = join(dir,"fleet.json");
const tokens = [randomBytes(32).toString("base64url"),randomBytes(32).toString("base64url")];
writeFileSync(configPath,JSON.stringify({nodes:[
  {id:"node-a",aliases:["math"],roots:[dir],token:tokens[0]},
  {id:"node-b",aliases:[],roots:[dir],token:tokens[1]},
]}),{mode:0o600});
const app=express(); app.use(express.json());
let fleet=createFleet(app,configPath,dir);
const http=app.listen(0,"127.0.0.1");
await new Promise<void>(r=>http.once("listening",r));
const address=http.address() as {port:number};
const poll=async(node:string,token:string,payload:unknown)=>fetch(`http://127.0.0.1:${address.port}/fleet/poll/${node}`,{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(payload)});
const body={info:{hostname:"fixture",roots:[dir]},reports:[],capacity:1};
const connect=async()=>{
  const [c,s]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:"fleet-test",version:"1"});
  await fleet.server().connect(s); await client.connect(c); return client;
};
let client=await connect();
const call=async(name:string,args:Record<string,unknown>)=>{
  const r=await client.callTool({name,arguments:args});
  return JSON.parse((r.content as {type:string;text:string}[])[0].text);
};
try {
  assert.equal((await poll("node-a","wrong",body)).status,401);
  assert.equal((await poll("node-a",tokens[1],body)).status,401);
  assert.equal((await poll("node-a",tokens[0],{...body,info:{hostname:"fixture",roots:["/"]}})).status,403);
  const job=await call("job_start",{node:"math",cwd:dir,command:"echo fixture"});
  assert.equal(job.node,"node-a"); assert.equal(job.status,"queued");
  const received=await (await poll("node-a",tokens[0],body)).json();
  assert.equal(received.tasks[0].id,job.job_id);
  assert.equal((await (await poll("node-a",tokens[0],body)).json()).tasks.length,0);
  await poll("node-b",tokens[1],{...body,reports:[{id:job.job_id,status:"completed",result:{exit_code:0}}]});
  assert.equal((await call("job_status",{job_id:job.job_id})).status,"dispatched");
  await poll("node-a",tokens[0],{...body,reports:[{id:job.job_id,status:"completed",result:{exit_code:0}}]});
  assert.equal((await call("job_status",{job_id:job.job_id})).status,"completed");
  await client.close(); fleet.close();
  // Restart the database owner; conversation/session identity is not needed.
  fleet=createFleet(express(),configPath,dir); client=await connect();
  assert.equal((await call("job_status",{job_id:job.job_id})).result.exit_code,0);
  const cancel=await call("job_start",{node:"node-b",cwd:dir,command:"echo never-run"});
  assert.equal((await call("job_cancel",{job_id:cancel.job_id})).status,"cancelled");
  assert.ok((await call("job_start",{node:"unknown",cwd:dir,command:"echo no"})).error);
  console.log("PASS node auth, root enrollment, node isolation, no duplicate dispatch, queued cancellation and central restart persistence");
} finally { await client.close(); fleet.close(); await new Promise<void>((r,j)=>http.close(e=>e?j(e):r())); }
