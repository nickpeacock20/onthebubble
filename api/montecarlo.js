// api/montecarlo.js
// Runs nightly at 2am ET
// 10,000 simulations of remaining schedule for NBA + NHL
// Outputs playoff odds per team, stored in KV

// ─── MATH UTILS ─────────────────────────────────────────────────────────────

function sigmoid(x, divisor) {
  return 1 / (1 + Math.exp(-x / divisor));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ─── NBA WIN PROBABILITY ─────────────────────────────────────────────────────
// team array index reference:
// [name, abbr, w, l, rem, netRtgSeason, l10w, streak, color, elim, clinched, l10str, home, road, netRtgL15]

function nbcWinProb(homeTeam, awayTeam, h2h, b2bSet) {
  const homeNR  = homeTeam[5];  // season net rating
  const homeL15 = homeTeam[14]; // L15 net rating
  const awayNR  = awayTeam[5];
  const awayL15 = awayTeam[14];

  // Adjusted net rating = 70% season + 30% L15
  const homeANR = homeNR * 0.70 + homeL15 * 0.30;
  const awayANR = awayNR * 0.70 + awayL15 * 0.30;

  // Base point diff
  let pointDiff = homeANR - awayANR;

  // Home court adjustment
  const awayOnB2B = b2bSet.has(awayTeam[1]);
  pointDiff += awayOnB2B ? 3.0 : 2.5;

  // H2H adjustment
  const hAbbr = homeTeam[1];
  const aAbbr = awayTeam[1];
  if (h2h[hAbbr]?.[aAbbr]) {
    const { wins, games } = h2h[hAbbr][aAbbr];
    if (games > 0) {
      const h2hWinRate = wins / games;
      const h2hWeight = Math.min(games / 4, 0.25);
      const anrWeight = 1 - h2hWeight;
      const anrProb = sigmoid(pointDiff, 7);
      const blendedProb = anrProb * anrWeight + h2hWinRate * h2hWeight;
      return blendedProb;
    }
  }

  return sigmoid(pointDiff, 7);
}

// ─── NBA PLAY-IN SIMULATION ──────────────────────────────────────────────────
// Given seeds 7-10, simulate play-in bracket
// Returns { abbr: true } for the two teams that make playoffs

function simulateNBAPlayIn(seeds710, h2h) {
  // seeds710 = [s7team, s8team, s9team, s10team] (team arrays)
  const [s7, s8, s9, s10] = seeds710;
  const b2b = new Set(); // no B2B adjustment for playoff games

  // Game 1: s7 vs s8 — winner = 7 seed (done)
  const p7beats8 = nbcWinProb(s7, s8, h2h, b2b);
  const g1Winner = Math.random() < p7beats8 ? s7 : s8;
  const g1Loser  = g1Winner === s7 ? s8 : s7;

  // Game 2: s9 vs s10 — winner survives, loser eliminated
  const p9beats10 = nbcWinProb(s9, s10, h2h, b2b);
  const g2Winner = Math.random() < p9beats10 ? s9 : s10;

  // Game 3: g1Loser vs g2Winner — winner = 8 seed
  const pG1LBeatsG2W = nbcWinProb(g1Loser, g2Winner, h2h, b2b);
  const g3Winner = Math.random() < pG1LBeatsG2W ? g1Loser : g2Winner;

  // Return the two teams that made it
  return new Set([g1Winner[1], g3Winner[1]]);
}

// ─── NBA MONTE CARLO ─────────────────────────────────────────────────────────

function runNBAMonteCarlo(eastTeams, westTeams, remainingGames, h2h, b2bSet, N = 10000) {
  // remainingGames = array of { home: abbr, away: abbr }
  // We derive remaining games from the schedule or estimate from standings

  const allTeams = [...eastTeams, ...westTeams];
  const teamMap = {};
  allTeams.forEach(t => { teamMap[t[1]] = t; });

  // Counters per team
  const counts = {};
  allTeams.forEach(t => {
    counts[t[1]] = { makePlayoffs: 0, top6: 0, inPlayIn: 0, survivePlayIn: 0 };
  });

  for (let sim = 0; sim < N; sim++) {
    // Clone win totals
    const wins = {};
    allTeams.forEach(t => { wins[t[1]] = t[2]; });

    // Simulate remaining games
    for (const game of remainingGames) {
      const home = teamMap[game.home];
      const away = teamMap[game.away];
      if (!home || !away) continue;

      const wp = nbcWinProb(home, away, h2h, b2bSet);
      if (Math.random() < wp) {
        wins[game.home]++;
      } else {
        wins[game.away]++;
      }
    }

    // Sort each conference by simulated wins
    const sortConf = (teams) =>
      [...teams].sort((a, b) => (wins[b[1]] - wins[a[1]]) || (a[3] - b[3]));

    const eastFinal = sortConf(eastTeams);
    const westFinal = sortConf(westTeams);

    // Process each conference
    for (const conf of [eastFinal, westFinal]) {
      const top6  = conf.slice(0, 6);
      const pi    = conf.slice(6, 10);
      const seeds710 = pi.length === 4 ? pi : null;

      top6.forEach(t => {
        counts[t[1]].top6++;
        counts[t[1]].makePlayoffs++;
      });

      if (seeds710) {
        pi.forEach(t => {
          counts[t[1]].inPlayIn++;
        });

        // Simulate play-in
        const playInWinners = simulateNBAPlayIn(seeds710, h2h);
        pi.forEach(t => {
          if (playInWinners.has(t[1])) {
            counts[t[1]].survivePlayIn++;
            counts[t[1]].makePlayoffs++;
          }
        });
      }
    }
  }

  // Convert to percentages
  const odds = {};
  allTeams.forEach(t => {
    const c = counts[t[1]];
    odds[t[1]] = {
      mp:   Math.round((c.makePlayoffs  / N) * 100),
      auto: Math.round((c.top6          / N) * 100),
      pi:   Math.round((c.inPlayIn      / N) * 100),
      sp:   Math.round((c.survivePlayIn / N) * 100),
    };
  });

  return odds;
}

// ─── NHL WIN PROBABILITY ─────────────────────────────────────────────────────
// team array index reference:
// [name, abbr, pts, w, l, otl, rem, streak, color, elim, clinched, confRank, divRank, div, l10str, gdSeason, gdL10]

function nhlWinProb(homeTeam, awayTeam, b2bSet = new Set()) {
  const homeGD  = homeTeam[15]; // season GD rate
  const homeL10 = homeTeam[16]; // L10 GD rate
  const awayGD  = awayTeam[15];
  const awayL10 = awayTeam[16];

  // Adjusted GD = 70% season + 30% L10
  const homeAGD = homeGD * 0.70 + homeL10 * 0.30;
  const awayAGD = awayGD * 0.70 + awayL10 * 0.30;

  let goalDiff = homeAGD - awayAGD;

  // Home ice advantage — extra if away team on back-to-back
  const awayOnB2B = b2bSet.has(awayTeam[1]);
  goalDiff += awayOnB2B ? 0.20 : 0.15;

  return sigmoid(goalDiff, 2.5);
}

// ─── NHL MONTE CARLO ─────────────────────────────────────────────────────────

function runNHLMonteCarlo(eastTeams, westTeams, remainingGames, b2bSet = new Set(), N = 10000) {
  const allTeams = [...eastTeams, ...westTeams];
  const teamMap = {};
  allTeams.forEach(t => { teamMap[t[1]] = t; });

  const OT_RATE = 0.23; // ~23% of NHL games go to OT/SO

  const counts = {};
  allTeams.forEach(t => {
    counts[t[1]] = { makePlayoffs: 0, divTop3: 0, wildCard: 0 };
  });

  for (let sim = 0; sim < N; sim++) {
    // Clone points
    const pts = {};
    allTeams.forEach(t => { pts[t[1]] = t[2]; });

    // Simulate remaining games
    for (const game of remainingGames) {
      const home = teamMap[game.home];
      const away = teamMap[game.away];
      if (!home || !away) continue;

      const wp = nhlWinProb(home, away, b2bSet);

      const isOT = Math.random() < OT_RATE;
      if (isOT) {
        // Both teams get 1 point (OTL), winner gets 2nd point
        pts[game.home]++;
        pts[game.away]++;
        // Flip for extra point — same win prob
        if (Math.random() < wp) {
          pts[game.home]++;
        } else {
          pts[game.away]++;
        }
      } else {
        // Regulation — winner gets 2, loser gets 0
        if (Math.random() < wp) {
          pts[game.home] += 2;
        } else {
          pts[game.away] += 2;
        }
      }
    }

    // Sort conferences by points
    const sortConf = (teams) =>
      [...teams].sort((a, b) => (pts[b[1]] - pts[a[1]]) || (b[2] - a[2]));

    for (const confTeams of [eastTeams, westTeams]) {
      const sorted = sortConf(confTeams);

      // Get top 3 per division
      const divs = {};
      sorted.forEach(t => {
        const div = t[13];
        if (!divs[div]) divs[div] = [];
        divs[div].push(t[1]);
      });

      const top3Abbrs = new Set();
      Object.values(divs).forEach(divTeams => {
        divTeams.slice(0, 3).forEach(abbr => top3Abbrs.add(abbr));
      });

      // Wild card = next 2 teams NOT in top 3 of their division
      const wcTeams = sorted.filter(t => !top3Abbrs.has(t[1])).slice(0, 2);
      const wcAbbrs = new Set(wcTeams.map(t => t[1]));

      // Top 8 = div top 3s + 2 wild cards
      const top8 = new Set([...top3Abbrs, ...wcAbbrs]);

      sorted.forEach(t => {
        const abbr = t[1];
        if (top3Abbrs.has(abbr)) {
          counts[abbr].divTop3++;
          counts[abbr].makePlayoffs++;
        } else if (wcAbbrs.has(abbr)) {
          counts[abbr].wildCard++;
          counts[abbr].makePlayoffs++;
        }
      });
    }
  }

  // Convert to percentages
  const odds = {};
  allTeams.forEach(t => {
    const c = counts[t[1]];
    odds[t[1]] = {
      mp:  Math.round((c.makePlayoffs / N) * 100),
      div: Math.round((c.divTop3      / N) * 100),
      wc:  Math.round((c.wildCard     / N) * 100),
    };
  });

  return odds;
}

// ─── REMAINING SCHEDULE FETCHERS ─────────────────────────────────────────────

async function fetchNBARemainingSchedule() {
  // Stable CDN file — no auth needed, no versioning issues
  const url = 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json';
  const res = await fetch(url);
  const data = await res.json();

  const today = new Date().toISOString().split('T')[0]; // "2026-03-29"
  const games = [];

  for (const dateObj of data.leagueSchedule.gameDates) {
    // Only include future games (gameDate > today)
    if (dateObj.gameDate <= today) continue;
    for (const g of dateObj.games) {
      const home = g.homeTeam?.teamTricode;
      const away = g.awayTeam?.teamTricode;
      if (!home || !away) continue;
      // Skip All-Star, preseason, playoff games (gameType === 2 = regular season)
      if (g.gameType !== undefined && g.gameType !== 2) continue;
      games.push({ home, away, date: dateObj.gameDate });
    }
  }

  return games;
}

async function fetchNHLRemainingSchedule() {
  // NHL schedule/now returns ~1 week. We paginate using nextStartDate
  // until we've collected all remaining games this season
  const games = [];
  const today = new Date().toISOString().split('T')[0];
  const regularSeasonEnd = '2026-04-17'; // from the API response

  let url = 'https://api-web.nhle.com/v1/schedule/now';

  while (url) {
    const res = await fetch(url);
    const data = await res.json();

    for (const week of (data.gameWeek || [])) {
      if (week.date > regularSeasonEnd) break;
      for (const g of (week.games || [])) {
        // Only future regular season games (gameType 2)
        if (g.gameType !== 2) continue;
        if (g.gameState !== 'FUT') continue; // skip live/finished
        const home = g.homeTeam?.abbrev;
        const away = g.awayTeam?.abbrev;
        if (!home || !away) continue;
        games.push({ home, away, date: week.date });
      }
    }

    // Paginate to next week if available and still within regular season
    const next = data.nextStartDate;
    if (next && next <= regularSeasonEnd) {
      url = `https://api-web.nhle.com/v1/schedule/${next}`;
    } else {
      url = null;
    }
  }

  return games;
}

function computeNHLBackToBack(nhlRemaining) {
  // Find teams playing today that also played yesterday
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  const playedYesterday = new Set();
  const playingToday = new Set();

  nhlRemaining.forEach(g => {
    if (g.date === yesterday) {
      playedYesterday.add(g.home);
      playedYesterday.add(g.away);
    }
    if (g.date === today) {
      playingToday.add(g.home);
      playingToday.add(g.away);
    }
  });

  // B2B = playing today AND played yesterday
  const b2b = new Set();
  playingToday.forEach(abbr => {
    if (playedYesterday.has(abbr)) b2b.add(abbr);
  });
  return b2b;
}
// Fills in win probabilities for tonight's NHL games using the model

function computeNHLTodayWinProbs(todayGames, allNHLTeams, b2bSet = new Set()) {
  const teamMap = {};
  allNHLTeams.forEach(t => { teamMap[t[1]] = t; });

  return todayGames.map(g => {
    const home = teamMap[g.h];
    const away = teamMap[g.a];
    if (!home || !away) return g;
    const hw = Math.round(nhlWinProb(home, away, b2bSet) * 100);
    return { ...g, hw, aw: 100 - hw };
  });
}

function computeNBATodayWinProbs(todayGames, allNBATeams, h2h, b2bSet) {
  const teamMap = {};
  allNBATeams.forEach(t => { teamMap[t[1]] = t; });

  return todayGames.map(g => {
    const home = teamMap[g.h];
    const away = teamMap[g.a];
    if (!home || !away) return g;
    const hw = Math.round(nbcWinProb(home, away, h2h, b2bSet) * 100);
    return { ...g, hw, aw: 100 - hw };
  });
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    console.log('[montecarlo] Starting simulation:', new Date().toISOString());

    const { kv } = await import('./kv.js');

    // Load current live data
    const raw = await kv.get('live_data');
    if (!raw) {
      return res.status(400).json({ ok: false, error: 'No live_data in KV. Run /api/update first.' });
    }

    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const { nba, nhl, _meta } = data;

    const h2h    = _meta?.nbaH2H || {};
    const b2bSet = new Set(_meta?.nbaB2B || []);

    const allNBA = [...nba.east, ...nba.west];
    const allNHL = [...nhl.east, ...nhl.west];

    // Fetch real remaining schedules in parallel
    console.log('[montecarlo] Fetching remaining schedules...');
    const [nbaRemaining, nhlRemaining] = await Promise.all([
      fetchNBARemainingSchedule(),
      fetchNHLRemainingSchedule(),
    ]);
    console.log(`[montecarlo] NBA: ${nbaRemaining.length} games, NHL: ${nhlRemaining.length} games remaining`);

    // Run simulations
    console.log('[montecarlo] Running NBA simulation (10,000 runs)...');
    const nbaOdds = runNBAMonteCarlo(nba.east, nba.west, nbaRemaining, h2h, b2bSet, 10000);

    console.log('[montecarlo] Running NHL simulation (10,000 runs)...');
    const nhlOdds = runNHLMonteCarlo(nhl.east, nhl.west, nhlRemaining, nhlB2B, 10000);

    // Compute today's win probabilities using the model
    const nhlB2B   = computeNHLBackToBack(nhlRemaining);
    const nbaToday = computeNBATodayWinProbs(nba.today, allNBA, h2h, b2bSet);
    const nhlToday = computeNHLTodayWinProbs(nhl.today, allNHL, nhlB2B);

    // Store odds
    const oddsPayload = {
      computedAt: new Date().toISOString(),
      nbaOdds,
      nhlOdds,
    };

    // Update live_data with model-computed win probs for today
    data.nba.today = nbaToday;
    data.nhl.today = nhlToday;

    await Promise.all([
      kv.set('mc_odds', JSON.stringify(oddsPayload), { ex: 86400 }), // 24hr TTL
      kv.set('live_data', JSON.stringify(data), { ex: 3600 }),
    ]);

    console.log('[montecarlo] Done.');
    res.status(200).json({ ok: true, computedAt: oddsPayload.computedAt, teams: Object.keys(nbaOdds).length });

  } catch (err) {
    console.error('[montecarlo] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
