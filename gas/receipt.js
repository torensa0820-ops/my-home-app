// =========================================================
// レシート・クーポンの写真：画面で撮った写真をドライブに保存し、夜に Claude が読み取った結果を確認する
//
// 流れ
//   1. 画面で撮った写真を uploadReceipt でドライブ（スクリプトプロパティ RECEIPT_FOLDER_ID のフォルダ）に保存し、
//      「レシート」シートに1行追加する（長いレシートは「続きを撮る」で同じ行に写真を足す）
//   2. 毎晩 0:00 に Claude のスケジュールタスク（アプリの外）が status が空の行の写真を読み、
//      「レシート」「在庫取込」「取込待ち」「クーポン」シートに書き込む
//   3. 画面で在庫取込の確認待ち（追加・追加しない）と自動追加の取り消し、家計簿の確認待ち、クーポンの使った・不要を処理する
//   4. 毎朝 7:00 に notifyCouponsAndPending がクーポンの期限と確認待ちの件数を Discord に通知する
//      （その前に、支払いの日になった定期支出を取込待ちに入れる。recurring.js）
// 列は見出し名で探す。シートや列がなければ1行目の見出しを作る（ensureReceiptSheets）
// =========================================================
const SHEET_RECEIPT = "レシート";
const SHEET_STOCK_IMPORT = "在庫取込";
const SHEET_COUPON = "クーポン";
const SHEET_RECEIPT_ITEMS = "レシート明細";
const RECEIPT_HEADERS = ["id", "kind", "fileIds", "uploadedAt", "status", "store", "purchasedAt", "total", "payment", "importId", "note", "processedAt"];
const STOCK_IMPORT_HEADERS = ["id", "receiptId", "itemName", "qty", "location", "tags", "kind", "status", "reason", "stockRowId", "createdAt", "updatedAt", "category"];
// レシート明細：レシートの全品目と、在庫についての判断（decision：自動追加 / 確認 / 対象外）と理由。Claude が書く
const RECEIPT_ITEM_HEADERS = ["id", "receiptId", "itemName", "qty", "price", "matchedStock", "decision", "reason", "stockImportId", "createdAt", "updatedAt"];
const COUPON_HEADERS = ["id", "receiptId", "fileId", "store", "title", "detail", "validFrom", "validUntil", "status", "notifiedOn", "createdAt", "repeat"];
// 取込待ち：gas-mail/ が作る列（列の位置で書き込むので順番を変えない）と、レシートの読み取りで足す列（末尾に足す）
const IMPORT_BASE_HEADERS = ["id", "source", "usedAt", "merchant", "kind", "amount", "card", "receivedAt", "status", "note"];
const IMPORT_RECEIPT_HEADERS = ["suggestItems", "suggestTags", "suggestMemo", "suggestPayment", "receiptId"];
const COUPON_DATE_COLUMNS = ["validFrom", "validUntil", "notifiedOn"]; // yyyy-MM-dd の文字列で持つ列
const RECEIPT_MAX_BYTES = 5 * 1024 * 1024; // 受け取る写真1枚の上限
const RECEIPT_REREAD = "再読"; // レシートの status。アプリで「在庫の判断を読み直す」を押したもの（今夜 Claude が在庫の判断だけやり直す）
const RECEIPT_UNREAD = ["", RECEIPT_REREAD]; // 今夜 Claude が読む status
const RECEIPT_RECENT_DAYS = 14; // 撮影画面に出す「最近撮った分」の日数
const STOCK_IMPORT_AUTO_DAYS = 7; // 自動追加をこの日数のあいだ画面に出す（取り消せるようにする）
const COUPON_MENTION = ""; // 通知の先頭に付けるメンション（"@everyone" にすると付く）
const COUPON_REMINDER = "※紙のクーポンを持っていく"; // クーポンの通知の行末に付ける
const COUPON_CANDIDATE = "候補"; // クーポンの status。レシートの写真から Claude が見つけた候補（画面で確認するまで通知しない）

// ---- シートの用意 ----

// シートを返す。なければ1行目に見出しを付けて作り、あれば足りない見出しを末尾に足す
// textColumns の列は、文字列が日付に変換されないよう書式を文字列にする（新しく作ったときだけ）
function receiptSheet(ss, name, headers, textColumns) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    (textColumns || []).forEach(c => {
      sheet.getRange(2, headers.indexOf(c) + 1, sheet.getMaxRows() - 1, 1).setNumberFormat("@");
    });
    return sheet;
  }
  const lastCol = sheet.getLastColumn();
  const current = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  const missing = headers.filter(h => current.indexOf(h) === -1);
  if (missing.length) {
    const need = lastCol + missing.length - sheet.getMaxColumns();
    if (need > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), need);
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

