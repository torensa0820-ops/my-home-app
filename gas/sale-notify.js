// =========================================================
// セールチェック：Claude のスケジュールタスクが「セールチェック」シートに追記した結果を Discord に通知する
// ・notifiedAt が空の行を runId（実行日）ごとにまとめ、古い回から1回分ずつ送る
// ・1回分は「買い・待ち」「店頭で買う物」「まとめ」の最大3メッセージ（embed が多いときは買い・待ちを分ける）
// ・全メッセージを送信できた回だけ、全行の notifiedAt に送信日時を書く（失敗したら書かず、次回また最初から送る）
// =========================================================
const SHEET_SALE_CHECK = "セールチェック";
const SHEET_SALE_ITEMS = "セール品目";
const SALE_MENTION = ""; // 通知の先頭に付けるメンション（"@everyone" にすると付く）
const SALE_DISCORD_LIMIT = 2000; // Discord の1メッセージの上限（文字数）。クーポンの通知でも使う
const SALE_EMBEDS_PER_MESSAGE = 10; // 1メッセージの embed の上限（個数）
const SALE_EMBED_CHARS_PER_MESSAGE = 6000; // 1メッセージの embed の合計の上限（文字数）
const SALE_SEND_INTERVAL_MS = 1000; // レート制限を避けるため、送信のあいだにあける時間
const SALE_COLOR_BUY = 0x23a55a;
const SALE_COLOR_WAIT = 0xf0b232;
const SALE_COLOR_STORE = 0x5865f2;
const SALE_COLOR_SUMMARY = 0x80848e;

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
    const masters = getSaleMasters();
    let sent = false;
    runs.forEach(run => {
      // 途中で失敗するとエラーで止まり、notifiedAt を書かないので次回は最初から送り直す
      buildSalePayloads(run, masters).forEach(payload => {
        if (sent) Utilities.sleep(SALE_SEND_INTERVAL_MS);
        sendDiscordPayload(payload, "SALE");
        sent = true;
      });
      const ts = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");
      setSameValue(sheet, run.rows.map(r => [r.row, col]), ts);
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

// 【デバッグ用】未送信分のペイロードをメッセージごとにログに出す（送信も notifiedAt の書き込みもしない）
function debugSaleCheckPreview() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SALE_CHECK);
  const runs = getPendingSaleRuns(sheet);
  if (runs.length === 0) {
    Logger.log("未送信のセールチェックはありませんでした。");
    return;
  }
  const masters = getSaleMasters();
  runs.forEach(run => {
    const payloads = buildSalePayloads(run, masters);
    payloads.forEach((p, i) => Logger.log(`---- ${run.runId}（${i + 1}/${payloads.length}）----\n${JSON.stringify(p, null, 2)}`));
  });
}

// ---- シートの読み取り ----

// notifiedAt が空の行がある回を runId の古い順に返す
// rows は未送信の行、allRows は通知済みも含むその回の全行（店頭で買う物の判定に使う）
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
    // runId が日付として読み込まれていても yyyy-MM-dd にそろえる
    const runId = o.runId instanceof Date
      ? Utilities.formatDate(o.runId, "Asia/Tokyo", "yyyy-MM-dd") : String(o.runId ?? "").trim();
    if (!runId) return;
    o.row = i + 2;
    const run = byRun[runId] = byRun[runId] || { runId: runId, rows: [], allRows: [] };
    run.allRows.push(o);
    if (String(o.notifiedAt ?? "").trim() === "") run.rows.push(o);
  });
  return Object.keys(byRun).sort().map(runId => byRun[runId]).filter(run => run.rows.length > 0);
}

// 「セール品目」（itemName ごとの行）と「在庫」（itemName ごとの stock の合計）を読む
function getSaleMasters() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const items = {};
  saleSheetRows(ss, SHEET_SALE_ITEMS).forEach(o => {
    const name = saleName(o);
    if (name && !items[name]) items[name] = o;
  });
  const stocks = {};
  saleSheetRows(ss, SHEET_STOCK).forEach(o => {
    const name = saleName(o);
    if (name) stocks[name] = (stocks[name] || 0) + (saleNum(o.stock) || 0);
  });
  return { items: items, stocks: stocks };
}

// シートの行を、1行目の見出しをキーにしたオブジェクトの配列にする
function saleSheetRows(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error(`シート「${name}」が見つかりません。`);
  const values = sheet.getDataRange().getValues();
  return values.slice(1).map(r => {
    const o = {};
    values[0].forEach((h, j) => o[h] = r[j]);
    return o;
  });
}

// ---- 通知のペイロード ----

// 1回分のペイロードを送る順に返す（買い・待ち → 店頭で買う物 → まとめ）
function buildSalePayloads(run, masters) {
  const payloads = saleCandidatePayloads(run, masters);
  const store = saleStorePayload(run, masters);
  if (store) payloads.push(store);
  payloads.push(saleSummaryPayload(run));
  return payloads;
}

