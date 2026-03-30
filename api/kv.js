// Upstash Redis REST API wrapper
// Env vars KV_REST_API_URL + KV_REST_API_TOKEN are auto-injected by Vercel

async function cmd(...parts) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const path  = parts.map(p => encodeURIComponent(p)).join('/');
  const res   = await fetch(`${url}/${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  return json.result;
}

export const kv = {
  async set(key, value, opts) {
    const val = typeof value === 'string' ? value : JSON.stringify(value);
    if (opts?.ex) return cmd('set', key, val, 'EX', String(opts.ex));
    return cmd('set', key, val);
  },
  async get(key) {
    const result = await cmd('get', key);
    if (result === null || result === undefined) return null;
    try { return JSON.parse(result); } catch { return result; }
  }
};
