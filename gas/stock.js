// =========================================================
// 在庫：1行＝1ロット（同じ商品でも賞味期限ごとに別の行）
// カテゴリ・収納場所・タグ・型番・買う目安・買い物メモの印は商品単位の情報として、同じ商品名の全ロットで揃える
// =========================================================
const SHEET_STOCK = "在庫";
const BUY_FLAG = "買う"; // buyFlag 列の値（買い物メモの印）
// 在庫のカテゴリ。移行（migrateStockCategory）でタグからカテゴリに移すもの。画面のタブも同じ順に並べる（js/stock.js）
const STOCK_CATEGORIES = ["食品", "日用品", "医薬品", "家具・家電", "住宅設備", "PC周辺機器"];
const STOCK_UNCATEGORIZED = "未分類"; // 画面で category が空の商品を出すタブの名前

// ---- 在庫の一覧（1行＝1ロット。画面で商品ごとにまとめる）----
function getStockRows() {
  const rows = sheetToObjects(SHEET_STOCK, "itemName");
  rows.forEach(r => { if (r.reorderAt !== undefined) r.reorderAt = parseReorderAt(r.reorderAt); });
  return rows;
}

// 買う目安を数値に直す。0 以上の整数でないもの（空・文字・小数・負の数）は「目安なし」の ""
function parseReorderAt(v) {
  const s = normText(v);
  return /^\d+$/.test(s) ? Number(s) : "";
}

function stockColumns(headers) {
  return {
    id: headers.indexOf("id"),
    itemName: headers.indexOf("itemName"),
    stock: headers.indexOf("stock"),
    category: headers.indexOf("category"),
    location: headers.indexOf("location"),
    tags: headers.indexOf("tags"),
    expirationDate: headers.indexOf("expirationDate"),
    modelNumber: headers.indexOf("modelNumber"),
    lastUpdated: headers.indexOf("lastUpdated"),
    reorderAt: headers.indexOf("reorderAt"),
    buyFlag: headers.indexOf("buyFlag"),
  };
}

// 同じ商品名（正規化して比べる）のロットの行番号（values の添字）を返す
function itemLotRows(values, col, name) {
  const lots = [];
  for (let i = 1; i < values.length; i++) {
    if (normText(values[i][col.itemName]) === name) lots.push(i);
  }
  return lots;
}

// 買い物メモの印を外す（個数が増えたとき）。buyFlag の列がないシートでは何もしない
function clearBuyFlag(sheet, col, values, lots) {
  if (col.buyFlag === -1) return;
  lots.filter(i => values[i][col.buyFlag] !== "").forEach(i => sheet.getRange(i + 1, col.buyFlag + 1).setValue(""));
}

// カテゴリを正規化する（「未分類」は空として保存する）
function normCategory(v) {
  const c = normText(v);
  return c === STOCK_UNCATEGORIZED ? "" : c;
}

// 画面から送られた商品情報を正規化する
function itemInfo(data) {
  return { category: normCategory(data.category), location: normText(data.location), tags: normTags(data.tags), modelNumber: normText(data.modelNumber) };
}

// 商品情報（info のキー：category・location・tags・modelNumber・reorderAt・buyFlag）を1行に入れる
// 列がまだないシートでは、その列を飛ばす
function setItemInfo(row, col, info) {
  Object.keys(info).forEach(key => {
    if (col[key] !== -1) row[col[key]] = info[key];
  });
}

// 賞味期限を比較用の "yyyy-MM-dd" にそろえる（未設定は ""）
function normDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, "Asia/Tokyo", "yyyy-MM-dd");
  const m = String(v || "").trim().match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
}

// ---- 在庫の登録（同じ商品名・同じ期限のロットがあれば個数を加算、なければロットを追加）----
function updateStock(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const col = stockColumns(values[0]);
  const name = normText(data.target);
  if (!name) throw new Error("商品名が空です。");
  const exp = normDate(data.expirationDate);
  const info = itemInfo(data);

  // 同じ商品かどうかは、正規化した商品名どうしで比べる
  const lots = itemLotRows(values, col, name);
  const target = lots.find(i => normDate(values[i][col.expirationDate]) === exp);
  const added = Number(data.value) > 0;

  const now = new Date();
  if (target === undefined) {
    // 既存商品の新しいロットなら、未指定の商品情報は既存ロットから引き継ぐ
    const base = lots.length ? values[lots[0]] : null;
    const inherited = {};
    Object.keys(info).forEach(key => {
      inherited[key] = info[key] || (base && col[key] !== -1 ? base[col[key]] : "");
    });
    // 買う目安も引き継ぐ。買い物メモの印は、個数が増えたら外すので引き継がない
    inherited.reorderAt = base ? base[col.reorderAt] : "";
    inherited.buyFlag = base && !added ? base[col.buyFlag] : "";
    const newRow = new Array(values[0].length).fill("");
    newRow[col.id] = Utilities.getUuid();
    newRow[col.itemName] = name;
    newRow[col.stock] = Number(data.value) || 0;
    setItemInfo(newRow, col, inherited);
    newRow[col.expirationDate] = exp;
    newRow[col.lastUpdated] = now;
    sheet.appendRow(newRow);
  } else {
    const current = Number(values[target][col.stock]) || 0;
    sheet.getRange(target + 1, col.stock + 1).setValue(current + (Number(data.value) || 0));
    sheet.getRange(target + 1, col.lastUpdated + 1).setValue(now);
  }
  if (added) clearBuyFlag(sheet, col, values, lots);

  // 商品情報の指定があれば、同じ商品名の既存ロットすべてに反映する
  Object.keys(info).forEach(key => {
    if (!info[key] || col[key] === -1) return;
    lots.forEach(i => sheet.getRange(i + 1, col[key] + 1).setValue(info[key]));
  });
}

