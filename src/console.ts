/**
 * Embedded single-page MOM console served at GET /.
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
<title>RAMEN FORGE · The Moral Memory Engine</title>
<meta name="description" content="Every agent needs a MOM. Agents forget. MOM remembers.">
<link rel="icon" href="data:,">
<script nonce="${nonce}" src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-full bg-zinc-950 text-zinc-100 font-sans antialiased">
<a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 bg-amber-400 text-zinc-950 px-3 py-2 rounded">Skip to content</a>
<header class="border-b border-zinc-800">
  <div class="max-w-6xl mx-auto px-6 py-8">
    <h1 class="text-3xl font-semibold tracking-tight">
      <span class="text-amber-400">RAMEN FORGE:</span> The Moral Memory Engine
    </h1>
    <p class="mt-2 text-lg text-zinc-300">Every agent needs a MOM. <span class="text-zinc-400">Agents forget.</span> <span class="text-amber-300 font-medium">MOM remembers.</span></p>
  </div>
  <div class="bg-amber-400/10 border-t border-amber-400/20">
    <p class="max-w-6xl mx-auto px-6 py-3 text-sm text-amber-100">
      Every agent gets a fresh context; your organisation shouldn't. Persistent domain memory capturing real-world mistakes, steering corrections, and cryptographic receipts.
    </p>
  </div>
</header>

<main id="main" class="max-w-6xl mx-auto px-6 py-8 space-y-10">
  <section aria-labelledby="stats-heading">
    <h2 id="stats-heading" class="sr-only">Live statistics</h2>
    <div class="grid gap-4 sm:grid-cols-3" aria-live="polite">
      <div class="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <p class="text-xs uppercase tracking-wider text-zinc-400">Total Exemplars</p>
        <p id="stat-total" class="mt-2 text-3xl font-semibold">–</p>
      </div>
      <div class="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <p class="text-xs uppercase tracking-wider text-zinc-400">Active Domains</p>
        <p id="stat-domains" class="mt-2 text-3xl font-semibold">–</p>
        <p id="stat-domain-list" class="mt-1 text-xs text-zinc-400"></p>
      </div>
      <div class="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <p class="text-xs uppercase tracking-wider text-zinc-400">Statutory &amp; Regulatory Anchors</p>
        <p id="stat-anchors" class="mt-2 text-3xl font-semibold">–</p>
        <p class="mt-1 text-xs text-zinc-400">Active codified legal and physical rules preventing first-turn agent failures.</p>
      </div>
    </div>
  </section>

  <section aria-labelledby="stream-heading">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="stream-heading" class="text-lg font-semibold">Domain Memory Lessons</h2>
      <p id="status" class="text-xs text-zinc-500" role="status"></p>
    </div>

    <div class="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
      <label for="search" class="sr-only">Search domain memory</label>
      <input id="search" type="search" autocomplete="off" maxlength="100"
        placeholder="Search domain memory (e.g. wire, burner, adverse action)..."
        class="w-full sm:flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm placeholder-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400">
      <div id="chips" role="group" aria-label="Filter by domain" class="flex flex-wrap gap-2">
        <button type="button" data-domain="" aria-pressed="true">All</button>
        <button type="button" data-domain="fintech" aria-pressed="false">FinTech</button>
        <button type="button" data-domain="industrial_iot" aria-pressed="false">Industrial IoT</button>
        <button type="button" data-domain="devsecops" aria-pressed="false">DevSecOps</button>
      </div>
    </div>

    <div class="mt-3 overflow-x-auto rounded-lg border border-zinc-800">
      <table class="min-w-full text-sm">
        <caption class="sr-only">Domain memory lessons matching the current search and domain filter, newest first</caption>
        <thead class="bg-zinc-900 text-left text-xs uppercase tracking-wider text-zinc-400">
          <tr>
            <th scope="col" class="px-4 py-3">Domain</th>
            <th scope="col" class="px-4 py-3">Tool</th>
            <th scope="col" class="px-4 py-3">Statutory Rule</th>
            <th scope="col" class="px-4 py-3">Directive &amp; Lesson</th>
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
    <p class="mt-1 text-sm text-zinc-400">Give a ramen-foundry agent a MOM. Pass the store to <code class="text-amber-300">RamenSteerNode(memory_store=memory)</code> and prior repairs are recalled before the first tool call.</p>
    <div class="mt-3 relative rounded-lg border border-zinc-800 bg-zinc-900">
      <button id="copy" type="button" class="absolute top-2 right-2 rounded bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400" aria-describedby="copy-status">Copy</button>
      <pre class="overflow-x-auto p-4 pr-20 text-xs leading-relaxed"><code id="quickstart"></code></pre>
    </div>
    <p id="copy-status" class="mt-2 text-xs text-zinc-500" role="status"></p>
  </section>
</main>

<script nonce="${nonce}">
(() => {
  const $ = (id) => document.getElementById(id);
  const quickstart =
    'from ramen_foundry import RemoteForgeMemoryStore\\n' +
    'memory = RemoteForgeMemoryStore(base_url="' + window.location.origin + '", domain="fintech")';
  $("quickstart").textContent = quickstart;

  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(quickstart);
      $("copy-status").textContent = "Copied to clipboard.";
    } catch {
      $("copy-status").textContent = "Copy failed. Select the snippet manually.";
    }
  });

  const CHIP_BASE = "rounded-full border px-3 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ";
  const CHIP_ON = CHIP_BASE + "border-amber-400 bg-amber-400 text-zinc-950 font-medium";
  const CHIP_OFF = CHIP_BASE + "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500";
  const chips = Array.from(document.querySelectorAll("#chips button"));
  const state = { q: "", domain: "" };

  const paintChips = () => {
    for (const chip of chips) {
      const on = chip.dataset.domain === state.domain;
      chip.setAttribute("aria-pressed", String(on));
      chip.className = on ? CHIP_ON : CHIP_OFF;
    }
  };
  paintChips();

  const cell = (text, extra) => {
    const td = document.createElement("td");
    td.className = "px-4 py-3 align-top " + (extra || "");
    td.textContent = text;
    return td;
  };

  async function loadStats() {
    try {
      const res = await fetch("/api/v1/stats", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const stats = await res.json();
      $("stat-total").textContent = String(stats.total_community_exemplars);
      $("stat-domains").textContent = String(stats.active_domains);
      $("stat-domain-list").textContent = stats.domains.map((d) => d.domain + " (" + d.exemplars + ")").join(" · ");
      $("stat-anchors").textContent = String(stats.statutory_anchors_count);
    } catch (err) {
      $("status").textContent = "Stats unavailable: " + err.message;
    }
  }

  let inflight = null;
  async function loadExemplars() {
    if (inflight) inflight.abort();
    inflight = new AbortController();
    const params = new URLSearchParams({ limit: "50" });
    if (state.q) params.set("q", state.q);
    if (state.domain) params.set("domain", state.domain);
    try {
      const res = await fetch("/api/v1/exemplars?" + params, {
        headers: { accept: "application/json" },
        signal: inflight.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.details && data.details[0]) || data.error || "HTTP " + res.status);

      const body = $("stream");
      body.replaceChildren();
      if (data.exemplars.length === 0) {
        const tr = document.createElement("tr");
        const td = cell(state.q || state.domain ? "No lessons match this search yet." : "No exemplars yet.", "text-center text-zinc-500");
        td.colSpan = 4;
        tr.append(td);
        body.append(tr);
      }
      for (const e of data.exemplars) {
        const tr = document.createElement("tr");
        tr.append(
          cell(e.domain, "whitespace-nowrap text-amber-300"),
          cell(e.tool_name, "whitespace-nowrap font-mono text-xs"),
          cell(e.primary_statutory_anchor, "text-zinc-300"),
          cell(e.steering_directive, "text-zinc-400"),
        );
        body.append(tr);
      }
      $("status").textContent = data.count + (data.count === 1 ? " lesson" : " lessons") + " · updated " + new Date().toLocaleTimeString();
    } catch (err) {
      if (err.name === "AbortError") return;
      $("status").textContent = "Search failed: " + err.message;
    }
  }

  let debounce;
  $("search").addEventListener("input", (event) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.q = event.target.value.trim();
      loadExemplars();
    }, 200);
  });

  for (const chip of chips) {
    chip.addEventListener("click", () => {
      state.domain = chip.dataset.domain;
      paintChips();
      loadExemplars();
    });
  }

  loadStats();
  loadExemplars();
  setInterval(() => { loadStats(); loadExemplars(); }, 30000);
})();
</script>
</body>
</html>`;
}
