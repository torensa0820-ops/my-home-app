// =========================================================
// カード利用通知メールの取り込み（通知受け取り専用の Gmail アカウントで動かす GAS）
//
// 三井住友カードの「ご利用のお知らせ」メール（iCloud メールのルールで転送されたもの）を読み、
// 「我が家の総合管理」スプレッドシートの「取込待ち」シートに1件ずつ追加する。
// カードの利用通知が来ない App Store・iCloud+ などの支払いは、Apple の領収書メール（同じく転送したもの）から読む。
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
// Apple の領収書（App Store・iCloud+ などのサブスク）。継続課金はカードの利用通知が来ないことがあるので、こちらから取り込む
const APPLE_QUERY = 'subject:"Apple" subject:"領収書"';
// 読むメールの種類。source は取込待ちの source 列に入る値
const MAIL_SOURCES = [
  { query: MAIL_QUERY, source: "card-mail", parse: body => parseCardMail(body) },
  { query: APPLE_QUERY, source: "apple-receipt", parse: body => parseAppleReceipt(body) },
];

// ---- 定期実行：新しい通知メールを読み、取込待ちシートに追加する ----
function importCardMails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // 前回の実行がまだ続いていれば今回は何もしない
  try {
    const label = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
    const from = PropertiesService.getScriptProperties().getProperty("ALLOWED_FROM");
    let sheet = null, known = null;
    const rows = [];
    MAIL_SOURCES.forEach(src => {
      const query = `${src.query} -label:${DONE_LABEL}${from ? " from:" + from : ""} newer_than:30d`;
      const threads = GmailApp.search(query, 0, 50);
      if (!threads.length) return;
      if (!sheet) {
        sheet = getImportSheet();
        known = new Set(sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(r => String(r[0])));
      }
      threads.forEach(thread => {
        thread.getMessages().forEach(msg => {
          const base = "mail:" + msg.getId();
          if (known.has(base) || known.has(base + "#1")) return; // 取り込み済み
          rows.push(...mailToRows(msg, base, src));
          known.add(base); // 両方の検索に当たったメールを二重に入れない
        });
        thread.addLabel(label);
      });
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
// 金額が0円のもの（無料アプリの入手など）は入れない。すべて0円なら行を作らない
// 利用日時が書かれていないメール（Apple の領収書の英語版など）は、受信した日にする
function mailToRows(msg, base, src) {
  const received = Utilities.formatDate(msg.getDate(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");
  const parsed = src.parse(msg.getPlainBody());
  if (!parsed.length) {
    return [[base, src.source, "", "", "", "", "", received, "error", "読み取れませんでした：" + msg.getSubject()]];
  }
  const usages = parsed.filter(u => u.amount > 0);
  return usages.map((u, i) => [
    usages.length > 1 ? `${base}#${i + 1}` : base,
    src.source, u.usedAt || received.slice(0, 10), u.merchant, u.kind, u.amount, u.card, received, "", "",
  ]);
}

// ---- メール本文の読み取り ----
// 本文（HTML メールをテキストにしたもの）から利用日時・店名・取引の種類・金額を探す。次の2つの形に対応する
//   項目ごとの行：「◇利用日:yyyy/MM/dd HH:mm」「◇利用先:店名」「◇利用取引:買物」「◇利用金額:1,550円」
//   1行に並ぶ形：「ご利用日時：yyyy/MM/dd HH:mm 店名（買物） 545円」
//   金額が「3,153.00 JPY」のように通貨コードで書かれる形（Uber Eats など。JPY 以外の通貨は円の金額が分からないので読み取らない）
// 戻り値：[{usedAt:"yyyy/MM/dd HH:mm", merchant, kind, amount, card}]
function parseCardMail(body) {
  const text = String(body || "").normalize("NFKC").replace(/\r/g, "");
  const cardLine = text.match(/ご利用カード\s*:\s*([^\n]+)/);
  const cardMatch = text.match(/三井住友カード\s*(.*?)\s*について/);
  const card = cardLine ? cardLine[1].trim() : cardMatch ? ("三井住友カード " + cardMatch[1]).trim() : "";
  const pad = s => String(s).padStart(2, "0");
  const result = [];
  const add = (m, merchant, kind, amountText) => {
    const amount = Math.round(Number(amountText.replace(/,/g, ""))); // 「3,153.00」のような小数つきも整数の円にする
    if (!merchant || !(amount > 0)) return;
    result.push({
      usedAt: `${m[1]}/${pad(m[2])}/${pad(m[3])} ${pad(m[4])}:${m[5]}`,
      merchant: merchant, kind: kind, amount: amount, card: card,
    });
  };
  let m;
  // 項目ごとの行（「利用日時」ではなく「利用日」の直後に「:」が来るものだけ）
  const lines = /利用日\s*:\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})[^\n]*\n\s*◇?\s*利用先\s*:([^\n]*)\n\s*◇?\s*利用取引\s*:([^\n]*)\n\s*◇?\s*利用金額\s*:\s*([\d,]+(?:\.\d+)?)\s*(?:円|JPY)/g;
  while ((m = lines.exec(text))) add(m, m[6].trim(), m[7].trim(), m[8]);
  if (result.length) return result;
  const inline = /ご利用日時\s*:\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})([\s\S]*?)([\d,]+(?:\.\d+)?)\s*(?:円|JPY)/g;
  while ((m = inline.exec(text))) {
    // 日時と金額の間の文字が「店名（取引の種類）」。改行・余分な空白を除く
    const between = m[6].replace(/\s+/g, " ").trim();
    const kindMatch = between.match(/^(.*?)\s*\(([^()]*)\)$/);
    add(m, (kindMatch ? kindMatch[1] : between).trim(), kindMatch ? kindMatch[2].trim() : "", m[7]);
  }
  return result;
}

// Apple の領収書の本文から、品目ごとの支払いを読む（手で転送したときに付く「転送されたメッセージ」の見出しは読み飛ばす）
//   「領収書」の下の1行だけの日付「2026年10月28日」が支払いの日
//   「Apple Account:」（とその次のメールアドレスの行）から「請求とお支払い」「小計」までが品目の並び。品目ごとに
//     アプリ名（「iCloud」）、品目（「200 GBのiCloud+(月額)」）、「更新日:…」、金額「¥540」、「JCT(10%)を含む¥49」の行が続く
//   「------」の線の次の行が支払いに使ったカード（「Visa •••• 1234」）
// 戻り値：[{usedAt:"yyyy/MM/dd", merchant:アプリ名, kind:品目, amount, card}]（0円の品目も入る。読めなければ空）
function parseAppleReceipt(body) {
  const text = String(body || "").normalize("NFKC").replace(/\r/g, "");
  const lines = text.split("\n").map(s => s.replace(/^[\s*]+|[\s*]+$/g, "")); // 転送で付く太字の「*」も外す
  const date = text.match(/^[\s*]*(\d{4})年(\d{1,2})月(\d{1,2})日[\s*]*$/m);
  const pad = s => String(s).padStart(2, "0");
  const usedAt = date ? `${date[1]}/${pad(date[2])}/${pad(date[3])}` : "";
  const cardMatch = text.match(/-{5,}\s*\n\s*([^\n]+)/);
  const card = cardMatch ? cardMatch[1].replace(/^[\s*]+|[\s*]+$/g, "") : "";
  const head = lines.findIndex(s => /^(Apple Account|Apple ID|Apple アカウント)\s*:?$/i.test(s));
  if (head === -1) return [];
  const account = lines.findIndex((s, i) => i > head && s); // 次の空でない行はアカウントのメールアドレス
  const result = [];
  let names = [];
  for (let i = account + 1; account !== -1 && i < lines.length; i++) {
    const s = lines[i];
    if (/^(請求とお支払い|請求先|小計|Billing|Subtotal)/i.test(s)) break;
    if (!s || /^更新日|を含む|^\[image:/.test(s)) continue;
    const price = s.match(/^[¥\\]\s*([\d,]+)$/);
    if (!price) { names.push(s); continue; }
    if (names.length) {
      result.push({ usedAt: usedAt, merchant: names[0], kind: names.slice(1).join(" "), amount: Number(price[1].replace(/,/g, "")), card: card });
    }
    names = [];
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
  MAIL_SOURCES.forEach(src => {
    const threads = GmailApp.search(src.query, 0, 5);
    if (!threads.length) { Logger.log(`${src.source}：メールが見つかりません。転送の設定を確認してください。`); return; }
    threads.forEach(t => t.getMessages().forEach(msg => {
      Logger.log(`${src.source}\n件名：${msg.getSubject()}\n差出人：${msg.getFrom()}\n結果：${JSON.stringify(src.parse(msg.getPlainBody()))}`);
    }));
  });
}

// ---- 【確認用】最新の通知メール1通の本文（読み取りに使うテキスト）をログに出す ----
// 読み取れないときに、本文の形を確かめるために使う。改行などが見えるよう JSON の文字列で出す
function debugDumpLatestBody() {
  dumpLatestBody(MAIL_QUERY);
}

// ---- 【確認用】最新の Apple の領収書メール1通の本文をログに出す ----
function debugDumpLatestAppleBody() {
  dumpLatestBody(APPLE_QUERY);
}

function dumpLatestBody(query) {
  const threads = GmailApp.search(query, 0, 1);
  if (!threads.length) { Logger.log("通知メールが見つかりません。転送の設定を確認してください。"); return; }
  const msg = threads[0].getMessages().pop();
  const text = String(msg.getPlainBody() || "").normalize("NFKC").replace(/\r/g, "");
  Logger.log(`件名：${msg.getSubject()}\n差出人：${msg.getFrom()}\n本文（${text.length}文字）：`);
  // ログ1件の長さに上限があるので、1500文字ずつに分けて出す
  for (let i = 0; i < Math.min(text.length, 6000); i += 1500) Logger.log(JSON.stringify(text.slice(i, i + 1500)));
}
