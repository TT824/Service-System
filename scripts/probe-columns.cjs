/* eslint-disable @typescript-eslint/no-require-imports -- 一次性诊断脚本（CommonJS 入口）。 */

/**
 * 一次性探针：数一份大 xlsx 里两列的去重值（款式编码 / 商品编码）。
 *
 * 目的是给「一个上传进来的是几个商品、几个规格」一个**实数**，而不是从几十行样例里外推。
 * 47 MB 的 sheet XML 不整份读进内存：按块流式扫，块尾留一段搭桥，避免把标签切断。
 *
 * 用法：node scripts/probe-columns.cjs <解压目录> <工作表> <列字母...>
 */
const fs = require('node:fs');
const path = require('node:path');

const CHUNK = 8 * 1024 * 1024;
const CARRY = 4096;

function decode(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/_x000D_/g, ' ')
    .replace(/_x000A_/g, ' ');
}

function main() {
  const dir = process.argv[2];
  const sheet = process.argv[3];
  const letters = process.argv.slice(4);
  const file = path.join(dir, 'xl', 'worksheets', `${sheet}.xml`);

  const seen = new Map(letters.map((letter) => [letter, new Set()]));
  const pattern = new RegExp(`<c r="([${letters.join('')}])(\\d+)"([^>]*)>([\\s\\S]*?)</c>`, 'g');

  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(CHUNK);
  let carry = '';
  let bytesRead = 0;
  for (;;) {
    const read = fs.readSync(descriptor, buffer, 0, CHUNK, null);
    if (read === 0) break;
    bytesRead += read;
    const text = carry + buffer.subarray(0, read).toString('utf8');
    carry = text.slice(-CARRY);
    const head = text.slice(0, text.length - CARRY);
    for (const match of head.matchAll(pattern)) {
      const [, letter, , attributes, body] = match;
      const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
      const raw = inline !== undefined ? decode(inline) : '';
      if (attributes.includes('t="s"')) continue;
      const value = raw.trim();
      if (value.length > 0) seen.get(letter).add(value);
    }
  }
  fs.closeSync(descriptor);

  console.log(`读了 ${(bytesRead / 1024 / 1024).toFixed(1)} MB`);
  for (const [letter, values] of seen) {
    console.log(`  列 ${letter}: 去重 ${values.size}`);
    console.log(`    样例 ${JSON.stringify([...values].slice(0, 5))}`);
  }
}

main();
