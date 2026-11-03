// =========================================================
// Webアプリの入口：画面（GitHub Pages）からのリクエストを振り分ける
//   doGet  … データの取得（action で種類を指定）
//   doPost … データの書き込み（type と action で種類を指定）
// 各処理は stock.js / receipt.js / tags.js / reminder.js にある
// =========================================================

function doGet(e) {
  const p = e.parameter;
  // 起動時に必要なデータをまとめて返す（リクエストの数を減らし、GAS が同時に動く数を抑える）
  if (p.action === "getAll") {
    return jsonOutput({
      stock: getStockRows(),
      reminders: getReminders(),
      stockImports: getStockImports(),
      coupons: getCoupons(),
    });
  }
  if (p.action === "getStock") return jsonOutput(getStockRows());
  if (p.action === "getReminders") return jsonOutput(getReminders());
  if (p.action === "getReceipts") return jsonOutput(getReceiptSummary());
  if (p.action === "getReceiptDetail") {
    try { return jsonOutput(getReceiptDetail(p)); }
    catch (err) { return jsonOutput({ status: "error", message: err.toString() }); }
  }
  if (p.action === "getStockImports") return jsonOutput(getStockImports());
  if (p.action === "getCoupons") return jsonOutput(getCoupons());
  return ContentService.createTextOutput("GAS is running.").setMimeType(ContentService.MimeType.TEXT);
}

// 画面からの書き込みを受け取るメイン処理
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (data.type === "stock") {
      stockAction(ss, data);
    } else if (data.type === "receipt" && data.action === "upload") {
      return jsonOutput(Object.assign({ status: "success" }, uploadReceipt(ss, data)));
    } else if (data.type === "receipt" && data.action === "skip") {
      skipReceipt(ss, data);
    } else if (data.type === "receipt" && data.action === "reread") {
      rereadReceipt(ss, data);
    } else if (data.type === "stockImport") {
      return jsonOutput({ status: "success", message: stockImportAction(ss, data) });
    } else if (data.type === "coupon") {
      couponAction(ss, data);
    } else if (data.type === "reminder") {
      return jsonOutput({ status: "success", item: reminderAction(ss, data) });
    } else if (data.type === "reminderList") {
      return jsonOutput({ status: "success", list: reminderListAction(ss, data) });
    } else if (data.type === "reminderCategory") {
      return jsonOutput({ status: "success", category: reminderCategoryAction(ss, data) });
    } else if (data.type === "tag") {
      return jsonOutput({ status: "success", count: manageTags(ss, data) });
    } else {
      return jsonOutput({ status: "error", message: "type が不正です: " + data.type });
    }
    return jsonOutput({ status: "success" });
  } catch (err) {
    return jsonOutput({ status: "error", message: err.toString() });
  }
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- 共通の小さな関数 ----

// シートの各行を「見出し → 値」のオブジェクトにする（日付は ISO 文字列）。keyColumn が空の行は除く
function sheetToObjects(sheetName, keyColumn) {
  const values = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName).getDataRange().getValues();
  const headers = values[0];
  return values.slice(1)
    .filter(r => r[headers.indexOf(keyColumn)] !== "")
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = r[i] instanceof Date ? r[i].toISOString() : r[i]);
      return obj;
    });
}

// 同じ値を、いくつかのセルにまとめて書く（cells：[[行, 列], ...]。行・列は1から）
// 1セルずつ setValue すると1回ごとに時間がかかるので、RangeList で1回の書き込みにする
function setSameValue(sheet, cells, value) {
  if (cells.length) sheet.getRangeList(cells.map(([row, col]) => a1Notation(row, col))).setValue(value);
}

// 行・列の番号（1から）を "B12" のような書き方にする
function a1Notation(row, col) {
  let letters = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  return letters + row;
}

// 文字列の正規化（normText）とタグの分解（splitTags）は shared.js（画面と共通）

// タグ文字列を正規化し、「,」（半角・空白なし）でつなぎ直す
function normTags(s) {
  return splitTags(s).join(",");
}