// Claude が書き込むシートと列をそろえる（写真を受け取ったときと setupReceiptTriggers で呼ぶ）
function ensureReceiptSheets(ss) {
  receiptSheet(ss, SHEET_STOCK_IMPORT, STOCK_IMPORT_HEADERS);
  receiptSheet(ss, SHEET_RECEIPT_ITEMS, RECEIPT_ITEM_HEADERS);
  receiptSheet(ss, SHEET_COUPON, COUPON_HEADERS, COUPON_DATE_COLUMNS);
  receiptSheet(ss, SHEET_IMPORT, IMPORT_BASE_HEADERS.concat(IMPORT_RECEIPT_HEADERS), ["usedAt"]);
  return receiptSheet(ss, SHEET_RECEIPT, RECEIPT_HEADERS);
}

// シートの行を「見出し → 値」のオブジェクトにする（_row にシートの行番号）。id が空の行は除く。シートがなければ空
function receiptRead(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return { headers: [], rows: [] };
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const rows = values.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    headers.forEach((h, j) => { if (h) o[h] = r[j]; });
    return o;
  }).filter(o => String(o.id ?? "") !== "");
  return { headers: headers, rows: rows };
}

// 1行のいくつかの列を書き換える（values：{見出し: 値}）
function receiptWrite(sheet, headers, row, values) {
  Object.keys(values).forEach(k => {
    const col = headers.indexOf(k);
    if (col === -1) throw new Error(`シート「${sheet.getName()}」に ${k} の列がありません。`);
    sheet.getRange(row, col + 1).setValue(values[k]);
  });
}

// 「見出し → 値」のオブジェクトを、シートの末尾に1行追加する
function receiptAppend(sheet, obj) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.appendRow(headers.map(h => obj[h] === undefined ? "" : obj[h]));
}

// 画面に渡す形にする（日付は日本時間の文字列。validFrom などは yyyy-MM-dd、それ以外は yyyy/MM/dd HH:mm）
function receiptOut(o) {
  const out = {};
  Object.keys(o).forEach(k => {
    if (k === "_row") return;
    const v = o[k];
    if (COUPON_DATE_COLUMNS.indexOf(k) !== -1) out[k] = normDate(v);
    else out[k] = v instanceof Date ? Utilities.formatDate(v, "Asia/Tokyo", "yyyy/MM/dd HH:mm") : v;
  });
  return out;
}

// 日時（Date か "yyyy/MM/dd HH:mm"・"yyyy-MM-ddTHH:mm" などの文字列）をミリ秒にする。読めなければ NaN
function receiptTime(v) {
  if (v instanceof Date) return v.getTime();
  const m = String(v ?? "").trim().match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return NaN;
  const p = s => String(s || "0").padStart(2, "0");
  return new Date(`${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${p(m[5])}:00+09:00`).getTime();
}

function receiptNow() {
  return Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");
}

