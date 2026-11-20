(() => {
 const login=document.getElementById("login-view"),dash=document.getElementById("dashboard-view"),mfaView=document.getElementById("mfa-setup-view"),recoveryView=document.getElementById("recovery-view");
 let csrf="",data={bookings:[],matches:[],receivers:[],help_contacts:[],driver_availability:[]};
 const api=async(path,body,method)=>{const r=await fetch("/api/"+path,{method:method|| (body?"POST":"GET"),headers:{"Content-Type":"application/json",...(csrf?{"X-CSRF-Token":csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||"Request failed");return j};
 const status=t=>document.getElementById("dashboard-status").textContent=t;
 function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
 let activityPage=0;
 async function loadActivity(){
  const period=document.getElementById("activity-period").value;
  const type=document.getElementById("activity-type").value;
  const query="activity-history?period="+encodeURIComponent(period)+"&type="+encodeURIComponent(type)+"&page="+activityPage;
  const result=await api(query,null,"GET");
  const list=document.getElementById("activity-list");
  list.innerHTML=(result.activity||[]).map(a=>'<div class="activity-row"><strong>'+esc(a.event.replaceAll("_"," "))+' · '+esc(a.reference||"No reference")+'</strong><small>'+esc(new Date(a.created_at).toLocaleString())+'</small></div>').join("")||'<p class="empty-state">No activity found for this period.</p>';
  document.getElementById("activity-summary").textContent=result.total+" record(s) · "+({ "1h":"Last hour","6h":"Last 6 hours","12h":"Last 12 hours","1d":"Last 1 day","7d":"Last 7 days" }[result.period])+" · "+({all:"All activity",whatsapp:"WhatsApp clicks",visitors:"Visitor / booking activity"}[result.type]);
  document.getElementById("activity-page-label").textContent="Page "+(activityPage+1)+" of "+Math.max(1,Math.ceil(result.total/50));
  document.getElementById("activity-prev").disabled=activityPage===0;
  document.getElementById("activity-next").disabled=!result.has_more;
 }
 async function refresh(){const j=await api("admin-data");data=j;render();document.getElementById("expiry-hours").value=String(j.expiry_hours||12);await loadActivity();status("Dashboard updated.")}
 function renderRoleGroups(role,targetId,searchId,countId){
  const query=document.getElementById(searchId).value.trim().toLowerCase();
  const groups=new Map();
  data.bookings.filter(b=>b.role===role).forEach(b=>{
   const digits=String(b.phone||"").replace(/\D/g,"");
   const key=digits||("no-phone:"+String(b.id));
   if(!groups.has(key))groups.set(key,[]);
   groups.get(key).push(b);
  });
  const visible=[];
  for(const [key,items] of groups){
   items.sort((a,b)=>(String(a.trip_date||"")+" "+String(a.trip_time||"")).localeCompare(String(b.trip_date||"")+" "+String(b.trip_time||"")));
   const matches=items.filter(b=>[b.name,b.phone,b.origin,b.destination,b.via,b.trip_date,b.trip_time,b.status,b.reference].join(" ").toLowerCase().includes(query));
   if(matches.length)visible.push({phone:items[0].phone||"Phone not provided",items:matches,total:items.length,key});
  }
  visible.sort((a,b)=>String(a.phone).localeCompare(String(b.phone),undefined,{numeric:true}));
  document.getElementById(countId).textContent=visible.length+" people";
  document.getElementById(targetId).innerHTML=visible.map(group=>{
   const entries=group.items.map((b,i)=>'<article class="group-booking"><div class="group-booking-top"><b>Booking '+(i+1)+'</b><span class="status-chip">'+esc(b.status||"pending")+' · '+(String(b.active)==="false"||String(b.active)==="0"?"inactive":"active")+'</span></div><strong>'+esc(b.name||"Name not provided")+'</strong><span class="group-route">'+esc(b.origin||"—")+' → '+esc(b.destination||"—")+(b.via?' · via '+esc(b.via):"")+'</span><small>'+esc(b.trip_date||"Date not set")+' · '+esc(b.trip_time||"Time not set")+' · Ref '+esc(b.reference||"—")+'</small><small>'+esc(b.vehicle_type||"")+(b.capacity_kg?" · "+esc(b.capacity_kg)+" kg":"")+(b.passenger_count?" · "+esc(b.passenger_count)+" passengers":"")+'</small></article>').join("");
   return '<article class="phone-group"><div class="phone-group-heading"><div><strong>☎ '+esc(group.phone)+'</strong><small>'+group.items.length+' shown / '+group.total+' booking(s)</small></div></div><div class="phone-group-bookings">'+entries+'</div></article>';
  }).join("")||'<p class="empty-state">No '+(role==="driver"?"driver":"customer")+' bookings match this search.</p>';
 }
 function render(){
  document.getElementById("total-count").textContent=data.bookings.length;
  document.getElementById("match-count").textContent=data.matches.length;
  document.getElementById("notified-count").textContent=data.notified||0;
  document.getElementById("active-count").textContent=data.bookings.filter(b=>Number(b.active)===1||b.active===true||String(b.active)==="true").length;
  const q=document.getElementById("search").value.toLowerCase(),role=document.getElementById("role-filter").value,st=document.getElementById("status-filter").value;
  const filtered=data.bookings.filter(b=>(!role||b.role===role)&&(!st||b.status===st)&&[b.name,b.phone,b.origin,b.destination,b.via,b.trip_date,b.reference].join(" ").toLowerCase().includes(q));
  document.getElementById("booking-list").innerHTML=filtered.map(b=>`<article class="booking-row"><div class="booking-main"><span class="type-chip ${esc(b.role)}">${esc(b.role)}</span><b>${esc(b.name)}</b><span>${esc(b.origin)} → ${esc(b.destination)} ${b.via?"via "+esc(b.via):""}</span><span>Vehicle: ${esc(b.vehicle_type||"—")} · ${esc(b.capacity_kg||"—")} kg ${b.passenger_count?"· "+esc(b.passenger_count)+" passengers":""}</span><small>${esc(b.trip_date)} · ${esc(b.trip_time)} · Ref ${esc(b.reference)}</small><strong class="private-phone">☎ <a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></strong><span class="status-chip">${esc(b.status||"pending")} · ${String(b.active)==="false"||String(b.active)==="0"?"inactive":"active"}</span><div class="inline-actions"><a class="outline-button small" href="https://wa.me/${esc(b.phone)}?text=${encodeURIComponent("Hello "+b.name+", regarding your booking "+b.reference+".")}" target="_blank" rel="noopener">Contact on WhatsApp</a><button class="outline-button small" data-edit="${esc(b.id)}">Edit</button><button class="outline-button small" data-status="${esc(b.id)}" data-active="${String(b.active)}">${String(b.active)==="false"||String(b.active)==="0"?"Reactivate":"Deactivate"}</button><select data-setstatus="${esc(b.id)}"><option value="">Change status…</option><option>pending</option><option>approved</option><option>rejected</option><option>completed</option></select><button class="danger-button small" data-delete="${esc(b.id)}" data-reference="${esc(b.reference)}">Delete</button></div></div></article>`).join("")||'<p class="empty-state">No matching bookings.</p>';
  renderRoleGroups("driver","driver-group-list","driver-group-search","driver-group-count");
  renderRoleGroups("customer","customer-group-list","customer-group-search","customer-group-count");
  document.getElementById("driver-availability-list").innerHTML=(data.driver_availability||[]).map(a=>'<article class="booking-row"><b>'+esc(a.name)+' · '+esc(a.phone)+'</b><span>'+esc(a.origin)+' → '+esc(a.destination)+' · '+esc(a.trip_date)+' '+esc(a.trip_time)+'</span><small>Other available locations: '+esc(a.available_locations||"Not specified")+'</small></article>').join("")||'<p class="empty-state">No drivers have marked extra availability.</p>';
  document.getElementById("help-contact-list").innerHTML=(data.help_contacts||[]).map(c=>'<div class="receiver-row"><span><b>'+esc(c.label)+'</b><small>+'+esc(c.phone)+'</small></span><button class="danger-button" data-help-delete="'+esc(c.id)+'">Remove</button></div>').join("")||'<p class="empty-state">No help contacts configured.</p>';
  document.getElementById("match-list").innerHTML=data.matches.map(m=>`<article class="match-card"><div class="match-tag">${esc(m.reason)}</div><div class="match-grid"><div><b>${esc(m.a.role)} · ${esc(m.a.name)}</b><span>${esc(m.a.origin)} → ${esc(m.a.destination)}</span><small>${esc(m.a.trip_date)} · ${esc(m.a.trip_time)} · ${esc(m.a.reference)}</small><strong class="private-phone">${esc(m.a.phone)}</strong></div><div><b>${esc(m.b.role)} · ${esc(m.b.name)}</b><span>${esc(m.b.origin)} → ${esc(m.b.destination)}</span><small>${esc(m.b.trip_date)} · ${esc(m.b.trip_time)} · ${esc(m.b.reference)}</small><strong class="private-phone">${esc(m.b.phone)}</strong></div></div><div class="inline-actions"><a class="outline-button small" target="_blank" rel="noopener" href="https://wa.me/${esc(m.a.phone)}?text=${encodeURIComponent("Hello "+m.a.name+", we may have a suitable ride for your route "+m.a.origin+" to "+m.a.destination+". Please confirm if still needed.")}">Contact first</a><a class="outline-button small" target="_blank" rel="noopener" href="https://wa.me/${esc(m.b.phone)}?text=${encodeURIComponent("Hello "+m.b.name+", we may have a suitable ride for your route "+m.b.origin+" to "+m.b.destination+". Please confirm if still needed.")}">Contact second</a><button class="copy-button" data-copy-match="${esc(m.a.reference)}|${esc(m.b.reference)}">Copy match summary</button></div></article>`).join("")||'<p class="empty-state">No possible matches found yet.</p>';
  document.getElementById("receiver-list").innerHTML=data.receivers.map(r=>`<div class="receiver-row"><span><b>${esc(r.label)}</b><small>+${esc(r.phone)}</small></span><button class="danger-button" data-receiver-delete="${esc(r.id)}">Remove</button></div>`).join("")||'<p class="empty-state">No WhatsApp receivers configured.</p>';
 }
 const telegramStatus=t=>{document.getElementById("telegram-status").textContent=t};
 document.getElementById("telegram-test").addEventListener("click",async e=>{
  const b=e.currentTarget;b.disabled=true;telegramStatus("Sending test message…");
  try{const r=await api("telegram-test",{});telegramStatus(r.message||"Telegram test sent.");}
  catch(x){telegramStatus(x.message);}
  finally{b.disabled=false}
 });
 document.getElementById("run-match-check").addEventListener("click",async e=>{
  const b=e.currentTarget;if(!confirm("Run a manual match check and send Telegram alerts for any new matches?"))return;
  b.disabled=true;telegramStatus("Checking active bookings…");
  try{const r=await api("admin-match-check",{});await refresh();telegramStatus("Check complete. Possible matches: "+r.total_possible_matches+". New alerts sent: "+r.matched_pairs_notified+". Already notified: "+r.already_notified+". Failed: "+r.failed+". Expired: "+r.expired+".");}
  catch(x){telegramStatus(x.message);}
  finally{b.disabled=false}
 });
 async function showDashboard(){login.hidden=true;mfaView.hidden=true;recoveryView.hidden=true;dash.hidden=false;await refresh();if(data.admin&&(data.admin.role==="owner"||data.admin.role==="admin")){document.getElementById("owner-security-panel").hidden=false;document.getElementById("owner-account-controls").hidden=data.admin.role!=="owner";document.getElementById("security-audit-section").hidden=data.admin.role!=="owner";document.getElementById("admin-emergency-lock").hidden=data.admin.role!=="admin";await loadSecurity();}}
 document.getElementById("owner-recovery-form").addEventListener("submit",async e=>{e.preventDefault();if(!confirm("This resets the Owner password and MFA and logs out all administrators. Continue?"))return;const f=new FormData(e.currentTarget);const err=document.getElementById("owner-recovery-error");err.textContent="";try{await api("owner-recovery",{username:f.get("username"),recovery_secret:f.get("recovery_secret"),new_password:f.get("new_password")});err.textContent="Owner password reset. Sign in with the new password and enrol MFA again.";e.currentTarget.reset();}catch(x){err.textContent=x.message;}});
 document.getElementById("login-form").addEventListener("submit",async e=>{e.preventDefault();const err=document.getElementById("login-error");err.textContent="";try{const j=await api("login",{username:document.getElementById("admin-username").value,password:document.getElementById("admin-password").value,code:document.getElementById("admin-code").value,recovery_code:document.getElementById("admin-recovery-code").value});csrf=j.csrf||"";if(j.mfaRequired){login.hidden=true;mfaView.hidden=false;const setup=await api("mfa-setup",{});document.getElementById("mfa-secret").value=setup.secret;if(window.QRCode&&QRCode.toCanvas){QRCode.toCanvas(document.getElementById("mfa-qr"),setup.otpauth_uri,{width:220},()=>{});}else{document.getElementById("mfa-qr").hidden=true;document.getElementById("mfa-error").textContent="QR library unavailable. Use the manual setup key above.";}return;}await showDashboard();}catch(x){err.textContent=x.message}});
 document.getElementById("mfa-confirm-form").addEventListener("submit",async e=>{e.preventDefault();const err=document.getElementById("mfa-error");err.textContent="";try{const j=await api("mfa-confirm",{code:document.getElementById("mfa-confirm-code").value});document.getElementById("recovery-codes").textContent=j.recovery_codes.join("\\n");mfaView.hidden=true;recoveryView.hidden=false;csrf=j.csrf||csrf;}catch(x){err.textContent=x.message}});
 document.getElementById("recovery-continue").addEventListener("click",()=>showDashboard().catch(x=>status(x.message)));
 document.getElementById("logout").addEventListener("click",async()=>{try{await api("logout",{})}finally{csrf="";dash.hidden=true;login.hidden=false}});
 document.getElementById("refresh").addEventListener("click",()=>refresh().catch(e=>status(e.message)));
 document.getElementById("activity-period").addEventListener("change",()=>{activityPage=0;loadActivity().catch(e=>document.getElementById("activity-summary").textContent=e.message)});
 document.getElementById("activity-type").addEventListener("change",()=>{activityPage=0;loadActivity().catch(e=>document.getElementById("activity-summary").textContent=e.message)});
 document.getElementById("activity-prev").addEventListener("click",()=>{if(activityPage>0){activityPage--;loadActivity().catch(e=>document.getElementById("activity-summary").textContent=e.message)}});
 document.getElementById("activity-next").addEventListener("click",()=>{activityPage++;loadActivity().catch(e=>document.getElementById("activity-summary").textContent=e.message)});

 ["search","role-filter","status-filter","driver-group-search","customer-group-search"].forEach(id=>document.getElementById(id).addEventListener("input",render));
 document.getElementById("booking-list").addEventListener("click",async e=>{
  const edit=e.target.closest("[data-edit]"),toggle=e.target.closest("[data-status]"),del=e.target.closest("[data-delete]");
  try{
   if(edit){const b=data.bookings.find(x=>String(x.id)===edit.dataset.edit);const fields=["name","phone","origin","destination","via","trip_date","trip_time","vehicle_type","capacity_kg","passenger_count"];const changes={id:b.id};for(const f of fields){const v=prompt("Update "+f.replace("_"," ")+":",b[f]||"");if(v===null)return;changes[f]=v}await api("booking-update",changes);await refresh()}
   if(toggle){const active=toggle.dataset.active!=="false"&&toggle.dataset.active!=="0";await api("booking-status",{id:toggle.dataset.status,active:!active});await refresh()}
   if(del&&confirm("Permanently delete this booking?")){await api("booking-delete",{id:del.dataset.delete,reference:del.dataset.reference});await refresh()}
  }catch(x){status(x.message)}
 });
 document.getElementById("booking-list").addEventListener("change",async e=>{const s=e.target.closest("[data-setstatus]");if(s&&s.value){try{await api("booking-status",{id:s.dataset.setstatus,status:s.value});await refresh()}catch(x){status(x.message)}}});
 document.getElementById("match-list").addEventListener("click",async e=>{const b=e.target.closest("[data-copy-match]");if(!b)return;const [a,bref]=b.dataset.copyMatch.split("|");const m=data.matches.find(x=>x.a.reference===a&&x.b.reference===bref||x.b.reference===a&&x.a.reference===bref);if(m){const txt="POSSIBLE MATCH ("+m.reason+")\n"+[m.a,m.b].map(x=>x.role+": "+x.name+" | "+x.origin+" to "+x.destination+" | "+x.trip_date+" "+x.trip_time+" | "+x.reference).join("\n");await navigator.clipboard.writeText(txt);status("Match summary copied.")}});
 document.getElementById("expiry-hours").addEventListener("change",async e=>{try{await api("expiry-setting",{hours:Number(e.target.value)});status("Expiry setting saved.")}catch(x){status(x.message)}});
 document.getElementById("help-contact-form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api("help-contact-add",{phone:f.get("phone")});e.currentTarget.reset();await refresh()}catch(x){status(x.message)}});
 document.getElementById("help-contact-list").addEventListener("click",async e=>{const b=e.target.closest("[data-help-delete]");if(b&&confirm("Remove this help contact?")){try{await api("help-contact-delete",{id:b.dataset.helpDelete});await refresh()}catch(x){status(x.message)}}});
 document.getElementById("receiver-form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api("receiver-add",{label:f.get("label"),phone:f.get("phone")});e.currentTarget.reset();await refresh()}catch(x){status(x.message)}});
 document.getElementById("receiver-list").addEventListener("click",async e=>{const b=e.target.closest("[data-receiver-delete]");if(b&&confirm("Remove this WhatsApp receiver?")){try{await api("receiver-delete",{id:b.dataset.receiverDelete});await refresh()}catch(x){status(x.message)}}});
 async function loadSecurity(){
  const panel=document.getElementById("owner-security-panel");if(!panel||panel.hidden)return;
  try{const j=await api("security-overview",null,"GET");
   document.getElementById("admin-account-list").innerHTML=(j.admins||[]).map(a=>'<div class="receiver-row"><span><b>'+esc(a.display_name)+' ('+esc(a.username)+')</b><small>'+esc(a.role)+' · MFA '+(Number(a.mfa_enabled)===1?"enabled":"not enrolled")+' · '+(Number(a.disabled)===1?"disabled":"active")+'</small></span>'+(a.role==="owner"?"":'<div class="inline-actions"><button class="danger-button small" data-disable-admin="'+esc(a.id)+'" data-disabled="'+String(Number(a.disabled)===1)+'">'+(Number(a.disabled)===1?"Enable":"Disable")+'</button><button class="outline-button small" data-reset-mfa="'+esc(a.id)+'">Reset MFA</button></div>')+'</div>').join("")||'<p class="empty-state">No admin accounts.</p>';
   document.getElementById("admin-session-list").innerHTML=(j.sessions||[]).map(s=>'<div class="receiver-row"><span><b>'+esc(s.username)+' · '+esc(s.role)+'</b><small>Signed in: '+esc(new Date(s.created_at).toLocaleString())+' · Last active: '+esc(new Date(s.last_seen_at).toLocaleString())+'<br>'+esc(s.user_agent||"Unknown device")+'<br>IP: '+esc(s.ip_masked||"hidden")+'</small></span><button class="danger-button small" data-revoke-session="'+esc(s.id)+'">Log out</button></div>').join("")||'<p class="empty-state">No active admin sessions.</p>';
   if(data.admin&&data.admin.role==="owner"){const audit=await api("security-audit",null,"GET");document.getElementById("security-audit-list").innerHTML=(audit.events||[]).map(a=>'<div class="activity-row"><strong>'+esc(a.event.replaceAll("_"," "))+'</strong><small>'+esc(new Date(a.created_at).toLocaleString())+' · '+esc(a.target_id||"No target")+'</small></div>').join("")||'<p class="empty-state">No security events yet.</p>';}
   document.getElementById("security-status").textContent="Security overview updated.";
  }catch(x){document.getElementById("security-status").textContent=x.message;}
 }
 document.getElementById("security-refresh").addEventListener("click",loadSecurity);
 document.getElementById("admin-create-form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api("admin-create",{username:f.get("username"),display_name:f.get("display_name"),password:f.get("password"),role:f.get("role")});e.currentTarget.reset();await loadSecurity();document.getElementById("security-status").textContent="Admin account created. The new admin must enrol MFA on first sign-in.";}catch(x){document.getElementById("security-status").textContent=x.message;}});
 document.getElementById("admin-account-list").addEventListener("click",async e=>{const b=e.target.closest("[data-disable-admin],[data-reset-mfa]");if(!b)return;try{if(b.dataset.disableAdmin){const disable=b.dataset.disabled!=="true";if(!confirm((disable?"Disable":"Enable")+" this admin account?"))return;await api("admin-disable",{id:b.dataset.disableAdmin,disabled:disable});}else{if(!confirm("Reset MFA for this admin? They will need to enrol again."))return;await api("admin-mfa-reset",{id:b.dataset.resetMfa});}await loadSecurity();}catch(x){document.getElementById("security-status").textContent=x.message;}});
 document.getElementById("admin-session-list").addEventListener("click",async e=>{const b=e.target.closest("[data-revoke-session]");if(!b||!confirm("Immediately log out this admin session?"))return;try{await api("admin-revoke-session",{session_id:b.dataset.revokeSession});await loadSecurity();}catch(x){document.getElementById("security-status").textContent=x.message;}});
 document.getElementById("admin-emergency-lock").addEventListener("click",async()=>{if(!confirm("Emergency-lock the Owner account and revoke all Owner sessions? Only secure recovery can restore it."))return;const code=prompt("Enter your current 6-digit authenticator code:");if(!code)return;try{await api("admin-lock-owner",{code});document.getElementById("security-status").textContent="Owner account locked. A Telegram security alert was sent.";await loadSecurity();}catch(x){document.getElementById("security-status").textContent=x.message;}});
 document.getElementById("revoke-all-sessions").addEventListener("click",async()=>{if(!confirm("Log out EVERY admin account, including your own? Everyone must sign in again."))return;try{await api("admin-revoke-all",{});csrf="";dash.hidden=true;login.hidden=false;document.getElementById("security-status").textContent="All sessions revoked.";}catch(x){document.getElementById("security-status").textContent=x.message;}});
 document.getElementById("password-change-form").addEventListener("submit",async e=>{e.preventDefault();if(!confirm("Changing this password will log out ALL admin accounts. Continue?"))return;const f=new FormData(e.currentTarget);try{await api("password-change",{current_password:f.get("current_password"),new_password:f.get("new_password"),code:f.get("code")});csrf="";dash.hidden=true;login.hidden=false;document.getElementById("login-error").textContent="Password changed. All admins must sign in again.";}catch(x){document.getElementById("security-status").textContent=x.message;}});
 login.hidden=false;dash.hidden=true;
 api("admin-data",null,"GET").then(async j=>{csrf=j.csrf||"";data=j;await showDashboard();}).catch(()=>{login.hidden=false;dash.hidden=true;});
})();