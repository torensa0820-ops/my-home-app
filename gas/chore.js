// =========================================================
// 家事：周期のルール（rule）から次の予定日時（nextDue）を計算し、完了すると次の回へ進める
// 周期の計算は chore-rule.js（画面と共通）を使う
// =========================================================
const SHEET_CHORE = "家事";
const CHORE_MORNING_HOUR = 8; // 期限切れ・時刻なしの家事をまとめて通知する時刻（毎朝）

// ---- 家事の一覧 ----
function getChoreRows() {
  return sheetToObjects(SHEET_CHORE, "taskName");
}

// 家事シートに必要な列がなければ末尾に追加する
function ensureChoreColumns(sheet) {
  const headers = sheet.getDataRange().getValues()[0];
  ["id", "taskName", "rule", "cycle", "nextDue", "lastDone", "notifiedFor"].forEach(name => {
    if (headers.indexOf(name) === -1) {
      headers.push(name);
      sheet.getRange(1, headers.length).setValue(name);
    }
  });
  return headers;
}

function updateTodo(ss, data) {
  const sheet = ss.getSheetByName(SHEET_CHORE);
  const headers = ensureChoreColumns(sheet);
  const col = name => headers.indexOf(name);
  const now = new Date();

  if (data.action === "add") {
    const taskName = String(data.taskName || "").trim();
    if (!taskName) throw new Error("家事名が空です。");
    const rule = choreParseRule(data.rule);
    const err = choreValidate(rule);
    if (err) throw new Error(err);
    const newRow = new Array(headers.length).fill("");
    newRow[col("id")] = Utilities.getUuid();
    newRow[col("taskName")] = taskName;
    newRow[col("rule")] = JSON.stringify(rule);
    newRow[col("cycle")] = choreLabel(rule);
    newRow[col("nextDue")] = choreFirst(rule, now) || "";
    sheet.appendRow(newRow);
    return null;
  }

  if (data.action === "done") {
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][col("id")]) !== String(data.id)) continue;
      const rule = choreParseRule(values[i][col("rule")]);
      if (!rule) throw new Error("この家事には周期が設定されていません。");
      const due = values[i][col("nextDue")] instanceof Date ? values[i][col("nextDue")] : null;
      const next = choreNextAfterDone(rule, now, due);
      sheet.getRange(i + 1, col("lastDone") + 1).setValue(now);
      sheet.getRange(i + 1, col("nextDue") + 1).setValue(next || "");
      return { lastDone: now.toISOString(), nextDue: next ? next.toISOString() : "" };
    }
    throw new Error("家事が見つかりませんでした。一覧を読み込み直してください。");
  }

  if (data.action === "edit" || data.action === "delete") {
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][col("id")]) !== String(data.id)) continue;
      if (data.action === "delete") {
        sheet.deleteRow(i + 1);
        return null;
      }
      // 家事名と周期を上書きする。周期が変わったら次の予定日時を計算し直す
      const taskName = String(data.taskName || "").trim();
      if (!taskName) throw new Error("家事名が空です。");
      const rule = choreParseRule(data.rule);
      const err = choreValidate(rule);
      if (err) throw new Error(err);
      const r = values[i];
      const asDate = v => v instanceof Date ? v : null;
      const next = choreDueAfterEdit(r[col("rule")], rule, asDate(r[col("nextDue")]), asDate(r[col("lastDone")]), now);
      const row = r.slice();
      row[col("taskName")] = taskName;
      row[col("rule")] = JSON.stringify(rule);
      row[col("cycle")] = choreLabel(rule);
      row[col("nextDue")] = next || "";
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return { nextDue: next ? next.toISOString() : "" };
    }
    throw new Error("家事が見つかりませんでした。一覧を読み込み直してください。");
  }
  throw new Error("action が不正です: " + data.action);
}

// 【トリガーで5分ごとに実行】家事の通知
// ・時刻を指定した家事：予定時刻を過ぎたら1回通知する（notifiedFor に予定日時を記録して二重通知を防ぐ）
// ・毎朝 CHORE_MORNING_HOUR 時：今日の時刻なしの家事と、期限切れの家事をまとめて通知する
function checkChores() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CHORE);
  const headers = ensureChoreColumns(sheet);
  const col = name => headers.indexOf(name);
  const values = sheet.getDataRange().getValues();
  const now = new Date();
  const todayStart = choreDayStart(now);
  const tasks = values.slice(1).map((r, i) => ({
    row: i + 2,
    name: r[col("taskName")],
    rule: choreParseRule(r[col("rule")]),
    due: r[col("nextDue")] instanceof Date ? r[col("nextDue")] : null,
    notified: r[col("notifiedFor")] instanceof Date ? r[col("notifiedFor")].getTime() : null,
  })).filter(t => t.name && t.rule && t.due);
  const fmtTime = d => Utilities.formatDate(d, "Asia/Tokyo", "H:mm");

  // 時刻を指定した家事の個別通知
  const timed = tasks.filter(t => t.rule.time && t.due <= now && t.notified !== t.due.getTime());
  if (timed.length) {
    sendDiscordMessage("@everyone 【家事の時間です】\n" + timed.map(t => `・${t.name}（${fmtTime(t.due)}）`).join("\n"));
    timed.forEach(t => sheet.getRange(t.row, col("notifiedFor") + 1).setValue(t.due));
  }

  // 毎朝のまとめ通知（1日1回）
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd");
  if (now.getHours() < CHORE_MORNING_HOUR || props.getProperty("CHORE_DIGEST_DATE") === today) return;
  const justNotified = new Set(timed.map(t => t.row));
  const list = tasks.filter(t => !justNotified.has(t.row)
    && (t.rule.time ? t.due <= now : t.due < new Date(todayStart.getTime() + 86400000)));
  if (list.length) {
    const lines = list.sort((a, b) => a.due - b.due).map(t => {
      const late = choreDiffDays(todayStart, t.due);
      const when = late > 0 ? `${late}日遅れ` : (t.rule.time ? `今日 ${fmtTime(t.due)}・未完了` : "今日");
      return `・${t.name}（${when}）`;
    });
    sendDiscordMessage("@everyone 【今日の家事】期限切れ・今日やる家事があります\n" + lines.join("\n"));
  }
  props.setProperty("CHORE_DIGEST_DATE", today);
}

// 【一度だけ実行】checkChores を5分ごとに実行するトリガーを作る（作り直しても重複しない）
function setupChoreTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "checkChores")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("checkChores").timeBased().everyMinutes(5).create();
  Logger.log("checkChores を5分ごとに実行するトリガーを作成しました");
}