// ---- ロットの個数を増減（idで特定）----
function bumpStock(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const col = stockColumns(values[0]);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col.id]) === String(data.id)) {
      const current = Number(values[i][col.stock]) || 0;
      sheet.getRange(i + 1, col.stock + 1).setValue(current + (Number(data.value) || 0));
      sheet.getRange(i + 1, col.lastUpdated + 1).setValue(new Date());
      if (Number(data.value) > 0) clearBuyFlag(sheet, col, values, itemLotRows(values, col, normText(values[i][col.itemName])));
      return;
    }
  }
  throw new Error("商品が見つかりませんでした。一覧を読み込み直してください。");
}

// ---- 買い物メモの印を付ける・外す（商品名で指定し、その商品の全ロットに入れる）----
// data: { target: 商品名, value: true / false }
function setBuyFlag(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const col = stockColumns(values[0]);
  if (col.buyFlag === -1) throw new Error("在庫シートに buyFlag の列がありません。");
  const lots = itemLotRows(values, col, normText(data.target));
  if (!lots.length) throw new Error(`「${data.target}」が在庫に見つかりませんでした。`);
  const now = new Date();
  lots.forEach(i => {
    sheet.getRange(i + 1, col.buyFlag + 1).setValue(data.value === true ? BUY_FLAG : "");
    sheet.getRange(i + 1, col.lastUpdated + 1).setValue(now);
  });
}

// ---- 商品の削除（商品名で指定し、その商品の全ロットを削除）----
function deleteStock(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const idxName = values[0].indexOf("itemName");
  const target = normText(data.target);

  let deleted = 0;
  // 下の行から消すことで、行番号がずれないようにする
  for (let i = values.length - 1; i >= 1; i--) {
    if (normText(values[i][idxName]) === target) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }
  if (!deleted) throw new Error(`「${data.target}」が在庫に見つかりませんでした。`);
}

