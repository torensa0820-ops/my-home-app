// レシート・クーポンの撮影：写真を縮めて GAS に送り、Google ドライブに保存する（読み取りは毎晩 0:00 に Claude が行う）
// ヘッダーのカメラのボタンから開く。長いレシートは「続きを撮る」で同じ1件に写真を足す

const RECEIPT_MAX_SIDE = 1600;     // 送る前に長い辺をこの大きさまで縮める（px）
const RECEIPT_JPEG_QUALITY = 0.8;
const RECEIPT_MAX_BYTES = 5 * 1024 * 1024; // GAS が受け取る1枚の上限
const RECEIPT_KINDS = [
  {kind:'レシート', label:'レシート'},
  {kind:'クーポン', label:'クーポン・割引券'},
];
// current：撮影中の1件（{id, kind, count}。続きを撮ると同じ1件に足す）、sending：送信中、summary：最近撮った分と未読の件数
const capture = {current:null, sending:false, summary:null, summaryBox:null};

document.getElementById('camera-btn').addEventListener('click', ()=>{
  capture.current = null;
  openSheet('receipt', tmCapture);
  loadReceiptSummary();
});

// 写真を選ぶ。useCamera ならカメラを開き、そうでなければアルバムから選ぶ（ボタンのタップの中で呼ぶ）
function pickPhoto(useCamera, onPick){
  const input = h('input', {type:'file', accept:'image/*', class:'photo-input'});
  if(useCamera) input.setAttribute('capture', 'environment');
  input.addEventListener('change', ()=>{
    const file = input.files && input.files[0];
    input.remove();
    if(file) onPick(file);
  });
  input.addEventListener('cancel', ()=>input.remove());
  document.body.append(input); // iPhone の Safari で確実に開くよう、ページに置いてから押す
  input.click();
}

// 写真を長い辺 1600px・JPEG に縮めて base64 にする（iPhone の HEIC もここで JPEG になる）
function shrinkPhoto(file){
  return new Promise((resolve, reject)=>{
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = ()=>{
      URL.revokeObjectURL(url);
      const scale = Math.min(1, RECEIPT_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // 透明な部分（PNG など）を白にする
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', RECEIPT_JPEG_QUALITY);
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      if(b64.length * 3 / 4 > RECEIPT_MAX_BYTES){ reject(new Error('写真が大きすぎます（1枚 5MB まで）')); return; }
      resolve(b64);
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('写真を読み込めませんでした')); };
    img.src = url;
  });
}

// 写真を撮って（選んで）送る。続きのときは撮影中の1件に足す
function sendPhoto(kind, useCamera){
  if(capture.sending) return;
  pickPhoto(useCamera, file=>{
    const cont = capture.current;
    capture.sending = true;
    tm.busy = true;
    tmRender();
    shrinkPhoto(file)
      .then(image=>postToGas({type:'receipt', action:'upload', kind, receiptId:cont ? cont.id : '', image}))
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '送信に失敗しました');
        capture.current = {id:res.id, kind, count:res.count};
        toast(res.count > 1 ? `${res.count}枚目を送りました` : `${kind}を送りました`);
      })
      // 時間切れでも GAS 側では保存できていることがあるので、最近撮った分を読み込み直して確かめられるようにする
      .catch(err=>toast(errMsg(err)))
      .finally(()=>{
        capture.sending = false;
        tm.busy = false;
        if(tmBackdrop.classList.contains('show')) tmRender();
        loadReceiptSummary();
      });
  });
}

// ---------- 撮影の画面 ----------
function tmCapture(){
  tmTitle.textContent = 'レシート・クーポンを撮る';
  const busy = capture.sending;
  const btn = (label, cls, onclick)=>h('button', {type:'button', class:cls, disabled:busy, onclick}, label);
  const cur = capture.current;
  if(busy) tmBody.append(h('div', {class:'capture-status'}, '送信中…（写真を縮めて保存しています）'));
  if(cur){
    tmBody.append(
      h('div', {class:'import-info'},
        h('div', {class:'top'}, h('span', {}, cur.kind), h('b', {}, `${cur.count}枚`)),
        h('div', {class:'sub'}, '送信済み。長いレシートは続きを撮ると、同じ1件にまとめます。')),
      h('div', {class:'capture-pair'},
        btn('続きを撮る', 'tm-btn capture-main', ()=>sendPhoto(cur.kind, true)),
        btn('アルバムから', 'cancel-btn', ()=>sendPhoto(cur.kind, false))),
      btn('終わる（別の1件を撮る）', 'cancel-btn', ()=>{ capture.current = null; tmRender(); }));
  } else {
    tmBody.append(h('p', {class:'tm-note tm-lead'},
      '写真は Google ドライブに保存し、毎晩 0:00 に Claude が読み取って、在庫・家計簿・クーポンに反映します。反映した内容は翌朝からアプリで確認できます。'));
    RECEIPT_KINDS.forEach(k=>tmBody.append(h('div', {class:'capture-kind'},
      h('div', {class:'capture-label'}, k.label),
      h('div', {class:'capture-pair'},
        btn('撮る', 'tm-btn capture-main', ()=>sendPhoto(k.kind, true)),
        btn('アルバムから', 'cancel-btn', ()=>sendPhoto(k.kind, false))))));
  }
  capture.summaryBox = h('div', {class:'tm-section capture-summary'});
  tmBody.append(capture.summaryBox);
  drawReceiptSummary();
}

