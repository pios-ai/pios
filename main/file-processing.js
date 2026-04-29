// Drop-paste 文件解析能力。提取自 tab-manager.js。
// 支持 image / text / pdf / excel / word，统一通过 extractFileContent 出口。

const path = require('path');
const fs = require('fs');

const IMAGE_EXT = new Set(['png','jpg','jpeg','gif','webp','svg']);
const TEXT_EXT = new Set(['txt','md','js','ts','jsx','tsx','py','go','java','c','cpp','h','css','html','json','yaml','yml','sh','rb','rs','kt','swift','toml','ini','env','csv','xml','log','conf','cfg','properties','gradle','makefile','dockerfile','gitignore','editorconfig','babelrc','eslintrc']);
const EXCEL_EXT = new Set(['xlsx','xls','xlsm','ods','numbers','csv']);
const WORD_EXT = new Set(['docx','doc']);

function parseExcelBuffer(buffer) {
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const parts = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      if (csv.trim()) parts.push(`[Sheet: ${sheetName}]\n${csv}`);
    }
    return parts.join('\n\n').substring(0, 60000) || null;
  } catch (e) {
    console.warn('[xlsx] parse failed:', e.message);
    return null;
  }
}

async function parseWordBuffer(buffer) {
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value ? result.value.substring(0, 60000) : null;
  } catch (e) {
    console.warn('[mammoth] parse failed:', e.message);
    return null;
  }
}

async function parsePDFBuffer(buffer) {
  return new Promise((resolve) => {
    try {
      const PDFParser = require('pdf2json');
      const parser = new PDFParser(null, 1);
      parser.on('pdfParser_dataReady', () => {
        try {
          const text = parser.getRawTextContent();
          resolve(text ? text.substring(0, 60000) : null);
        } catch { resolve(null); }
      });
      parser.on('pdfParser_dataError', (e) => {
        console.warn('[pdf2json] error:', e.parserError);
        resolve(null);
      });
      parser.parseBuffer(buffer);
    } catch (e) {
      console.warn('[pdf2json] load failed:', e.message);
      resolve(null);
    }
  });
}

// 统一内容提取：给定 ext + buffer，返回 { isImage, isPDF, content, base64 }
async function extractFileContent(ext, buf, size) {
  const isImage = IMAGE_EXT.has(ext);
  const isPDF = ext === 'pdf';
  const isExcel = EXCEL_EXT.has(ext) && ext !== 'csv';
  const isWord = WORD_EXT.has(ext);
  const isText = TEXT_EXT.has(ext);
  let content = null, base64 = null;
  if (isImage) {
    base64 = buf.toString('base64');
  } else if (isPDF) {
    content = await parsePDFBuffer(buf);
  } else if (isExcel) {
    content = parseExcelBuffer(buf);
  } else if (isWord) {
    content = await parseWordBuffer(buf);
  } else if (isText && size < 500 * 1024) {
    content = buf.toString('utf-8');
  }
  return { isImage, isPDF, isExcel, isWord, content, base64 };
}

async function processFilePathsAsync(filePaths) {
  const results = [];
  for (const fp of filePaths) {
    const name = path.basename(fp);
    const ext = path.extname(fp).slice(1).toLowerCase();
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }
    try {
      const buf = fs.readFileSync(fp);
      const extracted = await extractFileContent(ext, buf, stat.size);
      results.push({ name, ext, size: stat.size, filePath: fp, ...extracted });
    } catch { continue; }
  }
  return results;
}

function processFilePaths(filePaths) {
  return filePaths.map(fp => {
    const name = path.basename(fp);
    const ext = path.extname(fp).slice(1).toLowerCase();
    let stat;
    try { stat = fs.statSync(fp); } catch { return null; }
    const isImage = IMAGE_EXT.has(ext);
    const isText = TEXT_EXT.has(ext);
    let content = null, base64 = null;
    if (isImage) {
      try { base64 = fs.readFileSync(fp).toString('base64'); } catch {}
    } else if (isText && stat.size < 500 * 1024) {
      try { content = fs.readFileSync(fp, 'utf-8'); } catch { content = null; }
    }
    return { name, ext, size: stat.size, content, isImage, isPDF: ext === 'pdf', base64, filePath: fp };
  }).filter(Boolean);
}

module.exports = {
  IMAGE_EXT, TEXT_EXT, EXCEL_EXT, WORD_EXT,
  parseExcelBuffer, parseWordBuffer, parsePDFBuffer,
  extractFileContent, processFilePathsAsync, processFilePaths,
};
