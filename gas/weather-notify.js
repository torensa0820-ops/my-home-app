// =========================================================
// 天気の通知：毎朝の天気・傘・洗濯・花粉・警報・台風・電車・くらしログを Discord に1通で送る
// ・朝（WX_MORNING_TIME）：1日の通知
// ・朝の通勤時間（WX_TRAIN_WATCH）：電車の運行情報が変わったときだけ追加で送る
// ・夜（WX_EVENING_TIME）：翌日に警報・台風・大雨・強風・計画運休などがあるときだけ送る
// weatherTick を5分ごとに動かし、それぞれ1日1回だけ送る（スクリプトプロパティで送った日を覚える）
// 送り先はスクリプトプロパティ DISCORD_WEBHOOK_URL_WEATHER（なければ DISCORD_WEBHOOK_URL）
// =========================================================

// ---- 設定 ----
const WX_PLACE = { name: "鎌ケ谷市", lat: 35.7767, lon: 140.0008 };
const WX_JMA_OFFICE = "120000";      // 千葉県（気象庁の予報・警報のファイル）
const WX_JMA_CLASS10 = "120010";     // 千葉県北西部（天気・降水確率）
const WX_JMA_CITY = "1222400";       // 鎌ケ谷市（警報・注意報）
const WX_MORNING_TIME = "05:05";     // 朝の通知（5:00 の気象庁の予報が出たあと）
const WX_TRAIN_WATCH = ["05:20", "08:00"]; // この間、電車の運行情報が変わったら追加で送る
const WX_EVENING_TIME = "21:00";     // 翌日の注意（何かあるときだけ）
const WX_AWAY_HOURS = [7, 19];       // 洗濯物を外に出しておく時間（家を出てから帰るまで）
const WX_COMMUTE_HOURS = [6, 7];     // 家を出る時間帯（この時間の気温を出す）
const WX_MENTION = "";               // 先頭に付けるメンション（"@everyone" にすると付く）
const WX_TYPHOON_KM = 600;           // 台風の予報円の中心がこの距離まで近づく見込みなら知らせる
const WX_TYPHOON_HOURS = 72;         // 何時間先までの台風の予報を見るか

// 電車の運行情報を通知に入れるか（false：入れない。乗換案内アプリで見る。true にすると下の路線を読む）
const WX_TRAIN_ENABLED = false;

// 電車：使う路線。kind ごとに読み方が違う（wxTrainFetchers）
const WX_TRAINS = [
  { name: "総武快速線", kind: "jr", jrName: "総武快速線" },
  { name: "横須賀線", kind: "jr", jrName: "横須賀線" },
  { name: "アーバンパークライン", kind: "tobu", tobuName: "東武アーバンパークライン" },
  { name: "北総線", kind: "hokuso" },
  { name: "京成線", kind: "keisei" },
  { name: "都営浅草線", kind: "toei", odptRailway: "odpt.Railway:Toei.Asakusa" },
  { name: "京急線", kind: "keikyu" },
];

// 花粉：時期（月/日〜月/日）。この時期だけ花粉の行を出す
const WX_POLLEN_SEASONS = [
  { name: "スギ", from: [2, 1], to: [4, 30] },
  { name: "ヒノキ", from: [3, 15], to: [5, 15] },
  { name: "イネ科", from: [5, 1], to: [6, 30] },
  { name: "ブタクサ・ヨモギ・カナムグラ", from: [8, 15], to: [10, 31] },
];

// 気象庁の警報・注意報のコード（2026年5月からの新しい区分。気象庁のサイトの表と同じ）
// level：20 注意報 / 30 警報 / 40 危険警報 / 50 特別警報
const WX_WARNING_CODES = {
  "33": ["大雨特別警報", 50], "43": ["大雨危険警報", 40], "03": ["大雨警報", 30], "10": ["大雨注意報", 20],
  "39": ["土砂災害特別警報", 50], "49": ["土砂災害危険警報", 40], "09": ["土砂災害警報", 30], "29": ["土砂災害注意報", 20],
  "38": ["高潮特別警報", 50], "48": ["高潮危険警報", 40], "08": ["高潮警報", 30], "19": ["高潮注意報", 20],
  "35": ["暴風特別警報", 50], "05": ["暴風警報", 30], "15": ["強風注意報", 20],
  "32": ["暴風雪特別警報", 50], "02": ["暴風雪警報", 30], "13": ["風雪注意報", 20],
  "36": ["大雪特別警報", 50], "06": ["大雪警報", 30], "12": ["大雪注意報", 20],
  "37": ["波浪特別警報", 50], "07": ["波浪警報", 30], "16": ["波浪注意報", 20],
  "14": ["雷注意報", 20], "17": ["融雪注意報", 20], "20": ["濃霧注意報", 20], "21": ["乾燥注意報", 20],
  "22": ["なだれ注意報", 20], "23": ["低温注意報", 20], "24": ["霜注意報", 20], "25": ["着氷注意報", 20],
  "26": ["着雪注意報", 20],
};
// 内陸の鎌ケ谷では関係が薄いので出さない警報・注意報
const WX_WARNING_SKIP = ["波浪", "高潮"];

const WX_COLOR = { danger: 0xD9534F, caution: 0xE0A93B, rain: 0x7F8C9A, clear: 0x4A90D9 };

// =========================================================
// トリガー
// =========================================================

// 【トリガーで5分ごとに実行】朝の通知・電車の見張り・夜の注意を、時刻に合わせて1日1回ずつ送る
function weatherTick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const now = new Date();
    const today = wxFmt(now, "yyyy-MM-dd");
    const hm = wxFmt(now, "HH:mm");

    if (hm >= WX_MORNING_TIME && props.getProperty("WX_MORNING_DATE") !== today) {
      // 朝の時刻を大きく過ぎていたら（トリガーの停止明けなど）送らない
      if (hm < WX_TRAIN_WATCH[1]) sendMorningWeather();
      props.setProperty("WX_MORNING_DATE", today);
      return;
    }
    if (WX_TRAIN_ENABLED && hm >= WX_TRAIN_WATCH[0] && hm < WX_TRAIN_WATCH[1] && props.getProperty("WX_MORNING_DATE") === today) {
      watchTrains();
    }
    if (hm >= WX_EVENING_TIME && props.getProperty("WX_EVENING_DATE") !== today) {
      sendEveningAlert();
      props.setProperty("WX_EVENING_DATE", today);
    }
  } finally {
    lock.releaseLock();
  }
}

