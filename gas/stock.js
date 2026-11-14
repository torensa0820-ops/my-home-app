// =========================================================
// 在庫：1行＝1ロット（同じ商品でも賞味期限か容量が違えば別の行）
// 容量（size）は「2L」「1200g」のような文字。空は普段の量（セール品目の unitQty／stockPerUnit の量）
// カテゴリ・収納場所・タグ・型番・買う目安・買い物メモの印は商品単位の情報として、同じ商品名の全ロットで揃える
// 買い物メモの印（BUY_FLAG）・買う目安（parseReorderAt）・買う物の判定は shared.js（画面と共通）
// =========================================================
const SHEET_STOCK = "在庫";
const STOCK_UNCATEGORIZED = "未分類"; // 画面で category が空の商品を出すタブの名前

// ---- 在庫の一覧（1行＝1ロット。画面で商品ごとにまとめる）----
function getStockRows() {
  const rows = sheetToObjects(SHEET_STOCK, "itemName");
  rows.forEach(r => { if (r.reorderAt !== undefined) r.reorderAt = parseReorderAt(r.reorderAt); });
  return rows;
}

// ---- 画面からの在庫の操作（doPost から呼ぶ）----
// 「読む → 足す → 書く」の途中にほかの書き込みが入ると個数が消える（＋を続けて押したときなど）ので、ロックの中で行う
// 在庫が変わったら、買い物リストにもすぐ反映する（在庫が「買う物」になった・でなくなった）
function stockAction(ss, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (data.action === "delete") deleteStock(ss, data);
    else if (data.action === "bump") bumpStock(ss, data);
    else if (data.action === "setBuyFlag") setBuyFlag(ss, data);
    else if (data.action === "editItem") editItem(ss, data);
    else updateStock(ss, data);
    syncStockRemindersSafe(ss);
  } finally {
    lock.releaseLock();
  }
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
    size: headers.indexOf("size"),
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
  setSameValue(sheet, lots.filter(i => values[i][col.buyFlag] !== "").map(i => [i + 1, col.buyFlag + 1]), "");
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

// 容量を保存する形にそろえる（未指定は ""＝普段の量）。size の列がないシートでは、どれも "" として扱う
function normSize(col, v) {
  return col.size === -1 ? "" : normText(v);
}

// ロットを見分けるキー（期限＋容量。size は normSize でそろえた値）
function lotKey(exp, size) {
  return normDate(exp) + "|" + size;
}

// ---- 在庫の登録（同じ商品名・同じ期限・同じ容量のロットがあれば個数を加算、なければロットを追加）----
function updateStock(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const col = stockColumns(values[0]);
  const name = normText(data.target);
  if (!name) throw new Error("商品名が空です。");
  const exp = normDate(data.expirationDate);
  const size = normSize(col, data.size);
  const key = lotKey(exp, size);
  const info = itemInfo(data);

  // 同じ商品かどうかは、正規化した商品名どうしで比べる
  const lots = itemLotRows(values, col, name);
  const target = lots.find(i => lotKey(values[i][col.expirationDate], normSize(col, values[i][col.size])) === key);
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
    if (col.size !== -1) newRow[col.size] = size;
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
    setSameValue(sheet, lots.map(i => [i + 1, col[key] + 1]), info[key]);
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
  setSameValue(sheet, lots.map(i => [i + 1, col.buyFlag + 1]), data.value === true ? BUY_FLAG : "");
  setSameValue(sheet, lots.map(i => [i + 1, col.lastUpdated + 1]), new Date());
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
//         lots: [{ id（新規ロットは省略）, expirationDate, size, stock }], deleteIds: [id, ...] }
function editItem(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const col = stockColumns(values[0]);
  const name = normText(data.itemName);
  if (!name) throw new Error("商品名が空です。");
  const oldName = normText(data.oldName);
  const info = itemInfo(data);
  // 買う目安は、送られてこなければ（reorderAt の列がないシート）上書きしない
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
  // 容量が送られてこないロット（古い画面）は、シートの今の容量のままにする
  const rowById = {};
  itemRows.forEach(i => { rowById[String(values[i][col.id])] = i; });
  const sizeOf = l => {
    if (l.size !== undefined) return normSize(col, l.size);
    const i = rowById[String(l.id)];
    return i === undefined ? "" : normSize(col, values[i][col.size]);
  };
  const keys = lots.map(l => lotKey(l.expirationDate, sizeOf(l)));
  if (new Set(keys).size !== keys.length) throw new Error("同じ賞味期限・容量の行が重複しています。");

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

  // 既存ロット：商品情報を揃え、編集されたロットは期限・容量・個数も更新する
  itemRows.forEach(i => {
    const id = String(values[i][col.id]);
    if (deleteIds.has(id)) return;
    const row = values[i].slice();
    row[col.itemName] = name;
    setItemInfo(row, col, info);
    const lot = lotById[id];
    if (lot) {
      row[col.expirationDate] = normDate(lot.expirationDate);
      if (col.size !== -1) row[col.size] = sizeOf(lot);
      row[col.stock] = Number(lot.stock) || 0;
    }
    row[col.lastUpdated] = now;
    sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
  });

  // 新しいロットを追加
  // 買う目安と買い物メモの印が送られないときは、既存のロットから引き継ぐ（古いロットを消して新しいロットに移しても残るように）
  const newInfo = Object.assign({}, info);
  if (newInfo.reorderAt === undefined) newInfo.reorderAt = values[itemRows[0]][col.reorderAt];
  if (newInfo.buyFlag === undefined) newInfo.buyFlag = values[itemRows[0]][col.buyFlag];
  lots.filter(l => l.id === undefined || l.id === "").forEach(l => {
    const newRow = new Array(values[0].length).fill("");
    newRow[col.id] = Utilities.getUuid();
    newRow[col.itemName] = name;
    newRow[col.stock] = Number(l.stock) || 0;
    setItemInfo(newRow, col, newInfo);
    newRow[col.expirationDate] = normDate(l.expirationDate);
    if (col.size !== -1) newRow[col.size] = sizeOf(l);
    newRow[col.lastUpdated] = now;
    sheet.appendRow(newRow);
  });

  // 削除するロット（追加した行は末尾なので、既存の行番号は変わらない。下の行から消す）
  itemRows.filter(i => deleteIds.has(String(values[i][col.id])))
    .sort((a, b) => b - a)
    .forEach(i => sheet.deleteRow(i + 1));
}
