// api/update.js
// Runs every 5 min during game windows + 2am nightly
// Fetches NBA + NHL standings, scoreboard, game log
// Computes net ratings from game log
// Writes to Vercel KV (or file cache)

const NBA_HEADERS = {
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

// ─── NBA FETCHERS ────────────────────────────────────────────────────────────

async function fetchNBAStandings() {
  const url = 'https://stats.nba.com/stats/leaguestandingsv3?LeagueID=00&Season=2025-26&SeasonType=Regular+Season';
  const res = await fetch(url, { headers: NBA_HEADERS });
  const data = await res.json();
  const headers = data.resultSets[0].headers;
  const rows = data.resultSets[0].rowSet;

  const idx = (name) => headers.indexOf(name);

  return rows.map(r => ({
    abbr:        r[idx('TeamSlug')]?.toUpperCase() || r[idx('TeamCity')],
    teamId:      r[idx('TeamID')],
    name:        `${r[idx('TeamCity')]} ${r[idx('TeamName')]}`,
    conf:        r[idx('Conference')],
    div:         r[idx('Division')],
    w:           r[idx('WINS')],
    l:           r[idx('LOSSES')],
    pct:         r[idx('WinPCT')],
    home:        r[idx('HOME')],   // e.g. "25-12"
    road:        r[idx('ROAD')],
    l10:         r[idx('L10')],    // e.g. "7-3"
    streak:      r[idx('strCurrentStreak')],
    clinched:    r[idx('clinchIndicator')] || '',
    confRank:    r[idx('PlayoffRank')],
    divRank:     r[idx('DivisionRank')],
  }));
}

async function fetchNBAGameLog() {
  const url = 'https://stats.nba.com/stats/leaguegamelog?Season=2025-26&SeasonType=Regular+Season&Direction=DESC&Sorter=DATE&Counter=1000';
  const res = await fetch(url, { headers: NBA_HEADERS });
  const data = await res.json();
  const headers = data.resultSets[0].headers;
  const rows = data.resultSets[0].rowSet;

  const idx = (name) => headers.indexOf(name);

  return rows.map(r => ({
    teamId:    r[idx('TEAM_ID')],
    abbr:      r[idx('TEAM_ABBREVIATION')],
    gameId:    r[idx('GAME_ID')],
    date:      r[idx('GAME_DATE')],
    matchup:   r[idx('MATCHUP')],   // e.g. "BOS vs. MIA" or "BOS @ MIA"
    pts:       r[idx('PTS')],
    oppPts:    null, // computed below by pairing games
    wl:        r[idx('WL')],
  }));
}

async function fetchNBAScoreboard() {
  const url = 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json';
  const res = await fetch(url);
  const data = await res.json();
  return data.scoreboard?.games || [];
}

// ─── NHL FETCHERS ────────────────────────────────────────────────────────────

async function fetchNHLStandings() {
  const url = 'https://api-web.nhle.com/v1/standings/now';
  const res = await fetch(url);
  const data = await res.json();
  return data.standings;
}

async function fetchNHLScoreboard() {
  const url = 'https://api-web.nhle.com/v1/scoreboard/now';
  const res = await fetch(url);
  const data = await res.json();
  return data.gamesByDate?.[0]?.games || [];
}

// ─── NET RATING COMPUTATION ──────────────────────────────────────────────────

function computeNBANetRatings(gamelog) {
  // gamelog has one row per team per game
  // We need to pair home vs away to get pts_against
  // Group by gameId, then pair
  const byGame = {};
  gamelog.forEach(g => {
    if (!byGame[g.gameId]) byGame[g.gameId] = [];
    byGame[g.gameId].push(g);
  });

  // For each team: accumulate pts scored and pts allowed, plus last 15 games
  const teamStats = {}; // abbr -> { games: [{pts, oppPts, date}] }

  Object.values(byGame).forEach(pair => {
    if (pair.length !== 2) return;
    const [t1, t2] = pair;
    // pts for t1 = t1.pts, pts against t1 = t2.pts
    if (!teamStats[t1.abbr]) teamStats[t1.abbr] = { games: [] };
    if (!teamStats[t2.abbr]) teamStats[t2.abbr] = { games: [] };
    teamStats[t1.abbr].games.push({ pts: t1.pts, oppPts: t2.pts, date: t1.date });
    teamStats[t2.abbr].games.push({ pts: t2.pts, oppPts: t1.pts, date: t2.date });
  });

  // Compute season net rating and L15 net rating
  const netRatings = {};
  Object.entries(teamStats).forEach(([abbr, { games }]) => {
    // Sort by date descending (most recent first)
    games.sort((a, b) => b.date.localeCompare(a.date));

    const season = games.reduce((acc, g) => ({
      pts: acc.pts + g.pts,
      opp: acc.opp + g.oppPts,
      n:   acc.n + 1
    }), { pts: 0, opp: 0, n: 0 });

    const last15 = games.slice(0, 15).reduce((acc, g) => ({
      pts: acc.pts + g.pts,
      opp: acc.opp + g.oppPts,
      n:   acc.n + 1
    }), { pts: 0, opp: 0, n: 0 });

    const seasonNR = season.n > 0
      ? ((season.pts - season.opp) / season.n)
      : 0;

    const l15NR = last15.n > 0
      ? ((last15.pts - last15.opp) / last15.n)
      : seasonNR;

    netRatings[abbr] = {
      season: Math.round(seasonNR * 10) / 10,
      l15:    Math.round(l15NR * 10) / 10
    };
  });

  return netRatings;
}

function computeNBAH2H(gamelog) {
  // h2h[teamA][teamB] = { wins: X, games: Y }
  const h2h = {};

  const byGame = {};
  gamelog.forEach(g => {
    if (!byGame[g.gameId]) byGame[g.gameId] = [];
    byGame[g.gameId].push(g);
  });

  Object.values(byGame).forEach(pair => {
    if (pair.length !== 2) return;
    const [t1, t2] = pair;
    if (!h2h[t1.abbr]) h2h[t1.abbr] = {};
    if (!h2h[t2.abbr]) h2h[t2.abbr] = {};
    if (!h2h[t1.abbr][t2.abbr]) h2h[t1.abbr][t2.abbr] = { wins: 0, games: 0 };
    if (!h2h[t2.abbr][t1.abbr]) h2h[t2.abbr][t1.abbr] = { wins: 0, games: 0 };

    h2h[t1.abbr][t2.abbr].games++;
    h2h[t2.abbr][t1.abbr].games++;
    if (t1.wl === 'W') {
      h2h[t1.abbr][t2.abbr].wins++;
    } else {
      h2h[t2.abbr][t1.abbr].wins++;
    }
  });

  return h2h;
}

function computeNBABackToBack(gamelog) {
  // Returns set of team abbrs playing on a back-to-back TODAY
  // "today" = we check the most recent date in gamelog vs today
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0].replace(/-/g, '');

  const playedYesterday = new Set();
  gamelog.forEach(g => {
    if (g.date === yesterday) playedYesterday.add(g.abbr);
  });
  return playedYesterday; // teams that played yesterday = on B2B today
}

