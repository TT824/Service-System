/* eslint-disable @typescript-eslint/no-require-imports, no-control-regex -- 一次性诊断脚本（CommonJS 入口）。 */

/**
 * 一次性驱动：分别注错三条新机制，看**具体哪条用例转红、红在哪一行断言**。
 *
 * 「测试全绿」只说明断言成立，不说明用例名里写的那条路径真的跑了。三条注错各自
 * 对应一个机制；只看红不红还不够 —— 合成被摘掉与合成告警被摘掉都会让同一条用例变红，
 * 所以要连断言差异一起读，才能把红归到正确的机制上。
 *
 * 每条注错跑完都从 clean 副本整份还原，因此三次注错互不叠加。
 */
const { execSync } = require('node:child_process');
const { readFileSync, writeFileSync, copyFileSync } = require('node:fs');

const P = 'packages/core/src/platform/product-import-parser.ts';
const SPEC = 'packages/core/src/platform/product-import-parser.spec.ts';
const CLEAN = 'C:/tmp-parser-clean.ts';
const clean = readFileSync(P, 'utf8');
copyFileSync(P, CLEAN);

const INJECTIONS = [
  {
    name: '1 忽略显式映射',
    from: 'claimExplicitColumns(headers, columnMapping, issues)',
    to: 'claimExplicitColumns(headers, undefined, issues)',
    expect: '映射组：5 条转红；「without the mapping」那条仍绿（它不用映射）',
  },
  {
    name: '2 不合成规格',
    from: "mapping.has('sku_code') ? readRequiredText('sku_code') : productCode",
    to: "readRequiredText('sku_code')",
    expect:
      '依赖合成的 2 条转红（合成那条 + 真文件形状那条），红在 ok 那一行而不是 warningCount —— ' +
      '与下一条「告警反转」区分得开：那次会红在 warningCount 与多出来的 warning 上',
  },
  {
    name: '3 合成告警反转',
    from: "if (!analysis.mapping.has('sku_code')) {",
    to: "if (analysis.mapping.has('sku_code')) {",
    expect: '两条规格用例都红：合成那条红在 warningCount，空值那条红在多出来的 warning',
  },
];

function strip(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

for (const item of INJECTIONS) {
  writeFileSync(P, clean);
  if (!clean.includes(item.from)) {
    console.log(`\n### ${item.name}: 找不到注错点，跳过（脚本本身有问题）`);
    continue;
  }
  writeFileSync(P, clean.replace(item.from, item.to));
  console.log(`\n### ${item.name}  —— 预期：${item.expect}`);

  let output = '';
  try {
    execSync(`npx vitest run --config vitest.unit.config.ts ${SPEC}`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    console.log('  全绿 —— 这个机制没有被任何用例钉住！');
    continue;
  } catch (error) {
    output = strip(`${error.stdout ?? ''}${error.stderr ?? ''}`);
  }

  const lines = output.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/×|FAIL/.test(line)) continue;
    console.log(`  ${line.trim()}`);
    // 紧跟其后的断言差异才是「红在哪一行」。
    for (let next = index + 1; next < Math.min(index + 6, lines.length); next += 1) {
      const detail = lines[next].trim();
      if (/^AssertionError|^expected|^\s*[-+] |^→ /.test(detail)) console.log(`      ${detail}`);
      if (/^AssertionError/.test(detail)) break;
    }
  }
  const summary = lines.find((line) => line.includes('Tests '));
  if (summary) console.log(`  ${summary.trim()}`);
}

writeFileSync(P, clean);
console.log('\n已从 clean 副本整份还原。');
