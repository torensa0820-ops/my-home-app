// =========================================================
// やることの通知（送り先はスクリプトプロパティ DISCORD_WEBHOOK_URL_REMINDER。なければ DISCORD_WEBHOOK_URL）
// ・期限のある行（家事・用事。買い物でも期限を付けたもの）：時刻を指定したものは予定時刻に、
//   期限切れと時刻なしの今日のものは毎朝 REMINDER_MORNING_HOUR 時にまとめて
// ・買い物：毎週 REMINDER_SHOP_WEEKDAY 曜日の REMINDER_SHOP_HOUR 時ごろに、まだ終わっていない品目のあるリストごとにカード（embed）を1枚
// どちらも checkReminders（5分ごと）から送る。あわせて在庫とのつながり（syncStockReminders）もここで行う
// =========================================================
const REMINDER_MORNING_HOUR = 8; // 期限切れ・時刻なしの今日のものをまとめて通知する時刻（毎朝）
const REMINDER_MENTION = "@everyone"; // 期限の通知の先頭に付けるメンション
const REMINDER_DIGEST_KEY = "CHORE_DIGEST_DATE"; // 朝のまとめを送った日（以前の家事の通知と同じキー。移行した日に二重に送らない）
const REMINDER_SHOP_WEEKDAY = 6; // 買い物の通知の曜日（0=日〜6=土）
const REMINDER_SHOP_HOUR = 8; // 買い物の通知の時刻（この時刻を過ぎた最初の5分ごとの処理で送る）
const REMINDER_SHOP_MENTION = ""; // 買い物の通知の先頭に付けるメンション（"@everyone" にすると付く）
const REMINDER_SHOP_KEY = "REMINDER_SHOP_SENT"; // 買い物の通知を送った日（yyyy-MM-dd）
const REMINDER_SHOP_COLOR = 0xe2bc7a; // リストに色がないときの embed の色
const REMINDER_SHOP_DAYS = 7; // 「今週の特売日」に出す日数（通知の日から）

// 【トリガーで5分ごとに実行】在庫とのつながりと、やることの通知
function checkReminders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log("ほかの処理が実行中のため、今回は何もしませんでした。");
    return;
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss.getSheetByName(SHEET_REMINDER)) {
      Logger.log("「リマインダー」シートがありません。setupReminders を実行してください。");
      return;
    }
    const now = new Date();
    // どれかが失敗しても、ほかは行う（最後にまとめてエラーにする）
    const errors = [];
    [() => syncStockReminders(ss), () => notifyDueReminders(ss, now), () => notifyShoppingIfDue(ss, now)].forEach(fn => {
      try { fn(); } catch (e) { errors.push(e); Logger.log(String(e)); }
    });
    if (errors.length) throw errors[0];
  } finally {
    lock.releaseLock();
  }
}

// 以前の家事のトリガー（checkChores）が残っていても動くようにする。setupReminders でこのトリガーは消える
function checkChores() {
  checkReminders();
}

// ---- 期限のある行 ----

// 期限の通知：時刻を指定したものは予定時刻を過ぎたら1回（notifiedFor に予定日時を書いて二重に送らない）。
// 毎朝 REMINDER_MORNING_HOUR 時に、期限切れと今日のもの（時刻ありは過ぎたもの）をまとめて1回
function notifyDueReminders(ss, now) {
  const plan = buildDueNotice(ss, now);
  if (plan.timed.length) {
    sendDiscordMessage(plan.timedText, "REMINDER");
    plan.timed.forEach(x => receiptWrite(plan.sheet, plan.headers, x.o._row, { notifiedFor: x.due }));
  }
  if (!plan.digestDue) return;
  if (plan.digest.length) sendDiscordMessage(plan.digestText, "REMINDER");
  PropertiesService.getScriptProperties().setProperty(REMINDER_DIGEST_KEY, plan.today);
}

