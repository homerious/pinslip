// 开发入口：解析 Go 可执行文件路径，然后启动 electron-vite dev。
// Electron 主进程会自行拉起 Go 服务（见 apps/desktop/src/main/services/go-process.ts）。
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const desktopDir = path.join(__dirname, '..', 'apps', 'desktop');

/** 解析 go 可执行文件：PINSLIP_GO 环境变量 > 常见安装位置 > PATH */
function resolveGo() {
  if (process.env.PINSLIP_GO && existsSync(process.env.PINSLIP_GO)) {
    return process.env.PINSLIP_GO;
  }
  const candidates = [
    'D:\\Program Files\\Go\\bin\\go.exe', // 本机安装位置
    'C:\\Program Files\\Go\\bin\\go.exe',
    'C:\\Go\\bin\\go.exe',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'go'; // 退化为 PATH 查找
}

const goBin = resolveGo();
// electron-vite 的 exports 不暴露 bin 子路径，改为解析 package.json 后拼 bin 路径
const pkgJsonPath = require.resolve('electron-vite/package.json', { paths: [desktopDir] });
const viteBin = path.join(path.dirname(pkgJsonPath), 'bin', 'electron-vite.js');

console.log(`[dev] go binary: ${goBin}`);
const child = spawn(process.execPath, [viteBin, 'dev'], {
  cwd: desktopDir,
  stdio: 'inherit',
  env: { ...process.env, PINSLIP_GO: goBin },
});
child.on('exit', (code) => process.exit(code ?? 0));