// ─── DATA TRANSFORMERS ───────────────────────────────────────────────────────

const TEAM_COLORS = {
  // NBA
  ATL:'#E03A3E',BOS:'#007A33',BKN:'#444444',CHA:'#00788C',CHI:'#CE1141',
  CLE:'#860038',DAL:'#0053BC',DEN:'#FEC524',DET:'#C8102E',GSW:'#1D428A',
  HOU:'#CE1141',IND:'#FDBB30',LAC:'#C8102E',LAL:'#552583',MEM:'#5D76A9',
  MIA:'#98002E',MIL:'#00471B',MIN:'#78BE20',NOP:'#B4975A',NYK:'#006BB6',
  OKC:'#007AC1',ORL:'#0077C0',PHI:'#006BB6',PHX:'#E56020',POR:'#E03A3E',
  SAC:'#5A2D81',SAS:'#C4CED4',TOR:'#CE1141',UTA:'#F9A01B',WAS:'#4A90D9',
  // NHL
  ANA:'#FC4C02',ARI:'#8C2633',BUF:'#00B2A9',CAR:'#CC0000',CBJ:'#CE1126',
  CGY:'#C8102E',COL:'#6F263D',DAL:'#006847',EDM:'#FF4C00',FLA:'#C8102E',
  LAK:'#A2AAAD',MIN:'#154734',MTL:'#AF1E2D',NJD:'#CE1126',NSH:'#FFB81C',
  NYI:'#00539B',NYR:'#0038A8',OTT:'#C52032',PHI:'#F74902',PIT:'#FCB514',
  SEA:'#99D9D9',SJS:'#006D75',STL:'#0038A8',TBL:'#0099CC',TOR:'#003E7E',
  VAN:'#008852',VGK:'#B4975A',WPG:'#55B7E4',WSH:'#C8102E',UTA_NHL:'#71AFE5',
};

