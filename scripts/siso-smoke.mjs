// Real OAuth/PKCE + MCP acceptance probe. Never prints credentials or bearer tokens.
// Usage: node scripts/siso-smoke.mjs ORIGIN OWNER_AUTH_JSON NODE ROOT [--restart-test]
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import dns from "node:dns";
import { spawnSync } from "node:child_process";

const [origin, authFile, node, root] = process.argv.slice(2);
const mcpPath = process.env.SISO_MCP_PATH ?? "/mcp";
const resource = origin + mcpPath;
// Optional public-DNS address bypasses a laptop's private MagicDNS route while
// retaining the original TLS hostname and certificate verification.
if (process.env.SISO_PUBLIC_IP) {
  const ip = process.env.SISO_PUBLIC_IP;
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
  const lookup = dns.lookup;
  dns.lookup = function(host, options, callback) {
    if (host !== new URL(origin).hostname) return lookup(host, options, callback);
    const cb = typeof options === "function" ? options : callback;
    if (typeof options === "object" && options.all) cb(null, [{address:ip,family:4}]);
    else cb(null, ip, 4);
  };
  console.log("PUBLIC_ROUTE", ip);
}
const ownerToken = JSON.parse(readFileSync(authFile)).ownerToken;
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const request = async (path, options) => fetch(origin + path, { ...options, signal: AbortSignal.timeout(20000) });
const unauth = await request(mcpPath);
assert.equal(unauth.status, 401);
assert.match(unauth.headers.get("www-authenticate"), /resource_metadata=/);
console.log("PASS unauthenticated MCP rejected");
const wrongNode = await request("/fleet/poll/" + node, { method: "POST", headers: {"Content-Type":"application/json"}, body:"{}" });
assert.equal(wrongNode.status, 401);
console.log("PASS unauthenticated node rejected");
const metadata = await (await request("/.well-known/oauth-authorization-server")).json();
assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
assert.equal(new URL(metadata.authorization_endpoint).origin, new URL(origin).origin);
const registration = await request("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
  client_name: "SISO recovery acceptance probe", redirect_uris: ["http://localhost:9876/callback"],
  grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
}) });
assert.equal(registration.status, 201);
const clientInfo = await registration.json();
const fields = { client_id: clientInfo.client_id, redirect_uri: "http://localhost:9876/callback", response_type: "code", scope: "devspace",
  resource, code_challenge: challenge, code_challenge_method: "S256", state: randomBytes(16).toString("hex") };
const denied = await request("/authorize", { method: "POST", headers: { "Content-Type":"application/x-www-form-urlencoded" }, body:new URLSearchParams({...fields,owner_token:"incorrect"}),redirect:"manual" });
assert.equal(denied.status,401);
const authorize = await request("/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, owner_token: ownerToken }), redirect: "manual" });
assert.equal(authorize.status, 302);
const callback = new URL(authorize.headers.get("location"));
assert.equal(callback.searchParams.get("state"), fields.state);
const tokenResponse = await request("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientInfo.client_id,
  redirect_uri: fields.redirect_uri, code: callback.searchParams.get("code"), code_verifier: verifier, resource }) });
