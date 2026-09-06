import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dir = process.env.SISO_TEST_DIR;
if (!dir) throw new Error("Caller-owned SISO_TEST_DIR required");
const owner = randomBytes(32).toString("hex");
const configFile = join(dir, "http-fleet.json");
writeFileSync(configFile, JSON.stringify({nodes:["node-a","node-b"].map(id=>({id,aliases:[],roots:[dir],token:randomBytes(32).toString("base64url")})),
  profiles:{laptop:{node:"node-a",title:"Laptop"},byk:{node:"node-b",title:"BYK"}}}),{mode:0o600});
const http = httpServer(); http.listen(0,"127.0.0.1");
await new Promise<void>(r=>http.once("listening",r));
const port = (http.address() as {port:number}).port;
const origin = `http://127.0.0.1:${port}`;
const previous = process.env.SISO_FLEET_CONFIG;
process.env.SISO_FLEET_CONFIG = configFile;
const running = createServer(loadConfig({DEVSPACE_CONFIG_DIR:dir, DEVSPACE_STATE_DIR:join(dir,"http-state"),
  HOST:"127.0.0.1",PORT:String(port),DEVSPACE_PUBLIC_BASE_URL:origin,DEVSPACE_OAUTH_OWNER_TOKEN:owner,
  DEVSPACE_ALLOWED_ROOTS:dir,DEVSPACE_WIDGETS:"off",DEVSPACE_LOG_REQUESTS:"0",DEVSPACE_LOG_TOOL_CALLS:"0",DEVSPACE_SKILLS:"0"}));
if (previous === undefined) delete process.env.SISO_FLEET_CONFIG; else process.env.SISO_FLEET_CONFIG = previous;
http.on("request",running.app);
const post = (path:string, fields:Record<string,string>) => fetch(origin+path,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(fields),redirect:"manual"});
const clients:Client[] = [];
const grant = async (path:string) => {
  const resource=origin+path;
  const registration=await fetch(origin+"/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_name:"Isolation test",redirect_uris:["http://localhost:9876/callback"],token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"]})});
  assert.equal(registration.status,201); const info=await registration.json();
  const verifier=randomBytes(32).toString("base64url");
  const auth=await post("/authorize",{client_id:info.client_id,redirect_uri:"http://localhost:9876/callback",response_type:"code",scope:"devspace",resource,code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url"),owner_token:owner});
  assert.equal(auth.status,302);
  const code=new URL(auth.headers.get("location")!).searchParams.get("code")!;
  const fields={client_id:info.client_id,grant_type:"authorization_code",redirect_uri:"http://localhost:9876/callback",code,code_verifier:verifier,resource};
  assert.equal((await post("/token",{...fields,resource:origin+"/mcp/other"})).status,400);
  const exchanged=await post("/token",fields); assert.equal(exchanged.status,200);
  const tokens=await exchanged.json();
  const client=new Client({name:"profile-test",version:"1"}); clients.push(client);
  const transport=new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:"Bearer "+tokens.access_token}}});
  await client.connect(transport);
  return {client,transport,tokens,info};
};
const call=async(c:Client,name:string,args:Record<string,unknown>={})=>c.callTool({name,arguments:args});
const value=(r:any)=>JSON.parse(r.content[0].text);
try {
  for(const path of ["/mcp","/mcp/laptop","/mcp/byk"]){
    const denied=await fetch(origin+path); assert.equal(denied.status,401);
    const meta=await (await fetch(origin+"/.well-known/oauth-protected-resource"+path)).json();
    assert.equal(meta.resource,origin+path);
  }
  const laptop=await grant("/mcp/laptop"), byk=await grant("/mcp/byk"), all=await grant("/mcp");
  assert.deepEqual(value(await call(laptop.client,"nodes_list")).map((n:any)=>n.node),["node-a"]);
  assert.equal(value(await call(all.client,"nodes_list")).length,2);
  const tools=await laptop.client.listTools(); assert.ok(tools.tools.some(t=>t.name==="node_metrics"));
  assert.equal((await call(laptop.client,"job_start",{node:"node-b",cwd:dir,command:"echo forbidden"})).isError,true);
  const a=value(await call(laptop.client,"job_start",{cwd:dir,command:"echo default-node"})); assert.equal(a.node,"node-a");
  const b=value(await call(byk.client,"job_start",{cwd:dir,command:"echo other-node"}));
  for(const name of ["job_status","job_logs","job_cancel"]) assert.equal((await call(laptop.client,name,{job_id:b.job_id})).isError,true);
  assert.ok(value(await call(laptop.client,"job_list")).every((t:any)=>t.node==="node-a"));
  const refresh=await post("/token",{grant_type:"refresh_token",client_id:laptop.info.client_id,refresh_token:laptop.tokens.refresh_token,resource:origin+"/mcp/byk"});
  assert.equal(refresh.status,400);
  const wrongAudience=await fetch(origin+"/mcp/byk",{headers:{Authorization:"Bearer "+laptop.tokens.access_token}}); assert.equal(wrongAudience.status,401);
  const borrowedSession=await fetch(origin+"/mcp/byk",{method:"POST",headers:{Authorization:"Bearer "+byk.tokens.access_token,"mcp-session-id":laptop.transport.sessionId!,"Content-Type":"application/json",Accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:5,method:"tools/list",params:{}})});
  assert.equal(borrowedSession.status,403);
  console.log("PASS public OAuth metadata, exact resource binding, refresh/code audience isolation, session isolation and cross-node job/file access guards");
} finally {
  for(const client of clients) await client.close();
  await running.close();
  await new Promise<void>((r,j)=>http.close(e=>e?j(e):r()));
}
