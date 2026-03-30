// api/data.js
// Frontend calls this on page load
// Returns live standings + odds merged together

export default async function handler(req, res) {
  // CORS — allow frontend to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const { kv } = await import('./kv.js');

    const [liveRaw, oddsRaw] = await Promise.all([
      kv.get('live_data'),
      kv.get('mc_odds'),
    ]);

    if (!liveRaw) {
      return res.status(503).json({ ok: false, error: 'Data not yet available. Check back soon.' });
    }

    const live = typeof liveRaw === 'string' ? JSON.parse(liveRaw) : liveRaw;
    const odds = oddsRaw
      ? (typeof oddsRaw === 'string' ? JSON.parse(oddsRaw) : oddsRaw)
      : null;

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate'); // 5min CDN cache

    res.status(200).json({
      ok: true,
      updatedAt:   live.updatedAt,
      oddsAt:      odds?.computedAt || null,
      nba: {
        east:  live.nba.east,
        west:  live.nba.west,
        today: live.nba.today,
      },
      nhl: {
        east:  live.nhl.east,
        west:  live.nhl.west,
        today: live.nhl.today,
      },
      odds: {
        nba: odds?.nbaOdds || null,
        nhl: odds?.nhlOdds || null,
      }
    });

  } catch (err) {
    console.error('[data] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
