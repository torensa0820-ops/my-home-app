// =========================================================
// 家計簿：記録の追加・編集・削除と、履歴・入力候補の取得
// =========================================================
const SHEET_FINANCE = "家計簿";

// ---- 入力候補（登録済みのカテゴリ・支払い方法・タグ、タグごとの件数）----
function getFinanceOptions() {
  const values = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_FINANCE).getDataRange().getValues();
  const headers = values[0];
  const idxCat = headers.indexOf("category");
  const idxPay = headers.indexOf("payment"); // 列がまだなければ -1
  const idxTags = headers.indexOf("tags");
  const categories = new Set();
  const payments = new Set();
  const tagCounts = {};
  values.slice(1).forEach(r => {
    const cat = String(r[idxCat]).trim();
    if (cat) categories.add(cat);
    const pay = idxPay === -1 ? "" : String(r[idxPay]).trim();
    if (pay) payments.add(pay);
    splitTags(r[idxTags]).forEach(t => tagCounts[t] = (tagCounts[t] || 0) + 1);
  });
  return { categories: [...categories], payments: [...payments], tags: Object.keys(tagCounts), tagCounts: tagCounts };
}

// ---- 履歴 ----
// 記録を新しい順に offset 件目から limit 件返す（limit="all" なら全件。履歴表示は全件を取得してアプリ側で絞り込む。タグ一括付与の対象選択は30件ずつ）
// tags・mode でタグ、categories（JSON の配列）でカテゴリの絞り込み（両方あれば両方を満たす記録）
// monthTotals は（絞り込み後の）全記録の月別合計（キーは日本時間の "yyyy-MM"）
function getFinanceRows(p) {
  const values = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_FINANCE).getDataRange().getValues();
  const headers = values[0];
  const offset = Number(p.offset) || 0;
  const limit = p.limit === "all" ? Infinity : Number(p.limit) || 30; // "all" なら全件
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
  // カテゴリで絞り込む（categories は JSON の配列。いずれかのカテゴリの記録）
  const filterCats = p.categories ? JSON.parse(p.categories).map(c => String(c).trim()) : [];
  if (filterCats.length) {
    rows = rows.filter(r => filterCats.includes(String(r.category).trim()));
  }
  // 支出した日（日本時間）の新しい順。同じ日は登録時刻の新しい順
  // 1回の会計を分けた行（同じ groupId）は行番号の昇順（メインのカテゴリが先）、それ以外は行番号の新しい順
  const day = r => Utilities.formatDate(new Date(r.date), "Asia/Tokyo", "yyyy-MM-dd");
  rows.forEach(r => { r.day = day(r); });
  rows.sort((a, b) => b.day.localeCompare(a.day)
    || String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date))
    || (a.groupId && a.groupId === b.groupId ? a.row - b.row : b.row - a.row));
  const monthTotals = {};
  rows.forEach(r => {
    const key = r.day.slice(0, 7);
    monthTotals[key] = (monthTotals[key] || 0) + (Number(r.amount) || 0);
  });
  return { rows: rows.slice(offset, offset + limit), total: rows.length, monthTotals: monthTotals };
}

// ---- 後から増えた列 ----
// date は支出した日（入力した日にち）、createdAt はアプリで登録した時刻
// payment は支払い方法、groupId は1回の会計をカテゴリごとに分けた行に共通の ID（分けていない記録は空）
// 列がなければ末尾に追加する。createdAt は既存の記録に date の値（これまでは登録時刻が入っていた）を写す
function ensureFinanceColumns(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idxDate = headers.indexOf("date");
  const extra = [
    { name: "createdAt", fill: r => r[idxDate] },
    { name: "payment" },
    { name: "groupId" },
  ];
  let col = headers.length;
  extra.forEach(c => {
    if (headers.indexOf(c.name) !== -1) return;
    col++;
    sheet.getRange(1, col).setValue(c.name);
    if (c.fill && values.length > 1) {
      sheet.getRange(2, col, values.length - 1, 1).setValues(values.slice(1).map(r => [c.fill(r)]));
    }
  });
}

// 内訳 [{category, amount}] を確かめて、カテゴリを正規化したものを返す
function financeItems(items) {
  return items.map(it => {
    const category = normText(it.category);
    const amount = Number(it.amount);
    if (!category) throw new Error("カテゴリが空です。");
    if (!(amount > 0)) throw new Error("金額が不正です: " + category);
    return { category: category, amount: amount };
  });
}