// 【一度だけ実行】weatherTick を5分ごとに実行するトリガーを作る（作り直しても重複しない）
function setupWeatherTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "weatherTick")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("weatherTick").timeBased().everyMinutes(5).create();
  Logger.log("weatherTick を5分ごとに実行するトリガーを作成しました");
}

// 【デバッグ用】朝の通知をいま送る（送った日は記録しない）
function debugWeatherMorningNow() { sendMorningWeather(); }

// 【デバッグ用】朝の通知の中身をログに出す（送信しない）
function debugWeatherPreview() {
  const d = collectWeatherData(new Date());
  Logger.log(JSON.stringify(buildMorningPayload(d, new Date()), null, 2));
  const ev = buildEveningPayload(d, new Date());
  Logger.log(ev ? JSON.stringify(ev, null, 2) : "夜の注意：なし");
}

// =========================================================
// 送信
// =========================================================

function sendMorningWeather() {
  const now = new Date();
  const d = collectWeatherData(now);
  sendDiscordPayload(buildMorningPayload(d, now), "WEATHER");
  // 電車の見張りの基準にする
  if (d.trains) PropertiesService.getScriptProperties().setProperty("WX_TRAIN_SIG", wxTrainSignature(d.trains));
}

// 電車の運行情報が朝の通知（または前回の追加通知）から変わったら送る
function watchTrains() {
  const props = PropertiesService.getScriptProperties();
  const trains = fetchTrainStatus();
  if (trains.every(t => t.error)) return; // 全部読めないときは何もしない
  const sig = wxTrainSignature(trains);
  const prev = props.getProperty("WX_TRAIN_SIG") || "";
  if (sig === prev) return;
  props.setProperty("WX_TRAIN_SIG", sig);
  const bad = trains.filter(t => !t.error && !t.ok);
  const msg = bad.length
    ? "🚃 **運行情報が変わりました**（" + wxFmt(new Date(), "H:mm") + "）\n" + bad.map(wxTrainLine).join("\n")
    : "✅ 電車は平常に戻りました（" + wxFmt(new Date(), "H:mm") + "）";
  sendDiscordMessage((WX_MENTION ? WX_MENTION + " " : "") + msg, "WEATHER");
}

function sendEveningAlert() {
  const now = new Date();
  const d = collectWeatherData(now);
  const payload = buildEveningPayload(d, now);
  if (payload) sendDiscordPayload(payload, "WEATHER");
  else Logger.log("明日の注意はありませんでした。");
}

// =========================================================
// データを集める（どれかが失敗しても、ほかは使う）
// =========================================================

function collectWeatherData(now) {
  const d = { errors: [] };
  const tryGet = (label, fn) => {
    try { return fn(); } catch (e) { d.errors.push(label); Logger.log(`${label}の取得に失敗：${e}`); return null; }
  };
  d.om = tryGet("天気（Open-Meteo）", fetchOpenMeteo);
  d.jma = tryGet("気象庁の予報", fetchJmaForecast);
  d.warnings = tryGet("警報・注意報", fetchJmaWarnings);
  d.typhoons = tryGet("台風情報", () => fetchTyphoons(now));
  d.trains = WX_TRAIN_ENABLED ? tryGet("運行情報", fetchTrainStatus) : null;
  d.jrNotices = WX_TRAIN_ENABLED ? tryGet("JRのお知らせ", fetchJrNotices) : null;
  d.chores = tryGet("家事", () => readTodayChores(now));
  d.expiring = tryGet("賞味期限", () => readExpiringStock(now));
  return d;
}

function wxFetchText(url) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { "Cache-Control": "no-cache" } });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error(`HTTP ${code}: ${url}`);
  return res.getContentText("UTF-8");
}

// Open-Meteo：1時間ごとの気温・湿度・降水確率・風など（昨日から明日まで）
function fetchOpenMeteo() {
  const q = [
    `latitude=${WX_PLACE.lat}`, `longitude=${WX_PLACE.lon}`,
    "hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m",
    "daily=temperature_2m_max,temperature_2m_min,apparent_temperature_max,uv_index_max,precipitation_sum,wind_gusts_10m_max",
    "timezone=Asia%2FTokyo", "past_days=1", "forecast_days=2", "wind_speed_unit=ms",
  ].join("&");
  return parseOpenMeteo(JSON.parse(wxFetchText("https://api.open-meteo.com/v1/forecast?" + q)));
}

// 日付（yyyy-MM-dd）ごとに、時（0〜23）→ 値 の形にする
function parseOpenMeteo(j) {
  const days = {};
  j.hourly.time.forEach((t, i) => {
    const date = t.slice(0, 10), h = Number(t.slice(11, 13));
    const day = days[date] = days[date] || { hours: {} };
    day.hours[h] = {
      temp: j.hourly.temperature_2m[i], feels: j.hourly.apparent_temperature[i],
      rh: j.hourly.relative_humidity_2m[i], pop: j.hourly.precipitation_probability[i],
      rain: j.hourly.precipitation[i], code: j.hourly.weather_code[i],
      wind: j.hourly.wind_speed_10m[i], gust: j.hourly.wind_gusts_10m[i],
    };
  });
  j.daily.time.forEach((date, i) => {
    const day = days[date] = days[date] || { hours: {} };
    Object.assign(day, {
      max: j.daily.temperature_2m_max[i], min: j.daily.temperature_2m_min[i],
      feelsMax: j.daily.apparent_temperature_max[i], uv: j.daily.uv_index_max[i],
      rainSum: j.daily.precipitation_sum[i], gustMax: j.daily.wind_gusts_10m_max[i],
    });
  });
  return days;
}