// レシートの id → 写真のファイル ID の配列（取込待ち・在庫取込から写真を開くリンクに使う）
function receiptFileMap(ss) {
  const map = {};
  receiptRead(ss.getSheetByName(SHEET_RECEIPT)).rows.forEach(o => { map[String(o.id)] = receiptFileIds(o.fileIds); });
  return map;
}
function receiptFileIds(v) {
  return String(v ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

// ---- 写真の保存先（ドライブのフォルダ）----
// スクリプトプロパティ RECEIPT_FOLDER_ID のフォルダ。なければマイドライブに「くらしログ/レシート」を作って ID を保存する
function getReceiptFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("RECEIPT_FOLDER_ID");
  if (id) {
    try { return DriveApp.getFolderById(id); }
    catch (e) { throw new Error("スクリプトプロパティ RECEIPT_FOLDER_ID のフォルダが見つかりません: " + id); }
  }
  const parent = receiptChildFolder(DriveApp.getRootFolder(), "くらしログ");
  const folder = receiptChildFolder(parent, "レシート");
  props.setProperty("RECEIPT_FOLDER_ID", folder.getId());
  return folder;
}
function receiptChildFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// 画面から届いた写真（JPEG の base64）をバイト列にする。5MB を超えるもの・JPEG でないものはエラー
function receiptImageBytes(b64) {
  const text = String(b64 || "").replace(/^data:[^,]*,/, "");
  if (!text) throw new Error("写真が空です。");
  if (Math.floor(text.length * 3 / 4) > RECEIPT_MAX_BYTES + 3) throw new Error("写真が大きすぎます（1枚 5MB まで）。");
  const bytes = Utilities.base64Decode(text);
  if (bytes.length > RECEIPT_MAX_BYTES) throw new Error("写真が大きすぎます（1枚 5MB まで）。");
  if (bytes.length < 3 || bytes[0] !== -1 || bytes[1] !== -40) throw new Error("JPEG の写真ではありません。");
  return bytes;
}

// ---- 写真の受け取り ----
// data：{kind: "レシート" | "クーポン", image: JPEG の base64, receiptId（続きを撮るときだけ。その1件に写真を足す）}
// 戻り値：{id: レシートの id, count: この1件の写真の枚数}
function uploadReceipt(ss, data) {
  const bytes = receiptImageBytes(data.image);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // 続きの写真を同時に足しても fileIds が消えないよう、読んでから書くまでをまとめて行う
  try {
    const sheet = ensureReceiptSheets(ss);
    const now = new Date();
    if (data.receiptId) {
      const t = receiptRead(sheet);
      const found = t.rows.find(o => String(o.id) === String(data.receiptId));
      if (!found) throw new Error("続きを足す1件が見つかりません。新しく撮ってください。");
      if (String(found.status ?? "") !== "") throw new Error("この1件はもう読み取られています。新しく撮ってください。");
      const ids = receiptFileIds(found.fileIds);
      ids.push(saveReceiptFile(bytes, found.kind, found.id, ids.length + 1, now));
      receiptWrite(sheet, t.headers, found._row, { fileIds: ids.join(",") });
      return { id: found.id, count: ids.length };
    }
    const kind = data.kind === "クーポン" ? "クーポン" : "レシート";
    const id = Utilities.getUuid();
    const fileId = saveReceiptFile(bytes, kind, id, 1, now);
    receiptAppend(sheet, { id: id, kind: kind, fileIds: fileId, uploadedAt: now });
    return { id: id, count: 1 };
  } finally {
    lock.releaseLock();
  }
}

// 写真をドライブに保存してファイル ID を返す（ファイル名：20261018-193005_レシート_1a2b3c4d_1.jpg）
function saveReceiptFile(bytes, kind, id, n, now) {
  const name = `${Utilities.formatDate(now, "Asia/Tokyo", "yyyyMMdd-HHmmss")}_${kind}_${String(id).slice(0, 8)}_${n}.jpg`;
  return getReceiptFolder().createFile(Utilities.newBlob(bytes, "image/jpeg", name)).getId();
}

// ---- 撮影した分の一覧（今日撮った分と、まだ読まれていない件数）----
// ---- 撮影した分の一覧（直近 RECEIPT_RECENT_DAYS 日）と、まだ読まれていない件数 ----
// recent：[{id, kind, uploadedAt, status, store, purchasedAt, total, payment, importId, note, count（写真の枚数）,
//           items（明細の件数）, auto・confirm・skip（明細の判断ごとの件数）, coupons（このレシートから作ったクーポン・候補の件数）}]
// unread：status が空か「再読」の件数（今夜読む分）
function getReceiptSummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = receiptRead(ss.getSheetByName(SHEET_RECEIPT)).rows;
  const since = Utilities.formatDate(new Date(Date.now() - (RECEIPT_RECENT_DAYS - 1) * 86400000), "Asia/Tokyo", "yyyy-MM-dd");
  const recent = rows.filter(o => normDate(o.uploadedAt) >= since);
  const ids = new Set(recent.map(o => String(o.id)));
  const counts = {};
  const count = id => counts[id] || (counts[id] = { items: 0, auto: 0, confirm: 0, skip: 0, coupons: 0 });
  receiptRead(ss.getSheetByName(SHEET_RECEIPT_ITEMS)).rows.forEach(o => {
    const id = String(o.receiptId);
    if (!ids.has(id)) return;
    const c = count(id);
    c.items++;
    const key = { 自動追加: "auto", 確認: "confirm", 対象外: "skip" }[String(o.decision ?? "")];
    if (key) c[key]++;
  });
  receiptRead(ss.getSheetByName(SHEET_COUPON)).rows.forEach(o => { if (ids.has(String(o.receiptId))) count(String(o.receiptId)).coupons++; });
  return {
    recent: recent
      .map(o => Object.assign(receiptOut(o), { count: receiptFileIds(o.fileIds).length }, count(String(o.id))))
      .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt))),
    unread: rows.filter(o => RECEIPT_UNREAD.indexOf(String(o.status ?? "")) !== -1).length,
  };
}

