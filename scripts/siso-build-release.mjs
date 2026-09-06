// Build only a clean committed source state; artifact paths contain no node credentials/configuration.
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {resolve,join} from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
const out=resolve(process.argv[2]??"releases");
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:"utf8",env:{...process.env,COPYFILE_DISABLE:"1"},maxBuffer:32*1024*1024});if(r.status!==0)throw Error((r.stderr||r.stdout).slice(-3000));return r.stdout.trim();};
if(run("git",["status","--porcelain","--untracked-files=no"]))throw Error("Commit tracked source changes before building a release");
const commit=run("git",["rev-parse","HEAD"]);
run("npm",["run","typecheck"]);run("npm",["test"]);run("bash",["scripts/test-siso-fleet.sh"]);run("npm",["run","build"]);
if(run("git",["status","--porcelain","--untracked-files=no"]))throw Error("Build changed tracked source");
mkdirSync(out,{recursive:true});
const artifact=join(out,`siso-workspace-${commit.slice(0,12)}.tar.gz`);
run("tar",["-czf",artifact,"dist","scripts/siso-node.py","scripts/fix-node-pty-permissions.mjs","SKILL.md","package.json","package-lock.json"]);
const manifest={commit,artifact,sha256:createHash("sha256").update(readFileSync(artifact)).digest("hex"),bytes:readFileSync(artifact).length};
writeFileSync(artifact+".json",JSON.stringify(manifest,null,2)+"\n");console.log(JSON.stringify(manifest));
