// =========================================================
// 通知：Discord への送信と、賞味期限が近い食材の通知
// =========================================================

// Discord Webhook URLはスクリプトプロパティ「DISCORD_WEBHOOK_URL」から読み込む
function getDiscordWebhookUrl() {
  const url = PropertiesService.getScriptProperties().getProperty("DISCORD_WEBHOOK_URL");
  if (!url) throw new Error("スクリプトプロパティ DISCORD_WEBHOOK_URL が設定されていません。");
  return url;
}

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

// 【デバッグ用】強制的にDiscordへテスト通知を送る関数
function debugForceDiscordNotify() {
  // ※もしエラーが出る場合は、スクリプトプロパティ DISCORD_WEBHOOK_URL が正しく設定されているか確認してください
  sendDiscordMessage("@everyone \n🔔 【テスト成功！】GASからDiscordへの通信が100%成功しました。アプリは正常に動いています！");
}