// 最近撮った分と、まだ読まれていない件数を読み込む
function loadReceiptSummary(){
  return getFromGas('action=getReceipts')
    .then(data=>{ capture.summary = data; drawReceiptSummary(); })
    .catch(err=>{
      if(capture.summaryBox && capture.summaryBox.isConnected){
        capture.summaryBox.replaceChildren(h('p', {class:'tm-note'}, `最近撮った分を読み込めませんでした（${errMsg(err)}）`));
      }
    });
}
const RECEIPT_STATUS = {'':'今夜読みます', read:'読み取り済み', error:'読み取れませんでした', skipped:'読みません', 再読:'今夜 在庫の判断を読み直します'};
const RECEIPT_RECENT_LABEL = '14日'; // 撮影画面に出す期間（GAS の RECEIPT_RECENT_DAYS）
// 「yyyy/MM/dd HH:mm」→「10/18 19:39」
function receiptWhen(v){
  const m = String(v || '').match(/^\d{4}[-\/](\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}:\d{2})/);
  return m ? `${Number(m[1])}/${Number(m[2])} ${m[3]}` : '';
}
// 一覧の1行の説明：「ベルク ¥3,882・在庫 自動2・確認1・対象外5・クーポン1」
function receiptDigest(r){
  const status = String(r.status || '');
  if(status !== 'read' && status !== '再読') return RECEIPT_STATUS[status] || status;
  const head = [r.store, r.total ? `¥${Number(r.total).toLocaleString()}` : ''].filter(Boolean).join(' ');
  const stock = r.items ? `在庫 ${[r.auto ? `自動${r.auto}` : '', r.confirm ? `確認${r.confirm}` : '', r.skip ? `対象外${r.skip}` : ''].filter(Boolean).join('・')}` : '';
  return [head, stock, r.coupons ? `クーポン${r.coupons}` : '', status === '再読' ? '読み直し待ち' : ''].filter(Boolean).join('・');
}
function drawReceiptSummary(){
  const box = capture.summaryBox;
  if(!box || !box.isConnected) return;
  const s = capture.summary;
  if(!s){ box.replaceChildren(h('p', {class:'tm-note'}, '最近撮った分を読み込み中…')); return; }
  box.replaceChildren(
    h('h3', {}, `最近撮った分（${RECEIPT_RECENT_LABEL}・${s.recent.length}件）`),
    h('p', {class:'tm-note tm-lead'}, (s.unread ? `まだ読まれていないのは ${s.unread}件です（今夜 0:00 に読みます）。` : 'まだ読まれていない写真はありません。')
      + 'タップすると、在庫・家計簿・クーポンにどう反映したかを見られます。'),
    ...s.recent.map(r=>{
      const status = String(r.status || '');
      const skip = status === '' ? h('button', {type:'button', class:'row-action', disabled:capture.sending,
        onclick:e=>{ e.stopPropagation(); skipReceiptPhoto(r, e.currentTarget); }}, '取り消す') : '';
      return h('div', {class:'tm-row import-row receipt-row', role:'button', tabIndex:0, onclick:()=>{ if(!tm.busy) tmShow(tmReceiptDetail, r); }},
        h('span', {class:'when'}, receiptWhen(r.uploadedAt)),
        h('span', {class:'name'},
          h('span', {}, `${r.kind || 'レシート'}・${r.count || 0}枚`),
          h('small', {}, receiptDigest(r))),
        skip || h('span', {class:'chev'}, '›'));
    }));
}