// ---- 撮影した1件の詳細：何がどこに反映されたか ----
// receipt：レシートの行（files に写真のファイル ID の配列）
// items：レシート明細（品目ごとの判断）。stockImport に対応する在庫取込の行（あれば）
// finance：家計簿の確認待ち（取込待ちの行。importId か receiptId で探す）。なければ null
// coupons：このレシートから作ったクーポン・候補
function getReceiptDetail(p) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const found = receiptRead(ss.getSheetByName(SHEET_RECEIPT)).rows.find(o => String(o.id) === String(p.id));
  if (!found) throw new Error("撮影した記録が見つかりません。読み込み直してください。");
  const id = String(found.id);
  const imports = {};
  receiptRead(ss.getSheetByName(SHEET_STOCK_IMPORT)).rows.forEach(o => { if (String(o.receiptId) === id) imports[String(o.id)] = o; });
  const items = receiptRead(ss.getSheetByName(SHEET_RECEIPT_ITEMS)).rows
    .filter(o => String(o.receiptId) === id)
    .sort((a, b) => a._row - b._row)
    .map(o => {
      const imp = imports[String(o.stockImportId)];
      if (imp) delete imports[String(o.stockImportId)];
      return Object.assign(receiptOut(o), { stockImport: imp ? receiptOut(imp) : null });
    });
  const importId = String(found.importId ?? "");
  const fin = receiptRead(ss.getSheetByName(SHEET_IMPORT)).rows
    .find(o => (importId && String(o.id) === importId) || String(o.receiptId ?? "") === id);
  return {
    receipt: Object.assign(receiptOut(found), { files: receiptFileIds(found.fileIds) }),
    items: items,
    // 明細に結びついていない在庫取込（明細の記録を始める前に読んだレシートなど）
    otherStockImports: Object.keys(imports).map(k => receiptOut(imports[k])),
    finance: fin ? receiptOut(fin) : null,
    coupons: receiptRead(ss.getSheetByName(SHEET_COUPON)).rows.filter(o => String(o.receiptId) === id).map(receiptOut),
  };
}

// 在庫の判断を読み直す（読み取り済みのレシートだけ。status を「再読」にし、今夜 Claude が在庫の判断だけをやり直す）
// ストックタグを後から付けた品目などを拾うため。家計簿・クーポン・セール品目は書き直さない
function rereadReceipt(ss, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = ensureReceiptSheets(ss); // 今夜 Claude が書く「レシート明細」シートもここで用意する
    const t = receiptRead(sheet);
    const found = t.rows.find(o => String(o.id) === String(data.id));
    if (!found) throw new Error("撮影した記録が見つかりません。読み込み直してください。");
    if (String(found.kind ?? "") !== "レシート") throw new Error("読み直せるのはレシートだけです。");
    const status = String(found.status ?? "");
    if (status === RECEIPT_REREAD) throw new Error("すでに読み直しを頼んであります（今夜読みます）。");
    if (status !== "read") throw new Error("まだ読み取られていないレシートです。");
    const note = String(found.note ?? "");
    receiptWrite(sheet, t.headers, found._row, {
      status: RECEIPT_REREAD, note: (note ? note + " ／ " : "") + "在庫の読み直しを依頼：" + receiptNow(),
    });
  } finally {
    lock.releaseLock();
  }
}

// 撮り間違えた写真を読まないようにする（まだ読まれていない1件だけ。status を skipped にする）
function skipReceipt(ss, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = ss.getSheetByName(SHEET_RECEIPT);
    const t = receiptRead(sheet);
    const found = t.rows.find(o => String(o.id) === String(data.id));
    if (!found) throw new Error("撮影した記録が見つかりません。読み込み直してください。");
    if (String(found.status ?? "") !== "") throw new Error("この1件はもう読み取られています。");
    receiptWrite(sheet, t.headers, found._row, { status: "skipped", note: "アプリで取り消し：" + receiptNow() });
  } finally {
    lock.releaseLock();
  }
}

