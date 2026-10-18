// クーポン：レシートに付いていたクーポン・割引券（夜に Claude が「クーポン」シートに書いたもの）
// 家計簿タブの上に「クーポン n枚」を出し、一覧で「使った」「不要」を選ぶ。期限の近い順に並べ、近いものを目立たせる
// status=候補：レシートとして撮った写真の中で Claude が見つけたクーポン・キャンペーン・告知など。
//   一覧の上の「レシートから見つかった候補」で内容を直して「リマインドする」（通常のクーポンになり、翌朝通知される）か「不要」を選ぶ

let couponList = []; // 未使用（status が空）と候補（status=候補）の両方
const COUPON_CANDIDATE = '候補';

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
// candidate なら候補、そうでなければ未使用のクーポン
function sortedCoupons(candidate = false){
  const key = c=>toDateInputValue(c.validUntil) || '9999-99-99';
  return couponList
    .filter(c=>(String(c.status || '') === COUPON_CANDIDATE) === candidate)
    .filter(c=>!toDateInputValue(c.validUntil) || daysFromToday(toDateInputValue(c.validUntil)) >= 0)
    .sort((a, b)=>key(a).localeCompare(key(b)));
}

// 家計簿タブの上に「クーポン n枚」を出す（クーポンも候補もなければ何も出さない）。いちばん期限の近い1枚を書き添える
function renderCouponBanner(){
  const wrap = document.getElementById('finance-coupons');
  wrap.replaceChildren();
  const list = sortedCoupons();
  const candidates = sortedCoupons(true);
  if(!list.length && !candidates.length) return;
  const usable = list.filter(c=>couponState(c).cls !== 'later');
  const first = usable[0] || list[0];
  const parts = [];
  if(first){
    const st = couponState(first);
    parts.push(`${[first.store, first.title].filter(Boolean).join(' ')}${st.label ? `（${st.label}）` : ''}${list.length > 1 ? ` ほか${list.length - 1}枚` : ''}`);
  }
  if(candidates.length) parts.push(`候補 ${candidates.length}件`);
  wrap.append(h('button', {type:'button', class:'import-banner coupon' + (usable.some(c=>couponState(c).cls) ? ' soon' : ''),
    onclick:()=>openSheet('finance', tmCouponList)},
    h('span', {class:'dot' + (list.length ? '' : ' quiet')}, String(list.length || candidates.length)),
    h('span', {class:'text'},
      h('b', {}, 'クーポン'),
      h('span', {}, parts.join('・'))),
    h('span', {class:'chev'}, '›')));
}

function tmCouponList(){
  tmTitle.textContent = 'クーポン';
  const list = sortedCoupons();
  const candidates = sortedCoupons(true);
  if(!list.length && !candidates.length){ tmBody.append(h('p', {class:'empty-msg'}, '使えるクーポンはありません')); return; }
  if(candidates.length){
    tmBody.append(h('div', {class:'tm-section'},
      h('h3', {}, `レシートから見つかった候補（${candidates.length}件）`),
      h('p', {class:'tm-note tm-lead'}, 'レシートの写真に写っていたクーポン・キャンペーン・お店の告知です。内容と期間を直して「リマインドする」と、クーポンとして翌朝から通知します。'),
      candidates.map(couponCandidateCard)));
  }
  if(!list.length) return;
  tmBody.append(h('h3', {class:'tm-subhead'}, 'クーポン'),
    h('p', {class:'tm-note tm-lead'}, 'レシートに付いていたクーポン・割引券です。期限の近い順に並べています。使ったら「使った」を押してください。'));
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

// 候補の1件：店・内容（直せる）・詳細・期間（直せる）・写真。「不要」「リマインドする」
function couponCandidateCard(c){
  const title = h('input', {type:'text', value:c.title || '', placeholder:'例：次回100円引き'});
  const from = h('input', {type:'date', value:toDateInputValue(c.validFrom)});
  const until = h('input', {type:'date', value:toDateInputValue(c.validUntil)});
  const remind = h('button', {type:'button', class:'tm-btn'}, 'リマインドする');
  const dismiss = h('button', {type:'button', class:'row-action'}, '不要');
  remind.addEventListener('click', ()=>{
    const values = {title:normText(title.value), validFrom:from.value, validUntil:until.value};
    if(!values.title){ toast('内容を入力してください'); return; }
    if(values.validFrom && values.validUntil && values.validFrom > values.validUntil){ toast('開始日が期限より後になっています'); return; }
    couponDone(c, 'remind', [remind, dismiss], values);
  });
  dismiss.addEventListener('click', ()=>couponDone(c, 'dismiss', [remind, dismiss]));
  return h('div', {class:'coupon-card candidate'},
    h('div', {class:'coupon-top'},
      h('span', {class:'store'}, c.store || '店名不明'),
      h('span', {class:'coupon-badge'}, '候補')),
    h('div', {class:'field coupon-field'}, h('label', {}, '内容'), title),
    c.detail ? h('div', {class:'coupon-detail'}, c.detail) : '',
    h('div', {class:'coupon-dates'},
      h('div', {class:'field'}, h('label', {}, '使える日（任意）'), from),
      h('div', {class:'field'}, h('label', {}, '期限（任意）'), until)),
    h('div', {class:'coupon-actions'}, photoLinks(c.fileId ? [c.fileId] : [], '写真を開く'), dismiss, remind));
}

// 「使った」（used）・「不要」（dismiss）・候補の「リマインドする」（remind。values に直した内容）
const COUPON_DONE_MSG = {used:'使ったクーポンにしました', dismiss:'不要にしました', remind:'クーポンにしました（翌朝通知します）'};
function couponDone(c, action, buttons, values = {}){
  if(tm.busy) return;
  buttons.forEach(b=>{ b.disabled = true; });
  tm.busy = true;
  postToGas({type:'coupon', action, id:c.id, ...values})
    .then(res=>{
      if(res.status !== 'success') throw new Error(res.message || '処理に失敗しました');
      // リマインドした候補は未使用のクーポンとして一覧に移す（notifiedOn は空のまま）
      couponList = action === 'remind'
        ? couponList.map(x=>x.id === c.id ? {...x, ...values, status:'', notifiedOn:''} : x)
        : couponList.filter(x=>x.id !== c.id);
      renderCouponBanner();
      tm.busy = false;
      toast(COUPON_DONE_MSG[action]);
      if(!sortedCoupons().length && !sortedCoupons(true).length){ closeSheet(); return; }
      tmRender();
    })
    .catch(err=>{ tm.busy = false; toast(errMsg(err)); buttons.forEach(b=>{ b.disabled = false; }); });
}
