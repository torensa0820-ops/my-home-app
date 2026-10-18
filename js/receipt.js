// レシート・クーポンの撮影：写真を縮めて GAS に送り、Google ドライブに保存する（読み取りは毎晩 0:00 に Claude が行う）
// ヘッダーのカメラのボタンから開く。長いレシートは「続きを撮る」で同じ1件に写真を足す

const RECEIPT_MAX_SIDE = 1600;     // 送る前に長い辺をこの大きさまで縮める（px）
const RECEIPT_JPEG_QUALITY = 0.8;
const RECEIPT_MAX_BYTES = 5 * 1024 * 1024; // GAS が受け取る1枚の上限
const RECEIPT_KINDS = [
  {kind:'レシート', label:'レシート'},
  {kind:'クーポン', label:'クーポン・割引券'},
];
// current：撮影中の1件（{id, kind, count}。続きを撮ると同じ1件に足す）、sending：送信中、summary：今日撮った分と未読の件数
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
      // 時間切れでも GAS 側では保存できていることがあるので、今日撮った分を読み込み直して確かめられるようにする
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

// 今日撮った分と、まだ読まれていない件数を読み込む
function loadReceiptSummary(){
  return getFromGas('action=getReceipts')
    .then(data=>{ capture.summary = data; drawReceiptSummary(); })
    .catch(err=>{
      if(capture.summaryBox && capture.summaryBox.isConnected){
        capture.summaryBox.replaceChildren(h('p', {class:'tm-note'}, `今日撮った分を読み込めませんでした（${errMsg(err)}）`));
      }
    });
}
const RECEIPT_STATUS = {'':'今夜読みます', read:'読み取り済み', error:'読み取れませんでした', skipped:'読みません'};
function drawReceiptSummary(){
  const box = capture.summaryBox;
  if(!box || !box.isConnected) return;
  const s = capture.summary;
  if(!s){ box.replaceChildren(h('p', {class:'tm-note'}, '今日撮った分を読み込み中…')); return; }
  box.replaceChildren(
    h('h3', {}, `今日撮った分（${s.today.length}件）`),
    h('p', {class:'tm-note tm-lead'}, s.unread ? `まだ読まれていないのは ${s.unread}件です（今夜 0:00 に読みます）` : 'まだ読まれていない写真はありません'),
    ...s.today.map(r=>{
      const status = String(r.status || '');
      const read = status === 'read' && (r.store || r.total);
      const skip = status === '' ? h('button', {type:'button', class:'row-action', disabled:capture.sending, onclick:e=>skipReceiptPhoto(r, e.currentTarget)}, '取り消す') : '';
      return h('div', {class:'tm-row import-row'},
        h('span', {class:'when'}, String(r.uploadedAt || '').slice(11, 16)),
        h('span', {class:'name'},
          h('span', {}, `${r.kind || 'レシート'}・${r.count || 0}枚`),
          h('small', {}, read ? [r.store, r.total ? `¥${Number(r.total).toLocaleString()}` : ''].filter(Boolean).join(' ') : (RECEIPT_STATUS[status] || status))),
        skip);
    }));
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