// ---- 在庫取込 ----
// pending：確認待ち（kind=確認・status が空。古い順）
// auto：Claude が在庫に足した分（status=自動追加・作成から7日以内。新しい順）
// どちらも receiptFiles（レシートの写真のファイル ID の配列）を付ける
function getStockImports() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = receiptRead(ss.getSheetByName(SHEET_STOCK_IMPORT)).rows;
  const since = Date.now() - STOCK_IMPORT_AUTO_DAYS * 86400000;
  const pending = rows.filter(o => String(o.kind ?? "") === "確認" && String(o.status ?? "") === "");
  const auto = rows.filter(o => {
    if (String(o.status ?? "") !== "自動追加") return false;
    const t = receiptTime(o.createdAt);
    return isNaN(t) || t >= since; // 作成日時が読めないものは出しておく（取り消せるように）
  });
  if (!pending.length && !auto.length) return { pending: [], auto: [] };
  const files = receiptFileMap(ss);
  const out = o => Object.assign(receiptOut(o), { receiptFiles: files[String(o.receiptId)] || [] });
  const time = o => receiptTime(o.createdAt) || 0;
  return {
    pending: pending.sort((a, b) => time(a) - time(b)).map(out),
    auto: auto.sort((a, b) => time(b) - time(a)).map(out),
  };
}

// 在庫取込の操作（data.action）
//   add     … 確認待ちを在庫に登録する（在庫の登録と同じ処理。itemName・qty・category・location・tags・expirationDate は画面で直した値）。status=added
//   dismiss … 確認待ちを追加しない。status=dismissed
//   undo    … 自動追加を取り消す。stockRowId のロットの個数を qty だけ減らす（0 未満にはしない）。status=undone
// 戻り値：画面のトーストに出す文（なければ空）
function stockImportAction(ss, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // 同じ品目を二重に足したり減らしたりしないよう、確認から書き込みまでをまとめて行う
  try {
    const sheet = ss.getSheetByName(SHEET_STOCK_IMPORT);
    const t = receiptRead(sheet);
    const found = t.rows.find(o => String(o.id) === String(data.id));
    if (!found) throw new Error("レシートからの品目が見つかりません。読み込み直してください。");
    const status = String(found.status ?? "");
    const now = new Date();

    if (data.action === "add" || data.action === "dismiss") {
      if (status !== "") throw new Error("この品目はすでに処理されています。読み込み直してください。");
      if (data.action === "dismiss") {
        receiptWrite(sheet, t.headers, found._row, { status: "dismissed", updatedAt: now });
        return "";
      }
      const qty = Number(data.qty);
      if (!(qty > 0)) throw new Error("個数を入れてください。");
      updateStock(ss, { target: data.itemName, value: qty, category: data.category, location: data.location, tags: data.tags, expirationDate: data.expirationDate || "" });
      const written = { status: "added", updatedAt: now, itemName: normText(data.itemName), qty: qty, location: normText(data.location), tags: normTags(data.tags) };
      if (t.headers.indexOf("category") !== -1) written.category = normCategory(data.category);
      receiptWrite(sheet, t.headers, found._row, written);
      return "";
    }

    if (data.action === "undo") {
      if (status !== "自動追加") throw new Error("この品目はすでに取り消されています。読み込み直してください。");
      const message = reduceStockLot(ss, found.stockRowId, Number(found.qty) || 0);
      receiptWrite(sheet, t.headers, found._row, { status: "undone", updatedAt: now });
      return message;
    }
    throw new Error("action が不正です: " + data.action);
  } finally {
    lock.releaseLock();
  }
}

// 在庫のロット（id）の個数を qty だけ減らす（0 未満にはしない）。ロットが見つからなければ個数は変えず、その旨を返す
function reduceStockLot(ss, stockRowId, qty) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const col = stockColumns(values[0]);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col.id]) !== String(stockRowId) || stockRowId === "") continue;
    const current = Number(values[i][col.stock]) || 0;
    sheet.getRange(i + 1, col.stock + 1).setValue(Math.max(0, current - qty));
    sheet.getRange(i + 1, col.lastUpdated + 1).setValue(new Date());
    return "";
  }
  return "在庫の行が見つからなかったので、個数は変えずに取り消しました";
}

// ---- クーポン ----
// status が空（未使用）と「候補」で、期限を過ぎていないもの。期限の近い順（期限なしは最後）
// 候補：レシートとして撮った写真の中で Claude が見つけたクーポン・キャンペーン・告知など。画面で確認するまで通知しない
function getCoupons() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  return receiptRead(ss.getSheetByName(SHEET_COUPON)).rows
    .filter(o => ["", COUPON_CANDIDATE].indexOf(String(o.status ?? "")) !== -1 && !couponExpired(o, today))
    .map(receiptOut)
    .sort((a, b) => (a.validUntil || "9999-99-99").localeCompare(b.validUntil || "9999-99-99"));
}

// validUntil を過ぎているか（today は yyyy-MM-dd）
function couponExpired(o, today) {
  const until = normDate(o.validUntil);
  return !!until && until < today;
}

