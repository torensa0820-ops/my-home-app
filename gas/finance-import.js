// =========================================================
// 家計簿：カード利用の取り込み（確認待ちの一覧・登録・スキップ）
//
// 「取込待ち」シートには、通知受け取り用の Gmail で動く GAS（gas-mail/）が
// 三井住友カードの利用通知メールと Apple の領収書メールを読んで1件ずつ追加する。
// 支払いの日になった定期支出（source=recurring）も recurring.js が追加する。
// ここでは確認待ち（status が空）とエラー（status=error）の行を画面に渡し、
// 画面で内容を確認したものだけを家計簿に登録する。
// 「取込ルール」シートには、お店ごとに前回登録したカテゴリ・タグ・メモを覚えておき、次回の入力候補にする。
// 夜に Claude がレシートを読むと、カード利用の行に内訳の案（suggestItems など）が入り、
// カード利用のない支払い（PayPay・現金）は source=receipt の行として追加される（receipt.js）。
// =========================================================
const SHEET_IMPORT = "取込待ち";
const SHEET_IMPORT_RULES = "取込ルール";
const IMPORT_RULE_HEADERS = ["merchant", "category", "tags", "memo", "payment", "updatedAt"];

// ---- 確認待ちの一覧と、お店ごとの入力候補 ----
// pending：[{id, source, usedAt, merchant, kind, amount, card, receivedAt, status, note,
//            suggestItems, suggestTags, suggestMemo, suggestPayment, receiptId, receiptFiles}]（利用日時の古い順）
//   receiptFiles はレシートの写真のファイル ID の配列（receiptId があるとき）
// rules：{ 店名（正規化済み）: {category, tags, memo, payment} }
function getPendingImports() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_IMPORT);
  const pending = [];
  if (sheet) {
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    values.slice(1).forEach(r => {
      const o = {};
      headers.forEach((h, i) => o[h] = r[i] instanceof Date
        ? Utilities.formatDate(r[i], "Asia/Tokyo", "yyyy/MM/dd HH:mm") : r[i]);
      if (!o.id) return;
      const status = String(o.status || "");
      if (status === "" || status === "error") pending.push(o);
    });
    pending.sort((a, b) => String(a.usedAt || a.receivedAt).localeCompare(String(b.usedAt || b.receivedAt)));
    if (pending.some(o => o.receiptId)) {
      const files = receiptFileMap(ss);
      pending.forEach(o => { if (o.receiptId) o.receiptFiles = files[String(o.receiptId)] || []; });
    }
  }
  const rules = {};
  const ruleSheet = ss.getSheetByName(SHEET_IMPORT_RULES);
  if (ruleSheet) {
    const values = ruleSheet.getDataRange().getValues();
    const headers = values[0];
    values.slice(1).forEach(r => {
      const o = {};
      headers.forEach((h, i) => o[h] = r[i]);
      const key = normText(o.merchant);
      if (key) rules[key] = { category: o.category, tags: o.tags, memo: o.memo, payment: o.payment };
    });
  }
  return { pending: pending, rules: rules };
}

// 取込待ちシートの行を id で探す（見つからなければエラー）
function findImportRow(sheet, id) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idx = values.findIndex((r, i) => i > 0 && String(r[headers.indexOf("id")]) === String(id));
  if (idx === -1) throw new Error("取込待ちの記録が見つかりません。読み込み直してください。");
  return { row: idx + 1, headers: headers, values: values[idx] };
}

// 取込待ちの行の status（と note）を書き換える。すでに処理済みならエラー
function setImportStatus(sheet, id, status, note) {
  const found = findImportRow(sheet, id);
  const col = name => found.headers.indexOf(name) + 1;
  const current = String(found.values[col("status") - 1] || "");
  if (current !== "" && current !== "error") throw new Error("この記録はすでに処理されています。読み込み直してください。");
  sheet.getRange(found.row, col("status")).setValue(status);
  if (note !== undefined) sheet.getRange(found.row, col("note")).setValue(note);
}

// ---- 確認した内容で家計簿に登録する ----
// data：{id, date, items, memo, tags, payment, remember}。remember なら取込ルールにお店の分類を保存する
function confirmImport(ss, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // 同じ記録を二重に登録しないよう、確認から書き込みまでをまとめて行う
  try {
    const sheet = ss.getSheetByName(SHEET_IMPORT);
    if (!sheet) throw new Error("取込待ちシートがありません。");
    const found = findImportRow(sheet, data.id);
    const merchant = String(found.values[found.headers.indexOf("merchant")] || "");
    addFinance(ss, Object.assign({}, data, { sourceId: data.id }));
    setImportStatus(sheet, data.id, "registered",
      "登録：" + Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss"));
    if (data.remember && merchant) {
      const items = Array.isArray(data.items) && data.items.length ? data.items : [{ category: data.category }];
      saveImportRule(ss, merchant, {
        category: normText(items[0].category), tags: normTags(data.tags), memo: normText(data.memo), payment: normText(data.payment),
      });
    }
  } finally {
    lock.releaseLock();
  }
}

// ---- 登録しない（スキップ）----
// 二重登録になる、家計簿に入れない支出（立替えなど）、読み取れなかったメールなど
function skipImport(ss, data) {
  const sheet = ss.getSheetByName(SHEET_IMPORT);
  if (!sheet) throw new Error("取込待ちシートがありません。");
  setImportStatus(sheet, data.id, "skipped",
    "スキップ：" + Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss"));
}

// お店ごとの分類を保存する（同じ店名の行があれば上書き）
function saveImportRule(ss, merchant, rule) {
  let sheet = ss.getSheetByName(SHEET_IMPORT_RULES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_IMPORT_RULES);
    sheet.getRange(1, 1, 1, IMPORT_RULE_HEADERS.length).setValues([IMPORT_RULE_HEADERS]);
  }
  const key = normText(merchant);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const obj = Object.assign({ merchant: key, updatedAt: new Date() }, rule);
  const row = headers.map(h => obj[h] === undefined ? "" : obj[h]);
  const idx = values.findIndex((r, i) => i > 0 && normText(r[headers.indexOf("merchant")]) === key);
  if (idx === -1) sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  else sheet.getRange(idx + 1, 1, 1, row.length).setValues([row]);
}