function transformNBAStandings(rows, netRatings) {
  // Sort each conf by wins desc, then losses asc
  const east = rows.filter(r => r.conf === 'East').sort((a,b) => b.w - a.w || a.l - b.l);
  const west = rows.filter(r => r.conf === 'West').sort((a,b) => b.w - a.w || a.l - b.l);

  const transform = (teams) => teams.map(t => {
    const nr = netRatings[t.abbr] || { season: 0, l15: 0 };
    const rem = 82 - t.w - t.l;
    const l10parts = t.l10.split('-');
    const l10w = parseInt(l10parts[0]) || 0;
    const ci = t.clinched?.toLowerCase() || '';
    const clinched = ci.includes('x') ? 'auto' : ci.includes('p') ? 'pi' : false;
    const elim = false; // will be set by montecarlo or manual flag

    // Streak: API returns e.g. "W 3" or "L 2" — normalize to "W3"/"L3"
    const streakRaw = (t.streak || '').toString().trim();
    const streakMatch = streakRaw.match(/([WL])\s*(\d+)/);
    const streak = streakMatch ? `${streakMatch[1]}${streakMatch[2]}` : '';

    return [
      t.name,           // 0  full name
      t.abbr,           // 1  abbreviation
      t.w,              // 2  wins
      t.l,              // 3  losses
      rem,              // 4  games remaining
      nr.season,        // 5  net rating (season)
      l10w,             // 6  last 10 wins
      streak,           // 7  streak e.g. "W3"
      TEAM_COLORS[t.abbr] || '#888888', // 8 color
      elim,             // 9  eliminated
      clinched,         // 10 clinched status
      t.l10,            // 11 last 10 string e.g. "7-3"
      t.home,           // 12 home record e.g. "25-12"
      t.road,           // 13 road record
      nr.l15,           // 14 L15 net rating (used by Monte Carlo)
    ];
  });

  return { east: transform(east), west: transform(west) };
}

function transformNHLStandings(rows) {
  const east = rows.filter(r => r.conferenceName === 'Eastern')
    .sort((a,b) => b.points - a.points);
  const west = rows.filter(r => r.conferenceName === 'Western')
    .sort((a,b) => b.points - a.points);

  const transform = (teams, conf) => teams.map((t, i) => {
    const abbr = t.teamAbbrev.default;
    const rem = 82 - t.gamesPlayed;
    const ci = t.clinchIndicator || '';
    const clinched = ci === 'x' ? 'div' : ci === 'y' ? 'playoff' : false;
    const elim = false;

    // Streak
    const streak = t.streakCode && t.streakCount ? `${t.streakCode}${t.streakCount}` : '';

    // L10 string from API fields
    const l10str = `${t.l10Wins}-${t.l10Losses}-${t.l10OtLosses}`;

    // Goal differential rate (net rating equivalent)
    const gdSeason = t.gamesPlayed > 0
      ? (t.goalFor - t.goalAgainst) / t.gamesPlayed
      : 0;
    const gdL10 = t.l10GamesPlayed > 0
      ? (t.l10GoalsFor - t.l10GoalsAgainst) / t.l10GamesPlayed
      : gdSeason;

    // Division rank within conference
    const divRank = t.divisionSequence;
    const confRank = i + 1;

    return [
      t.teamName.default,      // 0  full name
      abbr,                    // 1  abbreviation
      t.points,                // 2  points
      t.wins,                  // 3  wins
      t.losses,                // 4  losses
      t.otLosses,              // 5  OT losses
      rem,                     // 6  games remaining
      streak,                  // 7  streak
      TEAM_COLORS[abbr] || '#888888', // 8 color
      elim,                    // 9  eliminated
      clinched,                // 10 clinched
      confRank,                // 11 conf rank
      divRank,                 // 12 div rank
      t.divisionName,          // 13 division name
      l10str,                  // 14 last 10 string
      Math.round(gdSeason * 100) / 100, // 15 season GD rate
      Math.round(gdL10 * 100) / 100,    // 16 L10 GD rate
    ];
  });

  return { east: transform(east, 'East'), west: transform(west, 'West') };
}

