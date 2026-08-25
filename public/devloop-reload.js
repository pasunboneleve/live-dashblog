const listenForReload = async () => {
  for (;;) {
    try {
      const response = await fetch("/__devloop/reload");
      if (!response.ok || !response.body) throw new Error("reload stream unavailable");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const events = pending.split("\n\n");
        pending = events.pop() ?? "";
        if (events.some((event) => /^(?:event|data): reload$/m.test(event))) {
          window.location.reload();
          return;
        }
      }
    } catch {
      // The local reload server can disappear briefly while devloop restarts.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
};

void listenForReload();
