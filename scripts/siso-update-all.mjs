// Explicit release promotion; not an unattended pull of arbitrary changes from a moving branch.
import {spawnSync} from "node:child_process";
if(!process.argv[2])throw Error("Usage: node scripts/siso-update-all.mjs PRIVATE_INVENTORY");
const built=spawnSync(process.execPath,["scripts/siso-build-release.mjs"],{encoding:"utf8",maxBuffer:4*1024*1024});
if(built.status!==0)throw Error(built.stderr||built.stdout);
const release=JSON.parse(built.stdout.trim());
console.log(JSON.stringify(release));
const rollout=spawnSync(process.execPath,["scripts/siso-rollout.mjs",release.artifact,process.argv[2],"--apply"],{stdio:"inherit"});
process.exitCode=rollout.status??1;