// 通知する内容を作る（送信も書き込みもしない）
// timed：予定時刻を過ぎた時刻指定の行、digest：朝のまとめの行（digestDue が false なら今は送らない）
function buildDueNotice(ss, now) {
  const sheet = ss.getSheetByName(SHEET_REMINDER);
  const t = receiptRead(sheet);
  const lists = {};
  reminderActiveLists(ss).forEach(l => { lists[String(l.id)] = l; });
  const todayStart = choreDayStart(now);
  const tomorrow = new Date(todayStart.getTime() + 86400000);
  const tasks = t.rows.map(o => {
    const list = lists[String(o.listId)];
    if (!list || String(o.status ?? "") !== "" || !(o.nextDue instanceof Date) || !normText(o.title)) return null;
    return { o: o, list: list, due: o.nextDue, timed: reminderTimed(o), notified: o.notifiedFor instanceof Date ? o.notifiedFor.getTime() : null };
  }).filter(Boolean);
  const fmtTime = d => Utilities.formatDate(d, "Asia/Tokyo", "H:mm");

  const timed = tasks.filter(x => x.timed && x.due <= now && x.notified !== x.due.getTime());
  const justNotified = new Set(timed.map(x => x.o._row));
  const today = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd");
  const digestDue = now.getHours() >= REMINDER_MORNING_HOUR && PropertiesService.getScriptProperties().getProperty(REMINDER_DIGEST_KEY) !== today;
  const digest = !digestDue ? [] : tasks
    .filter(x => !justNotified.has(x.o._row) && (x.timed ? x.due <= now : x.due < tomorrow))
    .sort((a, b) => a.due - b.due);

  const label = (x, many) => `${many ? x.list.name + "：" : ""}${normText(x.o.title)}${x.o.assignee ? `［${normText(x.o.assignee)}］` : ""}`;
  const many = arr => new Set(arr.map(x => String(x.list.id))).size > 1; // 複数のリストにまたがるときだけリスト名を付ける
  const timedMany = many(timed);
  const digestMany = many(digest);
  return {
    sheet: sheet, headers: t.headers, today: today, digestDue: digestDue, timed: timed, digest: digest,
    timedText: `${REMINDER_MENTION ? REMINDER_MENTION + " " : ""}【やることの時間です】\n`
      + timed.map(x => `・${label(x, timedMany)}（${fmtTime(x.due)}）`).join("\n"),
    digestText: `${REMINDER_MENTION ? REMINDER_MENTION + " " : ""}【今日のやること】期限切れ・今日やることがあります\n` + digest.map(x => {
      const late = choreDiffDays(todayStart, x.due);
      const when = late > 0 ? `${late}日遅れ` : (x.timed ? `今日 ${fmtTime(x.due)}・未完了` : "今日");
      return `・${label(x, digestMany)}（${when}）`;
    }).join("\n"),
  };
}

// 時刻を指定した行か（くり返しは rule.time。くり返しなしは nextDue が 0:00 ちょうどでなければ時刻あり）
function reminderTimed(o) {
  const rule = choreParseRule(o.rule);
  if (rule) return !!rule.time;
  return o.nextDue instanceof Date && (o.nextDue.getHours() !== 0 || o.nextDue.getMinutes() !== 0);
}

// ---- 買い物 ----

// 買い物の通知の曜日・時刻を過ぎていて、その日にまだ送っていなければ送る
// 全メッセージを送れたら送った日を書く（失敗したら書かず、次の5分ごとの処理で送り直す）
function notifyShoppingIfDue(ss, now) {
  if (now.getDay() !== REMINDER_SHOP_WEEKDAY || now.getHours() < REMINDER_SHOP_HOUR) return;
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd");
  if (props.getProperty(REMINDER_SHOP_KEY) === today) return;
  const payloads = buildShoppingPayloads(ss, now);
  payloads.forEach((p, i) => {
    if (i) Utilities.sleep(SALE_SEND_INTERVAL_MS);
    sendDiscordPayload(p, "REMINDER");
  });
  props.setProperty(REMINDER_SHOP_KEY, today);
  Logger.log(payloads.length ? `買い物の通知を${payloads.length}通送りました。` : "買い物リストに品目がないので、通知しませんでした。");
}

// 買い物の通知のペイロード（品目のあるリストがなければ空の配列）
// まだ終わっていない品目：くり返しなしは status が空のもの、くり返しは今日までに期限が来たもの
function buildShoppingPayloads(ss, now) {
  const lists = reminderActiveLists(ss).filter(l => String(l.kind) === "買い物");
  const tomorrow = new Date(choreDayStart(now).getTime() + 86400000);
  const items = receiptRead(ss.getSheetByName(SHEET_REMINDER)).rows.filter(o => {
    if (String(o.status ?? "") !== "" || !normText(o.title)) return false;
    return !normText(o.rule) || (o.nextDue instanceof Date && o.nextDue < tomorrow);
  });
  const byList = {};
  items.forEach(o => { (byList[String(o.listId)] = byList[String(o.listId)] || []).push(o); });
  const targets = lists.filter(l => (byList[String(l.id)] || []).length);
  if (!targets.length) return [];

  const sale = getReminderSaleInfo(ss);
  const stock = stockSummary(ss);
  const coupons = receiptRead(ss.getSheetByName(SHEET_COUPON)).rows.filter(o => String(o.status ?? "") === "");
  const today = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd");
  const embeds = targets.map(list => {
    const rows = byList[String(list.id)].sort((a, b) => receiptTime(a.createdAt) - receiptTime(b.createdAt));
    const c = shopCouponLines(list, coupons, today);
    const fields = [];
    if (c.coupons.length) fields.push({ name: "クーポン", value: c.coupons.join("\n") });
    if (c.days.length) fields.push({ name: "今週の特売日", value: c.days.join("\n") });
    const embed = saleEmbed({
      title: `🛒 ${list.name}（${rows.length}件）`,
      color: /^#[0-9a-fA-F]{6}$/.test(String(list.color)) ? parseInt(String(list.color).slice(1), 16) : REMINDER_SHOP_COLOR,
      description: rows.map(o => shopItemLine(o, sale, stock)).join("\n"),
      fields: fields.length ? fields : null,
    });
    (embed.fields || []).forEach(f => { f.inline = false; });
    return embed;
  });
  const total = targets.reduce((sum, l) => sum + byList[String(l.id)].length, 0);
  const head = `${REMINDER_SHOP_MENTION ? REMINDER_SHOP_MENTION + " " : ""}今週の買い物：${targets.length}リスト・${total}件`;
  const payloads = saleChunkEmbeds(embeds).map(chunk => ({ embeds: chunk }));
  payloads[0].content = head;
  return payloads;
}

