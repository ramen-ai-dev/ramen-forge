/**
 * Embedded single-page monitoring console served at GET /.
 *
 * All community-contributed text is rendered with textContent (never
 * innerHTML), and the page ships under a nonce-based CSP.
 */
export function renderConsole(nonce: string): string {
  return `<!doctype html>
<html lang="en" class="h-full">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RAMEN FORGE · Domain Memory Engine</title>
<script nonce="${nonce}" src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-full bg-zinc-950 text-zinc-100 font-sans antialiased">
<a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 bg-amber-400 text-zinc-950 px-3 py-2 rounded">Skip to content</a>
<header class="border-b border-zinc-800">
  <div class="max-w-6xl mx-auto px-6 py-6">
    <h1 class="text-2xl font-semibold tracking-tight">
      <span class="text-amber-400">RAMEN FORGE:</span> Autonomous Agent Domain Memory Engine
    </h1>
    <p class="mt-1 text-sm text-zinc-400">Level 1 Community Memory Commons. Normalised correction exemplars served to agents before tool dispatch.</p>
  </div>
</header>

<main id="main" class="max-w-6xl mx-auto px-6 py-8 space-y-10">
  <section aria-labelledby="stats-heading">
    <h2 id="stats-heading" class="sr-only">Live statistics</h2>
    <div class="grid gap-4 sm:grid-cols-3" aria-live="polite">
      <div class="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <p class="text-xs uppercase tracking-wider text-zinc-400">Total Community Exemplars</p>
        <p id="stat-total" class="mt-2 text-3xl font-semibold">–</p>
      </div>
      <div class="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <p class="text-xs uppercase tracking-wider text-zinc-400">Active Domains</p>
        <p id="stat-domains" class="mt-2 text-3xl font-semibold">–</p>
        <p id="stat-domain-list" class="mt-1 text-xs text-zinc-400"></p>
      </div>
      <div class="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <p class="text-xs uppercase tracking-wider text-zinc-400">Recovery Rate (receipt-verified)</p>
        <p id="stat-recovery" class="mt-2 text-3xl font-semibold">–</p>
        <p class="mt-1 text-xs text-zinc-400">Share of exemplars anchored to a ramen-ai receipt.</p>
      </div>
    </div>
    <p id="status" class="mt-3 text-xs text-zinc-500" role="status"></p>
  </section>

  <section aria-labelledby="stream-heading">
    <div class="flex items-baseline justify-between">
      <h2 id="stream-heading" class="text-lg font-semibold">Live Stream</h2>
      <p class="text-xs text-zinc-500">Refreshes every 15 seconds</p>
    </div>
    <div class="mt-3 overflow-x-auto rounded-lg border border-zinc-800">
      <table class="min-w-full text-sm">
        <caption class="sr-only">Recently contributed structural lessons, newest first</caption>
        <thead class="bg-zinc-900 text-left text-xs uppercase tracking-wider text-zinc-400">
          <tr>
            <th scope="col" class="px-4 py-3">Domain</th>
            <th scope="col" class="px-4 py-3">Tool</th>
            <th scope="col" class="px-4 py-3">Statutory Rule</th>
            <th scope="col" class="px-4 py-3">Steering Directive</th>
          </tr>
        </thead>
        <tbody id="stream" class="divide-y divide-zinc-800">
          <tr><td colspan="4" class="px-4 py-6 text-center text-zinc-500">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section aria-labelledby="quickstart-heading">
    <h2 id="quickstart-heading" class="text-lg font-semibold">Integration Quickstart</h2>
    <p class="mt-1 text-sm text-zinc-400">Pull prior repairs into a ramen-foundry agent before its first tool call. Records rehydrate directly into <code class="text-amber-300">CorrectionExemplar</code>.</p>
    <div class="mt-3 relative rounded-lg border border-zinc-800 bg-zinc-900">
      <button id="copy" type="button" class="absolute top-2 right-2 rounded bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400" aria-describedby="copy-status">Copy</button>
      <pre class="overflow-x-auto p-4 pr-20 text-xs leading-relaxed"><code id="quickstart"></code></pre>
    </div>
    <p id="copy-status" class="mt-2 text-xs text-zinc-500" role="status"></p>
  </section>
</main>

<script nonce="${nonce}">
(() => {
  const origin = window.location.origin;
  const quickstart =
    'import httpx; from ramen_foundry import CorrectionExemplar\\n' +
    'lessons = [CorrectionExemplar.from_dict(e) for e in httpx.get("' + origin + '/api/v1/exemplars", params={"tool_name": tool_name, "task_fingerprint": fingerprint}).json()["exemplars"]]';
  document.getElementById("quickstart").textContent = quickstart;

  document.getElementById("copy").addEventListener("click", async () => {
    const status = document.getElementById("copy-status");
    try {
      await navigator.clipboard.writeText(quickstart);
      status.textContent = "Copied to clipboard.";
    } catch {
      status.textContent = "Copy failed. Select the snippet manually.";
    }
  });

  const cell = (text, extra) => {
    const td = document.createElement("td");
    td.className = "px-4 py-3 align-top " + (extra || "");
    td.textContent = text;
    return td;
  };

  async function refresh() {
    const status = document.getElementById("status");
    try {
      const [statsRes, streamRes] = await Promise.all([
        fetch("/api/v1/stats", { headers: { accept: "application/json" } }),
        fetch("/api/v1/exemplars?limit=25", { headers: { accept: "application/json" } }),
      ]);
      if (!statsRes.ok || !streamRes.ok) throw new Error("HTTP " + statsRes.status + "/" + streamRes.status);
      const stats = await statsRes.json();
      const stream = await streamRes.json();

      document.getElementById("stat-total").textContent = String(stats.total_community_exemplars);
      document.getElementById("stat-domains").textContent = String(stats.active_domains);
      document.getElementById("stat-domain-list").textContent =
        stats.domains.map((d) => d.domain + " (" + d.exemplars + ")").join(" · ");
      document.getElementById("stat-recovery").textContent =
        (stats.recovery_rate * 100).toFixed(1) + "%";

      const body = document.getElementById("stream");
      body.replaceChildren();
      if (stream.exemplars.length === 0) {
        const tr = document.createElement("tr");
        const td = cell("No exemplars yet. POST /api/v1/seed to load the seed bank.", "text-center text-zinc-500");
        td.colSpan = 4;
        tr.append(td);
        body.append(tr);
      }
      for (const e of stream.exemplars) {
        const tr = document.createElement("tr");
        tr.append(
          cell(e.domain, "whitespace-nowrap text-amber-300"),
          cell(e.tool_name, "whitespace-nowrap font-mono text-xs"),
          cell(e.primary_statutory_anchor, "text-zinc-300"),
          cell(e.steering_directive, "text-zinc-400"),
        );
        body.append(tr);
      }
      status.textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (err) {
      status.textContent = "Refresh failed: " + err.message;
    }
  }

  refresh();
  setInterval(refresh, 15000);
})();
</script>
</body>
</html>`;
}