// 気象庁の予報：天気の文・天気コード（日ごと）と6時間ごとの降水確率
function fetchJmaForecast() {
  const j = JSON.parse(wxFetchText(`https://www.jma.go.jp/bosai/forecast/data/forecast/${WX_JMA_OFFICE}.json`));
  return parseJmaForecast(j, WX_JMA_CLASS10);
}

function parseJmaForecast(j, areaCode) {
  const ts = j[0].timeSeries;
  const out = { days: {}, pops: [] };
  const w = ts[0].areas.find(a => a.area.code === areaCode);
  ts[0].timeDefines.forEach((t, i) => {
    out.days[t.slice(0, 10)] = {
      text: String(w.weathers[i] || "").replace(/[　\s]+/g, ""),
      code: w.weatherCodes[i],
      wind: String(w.winds[i] || "").replace(/[　\s]+/g, ""),
    };
  });
  const p = ts[1].areas.find(a => a.area.code === areaCode);
  ts[1].timeDefines.forEach((t, i) => {
    if (p.pops[i] === "" || p.pops[i] == null) return;
    out.pops.push({ date: t.slice(0, 10), from: Number(t.slice(11, 13)), to: Number(t.slice(11, 13)) + 6, pop: Number(p.pops[i]) });
  });
  return out;
}

// 気象庁の警報・注意報（新しい形式 data/r8）：鎌ケ谷市に出ているもの
function fetchJmaWarnings() {
  return parseJmaWarnings(JSON.parse(wxFetchText(`https://www.jma.go.jp/bosai/warning/data/r8/${WX_JMA_OFFICE}.json`)), WX_JMA_CITY);
}

function parseJmaWarnings(j, cityCode) {
  const found = {};
  (Array.isArray(j) ? j : [j]).forEach(rep => {
    const items = (rep.warning && rep.warning.class20Items) || [];
    const area = items.find(a => a.areaCode === cityCode);
    if (!area) return;
    (area.kinds || []).forEach(k => {
      if (!k.code || k.status === "解除" || /なし/.test(k.status || "")) return;
      const def = WX_WARNING_CODES[k.code];
      const name = def ? def[0] : `気象の警報・注意報（コード${k.code}）`;
      if (WX_WARNING_SKIP.some(s => name.startsWith(s))) return;
      const level = def ? def[1] : 30;
      if (!found[name] || found[name].level < level) found[name] = { name: name, level: level, status: k.status };
    });
  });
  return Object.values(found).sort((a, b) => b.level - a.level);
}

// 台風：WX_TYPHOON_HOURS 時間先までの予報で、家から WX_TYPHOON_KM 以内に近づくもの
function fetchTyphoons(now) {
  const list = JSON.parse(wxFetchText("https://www.jma.go.jp/bosai/typhoon/data/targetTc.json"));
  return list.map(tc => {
    const spec = JSON.parse(wxFetchText(`https://www.jma.go.jp/bosai/typhoon/data/${tc.tropicalCyclone}/specifications.json`));
    return wxTyphoonApproach(spec, now);
  }).filter(Boolean);
}

function wxTyphoonApproach(spec, now) {
  const title = spec.find(p => p.part === "title") || {};
  const num = String(title.typhoonNumber || "").slice(-2).replace(/^0/, "");
  const label = (title.category && title.category.jp === "台風" && num ? `台風${num}号` : "熱帯低気圧")
    + (title.name && title.name.jp ? `（${title.name.jp}）` : "");
  let best = null;
  spec.filter(p => p.position && p.position.deg && p.validtime).forEach(p => {
    const t = new Date(p.validtime.JST);
    if (t - now > WX_TYPHOON_HOURS * 3600000) return;
    const km = wxDistanceKm(WX_PLACE.lat, WX_PLACE.lon, p.position.deg[0], p.position.deg[1]);
    if (!best || km < best.km) best = { km: km, time: t, intensity: p.intensity, pressure: p.pressure, storm: p.stormWarning, gale: p.galeWarning };
  });
  if (!best || best.km > WX_TYPHOON_KM) return null;
  return Object.assign({ label: label }, best);
}

function wxDistanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(a)));
}

// ---- 電車 ----

// 各社の公式の運行情報ページを読み、路線ごとに { name, ok, status, detail, error } を返す
function wxTrainUrls() {
  return {
    jr: "https://traininfo.jreast.co.jp/train_info/kanto.aspx",
    tobu: "https://www.tobu.co.jp/file/trainop/trainop.xml?dt=" + Date.now(),
    hokuso: "https://www.hokuso-railway.co.jp/data/train_info/emgc.js?" + Date.now(),
    keisei: "https://www.keisei.co.jp/traininfo/index.php?lang=ja",
    toei: wxOdptUrl("odpt.Operator:Toei"),
    keikyu: "https://www.keikyu.co.jp/",
  };
}

// 公共交通オープンデータセンター（ODPT）の運行情報 API。キーはスクリプトプロパティ ODPT_CONSUMER_KEY
// （都営の公式ページは GAS からだとロボット確認の画面になり読めないため）
function wxOdptUrl(operator) {
  const key = PropertiesService.getScriptProperties().getProperty("ODPT_CONSUMER_KEY");
  if (!key) return null;
  return `https://api.odpt.org/api/v4/odpt:TrainInformation?odpt:operator=${encodeURIComponent(operator)}&acl:consumerKey=${encodeURIComponent(key)}`;
}

// ブラウザから読むときと同じような名乗り（GAS の既定のままだと断るサイトがあるため）
const WX_BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en;q=0.8",
};

