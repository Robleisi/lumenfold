/**
 * Windows 安装包构建：先打到 %TEMP%，再把 Setup.exe 拷回 out-installer，
 * 避免项目目录被 Defender / 正在运行的解包版锁住 app.asar 导致 EBUSY。
 */
import { spawnSync } from "child_process";
import { mkdirSync, copyFileSync, rmSync, readdirSync, statSync, renameSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempOut = join(tmpdir(), `lumenfold-installer-out-${process.pid}`);
const finalOut = join(root, "out-installer");

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryRm(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(err?.code)) throw err;
      sleep(350 * (attempt + 1));
    }
  }
  return false;
}

/** 清掉旧产物；锁住的 win-unpacked 挪到 TEMP，不阻断打包 */
function prepareFinalOut() {
  mkdirSync(finalOut, { recursive: true });
  for (const name of readdirSync(finalOut)) {
    const full = join(finalOut, name);
    if (tryRm(full)) continue;
    const trash = join(tmpdir(), `lumenfold-locked-${name}-${Date.now()}`);
    try {
      renameSync(full, trash);
      console.warn(`[build] ${name} 被占用，已挪到 ${trash}`);
    } catch (err) {
      console.warn(`[build] 跳过占用中的 ${name}: ${err.message}`);
    }
  }
}

rmSync(tempOut, { recursive: true, force: true });
mkdirSync(tempOut, { recursive: true });

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

console.log("[build] 若失败且提示 EBUSY：请先关掉正在运行的「折光织界」或 out-installer\\win-unpacked。");

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["electron-builder", "--win", "nsis", `--config.directories.output=${tempOut}`, "--publish", "never"],
  { cwd: root, env, stdio: "inherit", shell: true },
);

if (result.status !== 0) {
  process.exit(result.status || 1);
}

prepareFinalOut();

let copiedSetup = null;
for (const name of readdirSync(tempOut)) {
  const src = join(tempOut, name);
  if (statSync(src).isDirectory()) continue;
  if (name.endsWith(".exe") && name.includes("Setup")) {
    copyFileSync(src, join(finalOut, name));
    copiedSetup = name;
  } else if (/\.(yml|yaml|blockmap)$/i.test(name)) {
    copyFileSync(src, join(finalOut, name));
  }
}

tryRm(tempOut);

if (!copiedSetup) {
  console.error("未找到 Setup.exe，请检查 electron-builder 输出");
  process.exit(1);
}

console.log(`\n安装包已生成: ${join(finalOut, copiedSetup)}`);
