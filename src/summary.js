// 总表：把 index 条目的统计聚合成 summary.json / summary.csv

export const SUMMARY_COLUMNS = [
  'repo',
  'name',
  'namePlain',
  'author',
  'stars',
  'modType',
  'releaseCount',
  'tagCount',
  'totalDownloads',
  'allAssetsDownloads',
  'minGameVersion',
  'gameVersionRanges',
  'releaseUpdatedAt',
  'commitUpdatedAt',
  'iconUrl',
  'heatScore',
  'heatRank',
  'recommendVisible',
  'releasesPath',
];

function compareRows(left, right) {
  if (left.totalDownloads !== right.totalDownloads) {
    return right.totalDownloads - left.totalDownloads;
  }
  if (left.stars !== right.stars) {
    return right.stars - left.stars;
  }
  return left.repo < right.repo ? -1 : left.repo > right.repo ? 1 : 0;
}

export function buildSummary({ rows, generatedAt }) {
  const sorted = [...rows].sort(compareRows);
  const totals = {
    mods: sorted.length,
    releases: sorted.reduce((sum, row) => sum + (row.releaseCount ?? 0), 0),
    downloads: sorted.reduce((sum, row) => sum + (row.totalDownloads ?? 0), 0),
  };
  return {
    formatVersion: 1,
    generatedAt,
    totals,
    mods: sorted,
  };
}

// 数据主体比较：generatedAt 变化不算
export function summaryBodyChanged(previous, next) {
  if (!previous) {
    return true;
  }
  for (const field of ['formatVersion', 'totals', 'mods']) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) {
      return true;
    }
  }
  return false;
}

export function csvEscape(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const text = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

// summary.csv：与 summary.json 同列（不含 totals），UTF-8 BOM + CRLF，Excel 直接打开不乱码
export function summaryCsv(rows) {
  const lines = [SUMMARY_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(SUMMARY_COLUMNS.map((column) => csvEscape(row[column])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// 极简 CSV 解析（支持双引号包裹、字段内换行与 "" 转义），用于校验
export function parseCsv(text) {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function summaryCsvRows(rows) {
  return rows.map((row) => SUMMARY_COLUMNS.map((column) => csvEscape(row[column])));
}