// 各社の公式の運行情報ページを読み、路線ごとに { name, ok, status, detail, error } を返す
function fetchTrainStatus() {
  const urls = wxTrainUrls();
  const kinds = [...new Set(WX_TRAINS.map(t => t.kind))];
  const pages = wxFetchPages(kinds.map(k => urls[k]));
  const byKind = {};
  kinds.forEach((k, i) => byKind[k] = pages[i]);
  return WX_TRAINS.map(t => {
    const page = byKind[t.kind];
    if (!page) return { name: t.name, error: true };
    try {
      const r = wxTrainParsers[t.kind](page, t);
      if (!r) Logger.log(`${t.name}：ページは読めたが、運行情報の場所が見つかりませんでした`);
      return r ? Object.assign({ name: t.name }, r) : { name: t.name, error: true };
    } catch (e) {
      Logger.log(`${t.name}の運行情報を読めませんでした：${e}`);
      return { name: t.name, error: true };
    }
  });
}

// まとめて読み、200 以外だったものはブラウザに近い名乗りで1回だけ読み直す。読めなければ null
function wxFetchPages(urlList) {
  const idx = urlList.map((u, i) => u ? i : -1).filter(i => i >= 0);
  const out = urlList.map(() => null);
  if (!idx.length) return out;
  const got = wxFetchPagesSub(idx.map(i => urlList[i]));
  idx.forEach((i, j) => out[i] = got[j]);
  return out;
}

function wxFetchPagesSub(urlList) {
  const req = (url, browser) => ({ url: url, muteHttpExceptions: true, followRedirects: true, headers: browser ? WX_BROWSER_HEADERS : {} });
  const first = UrlFetchApp.fetchAll(urlList.map(u => req(u, false)));
  const out = first.map(r => r.getResponseCode() === 200 ? r.getContentText("UTF-8") : null);
  const retry = urlList.map((u, i) => out[i] == null ? i : -1).filter(i => i >= 0);
  if (retry.length) {
    const second = UrlFetchApp.fetchAll(retry.map(i => req(urlList[i], true)));
    retry.forEach((i, j) => {
      const code = second[j].getResponseCode();
      if (code === 200) out[i] = second[j].getContentText("UTF-8");
      else Logger.log(`読めませんでした（1回目 HTTP ${first[i].getResponseCode()}・2回目 HTTP ${code}）：${urlList[i].replace(/consumerKey=[^&]+/, "consumerKey=***")}`);
    });
  }
  return out;
}

// 【デバッグ用】各社のページを GAS から読んだ結果（応答コード・長さ・目印の有無・先頭）をログに出す
function debugTrainFetch() {
  const marks = { jr: "traininfo-routes__name", tobu: "<line>", hokuso: "emgc_info", keisei: "jp_txt", toei: "Toei.Asakusa", keikyu: "info-block_text" };
  const urls = wxTrainUrls();
  Object.keys(urls).forEach(k => {
    if (!urls[k]) { Logger.log(`${k}：URL がありません（都営はスクリプトプロパティ ODPT_CONSUMER_KEY が必要）`); return; }
    [false, true].forEach(browser => {
      try {
        const r = UrlFetchApp.fetch(urls[k], { muteHttpExceptions: true, followRedirects: true, headers: browser ? WX_BROWSER_HEADERS : {} });
        const t = r.getContentText("UTF-8");
        Logger.log(`${k}（${browser ? "ブラウザ風" : "既定"}）：HTTP ${r.getResponseCode()}・${t.length}文字・目印${t.indexOf(marks[k]) >= 0 ? "あり" : "なし"}\n${t.slice(0, 300).replace(/\s+/g, " ")}`);
      } catch (e) {
        Logger.log(`${k}（${browser ? "ブラウザ風" : "既定"}）：エラー ${e}`);
      }
    });
  });
  Logger.log(JSON.stringify(fetchTrainStatus(), null, 1));
}

const wxTrainParsers = {
  // JR東日本：路線ごとに「状態」と「詳しい内容」が並ぶ（同じ路線が複数行のこともある）
  jr: (html, t) => {
    const rows = [];
    const re = /traininfo-routes__name">([^<]+)<[\s\S]*?traininfo-routes__status ([\w ]+)">\s*<span>([^<]+)<\/span>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[1].trim() !== t.jrName) continue;
      rows.push({ cls: m[2].trim(), status: m[3].trim(), detail: wxStripTags(m[4]) });
    }
    if (!rows.length) return null;
    const today = new Date();
    // お知らせ（info）は、今日・明日の日付があるか、運休・見合わせの話のときだけ出す
    const bad = rows.filter(r => r.cls !== "normal" && r.status !== "平常運転")
      .filter(r => r.cls !== "info" || wxMentionsSoon(r.detail, today) || (!wxHasDate(r.detail) && /運休|見合わせ|計画/.test(r.detail)));
    if (!bad.length) return { ok: true, status: "平常運転" };
    return { ok: false, status: bad[0].status, detail: [...new Set(bad.map(r => r.detail).filter(Boolean))].join(" ／ ") };
  },
  // 東武：XML の <line> と <description> が交互に並ぶ
  tobu: (xml, t) => {
    const re = /<line>([^<]*)<\/line>\s*<description>([^<]*)<\/description>/g;
    let m;
    while ((m = re.exec(xml))) {
      if (m[1].trim() !== t.tobuName) continue;
      const desc = m[2].trim();
      const ok = /平常/.test(desc);
      return { ok: ok, status: ok ? "平常運転" : wxStatusWord(desc), detail: ok ? "" : desc };
    }
    return null;
  },
  // 北総：emgc_auto（自動）と emgc_info（手入力）の2つの文がある。どちらかが平常でなければ平常でないとする
  hokuso: (js) => {
    const get = k => { const m = js.match(new RegExp(k + "\\s*=\\s*'([^']*)'")); return m ? wxStripTags(m[1]) : ""; };
    const texts = [get("emgc_info"), get("emgc_auto")].filter(Boolean);
    if (!texts.length) return null;
    const bad = texts.find(t => !/平常/.test(t));
    return bad ? { ok: false, status: wxStatusWord(bad), detail: bad } : { ok: true, status: "平常運転" };
  },
  // 京成：<dl class='cls0'> が平常。本文は <span id='jp_txt'>
  keisei: (html) => {
    const ja = html.match(/<div class='ja'>([\s\S]*?)<\/div>/);
    if (!ja) return null;
    const cls = (ja[1].match(/<dl class='cls(\d+)'/) || [])[1];
    const title = wxStripTags((ja[1].match(/<dt>([\s\S]*?)<\/dt>/) || [])[1] || "").replace(/^京成線\s*/, "");
    const text = wxStripTags((ja[1].match(/<span id='jp_txt'>([\s\S]*?)<\/span>/) || [])[1] || "");
    if (cls == null && !text) return null;
    const ok = cls === "0" || (/平常/.test(title + text) && cls == null);
    return { ok: ok, status: ok ? "平常運転" : (title || wxStatusWord(text)), detail: ok ? "" : text };
  },
  // 都営：ODPT の TrainInformation（JSON の配列）。平常でないときは trainInformationStatus が入る
  toei: (json, t) => {
    const list = JSON.parse(json);
    const it = list.find(x => x["odpt:railway"] === t.odptRailway);
    if (!it) return null;
    const ja = v => (v && (v.ja || v["ja"])) || "";
    const text = wxStripTags(ja(it["odpt:trainInformationText"]));
    const status = wxStripTags(ja(it["odpt:trainInformationStatus"]));
    const ok = !status && /平常/.test(text);
    return { ok: ok, status: ok ? "平常運転" : (status || wxStatusWord(text)), detail: ok ? "" : text };
  },
  // 京急：トップページ（www.keikyu.co.jp）の <p class="info-block_text"> の文（unkou.keikyu.co.jp は GAS から読めない）
  keikyu: (html) => {
    const m = html.match(/class="info-block_text">([\s\S]*?)<\/p>/);
    if (!m) return null;
    const text = wxStripTags(m[1]);
    const ok = /平常/.test(text);
    return { ok: ok, status: ok ? "平常運転" : wxStatusWord(text), detail: ok ? "" : text };
  },
};