// クーポンの操作（data.action）。すでに処理済み（対象の status でない）ならエラー
//   used    … 使った（status=used）。未使用のクーポンだけ
//   dismiss … 不要（status=dismissed）。未使用のクーポンと候補
//   remind  … 候補を直した内容（title・validFrom・validUntil・repeat）で保存し、status を空にする。
//             notifiedOn は空にするので、翌朝「新しいクーポン」として通知される
function couponAction(ss, data) {
  const allowed = { used: [""], dismiss: ["", COUPON_CANDIDATE], remind: [COUPON_CANDIDATE] }[data.action];
  if (!allowed) throw new Error("action が不正です: " + data.action);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = ss.getSheetByName(SHEET_COUPON);
    const t = receiptRead(sheet);
    const found = t.rows.find(o => String(o.id) === String(data.id));
    if (!found) throw new Error("クーポンが見つかりません。読み込み直してください。");
    if (allowed.indexOf(String(found.status ?? "")) === -1) throw new Error("このクーポンはすでに処理されています。読み込み直してください。");
    if (data.action !== "remind") {
      receiptWrite(sheet, t.headers, found._row, { status: data.action === "used" ? "used" : "dismissed" });
      return;
    }
    const title = normText(data.title);
    const from = couponDateInput(data.validFrom, "開始日");
    const until = couponDateInput(data.validUntil, "期限");
    if (!title) throw new Error("内容（title）を入れてください。");
    if (from && until && from > until) throw new Error("開始日が期限より後になっています。");
    const repeat = couponRepeatInput(data.repeat);
    receiptSheet(ss, SHEET_COUPON, COUPON_HEADERS); // repeat の列がなければ末尾に足す
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
    receiptWrite(sheet, headers, found._row, { title: title, validFrom: from, validUntil: until, repeat: repeat, status: "", notifiedOn: "" });
  } finally {
    lock.releaseLock();
  }
}

// ---- くり返し（repeat 列）----
// monthly:9,19,29 … 毎月その日（-1 は末日。その月にない日は飛ばす）
// weekly:0,6      … 毎週その曜日（0=日〜6=土）
// 空ならくり返しなし。読めなければ null
function parseCouponRepeat(v) {
  const m = normText(v).toLowerCase().replace(/\s/g, "").match(/^(monthly|weekly):([-\d,]+)$/);
  if (!m) return null;
  const values = [...new Set(m[2].split(",").filter(Boolean).map(Number))];
  const ok = m[1] === "monthly" ? n => n === -1 || (n >= 1 && n <= 31) : n => n >= 0 && n <= 6;
  if (!values.length || !values.every(n => Number.isInteger(n) && ok(n))) return null;
  return { type: m[1], values: values.sort((a, b) => (a === -1 ? 99 : a) - (b === -1 ? 99 : b)) };
}

// 画面から届いた repeat をそろえた文字列にする（空は空。読めなければエラー）
function couponRepeatInput(v) {
  if (normText(v) === "") return "";
  const r = parseCouponRepeat(v);
  if (!r) throw new Error("くり返しの書き方が不正です: " + v);
  return `${r.type}:${r.values.join(",")}`;
}

// yyyy-MM-dd がくり返しの日か
function couponRepeatMatches(r, ymd) {
  const d = new Date(ymd + "T00:00:00Z");
  if (r.type === "weekly") return r.values.indexOf(d.getUTCDay()) !== -1;
  const day = d.getUTCDate();
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return r.values.some(n => n === -1 ? day === last : n === day);
}

// 「毎月9・19・29日」「毎月15日・末日」「毎週日・土曜」
function couponRepeatLabel(r) {
  if (r.type === "weekly") return "毎週" + r.values.map(n => "日月火水木金土"[n]).join("・") + "曜";
  const days = r.values.filter(n => n !== -1);
  const parts = [];
  if (days.length) parts.push(days.join("・") + "日");
  if (r.values.indexOf(-1) !== -1) parts.push("末日");
  return "毎月" + parts.join("・");
}

// yyyy-MM-dd に n 日足す
function couponAddDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 画面から届いた日付を yyyy-MM-dd にする（空はそのまま空。読めなければエラー）
function couponDateInput(v, label) {
  if (String(v ?? "").trim() === "") return "";
  const d = normDate(v);
  if (!d) throw new Error(`${label}の日付が不正です: ${v}`);
  return d;
}

// ---- 毎朝の通知：クーポンの期限と、確認待ちの件数 ----

