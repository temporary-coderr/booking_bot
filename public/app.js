(() => {
 const form=document.getElementById("booking-form"); if(!form)return;
 const today=new Date(); const local=new Date(today.getTime()-today.getTimezoneOffset()*60000).toISOString().slice(0,10);
 const date=document.getElementById("trip-date"); date.min=local; date.value=local;
 const status=document.getElementById("form-status"),button=document.getElementById("submit-button"),success=document.getElementById("success-panel");
 form.addEventListener("submit",async e=>{
  e.preventDefault();status.textContent="";status.classList.remove("error-text");button.disabled=true;button.textContent="Saving booking…";
  const data=Object.fromEntries(new FormData(form));data.role=form.querySelector('input[name="role"]:checked').value;
  try{
   const res=await fetch("/api/bookings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
   const out=await res.json();if(!res.ok||!out.ok)throw new Error(out.error||"Could not save booking.");
   document.getElementById("success-message").textContent=out.message+" Your reference is "+out.reference+".";
   const links=document.getElementById("whatsapp-links");links.replaceChildren();
   (out.whatsapp_links||[]).forEach(item=>{const a=document.createElement("a");a.className="wa-button";a.href=item.url;a.target="_blank";a.rel="noopener noreferrer";a.textContent="WhatsApp · "+item.label;links.appendChild(a)});
   if(!(out.whatsapp_links||[]).length){const p=document.createElement("p");p.className="muted";p.textContent="Your booking is saved. The admin will review it.";links.appendChild(p)}
   success.hidden=false;success.scrollIntoView({behavior:"smooth",block:"center"});form.reset();date.value=local;
  }catch(err){status.textContent=err.message;status.classList.add("error-text")}
  finally{button.disabled=false;button.innerHTML='Save my booking <span>→</span>'}
 });
})();