// JR東日本のお知らせ（工事・計画運休など）のうち、使う路線で今日・明日の日付があるもの
function fetchJrNotices() {
  const list = JSON.parse(wxFetchText("https://www.jreast.co.jp/traininfojp/kanto.json"));
  const names = WX_TRAINS.filter(t => t.kind === "jr").map(t => t.jrName);
  const now = new Date();
  return list.map(n => wxStripTags(String((n.metainfo && n.metainfo.infomessage) || "").replace(/<br\s*\/?>/g, " ")))
    .filter(text => names.some(nm => text.includes(nm)) && wxMentionsSoon(text, now))
    .map(text => wxShorten(text.split("。")[0], 90));
}

function wxTrainSignature(trains) {
  return trains.filter(t => !t.error && !t.ok).map(t => `${t.name}:${t.status}:${t.detail || ""}`).join("|");
}

function wxTrainLine(t) {
  return `・${t.name}：**${t.status}**` + (t.detail ? `\n　${wxShorten(t.detail, 110)}` : "");
}

// ---- くらしログ ----

// 今日やる家事（期限切れを含む）
function readTodayChores(now) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CHORE);
  const values = sheet.getDataRange().getValues();
  const h = values[0];
  const iName = h.indexOf("taskName"), iDue = h.indexOf("nextDue");
  const tomorrow = new Date(choreDayStart(now).getTime() + 86400000);
  return values.slice(1)
    .filter(r => r[iName] && r[iDue] instanceof Date && r[iDue] < tomorrow)
    .sort((a, b) => a[iDue] - b[iDue])
    .map(r => {
      const late = choreDiffDays(now, r[iDue]);
      return { name: String(r[iName]), late: late > 0 ? late : 0 };
    });
}

// 期限が今日・明日の在庫（個数が残っているものだけ）
function readExpiringStock(now) {
  const values = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STOCK).getDataRange().getValues();
  const h = values[0];
  const iName = h.indexOf("itemName"), iExp = h.indexOf("expirationDate"), iStock = h.indexOf("stock");
  const today = new Date(wxFmt(now, "yyyy-MM-dd") + "T00:00:00+09:00");
  const out = [];
  values.slice(1).forEach(r => {
    if (!r[iName] || r[iExp] === "" || (Number(r[iStock]) || 0) <= 0) return;
    const exp = parseExpirationDate(r[iExp]);
    if (!exp) return;
    const days = Math.round((exp - today) / 86400000);
    if (days >= 0 && days <= 1) out.push({ name: String(r[iName]), days: days });
  });
  return out.sort((a, b) => a.days - b.days);
}

// =========================================================
// 判定（データ → 短い文）
// =========================================================

function wxHours(day, from, to) {
  const out = [];
  for (let h = from; h < to; h++) if (day && day.hours[h]) out.push(Object.assign({ h: h }, day.hours[h]));
  return out;
}

const wxAvg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
const wxMax = arr => arr.length ? Math.max.apply(null, arr) : null;

// 気象庁の6時間ごとの降水確率のうち、時間帯 [from, to) にかかるものの最大
function wxJmaPop(jma, date, from, to) {
  if (!jma) return null;
  const ps = jma.pops.filter(p => p.date === date && p.to > from && p.from < to).map(p => p.pop);
  return wxMax(ps);
}

// 雨の時間帯（降水確率50%以上か、0.3mm以上の時間）。例：{ from: 15, to: 19 }
function wxRainSpan(day, from, to) {
  const wet = wxHours(day, from, to).filter(x => (x.pop != null && x.pop >= 50) || x.rain >= 0.3);
  if (!wet.length) return null;
  return { from: wet[0].h, to: wet[wet.length - 1].h + 1 };
}