// 品目の行。例「・ボディソープ(Dove) ×2（シトラス）［在庫0・セール待ち・2袋まで］」
function shopItemLine(o, sale, stock) {
  const qty = normText(o.qty);
  const memo = saleOneLine(o.memo);
  const marks = shopItemMarks(o, sale, stock);
  return `・${normText(o.title)}${qty ? (/^\d+$/.test(qty) ? ` ×${qty}` : ` ${qty}`) : ""}${memo ? `（${memo}）` : ""}`
    + (o.assignee ? `［${normText(o.assignee)}］` : "")
    + (marks.length ? `［${marks.join("・")}］` : "");
}

// 品目の印：在庫の数（在庫0・在庫2/目安5）、セールチェックの判定（セール待ち・ネットで買い）、1回に買う上限（2袋まで）
function shopItemMarks(o, sale, stock) {
  const marks = [];
  const g = stock[normText(o.stockItemName)];
  if (normText(o.stockItemName) && g) marks.push(g.reorderAt !== "" ? `在庫${g.total}/目安${g.reorderAt}` : `在庫${g.total}`);
  const key = normText(o.stockItemName) || normText(o.title);
  const verdict = sale.verdicts[key];
  if (verdict) marks.push(verdict === "買い" ? "ネットで買い" : "セール待ち");
  const item = sale.items[key];
  if (item && item.pack) marks.push(item.pack);
  return marks;
}

// その店のクーポン（使える期間内。くり返しのないもの）と、通知の日から REMINDER_SHOP_DAYS 日のくり返しの日
// coupons：「・お買物券 500円値引（〜4/10まで）」、days：「・ふくちゃんデー 会員10%OFF：11/9（月）・11/19（木）」
function shopCouponLines(list, coupons, today) {
  const aliases = reminderStoreAliases(list);
  const last = couponAddDays(today, REMINDER_SHOP_DAYS - 1);
  const out = { coupons: [], days: [] };
  coupons.forEach(o => {
    if (aliases.indexOf(reminderStoreKey(o.store)) === -1) return;
    const from = normDate(o.validFrom);
    const until = normDate(o.validUntil);
    if ((until && until < today) || (from && from > last)) return;
    const title = saleOneLine(o.title);
    const repeat = parseCouponRepeat(o.repeat);
    if (!repeat) {
      out.coupons.push(`・${title}（${couponPeriod(from, until)}）`);
      return;
    }
    const dates = [];
    for (let ymd = today; ymd <= last; ymd = couponAddDays(ymd, 1)) {
      if ((!from || from <= ymd) && (!until || ymd <= until) && couponRepeatMatches(repeat, ymd)) dates.push(ymd);
    }
    if (dates.length) {
      out.days.push(`・${title}：` + dates.map(ymd => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}（${"日月火水木金土"[new Date(ymd + "T00:00:00Z").getUTCDay()]}）`).join("・"));
    }
  });
  return out;
}

// ---- デバッグ用 ----

// 【デバッグ用】今の期限の通知文をログに出す（送信も notifiedFor・送った日の書き込みもしない）
function debugReminderNotifyPreview() {
  const plan = buildDueNotice(SpreadsheetApp.getActiveSpreadsheet(), new Date());
  Logger.log(plan.timed.length ? plan.timedText : "予定時刻を過ぎた時刻指定のものはありません。");
  Logger.log(!plan.digestDue ? `朝のまとめは今は送りません（${REMINDER_MORNING_HOUR}時前か、今日はもう送りました）。`
    : plan.digest.length ? plan.digestText : "朝のまとめに入るものはありません。");
}

// 【デバッグ用】買い物の通知のペイロードをログに出す（曜日・時刻に関係なく、今の内容で作る。送信も送った日の書き込みもしない）
function debugShoppingNotifyPreview() {
  const payloads = buildShoppingPayloads(SpreadsheetApp.getActiveSpreadsheet(), new Date());
  if (!payloads.length) {
    Logger.log("品目のある買い物リストがないので、通知しません。");
    return;
  }
  payloads.forEach((p, i) => Logger.log(`---- ${i + 1}/${payloads.length} ----\n${JSON.stringify(p, null, 2)}`));
}
