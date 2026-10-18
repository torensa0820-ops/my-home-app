// =========================================================
// セールチェック：Claude のスケジュールタスクが「セールチェック」シートに追記した結果を Discord に通知する
// ・notifiedAt が空の行を runId（実行日）ごとにまとめ、古い回から1回分ずつ1つの通知にする
// ・送信できた回の全行の notifiedAt に送信日時を書く（失敗したら書かず、次回また送る）
// =========================================================
const SHEET_SALE_CHECK = "セールチェック";
const SALE_MENTION = ""; // 通知の先頭に付けるメンション（"@everyone" にすると付く）
const SALE_DISCORD_LIMIT = 2000; // Discord の1メッセージの上限（文字数）

// 【トリガーで1時間ごとに実行】未送信のセールチェックを通知する
function notifySaleCheck() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log("ほかの処理が実行中のため、今回は通知しませんでした。");
    return;
  }
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SALE_CHECK);
    const runs = getPendingSaleRuns(sheet);
    if (runs.length === 0) {
      Logger.log("未送信のセールチェックはありませんでした。");
      return;
    }
    const col = sheet.getDataRange().getValues()[0].indexOf("notifiedAt") + 1;
    runs.forEach(run => {
      // 1回分が複数のメッセージに分かれたときは、途中で失敗すると次回は最初から送り直す
      buildSaleMessages(run).forEach(msg => sendDiscordMessage(msg));
      const ts = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");
      run.rows.forEach(r => sheet.getRange(r.row, col).setValue(ts));
      Logger.log(`セールチェック ${run.runId} を通知しました（${run.rows.length}行）。`);
    });
  } finally {
    lock.releaseLock();
  }
}

// 【一度だけ実行】notifySaleCheck を1時間ごとに実行するトリガーを作る（作り直しても重複しない）
function setupSaleCheckTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "notifySaleCheck")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("notifySaleCheck").timeBased().everyHours(1).create();
  Logger.log("notifySaleCheck を1時間ごとに実行するトリガーを作成しました");
}

// 【デバッグ用】未送信分の通知文をログに出す（送信も notifiedAt の書き込みもしない）
function debugSaleCheckPreview() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SALE_CHECK);
  const runs = getPendingSaleRuns(sheet);
  if (runs.length === 0) {
    Logger.log("未送信のセールチェックはありませんでした。");
    return;
  }
  runs.forEach(run => {
    const msgs = buildSaleMessages(run);
    msgs.forEach((msg, i) => Logger.log(`---- ${run.runId}（${i + 1}/${msgs.length}・${msg.length}文字）----\n${msg}`));
  });
}

// ---- シートの読み取り ----

// notifiedAt が空の行を runId ごとにまとめ、runId の古い順に返す
function getPendingSaleRuns(sheet) {
  if (!sheet) throw new Error(`シート「${SHEET_SALE_CHECK}」が見つかりません。`);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  if (headers.indexOf("runId") === -1 || headers.indexOf("notifiedAt") === -1) {
    throw new Error(`シート「${SHEET_SALE_CHECK}」に runId または notifiedAt の列がありません。`);
  }
  const byRun = {};
  values.slice(1).forEach((r, i) => {
    const o = {};
    headers.forEach((h, j) => o[h] = r[j]);
    if (String(o.notifiedAt ?? "").trim() !== "") return;
    // runId が日付として読み込まれていても yyyy-MM-dd にそろえる
    const runId = o.runId instanceof Date
      ? Utilities.formatDate(o.runId, "Asia/Tokyo", "yyyy-MM-dd") : String(o.runId ?? "").trim();
    if (!runId) return;
    o.row = i + 2;
    (byRun[runId] = byRun[runId] || []).push(o);
  });
  return Object.keys(byRun).sort().map(runId => ({ runId: runId, rows: byRun[runId] }));
}

// ---- 通知文 ----

// 1回分の通知文を作り、Discord の上限を超えるなら行の途中で切らずに複数のメッセージに分ける
function buildSaleMessages(run) {
  const isSummary = r => String(r.site).trim() === "まとめ" || String(r.verdict).trim() === "まとめ";
  const items = run.rows.filter(r => !isSummary(r));
  const memos = run.rows.filter(isSummary).map(r => saleOneLine(r.memo)).filter(Boolean);
  const buy = items.filter(r => String(r.verdict).trim() === "買い");
  const wait = items.filter(r => String(r.verdict).trim() === "待ち");
  const skip = items.filter(r => String(r.verdict).trim() === "見送り");

  // ブロック（項目1つ分など）単位で並べ、分けるときもブロックの途中ではなるべく切らない
  const blocks = [(SALE_MENTION ? SALE_MENTION + " " : "") + `【セールチェック ${saleRunLabel(run.runId)}】`];
  if (buy.length === 0 && wait.length === 0) {
    const kinds = new Set(items.map(r => String(r.itemName).trim()).filter(Boolean)).size;
    blocks.push(`今週はおすすめなし（${kinds}品目を確認）`);
  } else {
    if (buy.length) {
      blocks.push(`🛒 買い（${buy.length}件）`);
      buy.forEach(r => blocks.push(saleItemBlock(r)));
    }
    if (wait.length) {
      blocks.push(`⏳ 待ち（${wait.length}件）`);
      wait.forEach(r => blocks.push(saleItemBlock(r)));
    }
    if (skip.length) blocks.push(`見送り ${skip.length}件`);
  }
  if (memos.length) blocks.push("📝 " + memos.join("\n"));
  return saleSplitMessages(blocks, SALE_DISCORD_LIMIT);
}