// 傘
function judgeUmbrella(d, date) {
  const day = d.om && d.om[date];
  const omPop = wxMax(wxHours(day, 6, 24).map(x => x.pop).filter(v => v != null));
  const jmaPop = wxJmaPop(d.jma, date, 6, 24);
  const pop = Math.max(omPop ?? 0, jmaPop ?? 0);
  const span = wxRainSpan(day, 6, 24);
  if (pop >= 50 || span) {
    const when = span ? `${span.from}時ごろ〜${span.to >= 24 ? "夜遅く" : span.to + "時ごろ"}` : wxJmaRainWhen(d.jma, date);
    return { need: 2, text: `☔ 傘：**必要**（${when}${when ? "・" : ""}降水確率${pop}%）`, short: "☔傘" };
  }
  if (pop >= 30) return { need: 1, text: `🌂 傘：折りたたみがあると安心（降水確率${pop}%）`, short: "🌂折りたたみ" };
  return { need: 0, text: "☂️ 傘：いらない", short: "傘なし" };
}

function wxJmaRainWhen(jma, date) {
  if (!jma) return "";
  const ps = jma.pops.filter(p => p.date === date && p.pop >= 50);
  if (!ps.length) return "";
  return `${ps[0].from}〜${ps[ps.length - 1].to}時`;
}

// 洗濯：家を出てから帰るまで（WX_AWAY_HOURS）外に干しておけるか
function judgeLaundry(d, date, pollen) {
  const day = d.om && d.om[date];
  if (!day) return null;
  const [from, to] = WX_AWAY_HOURS;
  const hours = wxHours(day, from, to);
  const pop = Math.max(wxMax(hours.map(x => x.pop).filter(v => v != null)) ?? 0, wxJmaPop(d.jma, date, from, to) ?? 0);
  const span = wxRainSpan(day, from, to);
  const notes = [];
  const gust = wxMax(hours.map(x => x.gust).filter(v => v != null));
  if (gust != null && gust >= 12) notes.push(`強風（最大${Math.round(gust)}m/s）で飛ばされやすい`);

  if (pop >= 50 || span) {
    return { mark: "✕", text: `👕 洗濯：**部屋干し**（${span ? span.from + "時ごろから雨" : "降水確率" + pop + "%"}）`, short: "部屋干し" };
  }
  if (pop >= 30) {
    return { mark: "△", text: `👕 洗濯：部屋干しがおすすめ（帰るまでの降水確率${pop}%）`, short: "部屋干し推奨" };
  }
  if (pollen && pollen.level >= 2) {
    return { mark: "△", text: "👕 洗濯：部屋干しがおすすめ（花粉が多い。外に干すならよく払って取り込む）", short: "部屋干し推奨" };
  }
  const mid = wxHours(day, 9, 15);
  const rh = Math.round(wxAvg(mid.map(x => x.rh)) ?? 0);
  const wind = wxAvg(mid.map(x => x.wind)) ?? 0;
  const sunny = mid.filter(x => x.code <= 2).length >= mid.length / 2;
  let mark, word;
  if (rh <= 55 && (sunny || wind >= 2.5)) { mark = "◎"; word = "外干し◎ よく乾く"; }
  else if (rh <= 70) { mark = "○"; word = "外干し○ 乾く（厚手は乾きにくい）"; }
  else { mark = "△"; word = "外干し△ 乾きにくい"; }
  const detail = [`湿度${rh}%`, `風${wind.toFixed(1)}m/s`].concat(notes).join("・");
  return { mark: mark, text: `👕 洗濯：**${word}**（${detail}）`, short: "外干し" + mark };
}

// 花粉：時期のものと、天気から見た飛びやすさ（0 少ない / 1 やや多い / 2 多い / 3 非常に多い）
function judgePollen(d, date) {
  const md = [Number(date.slice(5, 7)), Number(date.slice(8, 10))];
  const inRange = s => {
    const v = md[0] * 100 + md[1], a = s.from[0] * 100 + s.from[1], b = s.to[0] * 100 + s.to[1];
    return v >= a && v <= b;
  };
  const kinds = WX_POLLEN_SEASONS.filter(inRange).map(s => s.name);
  if (!kinds.length) return null;
  const day = d.om && d.om[date];
  if (!day) return { kinds: kinds, level: null, text: `🤧 花粉：${kinds.join("・")}の時期` };

  const mid = wxHours(day, 9, 17);
  const rainy = mid.some(x => (x.pop != null && x.pop >= 50) || x.rain >= 0.5);
  const sunny = mid.filter(x => x.code <= 2).length >= mid.length / 2;
  const wind = wxAvg(mid.map(x => x.wind)) ?? 0;
  const rh = wxAvg(mid.map(x => x.rh)) ?? 60;
  const yesterday = d.om[wxShiftDate(date, -1)];
  let score = 0;
  if (sunny) score++;
  if (day.max >= (md[0] <= 4 ? 15 : 25)) score++;   // 春は15℃・秋は25℃以上で飛びやすい
  if (wind >= 3) score++;
  if (rh <= 50) score++;
  if (yesterday && yesterday.rainSum >= 1 && sunny) score++; // 雨の翌日の晴れはたまった分が飛ぶ
  let level = score >= 4 ? 3 : score >= 3 ? 2 : score >= 2 ? 1 : 0;
  if (rainy) level = 0;
  const words = ["少ない", "やや多い", "**多い**", "**非常に多い**"];
  const tip = level >= 2 ? "（マスク・外干し注意）" : "";
  return { kinds: kinds, level: level, text: `🤧 花粉（${kinds.join("・")}）：${words[level]}${tip}　※天気からの目安` };
}