// メッセージ1：買い・待ち（1候補＝1つの embed。上限を超えるときは分け、content は最初の1通だけ）
function saleCandidatePayloads(run, masters) {
  const byDiff = verdict => saleSortByDiff(run.rows.filter(r => !isSaleSummary(r) && saleVerdict(r) === verdict));
  const buy = byDiff("買い");
  const wait = byDiff("待ち");
  const head = (SALE_MENTION ? SALE_MENTION + " " : "") + `セールチェック ${saleRunLabel(run.runId)}`;
  if (buy.length === 0 && wait.length === 0) return [{ content: `${head}　今週は買い・待ちなし` }];

  const embeds = buy.concat(wait).map(r => saleCandidateEmbed(r, masters));
  const payloads = saleChunkEmbeds(embeds).map(chunk => ({ embeds: chunk }));
  payloads[0] = { content: `${head}　買い ${buy.length}件・待ち ${wait.length}件`, embeds: payloads[0].embeds };
  return payloads;
}

// 候補1つ分の embed
function saleCandidateEmbed(r, masters) {
  const isBuy = saleVerdict(r) === "買い";
  const name = saleName(r);
  const item = masters.items[name] || {};
  const unit = String(item.unit ?? "").trim();
  const diff = saleNum(r.diffPct);

  const price = saleNum(r.price);
  const packQty = String(r.packQty ?? "").trim();
  const buyQty = String(r.buyQty ?? "").trim();
  let detail = price !== null ? `**${saleYen(price, 0)}円**` : "";
  if (packQty) detail += `（${packQty}）`;
  if (buyQty) detail += `${packQty ? "" : " "}× ${buyQty}`;

  const basePrice = saleNum(item.basePrice);
  const unitQty = saleNum(item.unitQty);
  const base = basePrice !== null && unitQty ? basePrice / unitQty : null;

  return saleEmbed({
    title: `${isBuy ? "🟢" : "🟡"} ${name}` + (diff !== null ? `　${saleDiffLabel(diff)}%` : ""),
    url: saleEmbedUrl(r.url),
    color: isBuy ? SALE_COLOR_BUY : SALE_COLOR_WAIT,
    description: [String(r.site ?? "").trim(), detail].filter(Boolean).join("　"),
    fields: [
      { name: "実質単価", value: saleUnitPrice(saleNum(r.effectiveUnitPrice), unit) },
      { name: "普段", value: saleUnitPrice(base, unit) },
      { name: "期限", value: saleDeadline(r.deadline) || "—" }
    ],
    footer: [String(r.shop ?? "").trim(), saleFirstSentence(r.memo)].filter(Boolean).join("・")
  });
}

// メッセージ2：在庫が普段の1回分より少ないのに、その回で買い・待ちがなかった品目（なければ null）
function saleStorePayload(run, masters) {
  // 通知済みの買い・待ち（チャットで確認済みなど）がある品目も「ネットの候補あり」として除く
  const candidates = new Set(run.allRows
    .filter(r => !isSaleSummary(r) && ["買い", "待ち"].indexOf(saleVerdict(r)) !== -1).map(saleName));
  const names = Array.from(new Set(run.rows.filter(r => !isSaleSummary(r)).map(saleName)));
  const targets = names.filter(name => name && !candidates.has(name)).map(name => {
    const item = masters.items[name];
    const stock = masters.stocks[name];
    const unitQty = item ? saleNum(item.unitQty) : null;
    if (stock === undefined || unitQty === null) return null; // 在庫か1回分の量が分からない
    const stockPerUnit = saleNum(item.stockPerUnit);
    if (stock * (stockPerUnit === null ? unitQty : stockPerUnit) >= unitQty) return null;
    return { name: name, item: item, stock: stock, unit: stockPerUnit === 1 ? String(item.unit ?? "").trim() : "個" };
  }).filter(Boolean);
  if (targets.length === 0) return null;

  const shops = new Set(targets.map(t => String(t.item.baseShop ?? "").trim()));
  const sameShop = shops.size === 1;
  const lines = targets.map(t => {
    const basePrice = saleNum(t.item.basePrice);
    const shop = String(t.item.baseShop ?? "").trim();
    let line = `・${t.name}` + (t.stock > 0 ? `（残り${t.stock}${t.unit}）` : "（在庫0）");
    if (basePrice !== null) line += `${saleYen(basePrice, 0)}円` + (!sameShop && shop ? `・${shop}` : "");
    return line;
  });
  const shop = sameShop ? Array.from(shops)[0] : "";
  return {
    embeds: [saleEmbed({
      title: "🏪 店頭で買う物（ネットは割高）",
      color: SALE_COLOR_STORE,
      description: lines.join("\n"),
      footer: shop ? `価格は普段の店（${shop}）` : ""
    })]
  };
}

