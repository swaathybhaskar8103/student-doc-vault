// Polls an estimated % complete for documents still being checked by the AI, so students see
// more than just "Checking…" while they wait. The server has no real progress to report (one
// model call, no partial results) — the % is elapsed time against how long recent checks took.
document.addEventListener('DOMContentLoaded', () => {
  const els = Array.from(document.querySelectorAll('[data-ai-progress]'));
  if (!els.length) return;

  const render = (el, percent) => {
    el.innerHTML = `<div class="ai-pct-track"><div class="ai-pct-fill" style="width:${percent}%"></div></div><span>${percent}%</span>`;
  };

  const pollOnce = async (el) => {
    const id = el.dataset.docId;
    try {
      const res = await fetch(`/documents/${encodeURIComponent(id)}/check-progress`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return true; // stop polling this one
      const { status, percent, statusCellHtml, actionsCellHtml } = await res.json();
      if (status === 'queued' || status === 'checking') {
        render(el, percent);
        return false;
      }
      // Done: swap in the real Status + actions cells in place (e.g. "Upload new copy" if rejected),
      // no page reload needed, so it never interrupts whatever else the student is doing.
      const cell = el.closest('[data-status-cell]');
      if (cell && statusCellHtml != null) cell.innerHTML = statusCellHtml;
      const row = cell?.closest('tr');
      const actionsCell = row?.querySelector('[data-actions-cell]');
      if (actionsCell && actionsCellHtml != null) actionsCell.innerHTML = actionsCellHtml;
      return true;
    } catch {
      return true;
    }
  };

  const tick = async () => {
    const results = await Promise.all(els.map((el) => (el.dataset.stopped ? true : pollOnce(el))));
    results.forEach((stopped, i) => { if (stopped) els[i].dataset.stopped = '1'; });
    if (results.some((stopped) => !stopped)) setTimeout(tick, 1500);
  };
  tick();
});
