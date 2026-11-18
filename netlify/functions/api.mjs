import crypto from "node:crypto";
const enc=v=>Buffer.from(JSON.stringify(v)).toString("base64url"),dec=v=>JSON.parse(Buffer.from(v,"base64url").toString("utf8"));
const secret=()=>process.env.SESSION_SECRET||"",cookieName="booking_admin",now=()=>Math.floor(Date.now()/1000);
const safeEqual=(a,b)=>{const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const sign=v=>crypto.createHmac("sha256",secret()).update(v).digest("base64url");
function makeSession(csrf){const p=enc({admin:true,exp:now()+28800,csrf});return p+"."+sign(p)}
function readSession(e){const raw=(e.headers.cookie||e.headers.Cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(cookieName+"="))?.slice(cookieName.length+1);if(!raw||!secret())return null;const [p,s]=raw.split(".");if(!p||!s||!safeEqual(s,sign(p)))return null;try{const d=dec(p);return d.admin&&d.exp>now()?d:null}catch{return null}}
const json=(statusCode,body,headers={})=>({statusCode,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers},body:JSON.stringify(body)});
const cookie=(v,maxAge=28800)=>cookieName+"="+v+"; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age="+maxAge;
async function sheet(action,data={}){const url=process.env.GOOGLE_SHEET_URL,key=process.env.SHEETS_API_SECRET;if(!url||!key)throw Error("Google Sheets connection is not configured.");const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({secret:key,action,data})});if(!r.ok)throw Error("Google Sheets request failed ("+r.status+").");const j=await r.json();if(!j.ok)throw Error(j.error||"Google Sheets operation failed.");return j.data}
const clean=(v,n=100)=>String(v??"").replace(/[<>]/g,"").trim().replace(/\s+/g," ").slice(0,n);
const phoneDigits=v=>String(v??"").replace(/[^\d]/g,"").slice(0,15);
function routePoints(b){return[b.origin,...(Array.isArray(b.via)?b.via:String(b.via||"").split(",")),b.destination].map(x=>clean(x,100).toLowerCase()).filter(Boolean)}
function matchReason(a,b){const pa=routePoints(a),pb=routePoints(b),sa=new Set(pa.slice(0,-1).map((x,i)=>x+"→"+pa[i+1]));if(pb.slice(0,-1).some((x,i)=>sa.has(x+"→"+pb[i+1])))return"overlapping route";if(pa[0]===pb[0]&&pa.at(-1)===pb.at(-1))return"same route";if(pa.slice(1,-1).some(x=>pb.includes(x))||pb.slice(1,-1).some(x=>pa.includes(x)))return"via/connecting route";return""}
function findMatches(bs){const out=[],active=bs.filter(x=>String(x.active)!=="false"&&String(x.active)!=="0"&&x.status!=="expired");for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++){const a=active[i],b=active[j];if(a.role===b.role||a.trip_date!==b.trip_date)continue;const mins=Math.abs(new Date(a.trip_date+"T"+a.trip_time)-new Date(b.trip_date+"T"+b.trip_time))/60000;if(mins>180)continue;const reason=matchReason(a,b);if(reason)out.push({a,b,reason})}return out}
async function sendTelegram(text){const t=process.env.TELEGRAM_BOT_TOKEN,c=process.env.TELEGRAM_CHAT_ID;if(!t||!c)return false;const r=await fetch("https://api.telegram.org/bot"+t+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:c,text,disable_web_page_preview:true})});return r.ok}
const summary=b=>String(b.role).toUpperCase()+": "+b.name+"\nMobile: "+b.phone+"\nRoute: "+b.origin+" → "+b.destination+(b.via?" via "+b.via:"")+"\nTravel: "+b.trip_date+" at "+b.trip_time+(b.vehicle_type?"\nVehicle: "+b.vehicle_type:"")+(b.capacity_kg?" · Capacity: "+b.capacity_kg+" kg":"")+(b.passenger_count?" · Passengers: "+b.passenger_count:"")+"\nReference: "+b.reference;
export default async e=>{
 const method=e.httpMethod,body=(()=>{try{return JSON.parse(e.body||"{}")}catch{return{}}})(),path=e.path||"";
 try{
  if(method==="POST"&&path.endsWith("/bookings")){
   const role=clean(body.role,12).toLowerCase(),booking={role,name:clean(body.name,80),phone:phoneDigits(body.phone),origin:clean(body.origin,80),destination:clean(body.destination,80),via:(Array.isArray(body.via)?body.via: String(body.via||"").split(",")).map(x=>clean(x,80)).filter(Boolean).slice(0,5).join(", "),trip_date:clean(body.trip_date,10),trip_time:clean(body.trip_time,5),vehicle_type:role==="driver"?clean(body.vehicle_type,20).toUpperCase():"",capacity_kg:role==="driver"&&["TRUCK","PICKUP"].includes(String(body.vehicle_type).toUpperCase())?String(Math.max(0,Number(body.capacity_kg)||0)):"",passenger_count:role==="driver"&&String(body.vehicle_type).toUpperCase()==="CAR"?String(Math.max(1,Math.min(20,Number(body.passenger_count)||1))):""};
   if(!["driver","customer"].includes(role)||!booking.name||booking.phone.length<10||!booking.origin||!booking.destination||booking.origin.toLowerCase()===booking.destination.toLowerCase()||(role==="driver"&&(!["TRUCK","PICKUP","CAR","OTHER"].includes(booking.vehicle_type)||(["TRUCK","PICKUP"].includes(booking.vehicle_type)&&!Number(booking.capacity_kg))||(booking.vehicle_type==="CAR"&&!Number(booking.passenger_count)))))return json(400,{ok:false,error:"Please complete all required details and check your mobile number."});
   if(!/^\d{4}-\d{2}-\d{2}$/.test(booking.trip_date)||!/^\d{2}:\d{2}$/.test(booking.trip_time))return json(400,{ok:false,error:"Enter a valid travel date and time."});
   const trip=new Date(booking.trip_date+"T"+booking.trip_time+":00");if(!Number.isFinite(trip.getTime())||trip.getTime()<=Date.now()||trip.getTime()>Date.now()+365*86400000)return json(400,{ok:false,error:"Past date or time is not allowed. Choose a future travel time."});
   const editToken=crypto.randomBytes(32).toString("hex"),tokenHash=crypto.createHash("sha256").update(editToken).digest("hex");
   const saved=await sheet("create_booking",{...booking,edit_token_hash:tokenHash});
   const cfg=await sheet("public_config"),message="Yahan booking hai\nBooking type: "+role.toUpperCase()+"\nName: "+booking.name+"\nMobile: "+booking.phone+"\nRoute: "+booking.origin+" → "+booking.destination+(booking.via?" via "+booking.via:"")+"\nDate & time: "+booking.trip_date+" | "+booking.trip_time+(booking.vehicle_type?"\nVehicle: "+booking.vehicle_type:"")+(booking.capacity_kg?"\nCapacity: "+booking.capacity_kg+" kg":"")+(booking.passenger_count?"\nPassengers: "+booking.passenger_count:"")+"\nBooking ID: "+saved.reference;
   const links=(cfg.receivers||[]).map(x=>({id:x.id,label:x.label,url:"https://wa.me/"+phoneDigits(x.phone)+"?text="+encodeURIComponent(message)}));
   await sheet("record_activity",{reference:saved.reference,event:"booking_created"});
   return json(201,{ok:true,reference:saved.reference,edit_token:editToken,whatsapp_links:links,message:"Booking saved. Share it with the admin on WhatsApp."});
  }
  if(method==="POST"&&path.endsWith("/booking-edit")){
   const editToken=clean(body.edit_token,100),hash=crypto.createHash("sha256").update(editToken).digest("hex"),phone=phoneDigits(body.phone);
   const editVehicle=clean(body.vehicle_type,20).toUpperCase();const b={name:clean(body.name,80),phone,origin:clean(body.origin,80),destination:clean(body.destination,80),via:clean(body.via,160),trip_date:clean(body.trip_date,10),trip_time:clean(body.trip_time,5),vehicle_type:editVehicle,capacity_kg:["TRUCK","PICKUP"].includes(editVehicle)?String(Math.max(0,Number(body.capacity_kg)||0)):"",passenger_count:editVehicle==="CAR"?String(Math.max(0,Number(body.passenger_count)||0)):""};
   const trip=new Date(b.trip_date+"T"+b.trip_time+":00");if(!editToken||phone.length<10||!b.name||!b.origin||!b.destination||!Number.isFinite(trip.getTime())||trip.getTime()<=Date.now())return json(400,{ok:false,error:"Check your details and choose a future travel date/time."});
   const updated=await sheet("owner_edit_booking",{reference:clean(body.reference,20),phone,edit_token_hash:hash,changes:b});
   await sheet("record_activity",{reference:body.reference,event:"booking_edited"});return json(200,{ok:true,booking:updated});
  }
  if(method==="POST"&&path.endsWith("/whatsapp-click")){await sheet("record_activity",{reference:clean(body.reference,20),event:"whatsapp_link_opened"});return json(200,{ok:true})}
  if(method==="POST"&&path.endsWith("/login")){
   if(!secret()||!process.env.ADMIN_PASSWORD||!process.env.ADMIN_URL_TOKEN)return json(503,{ok:false,error:"Admin security is not configured."});
   if(!safeEqual(body.token,process.env.ADMIN_URL_TOKEN))return json(404,{ok:false,error:"Not found."});
   if(!safeEqual(body.password,process.env.ADMIN_PASSWORD))return json(401,{ok:false,error:"Incorrect password."});
   const csrf=crypto.randomBytes(32).toString("base64url");return json(200,{ok:true,csrf},{"set-cookie":cookie(makeSession(csrf))});
  }
  if(method==="POST"&&path.endsWith("/logout"))return json(200,{ok:true},{"set-cookie":cookie("",0)});
  if(method==="POST"&&path.endsWith("/match-check")){
   if(!process.env.CRON_SECRET||!safeEqual(e.headers["x-cron-secret"],process.env.CRON_SECRET))return json(404,{ok:false});
   const expired=await sheet("expire_bookings"),bookings=await sheet("list_bookings"),matches=findMatches(bookings||[]);let notified=0;
   for(const m of matches){const pair=[m.a.reference,m.b.reference].sort().join(":");const known=await sheet("notification_exists",{pair});if(known.exists)continue;const ok=await sendTelegram("POSSIBLE DRIVER / CUSTOMER MATCH\n\n"+summary(m.a)+"\n\n"+summary(m.b)+"\n\nMatch: "+m.reason+"\nAdmin: review manually. No customer phone numbers included.");if(ok){await sheet("record_notification",{pair});notified++}}
   return json(200,{ok:true,expired:expired.count||0,matched_pairs_notified:notified});
  }
  const session=readSession(e);if(!session)return json(401,{ok:false,error:"Please sign in again."});
  if(method!=="GET"&&!safeEqual(e.headers["x-csrf-token"],session.csrf))return json(403,{ok:false,error:"Security token expired. Refresh the dashboard."});
  if(method==="GET"&&path.endsWith("/admin-data")){await sheet("expire_bookings");const [bookings,receivers,notified,activity,settings]=await Promise.all([sheet("list_bookings"),sheet("list_receivers"),sheet("count_notifications"),sheet("list_activity"),sheet("get_settings")]);return json(200,{ok:true,csrf:session.csrf,bookings,receivers,notified:notified.count,activity,matches:findMatches(bookings||[]),expiry_hours:settings.expiry_hours||12})}
  if(method==="POST"&&path.endsWith("/booking-update"))return json(200,{ok:true,booking:await sheet("update_booking",body)});
  if(method==="POST"&&path.endsWith("/booking-status"))return json(200,{ok:true,booking:await sheet("set_booking_status",body)});
  if(method==="POST"&&path.endsWith("/booking-delete")){await sheet("delete_booking",body);return json(200,{ok:true})}
  if(method==="POST"&&path.endsWith("/expiry-setting")){const h=Number(body.hours);if(![6,12,24].includes(h))return json(400,{ok:false,error:"Choose 6, 12 or 24 hours."});await sheet("set_settings",{expiry_hours:h});return json(200,{ok:true,expiry_hours:h})}
  if(method==="POST"&&path.endsWith("/receiver-add")){const label=clean(body.label,50),phone=phoneDigits(body.phone);if(!label||phone.length<10||phone.length>15)return json(400,{ok:false,error:"Enter a label and valid number including country code."});return json(200,{ok:true,receiver:await sheet("add_receiver",{label,phone})})}
  if(method==="POST"&&path.endsWith("/receiver-delete")){await sheet("delete_receiver",body);return json(200,{ok:true})}
  return json(404,{ok:false,error:"Not found."});
 }catch(err){console.error("Booking API error:",err);return json(500,{ok:false,error:err.message||"Server error."})}
};
