// =========================================================
// 家計簿：記録の追加・編集・削除と、履歴・入力候補の取得
// =========================================================
const SHEET_FINANCE = "家計簿";

// ---- 入力候補（登録済みのカテゴリとタグ、タグごとの件数）----
function getFinanceOptions() {
  const values = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_FINANCE).getDataRange().getValues();
  const headers = values[0];
  const idxCat = headers.indexOf("category");
  const idxTags = headers.indexOf("tags");
  const categories = new Set();
  const tagCounts = {};
  values.slice(1).forEach(r => {
    const cat = String(r[idxCat]).trim();
    if (cat) categories.add(cat);
    splitTags(r[idxTags]).forEach(t => tagCounts[t] = (tagCounts[t] || 0) + 1);
  });
  return { categories: [...categories], tags: Object.keys(tagCounts), tagCounts: tagCounts };
}

// ---- 履歴 ----
// 記録を新しい順に offset 件目から limit 件返す（履歴表示・タグ一括付与の対象選択用）
// tags・mode でタグの絞り込み。monthTotals は（絞り込み後の）全記録の月別合計（キーは日本時間の "yyyy-MM"）
function getFinanceRows(p) {
  const values = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_FINANCE).getDataRange().getValues();
  const headers = values[0];
  const offset = Number(p.offset) || 0;
  const limit = Number(p.limit) || 30;
  let rows = values.slice(1)
    .map((r, i) => {
      const obj = { row: i + 2 }; // シート上の行番号
      headers.forEach((h, j) => obj[h] = r[j] instanceof Date ? r[j].toISOString() : r[j]);
      return obj;
    })
    .filter(r => r.date !== "");
  // タグで絞り込む（tags は「,」区切り。mode=all ならすべて含む記録、それ以外はいずれかを含む記録）
  const filterTags = splitTags(p.tags || "");
  if (filterTags.length) {
    const all = p.mode === "all";
    rows = rows.filter(r => {
      const t = splitTags(r.tags);
      return all ? filterTags.every(x => t.includes(x)) : filterTags.some(x => t.includes(x));
    });
  }
  // 支出した日（日本時間）の新しい順。同じ日は登録時刻の新しい順
  const day = r => Utilities.formatDate(new Date(r.date), "Asia/Tokyo", "yyyy-MM-dd");
  rows.forEach(r => { r.day = day(r); });
  rows.sort((a, b) => b.day.localeCompare(a.day)
    || String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date))
    || b.row - a.row);
  const monthTotals = {};
  rows.forEach(r => {
    const key = r.day.slice(0, 7);
    monthTotals[key] = (monthTotals[key] || 0) + (Number(r.amount) || 0);
  });
  return { rows: rows.slice(offset, offset + limit), total: rows.length, monthTotals: monthTotals };
}

// ---- 記録の日付 ----
// date は支出した日（入力した日にち）、createdAt はアプリで登録した時刻
// createdAt 列がなければ末尾に追加し、既存の記録には date の値（これまでは登録時刻が入っていた）を写す
function ensureFinanceCreatedAt(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  if (headers.indexOf("createdAt") !== -1) return;
  const col = headers.length + 1;
  const idxDate = headers.indexOf("date");
  sheet.getRange(1, col).setValue("createdAt");
  if (values.length > 1) {
    sheet.getRange(2, col, values.length - 1, 1).setValues(values.slice(1).map(r => [r[idxDate]]));
  }
}

// "yyyy-MM-dd" を日本時間のその日の0時にする。未指定なら今日
function financeDate(str) {
  if (!str) str = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) throw new Error("日付が不正です: " + str);
  return Utilities.parseDate(str, "Asia/Tokyo", "yyyy-MM-dd");
}

// ---- 家計簿タブへの行追加 ----
function addFinance(ss, data) {
  const sheet = ss.getSheetByName(SHEET_FINANCE);
  ensureFinanceCreatedAt(sheet);
  const headers = sheet.getDataRange().getValues()[0];

  const col = {
    date: headers.indexOf("date"),
    category: headers.indexOf("category"),
    amount: headers.indexOf("amount"),
    memo: headers.indexOf("memo"),
    tags: headers.indexOf("tags"),
    createdAt: headers.indexOf("createdAt"),
  };

  const newRow = new Array(headers.length).fill("");
  newRow[col.date] = financeDate(data.date);
  newRow[col.category] = data.category || "";
  newRow[col.amount] = Number(data.amount) || 0;
  newRow[col.memo] = data.memo || "";
  newRow[col.tags] = data.tags || "";
  newRow[col.createdAt] = new Date();
  sheet.appendRow(newRow);
}

// ---- 家計簿の記録を特定 ----
// 行番号で指定し、一覧取得後にシートが変わっていないか date と createdAt で確認する
function findFinanceRow(sheet, data) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const iso = v => v instanceof Date ? v.toISOString() : String(v === undefined ? "" : v);
  const r = values[Number(data.row) - 1];
  const idxCreated = headers.indexOf("createdAt");
  if (!r || Number(data.row) < 2
    || iso(r[headers.indexOf("date")]) !== String(data.date || "")
    || (idxCreated !== -1 && iso(r[idxCreated]) !== String(data.createdAt || ""))) {
    throw new Error("家計簿のデータが変更されています。一覧を読み込み直してください。");
  }
  return { headers: headers, row: r.slice() };
}

// ---- 家計簿の記録を削除 ----
function deleteFinance(ss, data) {
  const sheet = ss.getSheetByName(SHEET_FINANCE);
  findFinanceRow(sheet, data);
  sheet.deleteRow(Number(data.row));
}

// ---- 家計簿の記録を編集（日付・カテゴリ・金額・メモ・タグを上書き。createdAt は変えない）----
// data.values に新しい値を入れる
function editFinance(ss, data) {
  const sheet = ss.getSheetByName(SHEET_FINANCE);
  const found = findFinanceRow(sheet, data);
  const col = name => found.headers.indexOf(name);
  const v = data.values || {};
  const amount = Number(v.amount);
  if (!String(v.category || "").trim()) throw new Error("カテゴリが空です。");
  if (!amount) throw new Error("金額が不正です。");
  const row = found.row;
  row[col("date")] = financeDate(v.date);
  row[col("category")] = String(v.category).trim();
  row[col("amount")] = amount;
  row[col("memo")] = v.memo || "";
  row[col("tags")] = v.tags || "";
  sheet.getRange(Number(data.row), 1, 1, row.length).setValues([row]);
}
