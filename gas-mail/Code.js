// =========================================================
// カード利用通知メールの取り込み（通知受け取り専用の Gmail アカウントで動かす GAS）
//
// 三井住友カードの「ご利用のお知らせ」メール（iCloud メールのルールで転送されたもの）を読み、
// 「我が家の総合管理」スプレッドシートの「取込待ち」シートに1件ずつ追加する。
// 家計簿への登録は、くらしログの家計簿タブで内容を確認してから行う（ここでは登録しない）。
//
// スクリプト プロパティ
//   SPREADSHEET_ID  … 書き込み先のスプレッドシートの ID（必須。このアカウントに編集者として共有しておく）
//   ALLOWED_FROM    … 転送元のメールアドレス（任意。設定すると、この差出人のメールだけを読む）
//
// 使い方
//   1. setupTrigger を一度実行する（importCardMails を10分ごとに動かすトリガーを作る。何度実行しても重複しない）
//   2. debugParseLatest で、届いているメールの読み取り結果をログで確かめられる（シートには書き込まない）
// =========================================================

const SHEET_IMPORT = "取込待ち";
const IMPORT_HEADERS = ["id", "source", "usedAt", "merchant", "kind", "amount", "card", "receivedAt", "status", "note"];
const DONE_LABEL = "kurashilog-imported"; // 読み取り済みのメールに付けるラベル（検索で使うので英数字にする）
// 件名は転送で「Fwd:」が付くこともあるので、語句で探す
const MAIL_QUERY = 'subject:"ご利用のお知らせ" subject:"三井住友カード"';

// ---- 定期実行：新しい通知メールを読み、取込待ちシートに追加する ----
function importCardMails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // 前回の実行がまだ続いていれば今回は何もしない
  try {
    const label = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
    const from = PropertiesService.getScriptProperties().getProperty("ALLOWED_FROM");
    const query = `${MAIL_QUERY} -label:${DONE_LABEL}${from ? " from:" + from : ""} newer_than:30d`;
    const threads = GmailApp.search(query, 0, 50);
    if (!threads.length) return;

    const sheet = getImportSheet();
    const known = new Set(sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(r => String(r[0])));
    const rows = [];
    threads.forEach(thread => {
      thread.getMessages().forEach(msg => {
        const base = "mail:" + msg.getId();
        if (known.has(base) || known.has(base + "#1")) return; // 取り込み済み
        rows.push(...mailToRows(msg, base));
      });
      thread.addLabel(label);
    });
    if (rows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, IMPORT_HEADERS.length).setValues(rows);
    }
  } finally {
    lock.releaseLock();
  }
}

// メール1通を取込待ちの行にする。1通に複数の利用があれば id の末尾に #1, #2 … を付ける
// 読み取れなかったときは status="error" の行を1行入れる（くらしログで「読み取れなかったメール」として表示）
function mailToRows(msg, base) {
  const received = Utilities.formatDate(msg.getDate(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");
  const usages = parseCardMail(msg.getPlainBody());
  if (!usages.length) {
    return [[base, "card-mail", "", "", "", "", "", received, "error", "読み取れませんでした：" + msg.getSubject()]];
  }
  return usages.map((u, i) => [
    usages.length > 1 ? `${base}#${i + 1}` : base,
    "card-mail", u.usedAt, u.merchant, u.kind, u.amount, u.card, received, "", "",
  ]);
}

// ---- メール本文の読み取り ----
// 本文（HTML メールをテキストにしたもの）から「ご利用日時：yyyy/MM/dd HH:mm」「店名（買物）」「545円」を探す
// 戻り値：[{usedAt:"yyyy/MM/dd HH:mm", merchant, kind, amount, card}]
function parseCardMail(body) {
  const text = String(body || "").normalize("NFKC").replace(/\r/g, "");
  const cardMatch = text.match(/三井住友カード\s*(.*?)\s*について/);
  const card = cardMatch ? ("三井住友カード " + cardMatch[1]).trim() : "";
  const result = [];
  const re = /ご利用日時\s*[:：]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})([\s\S]*?)([\d,]+)\s*円/g;
  let m;
  while ((m = re.exec(text))) {
    // 日時と金額の間の文字が「店名（取引の種類）」。改行・余分な空白を除く
    const between = m[6].replace(/\s+/g, " ").trim();
    const kindMatch = between.match(/^(.*?)\s*\(([^()]*)\)$/);
    const merchant = (kindMatch ? kindMatch[1] : between).trim();
    const kind = kindMatch ? kindMatch[2].trim() : "";
    const amount = Number(m[7].replace(/,/g, ""));
    if (!merchant || !(amount > 0)) continue;
    const pad = s => String(s).padStart(2, "0");
    result.push({
      usedAt: `${m[1]}/${pad(m[2])}/${pad(m[3])} ${pad(m[4])}:${m[5]}`,
      merchant: merchant, kind: kind, amount: amount, card: card,
    });
  }
  return result;
}

// 取込待ちシート（なければ見出し付きで作る）
function getImportSheet() {
  const id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!id) throw new Error("スクリプトプロパティ SPREADSHEET_ID が設定されていません。");
  const ss = SpreadsheetApp.openById(id);
  let sheet = ss.getSheetByName(SHEET_IMPORT);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_IMPORT);
    sheet.getRange(1, 1, 1, IMPORT_HEADERS.length).setValues([IMPORT_HEADERS]);
    sheet.getRange("C:C").setNumberFormat("@"); // usedAt は文字列のまま保存する
  }
  return sheet;
}

// ---- トリガーの設定（何度実行しても1つだけ） ----
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "importCardMails")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("importCardMails").timeBased().everyMinutes(10).create();
  Logger.log("importCardMails を10分ごとに実行するトリガーを作りました。");
}

// ---- 【確認用】最新の通知メールの読み取り結果をログに出す（シートには書き込まない） ----
function debugParseLatest() {
  const threads = GmailApp.search(MAIL_QUERY, 0, 5);
  if (!threads.length) { Logger.log("通知メールが見つかりません。転送の設定を確認してください。"); return; }
  threads.forEach(t => t.getMessages().forEach(msg => {
    Logger.log(`件名：${msg.getSubject()}\n差出人：${msg.getFrom()}\n結果：${JSON.stringify(parseCardMail(msg.getPlainBody()))}`);
  }));
}
