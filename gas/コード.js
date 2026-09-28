// ==== 設定 ====
const SHEET_STOCK = "在庫";
const SHEET_FINANCE = "家計簿";
// Discord Webhook URLはスクリプトプロパティ「DISCORD_WEBHOOK_URL」から読み込む
function getDiscordWebhookUrl() {
  const url = PropertiesService.getScriptProperties().getProperty("DISCORD_WEBHOOK_URL");
  if (!url) throw new Error("スクリプトプロパティ DISCORD_WEBHOOK_URL が設定されていません。");
  return url;
}

// ブラウザ確認 / 在庫一覧取得
function doGet(e) {
  if (e.parameter.action === "getStock") {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_STOCK);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const rows = values.slice(1)
      .filter(r => r[headers.indexOf("itemName")] !== "")
      .map(r => {
        const obj = {};
        headers.forEach((h, i) => obj[h] = r[i] instanceof Date ? r[i].toISOString() : r[i]);
        return obj;
      });
    return ContentService.createTextOutput(JSON.stringify(rows)).setMimeType(ContentService.MimeType.JSON);
  }
    if (e.parameter.action === "getTasks") {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = ss.getSheetByName("家事");
      const values = sheet.getDataRange().getValues();
      const headers = values[0];
      const rows = values.slice(1)
        .filter(r => r[headers.indexOf("taskName")] !== "")
        .map(r => {
          const obj = {};
          headers.forEach((h, i) => obj[h] = r[i] instanceof Date ? r[i].toISOString() : r[i]);
          return obj;
        });
      return ContentService.createTextOutput(JSON.stringify(rows)).setMimeType(ContentService.MimeType.JSON);
    }
  if (e.parameter.action === "getFinanceOptions") {
    // 家計簿の入力候補（登録済みのカテゴリとタグ）を返す
    const values = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_FINANCE).getDataRange().getValues();
    const headers = values[0];
    const idxCat = headers.indexOf("category");
    const idxTags = headers.indexOf("tags");
    const categories = new Set();
    const tags = new Set();
    values.slice(1).forEach(r => {
      const cat = String(r[idxCat]).trim();
      if (cat) categories.add(cat);
      String(r[idxTags]).split(/[,，、]/).map(t => t.trim()).filter(Boolean).forEach(t => tags.add(t));
    });
    return jsonOutput({ categories: [...categories], tags: [...tags] });
  }
  return ContentService.createTextOutput("GAS is running.").setMimeType(ContentService.MimeType.TEXT);
}

// ショートカット/Webアプリからの書き込みを受け取るメイン処理
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (data.type === "stock" && data.action === "delete") {
      deleteStock(ss, data);
    } else if (data.type === "stock") {
      updateStock(ss, data);
    } else if (data.type === "finance") {
      addFinance(ss, data);
    } else if (data.type === "todo") {
      updateTodo(ss, data);
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

// ---- 在庫タブの更新（上書き or 新規追加）----
function updateStock(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];

  const col = {
    id: headers.indexOf("id"),
    itemName: headers.indexOf("itemName"),
    stock: headers.indexOf("stock"),
    location: headers.indexOf("location"),
    tags: headers.indexOf("tags"),
    expirationDate: headers.indexOf("expirationDate"),
    modelNumber: headers.indexOf("modelNumber"),
    lastUpdated: headers.indexOf("lastUpdated"),
  };

  let targetRowIndex = -1; // 0-indexed（values配列内での位置）
  for (let i = 1; i < values.length; i++) {
    if (values[i][col.itemName] === data.target) {
      targetRowIndex = i;
      break;
    }
  }

  const now = new Date();

  if (targetRowIndex === -1) {
    // 新規品目として1行追加
    const newRow = new Array(headers.length).fill("");
    newRow[col.id] = Utilities.getUuid();
    newRow[col.itemName] = data.target || "";
    newRow[col.stock] = Number(data.value) || 0;
    newRow[col.location] = data.location || "";
    newRow[col.tags] = data.tags || "";
    newRow[col.expirationDate] = data.expirationDate || "";
    newRow[col.modelNumber] = data.modelNumber || "";
    newRow[col.lastUpdated] = now;
    sheet.appendRow(newRow);
  } else {
    // 既存品目を更新（stockは加算、他は値があれば上書き）
    const sheetRowNum = targetRowIndex + 1; // シート上の実際の行番号
    const currentStock = Number(values[targetRowIndex][col.stock]) || 0;
    const newStock = currentStock + (Number(data.value) || 0);

    sheet.getRange(sheetRowNum, col.stock + 1).setValue(newStock);
    if (data.location) sheet.getRange(sheetRowNum, col.location + 1).setValue(data.location);
    if (data.tags) sheet.getRange(sheetRowNum, col.tags + 1).setValue(data.tags);
    if (data.expirationDate) sheet.getRange(sheetRowNum, col.expirationDate + 1).setValue(data.expirationDate);
    if (data.modelNumber) sheet.getRange(sheetRowNum, col.modelNumber + 1).setValue(data.modelNumber);
    sheet.getRange(sheetRowNum, col.lastUpdated + 1).setValue(now);
  }
}

// ---- 在庫タブから品目の行を削除 ----
function deleteStock(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const idxName = values[0].indexOf("itemName");

  for (let i = 1; i < values.length; i++) {
    if (values[i][idxName] === data.target) {
      sheet.deleteRow(i + 1); // シート上の実際の行番号
      return;
    }
  }
  throw new Error(`「${data.target}」が在庫に見つかりませんでした。`);
}

