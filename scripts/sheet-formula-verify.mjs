import assert from 'node:assert/strict';
import XLSX from 'xlsx-js-style';

import { convertLakeSheet } from '../src/core/sheet-converter.js';

const cachedValue = '订单编号 (tid)';
const formula = "'字段定义'!$A2";
const fallbackFormula = "'字段定义'!$B2";
const formulaJsonMarker = '"class":"formula"';

const lakesheet = JSON.stringify({
  sheet: [
    {
      name: '字段定义',
      data: {
        0: { 0: { v: '字段' } },
        1: { 0: { v: cachedValue }, 1: { v: '备用字段' } },
      },
      vStore: { style: [], style_color: [], style_backColor: [] },
    },
    {
      name: '淘宝',
      data: {
        0: { 0: { v: '引用字段' } },
        1: {
          0: {
            v: {
              class: 'formula',
              formula,
              sources: [[1, 0, 1, 1, 0]],
              value: cachedValue,
              error: false,
              useCache: true,
            },
            s: 0,
          },
          1: {
            v: {
              class: 'formula',
              formula: `=${fallbackFormula}`,
            },
          },
        },
      },
      vStore: {
        style: ['z11w7h1'],
        style_color: [],
        style_backColor: [],
      },
    },
  ],
});

const xlsx = convertLakeSheet(lakesheet, 'xlsx');
const xlsxBytes = await xlsx.blob.arrayBuffer();
const workbook = XLSX.read(xlsxBytes, {
  type: 'array',
  cellStyles: true,
  bookFiles: true,
});
const formulaCell = workbook.Sheets['淘宝'].A2;
const fallbackFormulaCell = workbook.Sheets['淘宝'].B2;
const sheetXml = new TextDecoder().decode(workbook.files['xl/worksheets/sheet2.xml'].content);

assert.equal(formulaCell.f, formula, '淘宝 A2 应导出为真正的 Excel 公式');
assert.equal(formulaCell.v, cachedValue, '淘宝 A2 应保留语雀缓存值');
assert.equal(formulaCell.t, 's', '淘宝 A2 应按缓存值设置字符串类型');
assert.match(sheetXml, /<c r="A2" s="[1-9]\d*" t="str"><f>/, '淘宝 A2 应保留原有样式引用');
assert.equal(fallbackFormulaCell.f, fallbackFormula, 'XLSX 公式 f 不应保留开头的 =');

for (const format of ['csv', 'md', 'html']) {
  const result = convertLakeSheet(lakesheet, format);
  assert.ok(result.text.includes(cachedValue), `${format} 应使用公式缓存值`);
  assert.ok(result.text.includes(`=${fallbackFormula}`), `${format} 在缓存值缺失时应降级为公式文本`);
  assert.ok(!result.text.includes(formulaJsonMarker), `${format} 不应包含 formula JSON`);
}

console.log('Sheet formula export verification passed.');