// ---------- 撮影した1件の詳細：何がどこに反映されたか ----------
const RECEIPT_DECISION_CLS = {自動追加:'auto', 確認:'confirm', 対象外:'skip'};
// 在庫取込の status → いまの状態
const STOCK_IMPORT_STATUS = {自動追加:'在庫に足しました', '':'確認待ち（在庫タブの「レシートから」）', added:'在庫に追加しました', dismissed:'「追加しない」にしました', undone:'取り消しました'};
const FINANCE_IMPORT_STATUS = {'':'確認待ち（家計簿タブで登録してください）', registered:'家計簿に登録済み', skipped:'「登録しない」にしました', error:'読み取れませんでした'};
const COUPON_STATUS_LABEL = {'':'未使用（通知します）', 候補:'候補（クーポン一覧で確認）', used:'使った', dismissed:'不要', expired:'期限切れ'};

function tmReceiptDetail(r){
  tmTitle.textContent = r.kind === 'クーポン' ? 'クーポンの写真' : 'レシートの反映';
  tmBody.append(h('p', {class:'empty-msg'}, '読み込み中…'));
  const view = tm.stack[tm.stack.length - 1];
  getFromGas(`action=getReceiptDetail&id=${encodeURIComponent(r.id)}`)
    .then(d=>{
      if(tm.stack[tm.stack.length - 1] !== view) return; // ほかの画面に移っていたら描かない
      if(d.status === 'error') throw new Error(d.message);
      tmBody.replaceChildren();
      drawReceiptDetail(d);
    })
    .catch(err=>{
      if(tm.stack[tm.stack.length - 1] !== view) return;
      tmBody.replaceChildren(loadErrorView(err, ()=>tmRender()));
    });
}