// ---- 家計簿タブへの行追加 ----
function addFinance(ss, data) {
  const sheet = ss.getSheetByName(SHEET_FINANCE);
  const headers = sheet.getDataRange().getValues()[0];

  const col = {
    date: headers.indexOf("date"),
    category: headers.indexOf("category"),
    amount: headers.indexOf("amount"),
    memo: headers.indexOf("memo"),
    tags: headers.indexOf("tags"),
  };

  const newRow = new Array(headers.length).fill("");
  newRow[col.date] = new Date();
  newRow[col.category] = data.category || "";
  newRow[col.amount] = Number(data.amount) || 0;
  newRow[col.memo] = data.memo || "";
  newRow[col.tags] = data.tags || "";
  sheet.appendRow(newRow);
}

// =========================================================
// ここから修正：賞味期限切れ防止のDiscord自動通知機能
// =========================================================

// 「在庫」タブのexpirationDateを毎日チェックし、期限が迫っている商品をDiscordへ通知
function checkExpirationAndNotifyDiscord() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idxName = headers.indexOf("itemName");
  const idxExp = headers.indexOf("expirationDate");

  // 【修正】確実に「日本時間の今日（午前0時0分）」を取得する
  const todayStr = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  const today = new Date(todayStr + "T00:00:00+09:00");

  const alerts = [];

  for (let i = 1; i < values.length; i++) {
    const name = values[i][idxName];
    const expRaw = values[i][idxExp];
    if (!name || expRaw === "") continue;

    const expDate = parseExpirationDate(expRaw);
    if (!expDate) continue;

    // 日付の純粋な差分（日数）を計算
    const diffTime = expDate.getTime() - today.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

    // 本日（0日）〜3日以内が対象
    if (diffDays >= 0 && diffDays <= 3) {
      alerts.push({ name: name, diffDays: diffDays });
    }
  }

  if (alerts.length === 0) {
    Logger.log("該当する賞味期限切れ間近の食材はありませんでした。");
    return; 
  }

  const lines = alerts.map(a => {
    const label = a.diffDays === 0 ? "本日期限" : `残り${a.diffDays}日`;
    return `・${a.name}（${label}）`;
  });

  const message = "@everyone 【賞味期限アラート】期限が迫っている食材があります！\n" + lines.join("\n");

  sendDiscordMessage(message);
}

// 【修正】スプレッドシートの表記に関わらず、確実に日本時間のDateオブジェクトに正規化する
function parseExpirationDate(raw) {
  if (raw instanceof Date) {
    const dateStr = Utilities.formatDate(raw, "Asia/Tokyo", "yyyy-MM-dd");
    return new Date(dateStr + "T00:00:00+09:00");
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    let cleaned = raw.trim();
    // スプレッドシート側で「/」区切りになっている場合を考慮
    cleaned = cleaned.replace(/\//g, "-");
    const parts = cleaned.split("-");
    if (parts.length === 3) {
      const year = parts[0];
      const month = parts[1].padStart(2, '0');
      const day = parts[2].padStart(2, '0');
      return new Date(`${year}-${month}-${day}T00:00:00+09:00`);
    }
  }
  return null;
}

// Discord Webhookへメッセージを送信
// 429（レート制限）の場合は待ってから再送し、最終的に失敗したらエラーを投げる
function sendDiscordMessage(content) {
  const MAX_RETRIES = 3;
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ content: content }),
    muteHttpExceptions: true
  };
  const url = getDiscordWebhookUrl();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();

    if (code >= 200 && code < 300) {
      Logger.log("Discordへ通知を送信しました。");
      return;
    }

    if (code !== 429 || attempt === MAX_RETRIES) {
      throw new Error(`Discordへの送信に失敗しました（HTTP ${code}）: ${res.getContentText().slice(0, 200)}`);
    }

    // Retry-Afterヘッダ（秒）があれば従い、なければ 5秒→10秒→20秒 と待つ（最大60秒）
    const headers = res.getHeaders();
    const retryAfterSec = Number(headers["Retry-After"] || headers["retry-after"]);
    const waitMs = Math.min(retryAfterSec > 0 ? retryAfterSec * 1000 : 5000 * Math.pow(2, attempt), 60000);
    Logger.log(`Discordからレート制限（429）を受けました。${waitMs / 1000}秒後に再送します（${attempt + 1}/${MAX_RETRIES}）。`);
    Utilities.sleep(waitMs);
  }
}

function updateTodo(ss, data) {
  const sheet = ss.getSheetByName("家事");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const col = {
    id: headers.indexOf("id"),
    taskName: headers.indexOf("taskName"),
    cycle: headers.indexOf("cycle"),
    lastDone: headers.indexOf("lastDone"),
    isDone: headers.indexOf("isDone"),
  };

  if (data.action === "add") {
    const newRow = new Array(headers.length).fill("");
    newRow[col.id] = Utilities.getUuid();
    newRow[col.taskName] = data.taskName || "";
    newRow[col.cycle] = data.cycle || "";
    newRow[col.lastDone] = "";
    newRow[col.isDone] = false;
    sheet.appendRow(newRow);
  } else if (data.action === "done") {
    for (let i = 1; i < values.length; i++) {
      if (values[i][col.id] === data.id) {
        const rowNum = i + 1;
        // 日本時間の日付オブジェクトを書き込み
        sheet.getRange(rowNum, col.lastDone + 1).setValue(new Date());
        sheet.getRange(rowNum, col.isDone + 1).setValue(true);
        break;
      }
    }
  }
}


// 【デバッグ用】強制的にDiscordへテスト通知を送る関数
function debugForceDiscordNotify() {
  // ※もしエラーが出る場合は、スクリプトプロパティ DISCORD_WEBHOOK_URL が正しく設定されているか確認してください
  sendDiscordMessage("@everyone \n🔔 【テスト成功！】GASからDiscordへの通信が100%成功しました。アプリは正常に動いています！");
}
