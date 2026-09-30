# くらしログ

家の「在庫」「家計簿」「家事」を iPhone で管理する Web アプリです。

- 画面：GitHub Pages で公開する静的サイト（HTML・CSS・JS。ビルド不要）。iPhone のホーム画面に追加して使う
- データ：Google スプレッドシート
- サーバー処理：スプレッドシートに紐づく Google Apps Script（GAS）の Web アプリ。`clasp` で管理する
- 通知：GAS から Discord の Webhook へ送る

## 機能

| タブ | できること |
| --- | --- |
| 在庫 | 商品の登録（賞味期限ごとにロットを分けて管理）、＋−で個数の増減、商品の編集・削除、タグでの絞り込み |
| 家計簿 | 支出の記録（日付を指定できる）、履歴（30件ずつ・月別合計）、記録の編集・削除、タグでの絞り込み（合計も絞り込んだ分だけになる） |
| 家事 | 周期（N日ごと・N週ごと・毎月何日・毎月第何週何曜日・完了からN日後）と時刻の設定、長押しで完了すると次の予定日時へ進む、家事の編集・削除 |
| 共通 | タグ管理（名称変更・統合・一括削除・一括付与）、登録パネルを開いたまま一覧をタップするとフォームに入力 |

通知（Discord）：

- 賞味期限：期限が今日〜3日後で、個数が1以上のロットを通知する
- 家事：時刻を指定した家事は予定時刻に通知する。期限切れの家事と、時刻を指定していない今日の家事は、毎朝 8:00 にまとめて通知する

## ファイル構成

```text
index.html            HTML（画面の骨組み）
css/style.css         見た目
js/                   画面の処理。index.html で上から順に読み込む（順番に意味がある）
  common.js           GAS_URL、GASとの通信、トースト、要素作成 h()、日付・タグの小さな関数
  panels.js           下から出るパネル（登録フォーム・絞り込み）、編集用のシート、長押しボタン
  tags.js             タグの選択、一覧の絞り込み、タグ管理
  stock.js            在庫
  finance.js          家計簿
  chore.js            家事
  main.js             タブ切り替え、再読み込みボタン、起動時のデータ読み込み
apple-touch-icon.png  ホーム画面のアイコン（180×180）
gas/                  GAS のコード（clasp push でこのフォルダの中身が GAS に反映される）
  .clasp.json         GAS プロジェクトの scriptId
  appsscript.json     GAS の設定（タイムゾーン Asia/Tokyo、Web アプリの公開設定）
  main.js             doGet / doPost（リクエストの振り分け）と共通の関数
  stock.js            在庫
  finance.js          家計簿
  tags.js             タグの一括操作
  chore.js            家事（登録・完了・編集・削除・通知）
  chore-rule.js       家事の周期の計算。GAS と画面（index.html から読み込む）の両方で使う
  notify.js           Discord への送信、賞味期限の通知
```
`js/` のファイルは ES モジュールではなく通常の `<script>` で読み込むため、ファイルをまたいで関数や変数をそのまま使える。GAS も同じく、すべてのファイルが1つのプログラムとして動く。

## スプレッドシートの構成

シート名と1行目の見出し（列名）でデータを読み書きする。列の順番は自由だが、列名は変えないこと。

### 在庫（1行＝1ロット）

同じ商品でも賞味期限が違えば別の行になる。画面では商品名ごとにまとめて表示する。

| 列 | 内容 |
| --- | --- |
| `id` | ロットのID（UUID） |
| `itemName` | 商品名 |
| `stock` | 個数 |
| `location` | 収納場所（同じ商品の全ロットで共通） |
| `tags` | タグ（`,` 区切り。同じ商品の全ロットで共通） |
| `expirationDate` | 賞味期限（`yyyy-MM-dd`。なしなら空） |
| `modelNumber` | 型番（同じ商品の全ロットで共通）。型番を入れた商品は取扱説明書を探すための登録として扱い、画面の「登録中の商品」には表示しない |
| `lastUpdated` | 最終更新日時 |

### 家計簿

| 列 | 内容 |
| --- | --- |
| `date` | 支出した日（日本時間のその日の 0:00） |
| `category` | カテゴリ |
| `amount` | 金額 |
| `memo` | メモ |
| `tags` | タグ（`,` 区切り） |
| `createdAt` | アプリで登録した日時。同じ日の並び順と、編集・削除のときの行の確認に使う（列がなければ自動で追加される） |

### 家事

