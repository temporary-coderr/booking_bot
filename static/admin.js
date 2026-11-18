(() => {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      let data;
      try { data = JSON.parse(button.dataset.copy); } catch { return; }
      const text = [
        data.role + ": " + data.name,
        (data.phone ? "Mobile: " + data.phone : null),
        "Route: " + data.origin + " to " + data.destination + (data.via ? " via " + data.via : ""),
        "Date/time: " + data.trip_date + " " + data.trip_time,
        "Reference: " + data.reference
      ].join("\n");
      try {
        await navigator.clipboard.writeText(text);
        const old = button.textContent;
        button.textContent = "Copied!";
        setTimeout(() => button.textContent = old, 1400);
      } catch {
        window.prompt("Copy booking details:", text);
      }
    });
  });
})();