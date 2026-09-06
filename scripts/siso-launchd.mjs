// Install only the two SISO services owned by this project; preserve all other jobs.
// Usage: node scripts/siso-launchd.mjs gateway|node NODE_ID PYTHON_PATH
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const [role, node, python] = process.argv.slice(2);
if (!["gateway","node"].includes(role) || !["mac-mini","macbook"].includes(node) || !python?.startsWith("/")) throw new Error("Invalid service arguments");
const source = process.env.SISO_RUNTIME_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)),"..");
const privateDir = join(homedir(),".siso-workspace");
const label = role === "gateway" ? "com.siso.workspace-gateway" : "com.siso.workspace-node";
const system = process.argv.includes("--system");
const target = system ? join(privateDir,label+".plist") : join(homedir(),"Library/LaunchAgents",label+".plist");
if (existsSync(target)) throw new Error("Service already exists; do not overwrite without backup/review");
mkdirSync(join(privateDir,"logs"),{recursive:true,mode:0o700});
const xml = s => s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const args = role === "gateway" ? [process.execPath,join(source,"dist/cli.js"),"serve"] : [python,join(source,"scripts/siso-node.py"),"--config",join(privateDir,node+".json")];
const env = {PATH:"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",HOME:homedir(),
  ...(role === "gateway" ? {DEVSPACE_CONFIG_DIR:privateDir,DEVSPACE_STATE_DIR:join(privateDir,"gateway-state"),SISO_FLEET_CONFIG:join(privateDir,"gateway.json"),DEVSPACE_TRUST_PROXY:"true",DEVSPACE_SKILLS:"0",DEVSPACE_LOG_REQUESTS:"0",DEVSPACE_LOG_TOOL_CALLS:"0"}:{})};
writeFileSync(target,`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
${system ? `<key>UserName</key><string>${xml(userInfo().username)}</string>` : ""}
<key>ProgramArguments</key><array>${args.map(s=>`<string>${xml(s)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(source)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v])=>`<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>AbandonProcessGroup</key><true/>
<key>StandardOutPath</key><string>${xml(join(privateDir,"logs",role+".log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(privateDir,"logs",role+".err.log"))}</string>
</dict></plist>\n`,{mode:0o600,flag:"wx"});
console.log(target);
