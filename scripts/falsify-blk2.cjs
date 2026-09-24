/* eslint-disable @typescript-eslint/no-require-imports, no-control-regex -- 一次性诊断脚本（CommonJS 入口）。 */

/**
 * 一次性驱动：注错二期的两条承重机制，看**具体哪条用例转红**。
 *
 * 1. 控制器不把 `mapping` 交给解析器 —— 用来证明「用 mapping 说清两层编码」那几条
 *    真的经过了 mapping，而不是恰好也读到 2 个商品；
 * 2. 服务层把 `warnings` 写成空数组 —— 用来证明「回执里写明已合成默认规格」
 *    真的由那条过滤产生，而不是空数组也能过。
 *
 * 每条注错跑完都从副本整份还原，因此两次注错互不叠加。
 */
const { execSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');

const SPEC = 'apps/api/test/knowledge-import-apply.e2e-spec.ts';
const CONTROLLER = 'apps/api/src/knowledge/knowledge.controller.ts';
const SERVICE = 'apps/api/src/knowledge/knowledge.service.ts';

const CLEAN = {
  [CONTROLLER]: readFileSync(CONTROLLER, 'utf8'),
  [SERVICE]: readFileSync(SERVICE, 'utf8'),
};

const INJECTIONS = [
  {
    name: '1 控制器丢掉 mapping',
    file: CONTROLLER,
    from: `    const parsed = await parseProductImportFile({
      format,
      content: file.buffer,
      ...(mapping === undefined ? {} : { columnMapping: mapping }),
    });`,
    to: `    const parsed = await parseProductImportFile({
      format,
      content: file.buffer,
    });`,
    expect: '映射那 4 条该红（含「写错列名」——它会从 400 变成 201）；坏 JSON 那条仍绿',
  },
  {
    name: '2 warnings 写成空数组',
    file: SERVICE,
    from: "warnings: input.parsed.issues.filter((issue) => issue.severity === 'warning'),",
    to: 'warnings: [],',
    expect: '只有两条断言 warnings 的用例转红',
  },
];

function strip(text) {
  return text.replace(/\[[0-9;]*m/g, '');
}

const restore = () => {
  for (const [file, text] of Object.entries(CLEAN)) writeFileSync(file, text);
};

for (const item of INJECTIONS) {
  restore();
  if (!CLEAN[item.file].includes(item.from)) {
    console.log(`\n### ${item.name}: 找不到注错点，跳过（脚本本身有问题）`);
    continue;
  }
  writeFileSync(item.file, CLEAN[item.file].replace(item.from, item.to));
  console.log(`\n### ${item.name}  —— 预期：${item.expect}`);

  let output = '';
  try {
    execSync(`npx vitest run --config vitest.interface.config.ts ${SPEC}`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    console.log('  全绿 —— 这个机制没有被任何用例钉住！');
    continue;
  } catch (error) {
    output = strip(`${error.stdout ?? ''}${error.stderr ?? ''}`);
  }

  const lines = output.split('\n');
  for (const line of lines) {
    if (!/^\s*×|^\s*FAIL/.test(line)) continue;
    console.log(`  ${line.trim()}`);
  }
  for (const line of lines) {
    if (/AssertionError/.test(line)) console.log(`      ${line.trim()}`);
  }
  const summary = lines.find((line) => line.includes('Tests '));
  if (summary) console.log(`  ${summary.trim()}`);
}

restore();
console.log('\n已从副本整份还原。');