// 気温と服装のひとこと
function judgeTemp(d, date) {
  const day = d.om && d.om[date];
  if (!day) return null;
  const y = d.om[wxShiftDate(date, -1)];
  const diff = y && y.max != null ? Math.round(day.max - y.max) : null;
  const commute = wxHours(day, WX_COMMUTE_HOURS[0], WX_COMMUTE_HOURS[1] + 1).map(x => x.temp);
  const commuteT = commute.length ? Math.round(wxAvg(commute)) : null;
  const parts = [`🌡 最高**${Math.round(day.max)}℃**／最低${Math.round(day.min)}℃`];
  if (diff != null) parts.push(`（昨日より${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${Math.abs(diff)}℃）`);
  let line = parts.join("");
  const tips = [];
  if (commuteT != null) tips.push(`家を出る${WX_COMMUTE_HOURS[0]}〜${WX_COMMUTE_HOURS[1]}時は${commuteT}℃`);
  if (day.min <= 3) tips.push("冷え込むのでコート・手袋");
  else if (day.max - day.min >= 10) tips.push("寒暖差が大きいので羽織るものを");
  if (diff != null && diff <= -5) tips.push("昨日よりかなり寒い");
  if (diff != null && diff >= 5) tips.push("昨日よりかなり暖かい");
  if (tips.length) line += "\n　" + tips.join("・");
  return line;
}

// 季節・天気の注意（当てはまるときだけ）
function judgeCautions(d, date) {
  const day = d.om && d.om[date];
  if (!day) return [];
  const out = [];
  const month = Number(date.slice(5, 7));
  if (day.feelsMax != null && day.feelsMax >= 31) out.push(`🥵 暑さ：体感${Math.round(day.feelsMax)}℃。水分補給・熱中症に注意`);
  if (day.min <= 0) out.push("🧊 朝は氷点下：路面の凍結に注意");
  const snow = wxHours(day, 6, 24).some(x => (x.code >= 71 && x.code <= 77) || x.code === 85 || x.code === 86);
  if (snow) out.push("❄️ 雪の予報：足元と電車の遅れに注意");
  const gust = wxMax(wxHours(day, 6, 21).map(x => x.gust).filter(v => v != null));
  if (gust != null && gust >= 15) out.push(`💨 強風：最大瞬間${Math.round(gust)}m/s。自転車・傘に注意`);
  if (day.uv != null && day.uv >= 6 && month >= 4 && month <= 9) out.push(`🧴 紫外線が強い（UV${Math.round(day.uv)}）`);
  const rhs = wxHours(day, 9, 17).map(x => x.rh).filter(v => v != null);
  if ((month >= 11 || month <= 3) && rhs.length && Math.min.apply(null, rhs) <= 30) out.push("💧 空気がかなり乾燥：のど・肌の保湿を");
  return out;
}

// 天気のアイコン（気象庁の天気コードの百の位：1 晴れ / 2 くもり / 3 雨 / 4 雪）
function wxIcon(code) {
  const c = String(code || "")[0];
  return { "1": "☀️", "2": "☁️", "3": "☔", "4": "❄️" }[c] || "🌤";
}

// =========================================================
// 通知文
// =========================================================

function buildMorningPayload(d, now) {
  const date = wxFmt(now, "yyyy-MM-dd");
  const jmaDay = d.jma && d.jma.days[date];
  const umbrella = judgeUmbrella(d, date);
  const pollen = judgePollen(d, date);
  const laundry = judgeLaundry(d, date, pollen);
  const om = d.om && d.om[date];

  const lines = [];
  const t = judgeTemp(d, date);
  if (t) lines.push(t);
  lines.push(umbrella.text);
  if (laundry) lines.push(laundry.text);
  if (pollen) lines.push(pollen.text);

  const warn = d.warnings || [];
  if (warn.length) lines.push("⚠️ " + warn.map(w => w.level >= 30 ? `**${w.name}**` : w.name).join("、"));
  (d.typhoons || []).forEach(ty => lines.push(wxTyphoonLine(ty)));
  judgeCautions(d, date).forEach(c => lines.push(c));

  // 電車
  const trainLines = wxTrainBlock(d);
  lines.push(...trainLines.lines);

  // くらしログ
  const life = wxLifeLines(d);
  if (life.length) lines.push("", ...life);

  if (d.errors.length) lines.push("", `（取得できなかった情報：${d.errors.join("・")}）`);

  const danger = warn.some(w => w.level >= 30) || (d.typhoons || []).length || trainLines.bad;
  const caution = warn.length || umbrella.need >= 2 || (pollen && pollen.level >= 2);
  const color = danger ? WX_COLOR.danger : caution ? WX_COLOR.caution
    : (jmaDay && String(jmaDay.code)[0] === "1") ? WX_COLOR.clear : WX_COLOR.rain;

  const title = `${wxIcon(jmaDay && jmaDay.code)} ${wxFmt(now, "M/d")}(${wxWeekday(now)}) ${jmaDay ? jmaDay.text : "天気"}`;
  const summary = [
    `${wxFmt(now, "M/d")}`,
    om ? `${Math.round(om.max)}/${Math.round(om.min)}℃` : null,
    umbrella.short,
    laundry ? laundry.short : null,
    warn.some(w => w.level >= 30) ? "⚠️警報" : null,
    trainLines.bad ? "🚃遅れあり" : trainLines.allOk ? "電車平常" : null,
  ].filter(Boolean).join("・");

  return {
    content: (WX_MENTION ? WX_MENTION + " " : "") + summary,
    embeds: [{
      title: wxShorten(title, 250),
      description: wxShorten(lines.join("\n"), 4000),
      color: color,
      footer: { text: `${WX_PLACE.name}｜気象庁・Open-Meteo・各鉄道会社の情報` },
    }],
  };
}

function wxTrainBlock(d) {
  if (!WX_TRAIN_ENABLED) return { lines: [], bad: false, allOk: false };
  const lines = [];
  if (!d.trains) return { lines: ["🚃 電車：運行情報を取得できませんでした"], bad: false, allOk: false };
  const bad = d.trains.filter(t => !t.error && !t.ok);
  const err = d.trains.filter(t => t.error);
  if (!bad.length) lines.push(`🚃 電車：${err.length ? "読めた路線は" : ""}すべて平常`);
  else lines.push("🚃 電車：", ...bad.map(wxTrainLine));
  (d.jrNotices || []).forEach(n => lines.push(`📅 ${n}`));
  if (err.length) lines.push(`　（読めなかった路線：${err.map(t => t.name).join("・")}）`);
  return { lines: lines, bad: bad.length > 0, allOk: !bad.length && !err.length };
}

