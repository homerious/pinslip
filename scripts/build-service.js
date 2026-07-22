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

if (process.env.PINSLIP_MAC_UNIVERSAL === '1') {
  // mac 单腿双架构：分别交叉编译 arm64/amd64（纯 Go 无 CGO），
  // 再用 mac runner 自带 lipo 合成 universal 二进制——
  // 一条 CI 腿产出双 dmg + 单份 latest-mac.yml，避免两腿互相覆盖更新元信息
  const armOut = path.join(serviceDir, 'bin', 'pinslipd-arm64');
  const x64Out = path.join(serviceDir, 'bin', 'pinslipd-amd64');
  for (const [arch, out] of [
    ['arm64', armOut],
    ['amd64', x64Out],
  ]) {
    console.log(`[build-service] cross-compiling darwin/${arch}…`);
    const r = spawnSync(goBin, ['build', '-o', out, './cmd/pinslipd'], {
      cwd: serviceDir,
      stdio: 'inherit',
      env: { ...process.env, GOOS: 'darwin', GOARCH: arch, CGO_ENABLED: '0' },
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  const lipo = spawnSync('lipo', ['-create', '-output', binOut, armOut, x64Out], {
    stdio: 'inherit',
  });
  if (lipo.status !== 0) process.exit(lipo.status ?? 1);
  console.log('[build-service] universal pinslipd (arm64+amd64) ok');
} else {
  const result = spawnSync(goBin, ['build', '-o', binOut, './cmd/pinslipd'], {
    cwd: serviceDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

mkdirSync(resDir, { recursive: true });
copyFileSync(binOut, path.join(resDir, outName));
console.log(`[build-service] ok → ${path.join(resDir, outName)}`);