// メッセージ3：まとめ行の memo を箇条書きにし、最後に見送りの件数を足す
function saleSummaryPayload(run) {
  const lines = run.rows.filter(isSaleSummary)
    .flatMap(r => {
      const memo = String(r.memo ?? "");
      return memo.includes("\n") ? memo.split(/\r?\n/) : memo.split("。"); // 改行がなければ古い形式
    })
    .map(line => line.trim().replace(/^(?:-\s+|・\s*)/, "").trim())
    .filter(line => line && !/^(?:[^：:]*[：:]\s*)?なし[。．.]?$/.test(line))
    .map(line => "・" + saleClip(line, 60));
  const skip = run.rows.filter(r => !isSaleSummary(r) && saleVerdict(r) === "見送り").length;
  lines.push(`・見送り：${skip}件`);
  return {
    embeds: [saleEmbed({
      title: "📋 まとめ",
      color: SALE_COLOR_SUMMARY,
      description: lines.join("\n"),
      footer: "詳しくはスプレッドシート「セールチェック」"
    })]
  };
}

// embed を作る。Discord の上限を超える文字は切り、空の項目は入れない（空だと送信が失敗する）
function saleEmbed(e) {
  const embed = { title: saleClip(e.title, 256) };
  if (e.url) embed.url = e.url;
  embed.color = e.color;
  if (e.description) embed.description = saleClip(e.description, 4096);
  if (e.fields) embed.fields = e.fields.map(f => ({ name: f.name, value: saleClip(f.value, 1024), inline: true }));
  if (e.footer) embed.footer = { text: saleClip(e.footer, 2048) };
  return embed;
}

// embed を1メッセージの上限（個数・文字数）に収まるように分ける
function saleChunkEmbeds(embeds) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  embeds.forEach(e => {
    const n = saleEmbedChars(e);
    if (cur.length >= SALE_EMBEDS_PER_MESSAGE || (cur.length && chars + n > SALE_EMBED_CHARS_PER_MESSAGE)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(e);
    chars += n;
  });
  if (cur.length) chunks.push(cur);
  return chunks;
}

// embed の文字数（Discord が合計の上限に数える項目だけ）
function saleEmbedChars(e) {
  const texts = [e.title, e.description, e.footer && e.footer.text];
  (e.fields || []).forEach(f => texts.push(f.name, f.value));
  return texts.reduce((sum, t) => sum + saleCharCount(t || ""), 0);
}

// ---- 表示用の小さな関数 ----

function isSaleSummary(r) {
  return String(r.site).trim() === "まとめ" || saleVerdict(r) === "まとめ";
}

function saleVerdict(r) {
  return String(r.verdict).trim();
}

function saleName(r) {
  return String(r.itemName ?? "").trim();
}

// diffPct の小さい順（安い順）に並べる。空は後ろ
function saleSortByDiff(rows) {
  const diff = r => {
    const n = saleNum(r.diffPct);
    return n === null ? Infinity : n;
  };
  return rows.slice().sort((a, b) => diff(a) < diff(b) ? -1 : diff(a) > diff(b) ? 1 : 0);
}

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

// 単価の表示。1未満は小数2桁、1以上は整数（0.8327 → "0.83円/g"、1083 → "1,083円/本"）。空なら "—"
function saleUnitPrice(n, unit) {
  if (n === null) return "—";
  return (n < 1 ? n.toFixed(2) : saleYen(n, 0)) + "円" + (unit ? "/" + unit : "");
}

// diffPct の表示。小数1桁で符号をつける（-16.5 → "-16.5"、3.2 → "+3.2"）
function saleDiffLabel(diff) {
  return (diff > 0 ? "+" : "") + diff.toFixed(1);
}

// deadline（日付か文字列）を M/d HH:mm にする。時刻のない文字列は M/d、読めない文字列はそのまま
function saleDeadline(v) {
  if (v instanceof Date) return Utilities.formatDate(v, "Asia/Tokyo", "M/d HH:mm");
  const text = saleOneLine(v);
  const m = text.match(/^\d{4}[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return text;
  const date = `${Number(m[1])}/${Number(m[2])}`;
  return m[3] ? `${date} ${m[3].padStart(2, "0")}:${m[4]}` : date;
}

// memo の最初の文（最初の「。」まで）。40字を超えたら切る
function saleFirstSentence(memo) {
  const text = saleOneLine(memo);
  const end = text.indexOf("。");
  return saleClip(end === -1 ? text : text.slice(0, end + 1), 40);
}

// http(s) の URL だけ返す（不正な URL の embed は Discord に拒否される）
function saleEmbedUrl(v) {
  const url = String(v ?? "").trim();
  return /^https?:\/\/\S+$/.test(url) && url.length <= 2048 ? url : "";
}

// 文字数（絵文字も1字）
function saleCharCount(text) {
  return Array.from(text).length;
}

// max 字を超えたら「…」込みで max 字に切る
function saleClip(text, max) {
  const chars = Array.from(String(text));
  return chars.length <= max ? String(text) : chars.slice(0, max - 1).join("") + "…";
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

// 改行をまとめて1行にする
function saleOneLine(v) {
  return String(v ?? "").replace(/\s*\n\s*/g, " ").trim();
}
