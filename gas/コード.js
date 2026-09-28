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
    const tagCounts = {};
    values.slice(1).forEach(r => {
      const cat = String(r[idxCat]).trim();
      if (cat) categories.add(cat);
      splitTags(r[idxTags]).forEach(t => tagCounts[t] = (tagCounts[t] || 0) + 1);
    });
    return jsonOutput({ categories: [...categories], tags: Object.keys(tagCounts), tagCounts: tagCounts });
  }
  if (e.parameter.action === "getFinance") {
    // 家計簿の記録を新しい順に offset 件目から limit 件返す（タグ一括付与の対象選択用）
    const values = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_FINANCE).getDataRange().getValues();
    const headers = values[0];
    const offset = Number(e.parameter.offset) || 0;
    const limit = Number(e.parameter.limit) || 30;
    const rows = values.slice(1)
      .map((r, i) => {
        const obj = { row: i + 2 }; // シート上の行番号
        headers.forEach((h, j) => obj[h] = r[j] instanceof Date ? r[j].toISOString() : r[j]);
        return obj;
      })
      .filter(r => r.date !== "")
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.row - a.row);
    return jsonOutput({ rows: rows.slice(offset, offset + limit), total: rows.length });
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
    } else if (data.type === "stock" && data.action === "edit") {
      editStock(ss, data);
    } else if (data.type === "stock") {
      updateStock(ss, data);
    } else if (data.type === "finance") {
      addFinance(ss, data);
    } else if (data.type === "todo") {
      updateTodo(ss, data);
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

// ---- 在庫タブの品目を編集（idで特定し、送られた値で上書き。空欄は空欄にする）----
function editStock(ss, data) {
  const sheet = ss.getSheetByName(SHEET_STOCK);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const col = name => headers.indexOf(name);
  const itemName = String(data.itemName || "").trim();
  if (!itemName) throw new Error("商品名が空です。");

  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col("id")]) === String(data.id)) rowIndex = i;
    else if (values[i][col("itemName")] === itemName) throw new Error(`「${itemName}」は既に登録されています。`);
  }
  if (rowIndex === -1) throw new Error("商品が見つかりませんでした。一覧を読み込み直してください。");

  const row = values[rowIndex].slice();
  row[col("itemName")] = itemName;
  row[col("stock")] = Number(data.stock) || 0;
  row[col("location")] = data.location || "";
  row[col("tags")] = data.tags || "";
  row[col("expirationDate")] = data.expirationDate || "";
  row[col("modelNumber")] = data.modelNumber || "";
  row[col("lastUpdated")] = new Date();
  sheet.getRange(rowIndex + 1, 1, 1, row.length).setValues([row]);
}

// タグ文字列を配列に分解（「,」のほか全角の「，」「、」も区切りとして扱う）
function splitTags(s) {
  return String(s).split(/[,，、]/).map(t => t.trim()).filter(Boolean);
}

// ---- タグの一括操作（在庫・家計簿共通）----
// action: "rename"（名称変更。既存タグ名なら統合）/ "delete"（全行から外す）/ "assign"（指定行に付与）
// 戻り値：変更した行数
function manageTags(ss, data) {
  const sheetName = { stock: SHEET_STOCK, finance: SHEET_FINANCE }[data.sheet];
  if (!sheetName) throw new Error("sheet が不正です: " + data.sheet);
  const tag = String(data.tag || "").trim();
  if (!tag) throw new Error("タグ名が空です。");

  const sheet = ss.getSheetByName(sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idxTags = headers.indexOf("tags");
  const rows = values.slice(1);
  const tagsCol = rows.map(r => r[idxTags]);
  let count = 0;

  const setTags = (i, tags) => {
    tagsCol[i] = [...new Set(tags)].join(",");
    count++;
  };

  if (data.action === "rename") {
    const newName = String(data.newName || "").trim();
    if (!newName || /[,，、]/.test(newName)) throw new Error("新しいタグ名が不正です。");
    rows.forEach((r, i) => {
      const tags = splitTags(r[idxTags]);
      if (tags.includes(tag)) setTags(i, tags.map(t => t === tag ? newName : t));
    });
  } else if (data.action === "delete") {
    rows.forEach((r, i) => {
      const tags = splitTags(r[idxTags]);
      if (tags.includes(tag)) setTags(i, tags.filter(t => t !== tag));
    });
  } else if (data.action === "assign") {
    if (/[,，、]/.test(tag)) throw new Error("タグ名に区切り文字は使えません。");
    const targets = data.targets || [];
    if (data.sheet === "stock") {
      // 在庫は商品名で指定
      const idxName = headers.indexOf("itemName");
      const names = new Set(targets);
      rows.forEach((r, i) => {
        const tags = splitTags(r[idxTags]);
        if (names.has(r[idxName]) && !tags.includes(tag)) setTags(i, tags.concat(tag));
      });
    } else {
      // 家計簿は行番号で指定し、一覧取得後にシートが並べ替えられていないか日付で確認する
      const idxDate = headers.indexOf("date");
      targets.forEach(t => {
        const i = Number(t.row) - 2;
        const r = rows[i];
        const date = r && (r[idxDate] instanceof Date ? r[idxDate].toISOString() : r[idxDate]);
        if (!r || date !== t.date) throw new Error("家計簿のデータが変更されています。一覧を読み込み直してください。");
      });
      targets.forEach(t => {
        const i = Number(t.row) - 2;
        const tags = splitTags(tagsCol[i]);
        if (!tags.includes(tag)) setTags(i, tags.concat(tag));
      });
    }
  } else {
    throw new Error("action が不正です: " + data.action);
  }

  if (count > 0) {
    sheet.getRange(2, idxTags + 1, tagsCol.length, 1).setValues(tagsCol.map(v => [v]));
  }
  return count;
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
