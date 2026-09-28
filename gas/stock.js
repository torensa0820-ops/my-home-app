// =========================================================
// 在庫：1行＝1ロット（同じ商品でも賞味期限ごとに別の行）
// 収納場所・タグ・型番は商品単位の情報として、同じ商品名の全ロットで揃える
// =========================================================
const SHEET_STOCK = "在庫";

// ---- 在庫の一覧（1行＝1ロット。画面で商品ごとにまとめる）----
function getStockRows() {
  return sheetToObjects(SHEET_STOCK, "itemName");
}

function stockColumns(headers) {
  return {
    id: headers.indexOf("id"),
    itemName: headers.indexOf("itemName"),
    stock: headers.indexOf("stock"),
    location: headers.indexOf("location"),
    tags: headers.indexOf("tags"),
    expirationDate: headers.indexOf("expirationDate"),
    modelNumber: headers.indexOf("modelNumber"),
    lastUpdated: headers.indexOf("lastUpdated"),
  };
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
  const name = String(data.target || "").trim();
  if (!name) throw new Error("商品名が空です。");
  const exp = normDate(data.expirationDate);

  const lots = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i][col.itemName] === name) lots.push(i);
  }
  const target = lots.find(i => normDate(values[i][col.expirationDate]) === exp);

  const now = new Date();
  if (target === undefined) {
    // 既存商品の新しいロットなら、未指定の商品情報は既存ロットから引き継ぐ
    const base = lots.length ? values[lots[0]] : null;
    const inherit = (key) => data[key] || (base ? base[col[key]] : "");
    const newRow = new Array(values[0].length).fill("");
    newRow[col.id] = Utilities.getUuid();
    newRow[col.itemName] = name;
    newRow[col.stock] = Number(data.value) || 0;
    newRow[col.location] = inherit("location");
    newRow[col.tags] = inherit("tags");
    newRow[col.expirationDate] = exp;
    newRow[col.modelNumber] = inherit("modelNumber");
    newRow[col.lastUpdated] = now;
    sheet.appendRow(newRow);
  } else {
    const current = Number(values[target][col.stock]) || 0;
    sheet.getRange(target + 1, col.stock + 1).setValue(current + (Number(data.value) || 0));
    sheet.getRange(target + 1, col.lastUpdated + 1).setValue(now);
  }

  // 商品情報の指定があれば、同じ商品名の既存ロットすべてに反映する
  ["location", "tags", "modelNumber"].forEach(key => {
    if (!data[key]) return;
    lots.forEach(i => sheet.getRange(i + 1, col[key] + 1).setValue(data[key]));
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
      return;
    }
  }
  throw new Error("商品が見つかりませんでした。一覧を読み込み直してください。");
}

// ---- 商品の削除（商品名で指定し、その商品の全ロットを削除）----
function deleteStock(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const idxName = values[0].indexOf("itemName");

  let deleted = 0;
  // 下の行から消すことで、行番号がずれないようにする
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i][idxName] === data.target) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }
  if (!deleted) throw new Error(`「${data.target}」が在庫に見つかりませんでした。`);
}

// ---- 商品の編集 ----
// data: { oldName, itemName, location, tags, modelNumber,
//         lots: [{ id（新規ロットは省略）, expirationDate, stock }], deleteIds: [id, ...] }
function editItem(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const col = stockColumns(values[0]);
  const name = String(data.itemName || "").trim();
  if (!name) throw new Error("商品名が空です。");

  const itemRows = [];
  for (let i = 1; i < values.length; i++) {
    const rowName = values[i][col.itemName];
    if (rowName === data.oldName) itemRows.push(i);
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

  // 既存ロット：商品情報を揃え、編集されたロットは期限と個数も更新する
  itemRows.forEach(i => {
    const id = String(values[i][col.id]);
    if (deleteIds.has(id)) return;
    const row = values[i].slice();
    row[col.itemName] = name;
    row[col.location] = data.location || "";
    row[col.tags] = data.tags || "";
    row[col.modelNumber] = data.modelNumber || "";
    const lot = lotById[id];
    if (lot) {
      row[col.expirationDate] = normDate(lot.expirationDate);
      row[col.stock] = Number(lot.stock) || 0;
    }
    row[col.lastUpdated] = now;
    sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
  });

  // 新しいロットを追加
  lots.filter(l => l.id === undefined || l.id === "").forEach(l => {
    const newRow = new Array(values[0].length).fill("");
    newRow[col.id] = Utilities.getUuid();
    newRow[col.itemName] = name;
    newRow[col.stock] = Number(l.stock) || 0;
    newRow[col.location] = data.location || "";
    newRow[col.tags] = data.tags || "";
    newRow[col.expirationDate] = normDate(l.expirationDate);
    newRow[col.modelNumber] = data.modelNumber || "";
    newRow[col.lastUpdated] = now;
    sheet.appendRow(newRow);
  });

  // 削除するロット（追加した行は末尾なので、既存の行番号は変わらない。下の行から消す）
  itemRows.filter(i => deleteIds.has(String(values[i][col.id])))
    .sort((a, b) => b - a)
    .forEach(i => sheet.deleteRow(i + 1));
}
