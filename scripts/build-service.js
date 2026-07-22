// 编译 Go 服务 → apps/service/bin/，并拷贝到 apps/desktop/resources/service/
// （electron-builder 打包时作为 extraResources 携带，生产模式下主进程直接拉起二进制）
const { spawnSync } = require('node:child_process');
const { mkdirSync, copyFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const serviceDir = path.join(__dirname, '..', 'apps', 'service');
const outName = process.platform === 'win32' ? 'pinslipd.exe' : 'pinslipd';
const binOut = path.join(serviceDir, 'bin', outName);
const resDir = path.join(__dirname, '..', 'apps', 'desktop', 'resources', 'service');

function resolveGo() {
  if (process.env.PINSLIP_GO && existsSync(process.env.PINSLIP_GO)) {
    return process.env.PINSLIP_GO;
  }
  const candidates = [
    'D:\\Program Files\\Go\\bin\\go.exe',
    'C:\\Program Files\\Go\\bin\\go.exe',
    'C:\\Go\\bin\\go.exe',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'go';
}

const goBin = resolveGo();
console.log(`[build-service] go binary: ${goBin}`);

mkdirSync(path.dirname(binOut), { recursive: true });
const result = spawnSync(goBin, ['build', '-o', binOut, './cmd/pinslipd'], {
  cwd: serviceDir,
  stdio: 'inherit',
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

mkdirSync(resDir, { recursive: true });
copyFileSync(binOut, path.join(resDir, outName));
console.log(`[build-service] ok → ${path.join(resDir, outName)}`);