function drawReceiptDetail(d){
  const r = d.receipt;
  const status = String(r.status || '');
  const section = (title, ...children)=>h('div', {class:'tm-section'}, h('h3', {}, title), children);
  tmBody.append(h('div', {class:'import-info'},
    h('div', {class:'top'}, h('span', {}, r.store || r.kind || 'レシート'), r.total ? h('b', {}, `¥${Number(r.total).toLocaleString()}`) : ''),
    h('div', {class:'sub'}, [r.purchasedAt ? `購入 ${receiptWhen(r.purchasedAt) || r.purchasedAt}` : '', r.payment, `撮影 ${receiptWhen(r.uploadedAt)}`].filter(Boolean).join(' ・ ')),
    h('div', {class:'sub'}, `状態：${RECEIPT_STATUS[status] || status}`),
    photoLinks(r.files)));
  if(r.note) tmBody.append(h('p', {class:'tm-note tm-lead'}, `Claude のメモ：${r.note}`));
  if(status === '' || status === 'skipped' || status === 'error'){
    if(status === '') tmBody.append(h('p', {class:'tm-note'}, '今夜 0:00 に読み取ります。読み取ったあと、ここに在庫・家計簿・クーポンへの反映が出ます。'));
    return;
  }

  if(r.kind === 'レシート'){
    // 家計簿
    const f = d.finance;
    tmBody.append(section('家計簿', f
      ? h('div', {class:'receipt-line'},
          h('div', {class:'main'}, h('span', {}, f.source === 'receipt' ? 'レシートの支払い（カード以外）' : `カード利用 ${importWhen(f)}`), h('b', {}, `¥${(Number(f.amount) || 0).toLocaleString()}`)),
          h('div', {class:'sub'}, FINANCE_IMPORT_STATUS[String(f.status || '')] || f.status),
          suggestDigest(f) ? h('div', {class:'sub'}, `案：${suggestDigest(f)}`) : '')
      : h('p', {class:'tm-note'}, '確認待ちの行はありません（理由は上の Claude のメモを見てください）')));

    // 在庫
    const items = d.items || [];
    const stockBody = [];
    if(items.length){
      stockBody.push(h('p', {class:'tm-note tm-lead'}, 'レシートの全品目と、在庫についての判断です。在庫に登録済みでタグ「ストック」がある品目は自動で足し、登録済みでもストックタグのない品目や、新しく管理したほうがよさそうな品目は「確認」になります。'));
      items.forEach(it=>{
        const cls = RECEIPT_DECISION_CLS[it.decision] || 'skip';
        const si = it.stockImport;
        stockBody.push(h('div', {class:'receipt-line'},
          h('div', {class:'main'},
            h('span', {}, `${it.itemName || '品名不明'}${Number(it.qty) > 1 ? ` ×${it.qty}` : ''}`),
            h('span', {class:'decision ' + cls}, it.decision || '—')),
          it.matchedStock ? h('div', {class:'sub'}, `在庫の「${it.matchedStock}」と同じ物`) : '',
          it.reason ? h('div', {class:'sub'}, it.reason) : '',
          si ? h('div', {class:'sub state'}, `→ ${STOCK_IMPORT_STATUS[String(si.status || '')] || si.status}${si.qty ? `（${si.qty}個）` : ''}`) : ''));
      });
    } else {
      stockBody.push(h('p', {class:'tm-note'}, '品目ごとの記録がありません（品目の記録を始める前に読んだレシートです）。下の「在庫の判断を読み直す」を押すと、今夜記録されます。'));
    }
    (d.otherStockImports || []).forEach(si=>stockBody.push(h('div', {class:'receipt-line'},
      h('div', {class:'main'}, h('span', {}, `${si.itemName}${Number(si.qty) > 1 ? ` ×${si.qty}` : ''}`),
        h('span', {class:'decision ' + (si.kind === '自動' ? 'auto' : 'confirm')}, si.kind === '自動' ? '自動追加' : '確認')),
      h('div', {class:'sub state'}, `→ ${STOCK_IMPORT_STATUS[String(si.status || '')] || si.status}`))));
    tmBody.append(section(`在庫（${items.length}品目）`, stockBody));
  }

  // クーポン
  const coupons = d.coupons || [];
  if(coupons.length || r.kind === 'クーポン'){
    tmBody.append(section('クーポン', coupons.length
      ? coupons.map(c=>h('div', {class:'receipt-line'},
          h('div', {class:'main'}, h('span', {}, [c.store, c.title].filter(Boolean).join(' ')),
            h('span', {class:'decision ' + (c.status === '候補' ? 'confirm' : 'auto')}, c.status === '候補' ? '候補' : 'クーポン')),
          h('div', {class:'sub'}, COUPON_STATUS_LABEL[String(c.status || '')] || c.status)))
      : h('p', {class:'tm-note'}, 'クーポンは作られていません')));
  }

  // 在庫の判断を読み直す
  if(r.kind !== 'レシート') return;
  if(status === '再読'){
    tmBody.append(h('p', {class:'tm-note'}, '在庫の判断の読み直しを頼んであります。今夜 0:00 に読み直します。'));
    return;
  }
  const btn = h('button', {type:'button', class:'cancel-btn'}, '在庫の判断を読み直す');
  btn.addEventListener('click', ()=>rereadReceipt(r, btn));
  tmBody.append(h('div', {class:'tm-section tm-danger'},
    h('h3', {}, '在庫の判断を読み直す'),
    h('p', {class:'tm-note'}, '在庫の商品にタグ「ストック」を後から付けたときなどに使います。今夜 0:00 に Claude がこのレシートの在庫の判断だけをやり直します。家計簿・クーポンはそのままで、すでに在庫に足した品目は二重に足しません。'),
    btn));
}
// 取込待ちの案（suggestItems）を「食費 ¥4,246 ／ 日用品 ¥547」にする
function suggestDigest(f){
  let list = [];
  try { list = JSON.parse(f.suggestItems || '[]'); } catch(_){}
  return (Array.isArray(list) ? list : []).map(s=>`${s.category} ¥${(Number(s.amount) || 0).toLocaleString()}`).join(' ／ ');
}

// 在庫の判断の読み直しを頼む（レシートの status を「再読」にする）
function rereadReceipt(r, btn){
  if(tm.busy) return;
  btn.disabled = true;
  btn.textContent = '依頼中…';
  tm.busy = true;
  postToGas({type:'receipt', action:'reread', id:r.id})
    .then(res=>{
      if(res.status !== 'success') throw new Error(res.message || '依頼に失敗しました');
      toast('今夜、在庫の判断を読み直します');
      r.status = '再読';
      tm.busy = false;
      tmRender();
      loadReceiptSummary();
    })
    .catch(err=>{ tm.busy = false; toast(errMsg(err)); btn.disabled = false; btn.textContent = '在庫の判断を読み直す'; });
}

// 撮り間違えた写真を読まないようにする（まだ読まれていない1件だけ）
function skipReceiptPhoto(r, btn){
  if(capture.sending || tm.busy) return;
  btn.disabled = true;
  btn.textContent = '処理中…';
  tm.busy = true;
  postToGas({type:'receipt', action:'skip', id:r.id})
    .then(res=>{
      if(res.status !== 'success') throw new Error(res.message || '取り消しに失敗しました');
      if(capture.current && capture.current.id === r.id){ capture.current = null; }
      toast('この写真は読まないようにしました');
    })
    .catch(err=>toast(errMsg(err)))
    .finally(()=>{ tm.busy = false; tmRender(); loadReceiptSummary(); });
}
