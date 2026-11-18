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

  document.querySelectorAll("[data-telegram]").forEach((button) => {
    button.addEventListener("click", async () => {
      let data;
      try { data = JSON.parse(button.dataset.telegram); } catch { return; }
      const describe = (item) => [
        item.role.toUpperCase() + ": " + item.name,
        "Route: " + item.origin + " → " + item.destination + (item.via ? " via " + item.via : ""),
        "Travel: " + item.trip_date + " at " + item.trip_time,
        "Reference: " + item.reference
      ].join("\n");
      const message = "POSSIBLE DRIVER / CUSTOMER MATCH (" + data.reason + ")\n\n" +
        describe(data.a) + "\n\n" + describe(data.b) +
        "\n\nAdmin: review and contact parties manually. Contact numbers are not included.";
      try {
        await navigator.clipboard.writeText(message);
        const old = button.textContent;
        button.textContent = "Telegram message copied!";
        setTimeout(() => button.textContent = old, 1600);
      } catch {
        window.prompt("Copy Telegram-ready message:", message);
      }
    });
  });
})();