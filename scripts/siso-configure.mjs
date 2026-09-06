// Fresh installation only. Generates owner-private runtime configuration, never source secrets.
// Run on the gateway host: node scripts/siso-configure.mjs HTTPS_ORIGIN OWNER_AUTH_JSON
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const [origin, ownerFile] = process.argv.slice(2);
if (!origin?.startsWith("https://")) throw new Error("Explicit HTTPS origin required");
const home = homedir(), dir = join(home, ".siso-workspace"), root = join(home, "SISO_Workspace");
if (existsSync(join(dir, "gateway.json"))) throw new Error("Already configured; preserve existing enrollment");
mkdirSync(dir, {recursive:true,mode:0o700}); chmodSync(dir,0o700);
const put = (name, value) => writeFileSync(join(dir,name),JSON.stringify(value,null,2)+"\n",{mode:0o600,flag:"wx"});
const nodes = [
  {id:"mac-mini",aliases:["math-compute","primary-workspace"],roots:[root],token:randomBytes(32).toString("base64url")},
  {id:"macbook",aliases:[],roots:[root],token:randomBytes(32).toString("base64url")},
];
put("gateway.json",{nodes});
put("config.json",{host:"127.0.0.1",port:7676,allowedRoots:[root],publicBaseUrl:origin,toolMode:"minimal",widgets:"off",subagents:false});
put("auth.json",JSON.parse(readFileSync(ownerFile,"utf8")));
for (const n of nodes) put(n.id+".json",{node:n.id,token:n.token,roots:n.roots,state_dir:join(dir,"node-state"),gateway:n.id==="mac-mini"?"http://127.0.0.1:7676":origin});
console.log("Created private gateway and two node enrollment configurations; credentials not displayed.");
