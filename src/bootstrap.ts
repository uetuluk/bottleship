async function start(): Promise<void> {
  if (import.meta.env.VITE_GITHUB_PAGES === "true" && !crossOriginIsolated) {
    if (!("serviceWorker" in navigator)) {
      throw new Error("This browser cannot enable shared memory. Open BottleShip in Chrome or Edge.");
    }
    const reloadKey = "bottleship-isolation-reload";
    if (sessionStorage.getItem(reloadKey)) {
      sessionStorage.removeItem(reloadKey);
      throw new Error("Shared memory could not be enabled. Allow service workers, then reload the page.");
    }
    document.getElementById("root")!.textContent = "Preparing BottleShip…";
    const controlled = new Promise<void>((resolve) => {
      if (navigator.serviceWorker.controller) resolve();
      else navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}isolation-sw.js`, {
      scope: import.meta.env.BASE_URL,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        controlled,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Shared memory setup timed out. Reload to retry.")), 15000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    sessionStorage.setItem(reloadKey, "1");
    location.reload();
    return;
  }
  sessionStorage.removeItem("bottleship-isolation-reload");
  await import("./main");
}

void start().catch((error: unknown) => {
  document.getElementById("root")!.textContent = error instanceof Error ? error.message : String(error);
});