| 列 | 内容 |
| --- | --- |
| `id` | 家事のID（UUID） |
| `taskName` | 家事名 |
| `rule` | 周期のルール（JSON。形式は `gas/chore-rule.js` の先頭のコメントを参照） |
| `cycle` | 周期の説明文（`rule` から自動で作る。例：`毎月第2日曜 10:00`） |
| `nextDue` | 次の予定日時（時刻なしの家事はその日の 0:00） |
| `lastDone` | 最後に完了した日時 |
| `notifiedFor` | どの予定日時の分まで通知したか（二重通知の防止） |

`rule`・`nextDue`・`notifiedFor` などの列がなければ、最初に登録したときに自動で追加される。

## GAS の API

画面は `js/common.js` の `GAS_URL`（Web アプリの URL）にリクエストを送る。

### 取得（GET `?action=...`）

| action | 返すもの |
| --- | --- |
| `getStock` | 在庫の全行 |
| `getTasks` | 家事の全行 |
| `getFinanceOptions` | 家計簿のカテゴリ・タグの候補と、タグごとの件数 |
| `getFinance` | 家計簿の履歴。`offset`・`limit` で範囲、`tags`（`,` 区切り）・`mode`（`any` / `all`）でタグの絞り込み。`monthTotals` に月別合計 |

### 書き込み（POST。本文は JSON）

| type | action | 内容 |
| --- | --- | --- |
| `stock` | なし | 登録。同じ商品名・同じ賞味期限のロットがあれば個数を足し、なければロットを追加 |
| `stock` | `bump` | ロットの個数を増減（`id`・`value`） |
| `stock` | `editItem` | 商品の編集（商品情報と、賞味期限ごとの個数をまとめて保存） |
| `stock` | `delete` | 商品の全ロットを削除（`target` に商品名） |
| `finance` | なし | 記録の追加 |
| `finance` | `edit` / `delete` | 記録の編集・削除（`row` と `date`・`createdAt` で行を確認してから行う） |
| `tag` | `rename` / `delete` / `assign` | タグの名称変更・一括削除・一括付与（`sheet` は `stock` / `finance`） |
| `todo` | `add` / `done` / `edit` / `delete` | 家事の登録・完了・編集・削除 |

返り値は `{ "status": "success" }` または `{ "status": "error", "message": "..." }`。

## セットアップ

### 1. GAS

1. `gas/` フォルダで `clasp push` する
2. GAS エディタの「プロジェクトの設定」→「スクリプト プロパティ」に `DISCORD_WEBHOOK_URL`（Discord の Webhook URL）を追加する
3. GAS エディタで次のトリガーを用意する
   - `setupChoreTrigger` を一度実行する（`checkChores` を5分ごとに実行するトリガーが作られる。何度実行しても重複しない）
   - `checkExpirationAndNotifyDiscord` を1日1回実行する時間主導型トリガーを作る
4. Web アプリとしてデプロイし、URL を `js/common.js` の `GAS_URL` に入れる

通知のテストは `debugForceDiscordNotify` を実行する。

### 2. 画面

GitHub Pages でリポジトリのルートを公開する。iPhone では Safari で開き、「ホーム画面に追加」する。

## 更新の手順

### GAS を変更したとき

`clasp push` だけでは公開中の Web アプリは変わらない。デプロイを更新する（URL は変わらない）。

```sh
cd gas
clasp push
clasp deploy -i AKfycbzCsng8oDxwQnSnUlxz1m3ANECSSH1tkmK1GIhowAkyhAM_ao7BydA1venB-zGssbL1 -d "変更内容"
```
`clasp push` は GAS 側を手元の `gas/` と同じ状態にする（手元にないファイルは GAS から消える）。

### 画面を変更したとき

`main` に push すると GitHub Pages に反映される（1分ほどかかる）。

- GitHub Pages は10分間キャッシュされる。アプリのヘッダー右上の再読み込みボタンを押すと、キャッシュを使わずに最新版を読み込む
- ホーム画面のアイコンや `<head>` の `apple-mobile-web-app-*` の設定を変えたときは、ホーム画面のアイコンを削除して追加し直す必要がある

## 開発時の注意

- **ステータスバーの設定**：`apple-mobile-web-app-status-bar-style` は `black` にしている。`black-translucent` にすると、iOS 26 のホーム画面アプリで表示領域が画面の下端まで届かず、タブバーの下に空白ができる
- **タブバー**：背景は画面の下端（ホームバーの下）まで伸ばし、文字は `env(safe-area-inset-bottom)` の分だけ上に置く
- **日付**：GAS は `Asia/Tokyo` で動く。家計簿の日付と家事の予定日時は、日本時間で計算する
- **動作確認**：手元では Edge のヘッドレスモードで `index.html` を開いてスクリーンショットを撮れる（`msedge --headless=new --screenshot=... --window-size=520,900 file:///.../index.html`）。ヘッドレスの Edge は幅が約500px より狭くならない