function wxTyphoonLine(ty) {
  const when = `${wxFmt(ty.time, "d")}日${wxFmt(ty.time, "H")}時ごろ`;
  const storm = ty.storm && ty.storm[0] && ty.storm[0].range ? `・暴風域${ty.storm[0].range.km}km` : "";
  return `🌀 **${ty.label}**：${when}に約${ty.km}kmまで近づく見込み（${ty.intensity && ty.intensity !== "-" ? ty.intensity + "・" : ""}${ty.pressure}hPa${storm}）`;
}

function wxLifeLines(d) {
  const out = [];
  const chores = d.chores || [];
  if (chores.length) {
    const names = chores.slice(0, 4).map(c => c.late ? `${c.name}（${c.late}日遅れ）` : c.name);
    out.push(`🧹 今日の家事：${names.join("、")}${chores.length > 4 ? ` ほか${chores.length - 4}件` : ""}`);
  }
  const exp = d.expiring || [];
  if (exp.length) {
    const names = exp.slice(0, 4).map(e => `${e.name}（${e.days === 0 ? "今日" : "明日"}）`);
    out.push(`🥛 期限が近い：${names.join("、")}${exp.length > 4 ? ` ほか${exp.length - 4}件` : ""}`);
  }
  return out;
}

// 夜の注意：明日に気をつけることがあるときだけ作る（なければ null）
function buildEveningPayload(d, now) {
  const tomorrow = wxShiftDate(wxFmt(now, "yyyy-MM-dd"), 1);
  const day = d.om && d.om[tomorrow];
  const items = [];

  const warn = (d.warnings || []).filter(w => w.level >= 30);
  if (warn.length) items.push(`⚠️ 発表中：${warn.map(w => `**${w.name}**`).join("、")}`);
  (d.typhoons || []).filter(ty => ty.time - now <= 48 * 3600000).forEach(ty => items.push(wxTyphoonLine(ty)));
  if (day) {
    const morningPop = Math.max(wxMax(wxHours(day, 5, 10).map(x => x.pop).filter(v => v != null)) ?? 0, wxJmaPop(d.jma, tomorrow, 5, 10) ?? 0);
    if (day.rainSum >= 20) items.push(`☔ 明日は大雨のおそれ（雨量${Math.round(day.rainSum)}mmの予想）`);
    else if (morningPop >= 70) items.push(`☔ 明日は朝から雨（通勤の時間の降水確率${morningPop}%）`);
    if (day.gustMax != null && day.gustMax >= 15) items.push(`💨 明日は強風（最大瞬間${Math.round(day.gustMax)}m/s）`);
    const snow = wxHours(day, 0, 24).some(x => (x.code >= 71 && x.code <= 77) || x.code === 85 || x.code === 86);
    if (snow) items.push("❄️ 明日は雪の予報。早めに家を出る準備を");
    if (day.min <= -1) items.push(`🧊 明日の朝は${Math.round(day.min)}℃。路面の凍結に注意`);
  }
  (d.jrNotices || []).forEach(n => items.push(`📅 ${n}`));
  const bad = (d.trains || []).filter(t => !t.error && !t.ok && /運休|見合わせ|計画/.test(t.status + (t.detail || "")));
  bad.forEach(t => items.push(wxTrainLine(t)));

  if (!items.length) return null;
  const jmaDay = d.jma && d.jma.days[tomorrow];
  if (jmaDay) items.unshift(`${wxIcon(jmaDay.code)} 明日：${jmaDay.text}`);
  return {
    content: (WX_MENTION ? WX_MENTION + " " : "") + "🌙 明日の注意があります",
    embeds: [{
      title: `🌙 明日 ${wxFmt(new Date(tomorrow + "T12:00:00+09:00"), "M/d")}(${wxWeekday(new Date(tomorrow + "T12:00:00+09:00"))}) の注意`,
      description: wxShorten(items.join("\n"), 4000),
      color: WX_COLOR.danger,
      footer: { text: `${WX_PLACE.name}｜気象庁・Open-Meteo・各鉄道会社の情報` },
    }],
  };
}

// =========================================================
// 小さな関数
// =========================================================

function wxFmt(d, f) { return Utilities.formatDate(d, "Asia/Tokyo", f); }
function wxWeekday(d) { return "日月火水木金土"[Number(wxFmt(d, "u")) % 7]; }
function wxShiftDate(date, days) {
  const t = new Date(date + "T12:00:00+09:00");
  return wxFmt(new Date(t.getTime() + days * 86400000), "yyyy-MM-dd");
}
function wxStripTags(s) {
  return String(s || "").normalize("NFKC").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/[　\s]+/g, " ").trim();
}
function wxShorten(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function wxStatusWord(text) {
  const s = String(text);
  if (/運転見合わせ|見合わせ/.test(s)) return "運転見合わせ";
  if (/一部(の)?列車(に|が)?運休/.test(s)) return "一部運休";
  const m = s.match(/運休|直通運転中止|折り返し運転|ダイヤ乱れ|遅延|遅れ/);
  return m ? m[0] : "平常でない";
}
// 文中の「M月D日」（全角数字も可）を集める
function wxDatesIn(text) {
  const s = String(text).normalize("NFKC");
  return [...s.matchAll(/(\d{1,2})月(\d{1,2})日/g)].map(m => [Number(m[1]), Number(m[2])]);
}
function wxHasDate(text) { return wxDatesIn(text).length > 0; }
// 今日か明日の日付が書かれているか
function wxMentionsSoon(text, now) {
  const want = [0, 1].map(k => {
    const d = new Date(now.getTime() + k * 86400000);
    return [Number(wxFmt(d, "M")), Number(wxFmt(d, "d"))];
  });
  return wxDatesIn(text).some(([m, d]) => want.some(w => w[0] === m && w[1] === d));
}
