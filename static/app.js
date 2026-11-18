(() => {
  const form = document.getElementById("booking-form");
  if (!form) return;
  const status = document.getElementById("form-status");
  const button = document.getElementById("submit-button");
  const success = document.getElementById("success-panel");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "";
    button.disabled = true;
    button.textContent = "Saving booking…";
    const data = Object.fromEntries(new FormData(form).entries());
    data.role = form.querySelector('input[name="role"]:checked').value;
    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(data)
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not save booking.");
      document.getElementById("success-message").textContent = result.message + " Your reference is " + result.reference + ".";
      const links = document.getElementById("whatsapp-links");
      links.replaceChildren();
      if (result.whatsapp_links.length) {
        result.whatsapp_links.forEach((item) => {
          const a = document.createElement("a");
          a.className = "wa-button";
          a.href = item.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "WhatsApp · " + item.label;
          links.appendChild(a);
        });
      } else {
        const note = document.createElement("p");
        note.className = "muted";
        note.textContent = "No WhatsApp receiver is configured yet. Your booking is saved.";
        links.appendChild(note);
      }
      success.hidden = false;
      success.scrollIntoView({behavior: "smooth", block: "center"});
      form.reset();
    } catch (error) {
      status.textContent = error.message;
      status.classList.add("error-text");
    } finally {
      button.disabled = false;
      button.innerHTML = 'Save my booking <span>→</span>';
    }
  });
})();