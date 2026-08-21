/**
 * Windows 安装包构建：先打到 %TEMP%，再拷回 out-installer，
 * 避免项目目录被 Defender 锁文件导致 electron-builder rename EPERM。
 */
import { spawnSync } from "child_process";
import { mkdirSync, copyFileSync, rmSync, existsSync, readdirSync, statSync, cpSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempOut = join(tmpdir(), `lumenfold-installer-out-${process.pid}`);
const finalOut = join(root, "out-installer");

rmSync(tempOut, { recursive: true, force: true });
mkdirSync(tempOut, { recursive: true });

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["electron-builder", "--win", "nsis", `--config.directories.output=${tempOut}`, "--publish", "never"],
  { cwd: root, env, stdio: "inherit", shell: true },
);

if (result.status !== 0) {
  process.exit(result.status || 1);
}

rmSync(finalOut, { recursive: true, force: true });
mkdirSync(finalOut, { recursive: true });

for (const name of readdirSync(tempOut)) {
  const src = join(tempOut, name);
  const dest = join(finalOut, name);
  if (statSync(src).isDirectory()) {
    cpSync(src, dest, { recursive: true });
  } else {
    copyFileSync(src, dest);
  }
}

rmSync(tempOut, { recursive: true, force: true });

const setup = readdirSync(finalOut).find((n) => n.endsWith(".exe") && n.includes("Setup"));
console.log(`\n安装包已生成: ${setup ? join(finalOut, setup) : finalOut}`);