assert.equal(tokenResponse.status, 200);
let tokens = await tokenResponse.json();
const refresh = await request("/token", {method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",client_id:clientInfo.client_id,refresh_token:tokens.refresh_token,resource})});
assert.equal(refresh.status,200);
tokens = await refresh.json();
console.log("PASS OAuth discovery, owner rejection/approval, PKCE code exchange and refresh");
let client = new Client({ name: "siso-recovery-probe", version: "1.0" });
const transport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: "Bearer " + tokens.access_token } } });
await client.connect(transport);
const listed = await client.listTools();
console.log("TOOLS", listed.tools.map(t => t.name).join(", "));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} MCP error`);
  return JSON.parse(r.content.find(c => c.type === "text").text);
};
const done = async task => {
  const deadline = Date.now() + 90000;
  while (["queued", "dispatched", "running"].includes(task.status) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 700));
    task = await call("job_status", { job_id: task.job_id });
  }
  assert.equal(task.status, "completed", JSON.stringify(task));
  return task.result;
};
try {
  const nodes = await call("nodes_list", {});
  console.log("NODES", JSON.stringify(nodes));
  assert.equal(nodes.find(n => n.node === node)?.online, true);
  if(mcpPath !== "/mcp") assert.equal(nodes.length,1);
  const guide=await call("workspace_help",{}); assert.match(guide.guide,/node_metrics/);
  const metrics=await done(await call("node_metrics",{node}));
  assert.equal(metrics.errors.length,0);
  assert.ok(metrics.memory.total_bytes>0 && metrics.cpu.utilization_percent>=0 && metrics.cpu.utilization_percent<=100);
  console.log("PASS live metrics",JSON.stringify(metrics));
  const ls = await done(await call("fs_list", {node,path:root}));
  assert.ok(ls.entries.includes("README.md"));
  const read = await done(await call("fs_read", {node,path:root+"/README.md",limit:256}));
  assert.ok(read.text.length>0);
  console.log("PASS list workspace and read README", JSON.stringify({entries:ls.entries.length,read_bytes:read.text.length}));
  const bad = await call("fs_read", {node,path:"/etc/passwd"});
  let b=bad; for(let i=0; i<30 && ["queued","dispatched","running"].includes(b.status);i++){await new Promise(r=>setTimeout(r,500));b=await call("job_status",{job_id:b.job_id});}
  assert.equal(b.status,"failed");
  console.log("PASS filesystem escape refused");
  const directory = root + "/.siso-connector-acceptance";
  const setup = await done(await call("shell_exec", {node,cwd:root,command:`mkdir -p '${directory}'; pwd; python3 -c 'print(17 * 19)'`,timeout_seconds:15}));
  assert.equal(setup.exit_code,0);
  assert.match(setup.stdout_tail,/323/);
  const file = directory + "/proof-" + randomBytes(8).toString("hex") + ".txt";
  await done(await call("fs_write",{node,path:file,text:"SISO fleet roundtrip\n"}));
  const back = await done(await call("fs_read",{node,path:file}));
  assert.equal(back.text,"SISO fleet roundtrip\n");
  const cleanup = await done(await call("shell_exec",{node,cwd:root,command:`unlink '${file}'`,timeout_seconds:10}));
  assert.equal(cleanup.exit_code,0);
  console.log("PASS shell pwd/Python=323 and file create/read/delete");
  const job = await call("job_start",{node,cwd:root,command:"python3 -u -c 'import time; print(\"job-start\", flush=True); time.sleep(3); print(sum(i*i for i in range(10000)))'",timeout_seconds:30});
  const result = await done(job);
  assert.equal(result.exit_code,0);
  const logs = await done(await call("job_logs",{job_id:job.job_id}));
  assert.match(logs.text,/333283335000/);
  console.log("PASS durable background job",JSON.stringify({job_id:job.job_id,exit_code:result.exit_code,stdout:logs.text}));
  const cancellation = await call("job_start",{node,cwd:root,command:"sleep 120",timeout_seconds:150});
  await new Promise(r=>setTimeout(r,2000));
  await call("job_cancel",{job_id:cancellation.job_id});
  let cancelled;
  for(let i=0;i<30;i++){cancelled=await call("job_status",{job_id:cancellation.job_id});if(cancelled.status==="cancelled")break;await new Promise(r=>setTimeout(r,500));}
  assert.equal(cancelled.status,"cancelled");
  console.log("PASS cancellation", cancellation.job_id);
  if(process.argv.includes("--restart-test")) {
    const j=await call("job_start",{node,cwd:root,command:"python3 -u -c 'import time; print(\"restart-before\",flush=True); time.sleep(35); print(\"restart-after\",flush=True)'",timeout_seconds:90});
    console.log("RESTART_JOB",j.job_id);
    await new Promise(r=>setTimeout(r,3000));
    const before=await call("job_status",{job_id:j.job_id});
    assert.equal(before.status,"running");
    await client.close();
    const restart=spawnSync("ssh",["-T","-o","RemoteCommand=none","mac-mini-ts","sudo -n launchctl kickstart -k system/com.siso.workspace-gateway && sudo -n launchctl kickstart -k system/com.siso.workspace-node"],{encoding:"utf8",timeout:20000});
    assert.equal(restart.status,0,restart.stderr);
    let connected=false;
    for(let i=0;i<20;i++){
      try {
        client=new Client({name:"siso-recovery-after-restart",version:"1.0"});
        await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:"Bearer "+tokens.access_token}}}));
        connected=true;break;
      } catch {await new Promise(r=>setTimeout(r,500));}
    }
    assert.ok(connected,"Reconnect after restart");
    const after=await done(await call("job_status",{job_id:j.job_id}));
    assert.equal(after.exit_code,0);
    assert.equal(after.pid,before.result.pid);
    const output=await done(await call("job_logs",{job_id:j.job_id}));
    assert.match(output.text,/restart-before\nrestart-after/);
    console.log("PASS gateway + node daemon restart, same detached child PID, persisted OAuth and logs",JSON.stringify({job_id:j.job_id,pid:after.pid,stdout:output.text}));
  }
} finally {
  await client.close();
  await request("/revoke",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:clientInfo.client_id,token:tokens.refresh_token,token_type_hint:"refresh_token"})});
  await request("/revoke",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:clientInfo.client_id,token:tokens.access_token,token_type_hint:"access_token"})});
}
