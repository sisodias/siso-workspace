// Operator-only enrollment. Never outputs credentials; preserves existing nodes and private config.
// gateway-dir node-id profile title roots-json node-state-dir [--disabled]
import {readFileSync,writeFileSync,copyFileSync,renameSync,existsSync} from "node:fs";
import {join,isAbsolute} from "node:path";
import {randomBytes} from "node:crypto";
const [dir,id,profile,title,rootsJson,stateDir]=process.argv.slice(2);
if(!dir || !/^[a-z][a-z0-9-]{0,40}$/.test(id) || !/^[a-z][a-z0-9-]{0,40}$/.test(profile) || !isAbsolute(stateDir)) throw Error("Invalid enrollment arguments");
const roots=JSON.parse(rootsJson); if(!Array.isArray(roots)||!roots.length||roots.some(r=>!isAbsolute(r)||r==="/")) throw Error("Explicit narrow roots required");
const file=join(dir,"gateway.json"), config=JSON.parse(readFileSync(file,"utf8"));
let node=config.nodes.find(n=>n.id===id);
if(node && JSON.stringify(node.roots)!==JSON.stringify(roots)) throw Error("Existing roots differ; explicit migration required");
if(!node){node={id,aliases:[],roots,token:randomBytes(32).toString("base64url")};config.nodes.push(node);}
if(process.argv.includes("--disabled")) node.enabled=false;
config.profiles ??={};
if(config.profiles[profile] && config.profiles[profile].node!==id) throw Error("Existing profile belongs to another node");
config.profiles[profile]={node:id,title};
const output=join(dir,id+".json");
if(!existsSync(output)) {
  const origin=JSON.parse(readFileSync(join(dir,"config.json"),"utf8")).publicBaseUrl;
  writeFileSync(output,JSON.stringify({node:id,token:node.token,roots,state_dir:stateDir,gateway:origin},null,2)+"\n",{mode:0o600,flag:"wx"});
}
copyFileSync(file,file+".backup-"+Date.now());
writeFileSync(file+".new",JSON.stringify(config,null,2)+"\n",{mode:0o600});renameSync(file+".new",file);
console.log(JSON.stringify({node:id,profile,enabled:node.enabled!==false,credential_file:output}));
