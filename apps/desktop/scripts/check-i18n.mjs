#!/usr/bin/env node
/**
 * i18n 自检：七个语言包的 key 集合必须与基准语言（zh-CN）完全一致。
 * 用法：node scripts/check-i18n.mjs（在 apps/desktop 下执行；CI/验收可直接跑）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LOCALES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/renderer/src/i18n/locales',
);
const BASE = 'zh-CN';
const LOCALES = ['zh-CN', 'en', 'ja', 'ko', 'es', 'de', 'fr'];

function flatten(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') keys.push(...flatten(v, `${prefix}${k}.`));
    else keys.push(`${prefix}${k}`);
  }
  return keys;
}

const keySets = {};
for (const locale of LOCALES) {
  const file = path.join(LOCALES_DIR, `${locale}.json`);
  try {
    keySets[locale] = new Set(flatten(JSON.parse(readFileSync(file, 'utf8'))));
  } catch (err) {
    console.error(`✗ ${locale}.json 解析失败: ${err.message}`);
    process.exit(1);
  }
}

const baseKeys = [...keySets[BASE]];
console.log(`基准语言 ${BASE}: ${baseKeys.length} 个 key`);

let failed = false;
for (const locale of LOCALES) {
  const missing = baseKeys.filter((k) => !keySets[locale].has(k));
  const extra = [...keySets[locale]].filter((k) => !keySets[BASE].has(k));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`✗ ${locale}: 缺失 ${missing.length} 个，多出 ${extra.length} 个`);
    for (const k of missing) console.error(`    - 缺失: ${k}`);
    for (const k of extra) console.error(`    + 多出: ${k}`);
  } else {
    console.log(`✓ ${locale}: ${keySets[locale].size} 个 key，与基准一致`);
  }
}

process.exit(failed ? 1 : 0);
