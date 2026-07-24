// 商店提交打包：build → 版本对齐校验 → dist/ 打成 release/pinslip-extension-<version>.zip。
// 零新依赖：zip 用 node:zlib 手写（store/deflate + 中央目录），条目路径以 dist 为根，
// 即 manifest.json 位于 zip 根（商店要求），不含 dist/ 前缀。
import { deflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// --target chrome（默认）/ firefox：决定 manifest 来源、dist 目录与产物文件名
const target = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : 'chrome';
if (!['chrome', 'firefox'].includes(target)) {
  console.error(`未知 target: ${target}（可选 chrome / firefox）`);
  process.exit(1);
}
const distName = target === 'firefox' ? 'dist-firefox' : 'dist';
const manifestName = target === 'firefox' ? 'manifest.firefox.json' : 'manifest.json';

// ---------- 版本对齐校验（manifest 必须与 package.json 一致，商店按 manifest 判定版本） ----------
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const srcManifest = JSON.parse(
  fs.readFileSync(path.join(root, 'public', manifestName), 'utf8'),
);
if (srcManifest.version !== pkg.version) {
  console.error(
    `版本不一致：package.json=${pkg.version}，${manifestName}=${srcManifest.version}。请先对齐再打包。`,
  );
  process.exit(1);
}

// ---------- 1) 先跑现有构建 ----------
const r = spawnSync(process.execPath, [path.join(root, 'build.mjs'), '--target', target], {
  stdio: 'inherit',
});
if (r.status !== 0) process.exit(r.status ?? 1);

const dist = path.join(root, distName);
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(
    `${distName}/manifest.json 版本 ${manifest.version} 与 package.json ${pkg.version} 不一致`,
  );
  process.exit(1);
}

// ---------- 2) 收集文件（相对 dist 的 POSIX 路径） ----------
function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, rel, out);
    else out.push({ full, rel, mtime: st.mtime });
  }
}
const files = [];
walk(dist, '', files);
if (!files.some((f) => f.rel === 'manifest.json')) {
  console.error(`${distName}/ 缺 manifest.json，构建产物不完整`);
  process.exit(1);
}

// ---------- 3) 手写 zip（deflate 压缩） ----------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
// DOS 时间戳（zip 原生格式；mtime 超出 1980–2107 时收敛到 2024-01-01）
function dosDateTime(d) {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const chunks = [];
const central = [];
let offset = 0;

for (const f of files) {
  const data = fs.readFileSync(f.full);
  const nameBuf = Buffer.from(f.rel, 'utf8');
  const compressed = deflateRawSync(data, { level: 9 });
  // 压缩无收益时存原文（png 等已压缩格式）
  const useDeflate = compressed.length < data.length;
  const payload = useDeflate ? compressed : data;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(data);
  const { time, date } = dosDateTime(f.mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, payload);

  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(method, 10);
  head.writeUInt16LE(time, 12);
  head.writeUInt16LE(date, 14);
  head.writeUInt32LE(crc, 16);
  head.writeUInt32LE(payload.length, 20);
  head.writeUInt32LE(data.length, 24);
  head.writeUInt16LE(nameBuf.length, 28);
  head.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([head, nameBuf]));

  offset += local.length + nameBuf.length + payload.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);

const releaseDir = path.join(root, 'release');
fs.mkdirSync(releaseDir, { recursive: true });
const zipName =
  target === 'firefox'
    ? `pinslip-extension-firefox-${pkg.version}.zip`
    : `pinslip-extension-${pkg.version}.zip`;
const out = path.join(releaseDir, zipName);
fs.writeFileSync(out, Buffer.concat([...chunks, centralBuf, eocd]));

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`打包完成: ${path.relative(root, out)}（${files.length} 个文件，${kb} KB）`);
