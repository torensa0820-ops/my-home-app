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
    // 家計簿の記録を新しい順に offset 件目から limit 件返す（履歴表示・タグ一括付与の対象選択用）
    // monthTotals は全記録の月別合計（キーは日本時間の "yyyy-MM"）
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
      .filter(r => r.date !== "");
    // 支出した日（日本時間）の新しい順。同じ日は登録時刻の新しい順
    const day = r => Utilities.formatDate(new Date(r.date), "Asia/Tokyo", "yyyy-MM-dd");
    rows.forEach(r => { r.day = day(r); });
    rows.sort((a, b) => b.day.localeCompare(a.day)
      || String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date))
      || b.row - a.row);
    const monthTotals = {};
    rows.forEach(r => {
      const key = r.day.slice(0, 7);
      monthTotals[key] = (monthTotals[key] || 0) + (Number(r.amount) || 0);
    });
    return jsonOutput({ rows: rows.slice(offset, offset + limit), total: rows.length, monthTotals: monthTotals });
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
    } else if (data.type === "stock" && data.action === "bump") {
      bumpStock(ss, data);
    } else if (data.type === "stock" && data.action === "editItem") {
      editItem(ss, data);
    } else if (data.type === "stock") {
      updateStock(ss, data);
    } else if (data.type === "finance" && data.action === "delete") {
      deleteFinance(ss, data);
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

// =========================================================
// 在庫：1行＝1ロット（同じ商品でも賞味期限ごとに別の行）
// 収納場所・タグ・型番は商品単位の情報として、同じ商品名の全ロットで揃える
// =========================================================

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
  let target = lots.find(i => normDate(values[i][col.expirationDate]) === exp);
  // 期限の指定がない登録（ショートカットなど）で、ロットが1つだけならそのロットに加算する
  if (target === undefined && !exp && lots.length === 1) target = lots[0];

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

// ---- 家計簿 ----
// date は支出した日（入力した日にち）、createdAt はアプリで登録した時刻
// createdAt 列がなければ末尾に追加し、既存の記録には date の値（これまでは登録時刻が入っていた）を写す
function ensureFinanceCreatedAt(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  if (headers.indexOf("createdAt") !== -1) return;
  const col = headers.length + 1;
  const idxDate = headers.indexOf("date");
  sheet.getRange(1, col).setValue("createdAt");
  if (values.length > 1) {
    sheet.getRange(2, col, values.length - 1, 1).setValues(values.slice(1).map(r => [r[idxDate]]));
  }
}

// "yyyy-MM-dd" を日本時間のその日の0時にする。未指定なら今日
function financeDate(str) {
  if (!str) str = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) throw new Error("日付が不正です: " + str);
  return Utilities.parseDate(str, "Asia/Tokyo", "yyyy-MM-dd");
}

// ---- 家計簿タブへの行追加 ----
function addFinance(ss, data) {
  const sheet = ss.getSheetByName(SHEET_FINANCE);
  ensureFinanceCreatedAt(sheet);
  const headers = sheet.getDataRange().getValues()[0];

  const col = {
    date: headers.indexOf("date"),
    category: headers.indexOf("category"),
    amount: headers.indexOf("amount"),
    memo: headers.indexOf("memo"),
    tags: headers.indexOf("tags"),
    createdAt: headers.indexOf("createdAt"),
  };

  const newRow = new Array(headers.length).fill("");
  newRow[col.date] = financeDate(data.date);
  newRow[col.category] = data.category || "";
  newRow[col.amount] = Number(data.amount) || 0;
  newRow[col.memo] = data.memo || "";
  newRow[col.tags] = data.tags || "";
  newRow[col.createdAt] = new Date();
  sheet.appendRow(newRow);
}

// ---- 家計簿の記録を削除 ----
// 行番号で指定し、一覧取得後にシートが変わっていないか date と createdAt で確認してから消す
function deleteFinance(ss, data) {
  const sheet = ss.getSheetByName(SHEET_FINANCE);
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
  sheet.deleteRow(Number(data.row));
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
  const idxStock = headers.indexOf("stock");

  // 【修正】確実に「日本時間の今日（午前0時0分）」を取得する
  const todayStr = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  const today = new Date(todayStr + "T00:00:00+09:00");

  const alerts = [];

  for (let i = 1; i < values.length; i++) {
    const name = values[i][idxName];
    const expRaw = values[i][idxExp];
    if (!name || expRaw === "") continue;
    // 使い切ったロット（個数0以下）は通知しない
    const stock = Number(values[i][idxStock]) || 0;
    if (stock <= 0) continue;

    const expDate = parseExpirationDate(expRaw);
    if (!expDate) continue;

    // 日付の純粋な差分（日数）を計算
    const diffTime = expDate.getTime() - today.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

    // 本日（0日）〜3日以内が対象
    if (diffDays >= 0 && diffDays <= 3) {
      alerts.push({ name: name, diffDays: diffDays, stock: stock });
    }
  }

  if (alerts.length === 0) {
    Logger.log("該当する賞味期限切れ間近の食材はありませんでした。");
    return; 
  }

  const lines = alerts.map(a => {
    const label = a.diffDays === 0 ? "本日期限" : `残り${a.diffDays}日`;
    return `・${a.name}（${label}・${a.stock}個）`;
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

// 【一度だけ実行】家計簿の date を「日にち」だけにそろえ、createdAt 列を追加する
// createdAt には、変換前の date（これまで登録時刻が入っていた）を写す
function migrateFinanceDates() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_FINANCE);
  ensureFinanceCreatedAt(sheet);
  const values = sheet.getDataRange().getValues();
  const idxDate = values[0].indexOf("date");
  if (values.length < 2) return "記録がありません";
  const dates = values.slice(1).map(r => {
    const v = r[idxDate];
    if (!(v instanceof Date)) return [v];
    return [financeDate(Utilities.formatDate(v, "Asia/Tokyo", "yyyy-MM-dd"))];
  });
  sheet.getRange(2, idxDate + 1, dates.length, 1).setValues(dates);
  sheet.getRange(2, idxDate + 1, dates.length, 1).setNumberFormat("yyyy/MM/dd");
  const msg = `${dates.length}件の date を日にちだけにしました`;
  Logger.log(msg);
  return msg;
}
