// One tested artifact, operator-owned machine inventory, rolling restarts. No URLs or secrets change.
// node scripts/siso-rollout.mjs ARTIFACT PRIVATE_INVENTORY [--apply]
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
const [input, inventoryFile]=process.argv.slice(2);
const artifact=resolve(input), inventory=JSON.parse(readFileSync(inventoryFile,"utf8"));
const sha=createHash("sha256").update(readFileSync(artifact)).digest("hex");
const installer=resolve(dirname(fileURLToPath(import.meta.url)),"siso-install-release.py");
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:"utf8",maxBuffer:8*1024*1024});if(r.status!==0)throw Error(`${cmd} failed: ${r.stderr?.slice(-1500)}`);return r.stdout.trim();};
for(const t of inventory.targets){
  if(!/^[a-z][a-z0-9-]*$/.test(t.id)||!t.expectedHost||!t.runtimeRoot?.startsWith("/")||!t.stagingDir?.startsWith("/")||!Array.isArray(t.restart))throw Error("Invalid private target inventory");
  console.log(JSON.stringify({target:t.id,role:t.role,sha256:sha,apply:process.argv.includes("--apply")}));
  if(!process.argv.includes("--apply"))continue;
  const execute=command=>t.ssh ? run("ssh",["-T","-o","RemoteCommand=none","-o","BatchMode=yes",t.ssh,command]) : run("/bin/sh",["-c",command]);
  if(execute("hostname")!==t.expectedHost)throw Error(`Host identity mismatch for ${t.id}`);
  execute(`mkdir -p ${quote(t.stagingDir)}`);
  const remoteArchive=t.stagingDir+"/"+sha+".tar.gz", remoteInstaller=t.stagingDir+"/siso-install-release.py";
  if(t.ssh){run("scp",["-o","RemoteCommand=none",artifact,t.ssh+":"+remoteArchive]);run("scp",["-o","RemoteCommand=none",installer,t.ssh+":"+remoteInstaller]);}
  const env=t.path ? `PATH=${quote(t.path)} ` : "";
  const installed=JSON.parse(execute(`${env}${quote(t.python)} ${quote(t.ssh?remoteInstaller:installer)} ${quote(t.ssh?remoteArchive:artifact)} ${sha} ${quote(t.runtimeRoot)} ${quote(t.role)}`));
  try {
    for(const cmd of t.restart)execute(cmd);
    for(const cmd of t.check ?? [])execute(cmd);
    console.log(JSON.stringify({target:t.id,status:"installed-and-service-checked",...installed}));
  } catch(error) {
    // Keep prior immutable releases so in-flight jobs can still import their original code.
    if(installed.previous){
      if(!/^releases\/[a-f0-9]{16}$/.test(installed.previous))throw Error("Unsafe rollback pointer");
      execute(`${quote(t.python)} -c ${quote('import os,sys; os.symlink(sys.argv[1],sys.argv[2]); os.replace(sys.argv[2],sys.argv[3])')} ${quote(installed.previous)} ${quote(t.runtimeRoot+"/rollback.new")} ${quote(t.runtimeRoot+"/current")}`);
      for(const cmd of t.restart)execute(cmd);
    }
    throw error;
  }
}
