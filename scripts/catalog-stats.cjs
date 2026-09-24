/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */
/*
 * 商品资料工作簿统计（只读）：量一量「两级编码」与重复，别靠猜。
 *
 * 用法：node scripts/catalog-stats.cjs "C:/.../商品资料_1.xlsx" ...
 */
const path = require('node:path');
const ExcelJS = require('exceljs');

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map((part) => part.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    return JSON.stringify(value);
  }
  return String(value);
}

async function stats(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  const header = sheet.getRow(1);
  const column = {};
  header.eachCell({ includeEmpty: true }, (cell, index) => {
    column[text(cell.value).trim()] = index;
  });
  const style = column['款式编码'];
  const item = column['商品编码'];
  const name = column['商品名称'];
  const image = column['图片'];

  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    rows.push({
      style: text(row.getCell(style).value).trim(),
      item: text(row.getCell(item).value).trim(),
      name: text(row.getCell(name).value).trim(),
      image: text(row.getCell(image).value).trim(),
    });
  }
  const styles = new Set(rows.map((row) => row.style));
  const items = new Set(rows.map((row) => row.item));
  const same = rows.filter((row) => row.style === row.item).length;
  const blankStyle = rows.filter((row) => row.style === '').length;
  const withImage = rows.filter((row) => row.image !== '').length;
  const imagesPerStyle = new Map();
  for (const row of rows) {
    if (row.image === '') continue;
    const set = imagesPerStyle.get(row.style) ?? new Set();
    set.add(row.image);
    imagesPerStyle.set(row.style, set);
  }
  const multi = [...imagesPerStyle.values()].filter((set) => set.size > 1).length;
  console.log(
    JSON.stringify(
      {
        file: path.basename(file),
        dataRows: rows.length,
        distinctStyle: styles.size,
        distinctItem: items.size,
        rowsStyleEqualsItem: same,
        blankStyle,
        rowsWithImage: withImage,
        stylesWithImage: imagesPerStyle.size,
        stylesWithMoreThanOneImage: multi,
      },
      null,
      0,
    ),
  );
  return { styles, rows };
}

async function main() {
  const all = [];
  for (const file of process.argv.slice(2)) {
    all.push(await stats(file));
  }
  const first = all[0];
  if (first === undefined || all.length < 2) return;
  for (let i = 1; i < all.length; i += 1) {
    const other = all[i];
    const a = [...first.styles].filter((code) => other.styles.has(code)).length;
    console.log(`overlap(file1, file${i + 1}) = ${a}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
