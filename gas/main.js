// =========================================================
// Webアプリの入口：画面（GitHub Pages）や iPhone のショートカットからのリクエストを振り分ける
//   doGet  … データの取得（action で種類を指定）
//   doPost … データの書き込み（type と action で種類を指定）
// 各処理は stock.js / finance.js / tags.js / chore.js にある
// =========================================================

function doGet(e) {
  const p = e.parameter;
  if (p.action === "getStock") return jsonOutput(getStockRows());
  if (p.action === "getTasks") return jsonOutput(getChoreRows());
  if (p.action === "getFinanceOptions") return jsonOutput(getFinanceOptions());
  if (p.action === "getFinance") return jsonOutput(getFinanceRows(p));
  return ContentService.createTextOutput("GAS is running.").setMimeType(ContentService.MimeType.TEXT);
}

// ショートカット/Webアプリからの書き込みを受け取るメイン処理
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (data.type === "stock" && data.action === "delete") {
      deleteStock(ss, data);
    } else if (data.type === "stock" && data.action === "bump") {
      bumpStock(ss, data);
    } else if (data.type === "stock" && data.action === "editItem") {
      editItem(ss, data);
    } else if (data.type === "stock") {
      updateStock(ss, data);
    } else if (data.type === "finance" && data.action === "delete") {
      deleteFinance(ss, data);
    } else if (data.type === "finance" && data.action === "edit") {
      editFinance(ss, data);
    } else if (data.type === "finance") {
      addFinance(ss, data);
    } else if (data.type === "todo") {
      return jsonOutput({ status: "success", task: updateTodo(ss, data) });
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

// タグ文字列を配列に分解（「,」のほか全角の「，」「、」も区切りとして扱う）
function splitTags(s) {
  return String(s).split(/[,，、]/).map(t => t.trim()).filter(Boolean);
}
