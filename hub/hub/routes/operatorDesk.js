// The operator's desk: one static page. Enter the admin token once (kept only in this tab's sessionStorage) and it shows
//   1. chemists waiting to be paid / disputes, with a "Mark paid" button that needs the 12-digit payment reference
//   2. riders' cash deposits waiting for you to verify, with Confirm / Reject
//   3. riders' KYC documents: view the pictures, then Approve (rider becomes verified) or Reject with a reason
// All actions call the token-protected APIs; the page itself contains no secrets. Text from users is inserted with textContent only.
'use strict';
function deskHtml(nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SehatWaadi operator desk</title>
<style nonce="${nonce}">
:root{--bg:#f7f3ec;--card:#fff;--ink:#1d2b28;--muted:#66726f;--line:#e3ddd0;--brand:#1b4b43;--bad:#b42318;--ok:#0c831f}
@media (prefers-color-scheme:dark){:root{--bg:#12201d;--card:#1a2c28;--ink:#eef2f0;--muted:#a2b1ad;--line:#2c423d;--brand:#6fc4b3}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif}main{max-width:900px;margin:0 auto;padding:16px}
h1{font-size:22px;color:var(--brand)}h2{font-size:17px;margin:24px 0 8px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:8px 0}
.grow{flex:1}.row{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.muted{color:var(--muted)}.big{font-size:20px;font-weight:700}
button,input{font:inherit;padding:8px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--ink)}button{cursor:pointer;font-weight:600}
button.primary{background:var(--brand);color:#fff;border-color:var(--brand)}button.bad{color:var(--bad)}button:disabled{opacity:.5}
.tag{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:700;background:var(--line)}.tag.DISPUTED{background:#fde7e4;color:var(--bad)}.tag.PAID{background:#e3f4e6;color:var(--ok)}
#msg{position:sticky;top:0;padding:8px 12px;border-radius:9px;margin:8px 0;display:none}#msg.err{display:block;background:#fde7e4;color:var(--bad)}#msg.ok{display:block;background:#e3f4e6;color:var(--ok)}
.kycgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin:10px 0}.kycdoc img{width:100%;border-radius:8px;border:1px solid var(--line);cursor:zoom-in;margin:4px 0}.kycdoc label{font-size:13px}
</style></head><body><main>
<h1>SehatWaadi operator desk</h1>
<div id="login" class="card"><p>Enter the admin token. It stays in this browser tab only.</p><div class="row"><input id="tok" type="password" autocomplete="off" placeholder="Admin token" class="grow"><button class="primary" id="go">Open</button></div></div>
<div id="msg" role="status"></div>
<div id="app" hidden>
  <div class="row"><span class="muted" id="when"></span><span><button id="refresh">Refresh</button> <button id="out">Lock</button></span></div>
  <h2>Chemists to pay</h2><div id="pharm"></div>
  <h2>Rider documents to review (KYC)</h2><div id="kyc"></div>
  <h2>Riders' cash deposits to verify</h2><div id="riders"></div>
</div>
<script nonce="${nonce}">
(function(){
var $=function(i){return document.getElementById(i)}, T=function(){try{return sessionStorage.getItem('swdesk')||''}catch(e){return ''}};
function say(t,k){var m=$('msg');m.textContent=t||'';m.className=t?k:'';}
function api(method,path,body){return fetch(path,{method:method,headers:{'content-type':'application/json','x-admin-token':T()},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){if(r.status===403||r.status===503){lock();throw new Error(j.error==='admin_disabled'?'Admin access is not enabled on the server.':'Wrong admin token.');}if(!r.ok||j.ok===false)throw new Error(j.message||j.error||('Failed ('+r.status+')'));return j;});});}
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e}
function rs(n){return '₹'+Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}
function dt(s){return s?new Date(s).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):''}
function btn(label,cls,fn){var b=el('button',cls||'',label);b.onclick=function(){b.disabled=true;Promise.resolve(fn()).then(function(){load()},function(e){say(e.message,'err');b.disabled=false})};return b}
function lock(){try{sessionStorage.removeItem('swdesk')}catch(e){}$('app').hidden=true;$('login').hidden=false}
function renderPharm(list){var box=$('pharm');box.textContent='';if(!list.length){box.appendChild(el('p','muted','No claims waiting.'));return}
 list.forEach(function(s){var c=el('div','card'),top=el('div','row');var l=el('div');l.appendChild(el('b','',s.pharmacyName||s.pharmacyId));l.appendChild(document.createTextNode(' '));l.appendChild(el('span','tag '+s.status,s.status));
 l.appendChild(el('div','muted',s.ordersCount+' orders · claimed '+dt(s.requestedAt)));top.appendChild(l);top.appendChild(el('div','big',rs(s.amount)));c.appendChild(top);
 if(s.status==='DISPUTED'){c.appendChild(el('p','',"Chemist says NOT received: "+(s.disputeNote||'')));}
 if(s.status==='PAID'){c.appendChild(el('p','muted','You recorded payment ref '+s.paidRef+' on '+dt(s.paidAt)+'. Waiting for the chemist to confirm.'));}
 if(s.status==='REQUESTED'||s.status==='DISPUTED'){var f=el('div','row'),ref=el('input');ref.placeholder='12-digit payment reference (UTR)';ref.inputMode='numeric';ref.maxLength=16;ref.className='grow';f.appendChild(ref);
  f.appendChild(btn('Mark paid','primary',function(){return api('POST','/api/admin/payouts/'+s.id+'/pay',{ref:ref.value}).then(function(){say('Marked paid. The chemist has to confirm it.','ok')})}));
  f.appendChild(btn('Cancel claim','bad',function(){var n=prompt('Why are you cancelling this claim?');if(n===null)return Promise.resolve();return api('POST','/api/admin/payouts/'+s.id+'/cancel',{note:n}).then(function(){say('Claim cancelled.','ok')})}));c.appendChild(f);}
 box.appendChild(c)})}
function renderRiders(list){var box=$('riders');box.textContent='';if(!list.length){box.appendChild(el('p','muted','No deposits waiting.'));return}
 list.forEach(function(s){var c=el('div','card'),top=el('div','row');var l=el('div');l.appendChild(el('b','',s.full_name||'Rider'));l.appendChild(el('div','muted',(s.phone||'')+' · ref '+s.upi_ref+' · '+dt(s.created_at)));top.appendChild(l);top.appendChild(el('div','big',rs(s.amount)));c.appendChild(top);
 var f=el('div','row');f.appendChild(el('span','muted','Check the money is in your account with this reference before confirming.'));var b=el('span');
 b.appendChild(btn('Confirm received','primary',function(){return api('POST','/api/delivery/admin/settlements/'+s.id+'/confirm').then(function(){say('Deposit confirmed. The rider\\'s cash balance dropped.','ok')})}));b.appendChild(document.createTextNode(' '));
 b.appendChild(btn('Reject','bad',function(){var n=prompt('Why is it rejected? (e.g. no matching credit)');if(n===null)return Promise.resolve();return api('POST','/api/delivery/admin/settlements/'+s.id+'/reject',{note:n}).then(function(){say('Deposit rejected.','ok')})}));f.appendChild(b);c.appendChild(f);box.appendChild(c)})}
function renderKyc(list){var box=$('kyc');box.textContent='';if(!list.length){box.appendChild(el('p','muted','No riders waiting for review.'));return}
 list.forEach(function(s){var c=el('div','card'),top=el('div','row'),l=el('div');l.appendChild(el('b','',s.name||'Rider'));l.appendChild(el('div','muted',(s.phone||'')+' · '+s.vehicleType+(s.vehicleNumber?' '+s.vehicleNumber:'')+' · submitted '+dt(s.submittedAt)));top.appendChild(l);
 var open=el('button','primary','Review');top.appendChild(open);c.appendChild(top);var body=el('div');c.appendChild(body);open.onclick=function(){open.disabled=true;reviewKyc(s.riderId,body)};box.appendChild(c)})}
var LABEL={SELFIE:'Selfie',AADHAAR_FRONT:'Aadhaar (front)',AADHAAR_BACK:'Aadhaar (back)',PAN:'PAN card',DL_FRONT:'Driving licence'};
function reviewKyc(id,body){body.textContent='Loading…';api('GET','/api/admin/kyc/'+id).then(function(r){body.textContent='';var k=r.kyc,rd=r.rider;
 body.appendChild(el('div','muted','Date of birth '+k.dob+' · Aadhaar ending '+k.aadhaarLast4+' · PAN '+k.pan+(k.dlNumber?' · Licence '+k.dlNumber+' (expires '+k.dlExpiry+')':'')));
 body.appendChild(el('p','muted','Check each picture is sharp, shows the same name and number as typed above, and that the selfie matches the card photos.'));
 var grid=el('div','kycgrid'),checks={};
 r.docs.forEach(function(doc){var f=el('div','kycdoc');f.appendChild(el('b','',LABEL[doc.kind]||doc.kind));var img=el('img');img.alt=LABEL[doc.kind]||doc.kind;f.appendChild(img);
  fetch('/api/admin/kyc/'+id+'/doc/'+doc.kind,{headers:{'x-admin-token':T()}}).then(function(x){return x.blob()}).then(function(b){img.src=URL.createObjectURL(b);img.onclick=function(){window.open(img.src)}});
  var lab=el('label','');var cb=document.createElement('input');cb.type='checkbox';checks[doc.kind]=cb;lab.appendChild(cb);lab.appendChild(document.createTextNode(' Retake this one'));f.appendChild(lab);grid.appendChild(f)});
 body.appendChild(grid);var why=el('input');why.placeholder='If rejecting: what is wrong? (the rider sees this)';why.className='grow';var row=el('div','row');row.appendChild(why);
 row.appendChild(btn('Approve - rider becomes verified','primary',function(){return api('POST','/api/admin/kyc/'+id+'/decide',{decision:'APPROVE'}).then(function(){say(rd.name+' is verified and can go online.','ok')})}));
 row.appendChild(btn('Reject','bad',function(){var rt=Object.keys(checks).filter(function(k){return checks[k].checked});return api('POST','/api/admin/kyc/'+id+'/decide',{decision:'REJECT',retake:rt,reason:why.value}).then(function(){say('Rejected. The rider will see your reason.','ok')})}));
 body.appendChild(row)},function(e){body.textContent='';say(e.message,'err')})}
function load(){say('');Promise.all([api('GET','/api/admin/payouts'),api('GET','/api/delivery/admin/settlements'),api('GET','/api/admin/kyc').catch(function(){return {items:[]}})]).then(function(r){$('login').hidden=true;$('app').hidden=false;renderPharm(r[0].settlements||[]);renderRiders(r[1].settlements||[]);renderKyc(r[2].items||[]);$('when').textContent='Updated '+dt(new Date())},function(e){say(e.message,'err')})}
$('go').onclick=function(){try{sessionStorage.setItem('swdesk',$('tok').value.trim())}catch(e){}$('tok').value='';load()};
$('tok').onkeydown=function(e){if(e.key==='Enter')$('go').click()};$('refresh').onclick=load;$('out').onclick=function(){lock()};
if(T())load();
})();
</script></main></body></html>`;
}
module.exports = { deskHtml };
