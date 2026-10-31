// Данные каталога — недоверенные, поэтому проверяем структуру и ссылку.
export type GifkaCandidate = { title: string; url: string; key: string };
export function gifkaCandidates(data: any): GifkaCandidate[] {
  if (!Array.isArray(data?.items)) return [];
  const seen = new Set<string>();
  return data.items.flatMap((item: any) => {
    if (!Array.isArray(item?.renditions)) return [];
    const r = item.renditions.find((x: any) => String(x?.format ?? x?.type ?? x?.mimeType ?? '').toLowerCase().includes('mp4') && typeof x?.url === 'string');
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

// History is newest first, shared across search queries in the same chat.
export function chooseGifka(candidates: GifkaCandidate[], recent: string[], random = Math.random): GifkaCandidate | null {
  const unseen = candidates.filter(item => !recent.includes(item.key));
  if (unseen.length) return unseen[Math.floor(random() * unseen.length)];
  // Once all matches have been seen, reuse the oldest one, never the last sent GIF.
  const eligible = candidates.filter(item => item.key !== recent[0]);
  return eligible.reduce<GifkaCandidate | null>((oldest, item) =>
    !oldest || recent.indexOf(item.key) > recent.indexOf(oldest.key) ? item : oldest, null);
}
