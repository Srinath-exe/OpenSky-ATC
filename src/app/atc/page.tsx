/* /atc -> /play (00-MASTER-PLAN §1). Server component; the query string (?icao=&seed=&spawn=&test=&position=) is carried over. */
import { redirect } from 'next/navigation';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AtcRedirect({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v == null) continue;
    for (const item of Array.isArray(v) ? v : [v]) q.append(k, item);
  }
  const qs = q.toString();
  redirect(qs ? `/play?${qs}` : '/play');
}