function transformNBAScoreboard(games) {
  return games.map(g => {
    const home = g.homeTeam;
    const away = g.awayTeam;

    // Win probability from API (0-1 float) — convert to percentage
    const hwp = home.teamTricode;
    const awp = away.teamTricode;

    // API provides periods/clock for live games
    const status = g.gameStatusText || '';
    const time = g.gameEt
      ? new Date(g.gameEt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
      : status;

    // Win probability — scoreboard sometimes has it
    const hw = g.homeTeam.teamWinProbability != null
      ? Math.round(g.homeTeam.teamWinProbability * 100)
      : 50;
    const aw = 100 - hw;

    return { h: hwp, a: awp, hw, aw, t: time };
  });
}

function transformNHLScoreboard(games) {
  return games.map(g => {
    const home = g.homeTeam?.abbrev || '';
    const away = g.awayTeam?.abbrev || '';
    const time = g.startTimeUTC
      ? new Date(g.startTimeUTC).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
      : '';

    // NHL scoreboard doesn't provide win probability — use 50/50 as placeholder
    // Monte Carlo will fill in real win probabilities
    return { h: home, a: away, hw: 50, aw: 50, t: time };
  });
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    console.log('[update] Starting data fetch:', new Date().toISOString());

    // Fetch everything in parallel
    const [
      nbaStandingsRaw,
      nbaGamelogRaw,
      nbaScoreboardRaw,
      nhlStandingsRaw,
      nhlScoreboardRaw,
    ] = await Promise.all([
      fetchNBAStandings(),
      fetchNBAGameLog(),
      fetchNBAScoreboard(),
      fetchNHLStandings(),
      fetchNHLScoreboard(),
    ]);

    // Compute derived stats
    const nbaNetRatings = computeNBANetRatings(nbaGamelogRaw);
    const nbaH2H        = computeNBAH2H(nbaGamelogRaw);
    const nbaB2B        = computeNBABackToBack(nbaGamelogRaw);

    // Transform to frontend array format
    const nbaStandings = transformNBAStandings(nbaStandingsRaw, nbaNetRatings);
    const nhlStandings = transformNHLStandings(nhlStandingsRaw);
    const nbaToday     = transformNBAScoreboard(nbaScoreboardRaw);
    const nhlToday     = transformNHLScoreboard(nhlScoreboardRaw);

    // Build final payload
    const payload = {
      updatedAt: new Date().toISOString(),
      nba: {
        east:  nbaStandings.east,
        west:  nbaStandings.west,
        today: nbaToday,
      },
      nhl: {
        east:  nhlStandings.east,
        west:  nhlStandings.west,
        today: nhlToday,
      },
      // H2H and B2B used by Monte Carlo — stored separately
      _meta: {
        nbaH2H,
        nbaB2B: [...nbaB2B],
      }
    };

    // Store in Vercel KV
    const { kv } = await import('@vercel/kv');
    await kv.set('live_data', JSON.stringify(payload), { ex: 3600 }); // 1hr TTL

    console.log('[update] Done. NBA east:', nbaStandings.east.length, 'teams');
    res.status(200).json({ ok: true, updatedAt: payload.updatedAt });

  } catch (err) {
    console.error('[update] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