// "yyyy-MM-dd" を日本時間のその日の0時にする
function financeDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str || "")) throw new Error("日付が不正です: " + str);
  return Utilities.parseDate(str, "Asia/Tokyo", "yyyy-MM-dd");
}

// ---- 家計簿タブへの行追加 ----
// data.items = [{category, amount}, ...] が2件以上なら、1回の会計をカテゴリごとに分けた行として
// 同じ groupId・同じ createdAt で追加する（items がなければ data.category・data.amount の1件）
// date・memo・tags・payment は全行共通
function addFinance(ss, data) {
  const sheet = ss.getSheetByName(SHEET_FINANCE);
  ensureFinanceColumns(sheet);
  const items = financeItems(Array.isArray(data.items) && data.items.length
    ? data.items : [{ category: data.category, amount: data.amount }]);
  const groupId = items.length > 1 ? Utilities.getUuid() : "";
  const createdAt = new Date();
  const date = financeDate(data.date);
  appendFinanceRows(sheet, items.map(it => ({
    date: date, category: it.category, amount: it.amount, memo: normText(data.memo), tags: normTags(data.tags),
    payment: normText(data.payment), groupId: groupId, createdAt: createdAt,
  })));
}

// 「見出し名 → 値」のオブジェクトを、シートの末尾にまとめて追加する
function appendFinanceRows(sheet, objs) {
  if (!objs.length) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rows = objs.map(o => headers.map(h => o[h] === undefined ? "" : o[h]));
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
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
  return { headers: headers, row: r.slice(), values: values };
}

// ---- 家計簿の記録を削除 ----
function deleteFinance(ss, data) {
  const sheet = ss.getSheetByName(SHEET_FINANCE);
  findFinanceRow(sheet, data);
  sheet.deleteRow(Number(data.row));
}

// ---- 家計簿の記録を編集（日付・カテゴリ・金額・メモ・タグ・支払い方法を上書き。createdAt は変えない）----
// data.values に新しい値を入れる
// values.splits = [{category, amount}] があれば、この記録の金額を「values.amount − splits の合計」にし、
// splits を同じ groupId（なければ新しく作る）・同じ createdAt の行として追加する
// groupId がある記録の日付と支払い方法は、同じ groupId のほかの行にも反映する（カテゴリ・金額・メモ・タグは行ごと）
function editFinance(ss, data) {
  const sheet = ss.getSheetByName(SHEET_FINANCE);
  ensureFinanceColumns(sheet);
  const found = findFinanceRow(sheet, data);
  const col = name => found.headers.indexOf(name);
  const v = data.values || {};
  const amount = Number(v.amount);
  const category = normText(v.category);
  const memo = normText(v.memo);
  const tags = normTags(v.tags);
  if (!category) throw new Error("カテゴリが空です。");
  if (!amount) throw new Error("金額が不正です。");
  const splits = financeItems(Array.isArray(v.splits) ? v.splits : []);
  const mainAmount = amount - splits.reduce((sum, it) => sum + it.amount, 0);
  if (splits.length && mainAmount <= 0) throw new Error("内訳の合計が合計の金額以上です。");
  const row = found.row;
  const oldGroupId = String(row[col("groupId")] || "");
  const groupId = oldGroupId || (splits.length ? Utilities.getUuid() : "");
  const date = financeDate(v.date);
  const payment = normText(v.payment);
  row[col("date")] = date;
  row[col("category")] = category;
  row[col("amount")] = mainAmount;
  row[col("memo")] = memo;
  row[col("tags")] = tags;
  row[col("payment")] = payment;
  row[col("groupId")] = groupId;
  sheet.getRange(Number(data.row), 1, 1, row.length).setValues([row]);

  if (oldGroupId) {
    found.values.forEach((r, i) => {
      if (i === 0 || i + 1 === Number(data.row) || String(r[col("groupId")]) !== oldGroupId) return;
      sheet.getRange(i + 1, col("date") + 1).setValue(date);
      sheet.getRange(i + 1, col("payment") + 1).setValue(payment);
    });
  }
  appendFinanceRows(sheet, splits.map(it => ({
    date: date, category: it.category, amount: it.amount, memo: memo, tags: tags,
    payment: payment, groupId: groupId, createdAt: row[col("createdAt")],
  })));
}
