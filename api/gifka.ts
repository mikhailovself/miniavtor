// Данные каталога — недоверенные, поэтому проверяем структуру и ссылку.
export type GifkaCandidate = { title: string; url: string; key: string };
export function gifkaCandidates(data: any): GifkaCandidate[] {
  if (!Array.isArray(data?.items)) throw new Error('gifka: unexpected response (items must be an array)');
  const seen = new Set<string>();
  return data.items.flatMap((item: any) => {
    if (!Array.isArray(item?.renditions)) return [];
    const r = item.renditions.find((x: any) => {
      const format = String(x?.kind ?? x?.format ?? x?.type ?? '').toLowerCase();
      const mime = String(x?.mime ?? x?.mimeType ?? '').toLowerCase();
      if (format !== 'mp4' && mime !== 'video/mp4') return false;
      try { return typeof x.url === 'string' && new URL(x.url).protocol === 'https:'; } catch { return false; }
    });
    if (!r) return [];
    try {
      const url = new URL(r.url);
      if (url.protocol !== 'https:') return [];
      const key = typeof item.id === 'string' || typeof item.id === 'number' ? `id:${item.id}` : `url:${url.href}`;
      if (seen.has(key) || seen.has(url.href)) return [];
      seen.add(key); seen.add(url.href);
      return [{ title: String(item.title ?? item.name ?? 'Реакция').slice(0, 100), url: url.href, key }];
    } catch { return []; }
  }).slice(0, 10);
}

export function gifkaQueries(reply: string): string[] {
  const cleaned = reply.replace(/[«»"“”]/g, '').replace(/(?:^|\s)(?:gif|гифка|гифки|гиф|мем|мемы)(?=\s|$)/giu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!cleaned) return [];
  const words = cleaned.split(' ');
  return [...new Set([cleaned, ...(words.length > 2 ? [words.slice(0, 2).join(' ')] : []), ...(words.length > 1 ? [words[0]] : [])])].slice(0, 3);
}

type GifkaFetch = (url: string, init: { headers: Record<string, string> }, timeout: number) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
export async function searchGifka(queries: string[], headers: Record<string, string>, fetcher: GifkaFetch): Promise<{ query: string; candidates: GifkaCandidate[]; attempts: number }> {
  let query = '';
  let attempts = 0;
  for (query of queries.slice(0, 3)) {
    attempts++;
    const params = new URLSearchParams({ q: query, type: 'gif', limit: '10', rating: 'pg13' });
    const response = await fetcher(`https://api.gifka.me/v1/search?${params}`, { headers }, 8000);
    if (!response.ok) throw new Error(`gifka HTTP ${response.status}`);
    const data = await response.json();
    const candidates = gifkaCandidates(data);
    if (candidates.length) return { query, candidates, attempts };
    // Distinguish a format problem from genuinely empty search results.
    if (data.items.length) throw new Error(`gifka: ${data.items.length} items but no usable HTTPS MP4`);
  }
  return { query, candidates: [], attempts };
}

// History is newest first, shared across search queries in the same chat.
export function chooseGifka(candidates: GifkaCandidate[], recent: string[], random = Math.random): GifkaCandidate | null {
  const unseen = candidates.filter(item => !recent.includes(item.key));
  if (unseen.length) return unseen[Math.floor(random() * unseen.length)];
  // Once all matches have been seen, reuse the oldest one, never the last sent GIF.
  const eligible = candidates.filter(item => item.key !== recent[0]);
  return eligible.reduce<GifkaCandidate | null>((oldest, item) =>
    !oldest || recent.indexOf(item.key) > recent.indexOf(oldest.key) ? item : oldest, null);
}

export type GifkaSendResult = { ok: boolean; error_code?: number; description?: string; [key: string]: any };

// Retry only an explicit URL/file rejection. A timeout may mean Telegram already sent it.
export async function sendGifkaAnimation(url: string, send: (animation: string | Blob) => Promise<GifkaSendResult>, download = downloadGifka): Promise<GifkaSendResult> {
  const result = await send(url);
  if (result.ok || result.error_code !== 400 || !/failed to get http url content|wrong (?:file identifier\/)?http url|webpage_curl_failed|webpage_media_empty|failed to fetch|failed to download|wrong type of the web page content|wrong file identifier\/http url specified/i.test(result.description ?? '')) return result;
  return send(await download(url));
}

export async function downloadGifka(url: string, fetcher: typeof fetch = fetch): Promise<Blob> {
  const parsed = new URL(url);
  // Only the documented public CDN; never follow a redirect to an arbitrary server.
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'media.gifka.me' || parsed.port || parsed.username || parsed.password) throw new Error('gifka: unsupported download host');
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  const maxBytes = 10 * 1024 * 1024;
  if (!response.ok) throw new Error(`gifka media HTTP ${response.status}`);
  if (!response.body) throw new Error('gifka: empty media body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('gifka: media exceeds 10 MB');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('gifka: media exceeds 10 MB');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (size < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') throw new Error('gifka: download is not an MP4');
  return new Blob([bytes], { type: 'video/mp4' });
}
