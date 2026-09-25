import { rpc } from './api.js';
import { loadXLSX } from './ui.js';

const PAGE = 5000;
const stamp = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

/** Pull every table (page by page). onProgress(done, total, table) */
export async function collectBackup(onProgress = () => {}) {
  const counts = await rpc('backup_counts');
  const tables = Object.keys(counts);
  const total = Object.values(counts).reduce((a, n) => a + Number(n), 0);
  const data = {};
  let done = 0;
  for (const tbl of tables) {
    data[tbl] = [];
    for (let off = 0; off < Number(counts[tbl]); off += PAGE) {
      const rows = await rpc('backup_table', { p_table: tbl, p_offset: off, p_limit: PAGE });
      data[tbl].push(...rows);
      done += rows.length;
      onProgress(done, total, tbl);
    }
    onProgress(done, total, tbl);
  }
  return { data, counts, total };
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** Excel: one sheet per table (readable; nested values kept as JSON text). */
export async function backupExcel(onProgress) {
  await loadXLSX();
  const { data, total } = await collectBackup(onProgress);
  const wb = window.XLSX.utils.book_new();
  const info = [{ created_at: new Date().toISOString(), tables: Object.keys(data).length, rows: total }];
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(info), '_info');
  for (const [tbl, rows] of Object.entries(data)) {
    const flat = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v])));
    const ws = flat.length ? window.XLSX.utils.json_to_sheet(flat) : window.XLSX.utils.aoa_to_sheet([['(empty)']]);
    window.XLSX.utils.book_append_sheet(wb, ws, tbl.slice(0, 31));
  }
  window.XLSX.writeFile(wb, `cafeteria-backup_${stamp()}.xlsx`);
  await rpc('backup_done', { p_rows: total, p_format: 'xlsx' });
  return total;
}

/** JSON: exact copy of every row, used if data ever has to be restored. */
export async function backupJson(onProgress) {
  const { data, total } = await collectBackup(onProgress);
  const payload = { app: 'cafeteria', version: 1, created_at: new Date().toISOString(), rows: total, tables: data };
  download(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `cafeteria-backup_${stamp()}.json`);
  await rpc('backup_done', { p_rows: total, p_format: 'json' });
  return total;
}