// 項目1つ分（・米：Yahoo 〇〇ストア ブレンド米 10kg ／ 実質…／ <URL> ／ memo）
function saleItemBlock(r) {
  const name = String(r.itemName ?? "").trim();
  const where = [r.site, r.shop, r.productName].map(v => String(v ?? "").trim()).filter(Boolean).join(" ");
  const lines = [`・${name}${where ? "：" + where : ""}`];

  const price = saleNum(r.effectivePrice);
  const unitPrice = saleNum(r.effectiveUnitPrice);
  const diff = saleNum(r.diffPct);
  const qty = saleNum(r.buyQty);
  const notes = [];
  if (unitPrice !== null) {
    const unit = saleUnit(r.packQty);
    notes.push(unit ? `${saleYen(unitPrice, 1)}円/${unit}` : `単価 ${saleYen(unitPrice, 1)}円`);
  }
  if (diff !== null) {
    const d = Math.sign(diff) * Math.round(Math.abs(diff)); // 四捨五入（-18.5 → -19）
    notes.push(`普段より ${d > 0 ? "+" : ""}${d}%`);
  }
  let detail = price !== null ? `実質 ${saleYen(price, 0)}円` : "";
  if (notes.length) detail += `（${notes.join("、")}）`;
  if (qty !== null && qty > 0) detail += `おすすめ${qty}個`;
  const deadline = saleDeadline(r.deadline);
  if (deadline) detail += (detail ? " ／ " : "") + `${deadline}まで`;
  if (detail) lines.push("  " + detail);

  const url = String(r.url ?? "").trim();
  if (url) lines.push(`  <${url}>`); // <> で囲むと Discord のリンクプレビューが出ない
  const memo = saleOneLine(r.memo);
  if (memo) lines.push("  " + memo);
  return lines.join("\n");
}

// ブロックを上限までつなげて1メッセージにする。1ブロックが上限を超えるときは行ごとに分ける
function saleSplitMessages(blocks, limit) {
  const pieces = [];
  blocks.forEach(b => {
    if (b.length <= limit) { pieces.push(b); return; }
    b.split("\n").forEach(line => {
      for (let i = 0; i < line.length; i += limit) pieces.push(line.slice(i, i + limit)); // 1行が上限を超えるときだけ切る
    });
  });
  const messages = [];
  let cur = "";
  pieces.forEach(p => {
    if (cur && cur.length + 1 + p.length > limit) {
      messages.push(cur);
      cur = p;
    } else {
      cur = cur ? cur + "\n" + p : p;
    }
  });
  if (cur) messages.push(cur);
  return messages;
}

// ---- 表示用の小さな関数 ----

// "2026-10-24" → "10/24"
function saleRunLabel(runId) {
  const m = String(runId).match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(runId);
}

// 数値に変換する（空・数値でないものは null。"4,980" のような区切り付きも読む）
function saleNum(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,，円%％\s]/g, ""));
  return isFinite(n) ? n : null;
}

// 3桁区切り。digits は小数の最大桁数（498.0 → "498"、49.75 → "49.8"）
function saleYen(n, digits) {
  const p = Math.pow(10, digits);
  const rounded = Math.round(n * p) / p;
  const [int, frac] = String(Math.abs(rounded)).split(".");
  return (rounded < 0 ? "-" : "") + int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? "." + frac : "");
}

// packQty（"10kg"・"24本" など）から単位を取り出す。数値だけなら空
function saleUnit(packQty) {
  return String(packQty ?? "").trim().replace(/^[\d.,\s×xX*]+/, "").trim();
}

// deadline（文字列か日付）を表示用にする。日付で 0:00 なら日付だけ
function saleDeadline(v) {
  if (v instanceof Date) {
    const hm = Utilities.formatDate(v, "Asia/Tokyo", "HH:mm");
    return Utilities.formatDate(v, "Asia/Tokyo", hm === "00:00" ? "M/d" : "M/d HH:mm");
  }
  return saleOneLine(v);
}

// 改行をまとめて1行にする
function saleOneLine(v) {
  return String(v ?? "").replace(/\s*\n\s*/g, " ").trim();
}