// 【トリガーで毎朝 7:00 に実行】
function notifyCouponsAndPending() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log("ほかの処理が実行中のため、今回は通知しませんでした。");
    return;
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // 支払いの日になった定期支出を取込待ちに入れる（recurring.js）。失敗してもクーポンの通知は続ける
    try { generateRecurringImports(ss); } catch (err) { Logger.log("定期支出の取り込みに失敗しました：" + err); }
    const notice = buildCouponNotice(ss);
    // 期限を過ぎた未使用のクーポンは、通知の有無にかかわらず expired にする
    notice.expired.forEach(o => receiptWrite(notice.sheet, notice.headers, o._row, { status: "expired" }));
    if (!notice.lines.length) {
      Logger.log("通知するクーポンも確認待ちもありませんでした。");
      return;
    }
    saleSplitMessages(notice.lines, SALE_DISCORD_LIMIT).forEach(msg => sendDiscordMessage(msg, "COUPON"));
    // 送れたクーポンだけ、今日通知したことを書く（失敗したら書かず、次回また送る）
    notice.notified.forEach(o => receiptWrite(notice.sheet, notice.headers, o._row, { notifiedOn: notice.today }));
    Logger.log(`クーポン ${notice.notified.length}件と確認待ちを通知しました。`);
  } finally {
    lock.releaseLock();
  }
}

// 【一度だけ実行】notifyCouponsAndPending を毎朝 7:00 に実行するトリガーを作る（作り直しても重複しない）
// あわせて、Claude が書き込むシート・列と、写真の保存先のフォルダを用意する（ドライブの権限の許可もここで求められる）
function setupReceiptTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "notifyCouponsAndPending")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("notifyCouponsAndPending").timeBased().atHour(7).nearMinute(0).everyDays(1).inTimezone("Asia/Tokyo").create();
  ensureReceiptSheets(SpreadsheetApp.getActiveSpreadsheet());
  const folder = getReceiptFolder();
  Logger.log(`notifyCouponsAndPending を毎朝 7:00 に実行するトリガーを作成しました。写真の保存先：${folder.getName()}（${folder.getId()}）`);
}

// 【デバッグ用】今朝の通知文をログに出す（送信も status・notifiedOn の書き込みもしない）
function debugCouponNotifyPreview() {
  const notice = buildCouponNotice(SpreadsheetApp.getActiveSpreadsheet());
  Logger.log(`期限切れにするクーポン：${notice.expired.length}件`);
  Logger.log(notice.lines.length ? notice.lines.join("\n") : "通知するクーポンも確認待ちもありません。");
}

// 通知の内容を作る
// lines：通知の行（「新しいクーポン」「今日から・明日から使える」「期限が近い」の順。最後に確認待ちの件数）
// notified：通知するクーポン、expired：期限を過ぎた未使用のクーポン
function buildCouponNotice(ss) {
  const sheet = ss.getSheetByName(SHEET_COUPON);
  const t = receiptRead(sheet);
  const today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  const tomorrow = couponAddDays(today, 1);
  const groups = { fresh: [], repeat: [], start: [], end: [] };
  const expired = [];
  // くり返しの日が使える期間（validFrom〜validUntil）の中か
  const inRange = (ymd, from, until) => (!from || from <= ymd) && (!until || ymd <= until);
  t.rows.forEach(o => {
    const status = String(o.status ?? "");
    if (status !== "" && status !== COUPON_CANDIDATE) return;
    const from = normDate(o.validFrom);
    const until = normDate(o.validUntil);
    if (until && until < today) { expired.push(o); return; } // 未使用のクーポンも候補も、期限を過ぎたら expired
    if (status === COUPON_CANDIDATE) return; // 候補は画面で確認する（「リマインドする」）まで通知しない
    const notifiedOn = normDate(o.notifiedOn);
    if (notifiedOn === today) return; // 同じ日に二重に通知しない
    const fromDays = from ? couponDays(today, from) : null;
    const untilDays = until ? couponDays(today, until) : null;
    const endLabel = { 0: "今日まで", 1: "明日まで", 3: "あと3日" }[untilDays];
    const repeat = parseCouponRepeat(o.repeat); // 読めない repeat はくり返しなしとして扱う
    if (repeat) {
      // くり返し：最初の朝は「新しいクーポン」、それ以降はくり返しの日の前日（明日は）と当日（今日は）
      if (!notifiedOn) {
        groups.fresh.push({ o: o, key: until || "9999", line: couponRepeatLine(o, "新しいクーポン", repeat, from, until) });
      } else if (couponRepeatMatches(repeat, today) && inRange(today, from, until)) {
        groups.repeat.push({ o: o, key: "0", line: couponRepeatLine(o, "今日は", repeat, from, until) });
      } else if (couponRepeatMatches(repeat, tomorrow) && inRange(tomorrow, from, until)) {
        groups.repeat.push({ o: o, key: "1", line: couponRepeatLine(o, "明日は", repeat, from, until) });
      }
      return;
    }
    if (!notifiedOn) {
      // 登録後の最初の朝（まだ使えない物も含む）。期限が3日以内なら残りも書く
      const left = untilDays !== null && untilDays <= 3 ? { 0: "今日まで", 1: "明日まで" }[untilDays] || `あと${untilDays}日` : "";
      groups.fresh.push({ o: o, key: until || "9999", line: couponLine(o, "新しいクーポン", from, until, left) });
    } else if (fromDays === 0 || fromDays === 1) {
      groups.start.push({ o: o, key: String(fromDays), line: couponLine(o, fromDays ? "明日から使える" : "今日から使える", from, until, "") });
    } else if (endLabel) {
      groups.end.push({ o: o, key: String(untilDays), line: couponLine(o, endLabel, from, until, "") });
    }
  });
  const ordered = ["fresh", "repeat", "start", "end"].flatMap(g => groups[g].sort((a, b) => a.key.localeCompare(b.key)));
  const lines = ordered.map(x => x.line);
  if (lines.length && COUPON_MENTION) lines[0] = COUPON_MENTION + " " + lines[0];
  const pending = pendingCountsLine(ss, today);
  if (pending) lines.push(pending);
  return { sheet: sheet, headers: t.headers, today: today, lines: lines, notified: ordered.map(x => x.o), expired: expired };
}