// ---- 商品の編集 ----
// data: { oldName, itemName, category, location, tags, modelNumber, reorderAt,
//         lots: [{ id（新規ロットは省略）, expirationDate, stock }], deleteIds: [id, ...] }
function editItem(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const col = stockColumns(values[0]);
  const name = normText(data.itemName);
  if (!name) throw new Error("商品名が空です。");
  const oldName = normText(data.oldName);
  const info = itemInfo(data);
  // カテゴリ欄のない古い画面からの保存では、カテゴリを空で上書きしない
  if (data.category === undefined) delete info.category;
  // 買う目安も同じく、送られてこなければ上書きしない
  if (data.reorderAt !== undefined) {
    info.reorderAt = parseReorderAt(data.reorderAt);
    if (info.reorderAt === "" && normText(data.reorderAt) !== "") throw new Error("買う目安は0以上の整数で入れてください。");
  }

  const itemRows = [];
  for (let i = 1; i < values.length; i++) {
    const rowName = normText(values[i][col.itemName]);
    if (rowName === oldName) itemRows.push(i);
    else if (rowName === name) throw new Error(`「${name}」は既に登録されています。`);
  }
  if (!itemRows.length) throw new Error("商品が見つかりませんでした。一覧を読み込み直してください。");

  const lots = data.lots || [];
  const deleteIds = new Set((data.deleteIds || []).map(String));
  if (!lots.length) throw new Error("賞味期限の行を1つ以上残してください。");
  const exps = lots.map(l => normDate(l.expirationDate));
  if (new Set(exps).size !== exps.length) throw new Error("同じ賞味期限の行が重複しています。");

  const now = new Date();
  const lotById = {};
  lots.forEach(l => { if (l.id !== undefined && l.id !== "") lotById[String(l.id)] = l; });
  // 書き込む前に、送られたロットがすべてこの商品の行として存在するか確認する
  const itemIds = new Set(itemRows.map(i => String(values[i][col.id])));
  if (Object.keys(lotById).some(id => !itemIds.has(id))) {
    throw new Error("商品のデータが変更されています。一覧を読み込み直してください。");
  }

  // 保存の前後で合計個数を比べ、増えたら買い物メモの印を外す
  const stockOf = i => Number(values[i][col.stock]) || 0;
  const totalBefore = itemRows.reduce((sum, i) => sum + stockOf(i), 0);
  const totalAfter = itemRows.filter(i => !deleteIds.has(String(values[i][col.id]))).reduce((sum, i) => {
    const lot = lotById[String(values[i][col.id])];
    return sum + (lot ? Number(lot.stock) || 0 : stockOf(i));
  }, 0) + lots.filter(l => l.id === undefined || l.id === "").reduce((sum, l) => sum + (Number(l.stock) || 0), 0);
  const increased = totalAfter > totalBefore;
  if (increased) info.buyFlag = "";

  // 既存ロット：商品情報を揃え、編集されたロットは期限と個数も更新する
  itemRows.forEach(i => {
    const id = String(values[i][col.id]);
    if (deleteIds.has(id)) return;
    const row = values[i].slice();
    row[col.itemName] = name;
    setItemInfo(row, col, info);
    const lot = lotById[id];
    if (lot) {
      row[col.expirationDate] = normDate(lot.expirationDate);
      row[col.stock] = Number(lot.stock) || 0;
    }
    row[col.lastUpdated] = now;
    sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
  });

  // 新しいロットを追加
  // （古い画面からの保存でカテゴリが送られないときは、既存のロットのカテゴリを引き継ぐ）
  const newInfo = Object.assign({}, info);
  if (newInfo.category === undefined && col.category !== -1) newInfo.category = values[itemRows[0]][col.category];
  // 買う目安と買い物メモの印も同じ。古いロットを消して新しいロットに移しても残るようにする
  if (newInfo.reorderAt === undefined) newInfo.reorderAt = values[itemRows[0]][col.reorderAt];
  if (newInfo.buyFlag === undefined) newInfo.buyFlag = values[itemRows[0]][col.buyFlag];
  lots.filter(l => l.id === undefined || l.id === "").forEach(l => {
    const newRow = new Array(values[0].length).fill("");
    newRow[col.id] = Utilities.getUuid();
    newRow[col.itemName] = name;
    newRow[col.stock] = Number(l.stock) || 0;
    setItemInfo(newRow, col, newInfo);
    newRow[col.expirationDate] = normDate(l.expirationDate);
    newRow[col.lastUpdated] = now;
    sheet.appendRow(newRow);
  });

  // 削除するロット（追加した行は末尾なので、既存の行番号は変わらない。下の行から消す）
  itemRows.filter(i => deleteIds.has(String(values[i][col.id])))
    .sort((a, b) => b - a)
    .forEach(i => sheet.deleteRow(i + 1));
}

// ---- カテゴリの移行（タグからカテゴリを分ける。GAS のエディタから一度だけ実行する）----
// 1. 在庫シートを「在庫_バックアップ_yyyyMMdd_HHmm」として複製する
// 2. category 列がなければ tags 列の右に足す。在庫取込シートにも category 列を足す
// 3. 各行の tags のうち STOCK_CATEGORIES にあるタグを category に移し、tags から外す
//    （category が入っている行は category を変えず、同じ名前のタグだけ外す）
// 何度実行しても結果は同じ
function migrateStockCategory() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const backup = `${SHEET_STOCK}_バックアップ_${Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd_HHmm")}`;
  sheet.copyTo(ss).setName(backup);

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf("category") === -1) {
    const tagsCol = headers.indexOf("tags") + 1;
    sheet.insertColumnAfter(tagsCol);
    sheet.getRange(1, tagsCol + 1).setValue("category");
  }
  receiptSheet(ss, SHEET_STOCK_IMPORT, STOCK_IMPORT_HEADERS);

  const values = sheet.getDataRange().getValues();
  const col = stockColumns(values[0]);
  let changed = 0;
  for (let i = 1; i < values.length; i++) {
    const tags = splitTags(values[i][col.tags]);
    const found = STOCK_CATEGORIES.filter(c => tags.includes(c));
    if (!found.length) continue;
    const category = normCategory(values[i][col.category]) || found[0];
    sheet.getRange(i + 1, col.category + 1).setValue(category);
    sheet.getRange(i + 1, col.tags + 1).setValue(tags.filter(t => t !== category).join(","));
    changed++;
  }
  Logger.log(`カテゴリを移した行：${changed}行（バックアップ：${backup}）`);
}
