// クーポン：レシートに付いていたクーポン・割引券（夜に Claude が「クーポン」シートに書いたもの）
// 家計簿タブの上に「クーポン n枚」を出し、一覧で「使った」「不要」を選ぶ。期限の近い順に並べ、近いものを目立たせる

let couponList = [];

// preloaded：起動時にまとめて取得したデータ（あれば通信しない）
function loadCoupons(preloaded){
  return (preloaded ? Promise.resolve(preloaded) : getFromGas('action=getCoupons'))
    .then(rows=>{
      couponList = rows || [];
      renderCouponBanner();
    })
    .catch(err=>toast(`クーポンの読み込みに失敗しました（${errMsg(err)}）`));
}

// 使える期間「10/20〜10/26」（validFrom が空なら「〜10/26まで」）
function couponPeriod(c){
  const from = toDateInputValue(c.validFrom), until = toDateInputValue(c.validUntil);
  if(from && until) return `${mdLabel(from)}〜${mdLabel(until)}`;
  if(until) return `〜${mdLabel(until)}まで`;
  if(from) return `${mdLabel(from)}から`;
  return '期限なし';
}
// 今の状態：まだ使えない（「10/20から」）、期限が近い（今日まで・明日まで・あと3日）など
// cls：later（まだ使えない）・soon（3日以内）・urgent（今日まで）
function couponState(c){
  const from = toDateInputValue(c.validFrom), until = toDateInputValue(c.validUntil);
  if(from && daysFromToday(from) > 0) return {label:`${mdLabel(from)}から`, cls:'later'};
  if(!until) return {label:'', cls:''};
  const d = daysFromToday(until);
  if(d <= 0) return {label:'今日まで', cls:'urgent'};
  if(d === 1) return {label:'明日まで', cls:'soon'};
  return {label:`あと${d}日`, cls:d <= 3 ? 'soon' : ''};
}
// 期限の近い順（期限なしは最後）。期限が過ぎたものは出さない（翌朝の通知で expired になる）
function sortedCoupons(){
  const key = c=>toDateInputValue(c.validUntil) || '9999-99-99';
  return couponList
    .filter(c=>!toDateInputValue(c.validUntil) || daysFromToday(toDateInputValue(c.validUntil)) >= 0)
    .sort((a, b)=>key(a).localeCompare(key(b)));
}

// 家計簿タブの上に「クーポン n枚」を出す（なければ何も出さない）。いちばん期限の近い1枚を書き添える
function renderCouponBanner(){
  const wrap = document.getElementById('finance-coupons');
  wrap.replaceChildren();
  const list = sortedCoupons();
  if(!list.length) return;
  const usable = list.filter(c=>couponState(c).cls !== 'later');
  const first = usable[0] || list[0];
  const st = couponState(first);
  wrap.append(h('button', {type:'button', class:'import-banner coupon' + (usable.some(c=>couponState(c).cls) ? ' soon' : ''),
    onclick:()=>openSheet('finance', tmCouponList)},
    h('span', {class:'dot'}, String(list.length)),
    h('span', {class:'text'},
      h('b', {}, 'クーポン'),
      h('span', {}, `${[first.store, first.title].filter(Boolean).join(' ')}${st.label ? `（${st.label}）` : ''}${list.length > 1 ? ` ほか${list.length - 1}枚` : ''}`)),
    h('span', {class:'chev'}, '›')));
}

function tmCouponList(){
  tmTitle.textContent = 'クーポン';
  const list = sortedCoupons();
  if(!list.length){ tmBody.append(h('p', {class:'empty-msg'}, '使えるクーポンはありません')); return; }
  tmBody.append(h('p', {class:'tm-note tm-lead'}, 'レシートに付いていたクーポン・割引券です。期限の近い順に並べています。使ったら「使った」を押してください。'));
  list.forEach(c=>{
    const st = couponState(c);
    const used = h('button', {type:'button', class:'tm-btn'}, '使った');
    const dismiss = h('button', {type:'button', class:'row-action'}, '不要');
    used.addEventListener('click', ()=>couponDone(c, 'used', [used, dismiss]));
    dismiss.addEventListener('click', ()=>couponDone(c, 'dismiss', [used, dismiss]));
    tmBody.append(h('div', {class:'coupon-card ' + st.cls},
      h('div', {class:'coupon-top'},
        h('span', {class:'store'}, c.store || '店名不明'),
        st.label ? h('span', {class:'coupon-badge'}, st.label) : ''),
      h('div', {class:'coupon-title'}, c.title || 'クーポン'),
      c.detail ? h('div', {class:'coupon-detail'}, c.detail) : '',
      h('div', {class:'coupon-period'}, `使える期間 ${couponPeriod(c)}`),
      h('div', {class:'coupon-actions'}, photoLinks(c.fileId ? [c.fileId] : [], '写真を開く'), dismiss, used)));
  });
}

// 「使った」（used）・「不要」（dismiss）
function couponDone(c, action, buttons){
  if(tm.busy) return;
  buttons.forEach(b=>{ b.disabled = true; });
  tm.busy = true;
  postToGas({type:'coupon', action, id:c.id})
    .then(res=>{
      if(res.status !== 'success') throw new Error(res.message || '処理に失敗しました');
      couponList = couponList.filter(x=>x.id !== c.id);
      renderCouponBanner();
      tm.busy = false;
      toast(action === 'used' ? '使ったクーポンにしました' : '不要にしました');
      if(!sortedCoupons().length){ closeSheet(); return; }
      tmRender();
    })
    .catch(err=>{ tm.busy = false; toast(errMsg(err)); buttons.forEach(b=>{ b.disabled = false; }); });
}