// 例「【クーポン】明日から使える：ベルク 次回100円引き（1,000円以上）10/20〜10/26 ※紙のクーポンを持っていく」
function couponLine(o, label, from, until, extra) {
  const what = [o.store, o.title].map(v => saleOneLine(v)).filter(Boolean).join(" ");
  const detail = saleOneLine(o.detail);
  return `【クーポン】${label}：${what}${detail ? `（${detail}）` : " "}${couponPeriod(from, until)}${extra ? `（${extra}）` : ""} ${COUPON_REMINDER}`;
}

// くり返しのクーポンの行。例「【クーポン】明日は：くすりの福太郎 ふくちゃんデー 会員10%OFF（毎月9・19・29日）」
// 使える期間が決まっていれば後ろに書く。紙を持っていくとは限らない（お店の告知など）ので COUPON_REMINDER は付けない
function couponRepeatLine(o, label, repeat, from, until) {
  const what = [o.store, o.title, o.detail].map(v => saleOneLine(v)).filter(Boolean).join(" ");
  return `【クーポン】${label}：${what}（${couponRepeatLabel(repeat)}）${from || until ? " " + couponPeriod(from, until) : ""}`;
}

// 使える期間「10/20〜10/26」（validFrom が空なら「〜10/26まで」、validUntil が空なら「10/20から」）
function couponPeriod(from, until) {
  const md = s => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  if (from && until) return `${md(from)}〜${md(until)}`;
  if (until) return `〜${md(until)}まで`;
  if (from) return `${md(from)}から`;
  return "期限なし";
}

// "yyyy-MM-dd" どうしの日数の差（to − from）
function couponDays(from, to) {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
}

// 「確認待ち：家計簿 n件・在庫 n件・クーポン候補 n件」（0件の項目は書かない。すべて0件なら空）
// クーポン候補は期限を過ぎていないものだけ数える（過ぎたものは同じ通知で expired にする）
function pendingCountsLine(ss, today) {
  const finance = receiptRead(ss.getSheetByName(SHEET_IMPORT)).rows
    .filter(o => ["", "error"].indexOf(String(o.status ?? "")) !== -1).length;
  const stock = receiptRead(ss.getSheetByName(SHEET_STOCK_IMPORT)).rows
    .filter(o => String(o.kind ?? "") === "確認" && String(o.status ?? "") === "").length;
  const candidates = receiptRead(ss.getSheetByName(SHEET_COUPON)).rows
    .filter(o => String(o.status ?? "") === COUPON_CANDIDATE && !couponExpired(o, today)).length;
  const parts = [finance ? `家計簿 ${finance}件` : "", stock ? `在庫 ${stock}件` : "", candidates ? `クーポン候補 ${candidates}件` : ""].filter(Boolean);
  return parts.length ? "確認待ち：" + parts.join("・") : "";
}
