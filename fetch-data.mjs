// fetch-data.mjs — On The Bubble data fetcher
// Runs on GitHub Actions daily to update data.json

import fs from 'fs';

const BDL_KEY = 'cf0cd330-270e-4946-8088-3818a785f31b';

const NBA_COLORS = {
  ATL:'#E03A3E',BOS:'#007A33',BKN:'#444444',CHA:'#00788C',CHI:'#CE1141',
  CLE:'#860038',DAL:'#0053BC',DEN:'#FEC524',DET:'#C8102E',GSW:'#1D428A',
  HOU:'#CE1141',IND:'#FDBB30',LAC:'#C8102E',LAL:'#552583',MEM:'#5D76A9',
  MIA:'#98002E',MIL:'#00471B',MIN:'#78BE20',NOP:'#B4975A',NYK:'#006BB6',
  OKC:'#007AC1',ORL:'#0077C0',PHI:'#006BB6',PHX:'#E56020',POR:'#E03A3E',
  SAC:'#5A2D81',SAS:'#C4CED4',TOR:'#CE1141',UTA:'#F9A01B',WAS:'#4A90D9',
};

const NHL_COLORS = {
  ANA:'#FC4C02',BUF:'#00B2A9',CAR:'#CC0000',CBJ:'#CE1126',CGY:'#C8102E',
  COL:'#6F263D',DAL:'#006847',EDM:'#FF4C00',FLA:'#C8102E',LAK:'#A2AAAD',
  MIN:'#154734',MTL:'#AF1E2D',NJD:'#CE1126',NSH:'#FFB81C',NYI:'#00539B',
  NYR:'#0038A8',OTT:'#C52032',PHI:'#F74902',PIT:'#FCB514',SEA:'#99D9D9',
  SJS:'#006D75',STL:'#0038A8',TBL:'#0099CC',TOR:'#003E7E',VAN:'#008852',
  VGK:'#B4975A',WPG:'#55B7E4',WSH:'#C8102E',UTA:'#71AFE5',
};

async function main() {
  console.log('=== ON THE BUBBLE DATA FETCH ===');
  console.log('Time:', new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }), 'ET\n');

  // 1. NBA Standings from ESPN
  console.log('Fetching NBA standings...');
  const espnRes = await fetch('https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=2026');
  const espnData = await espnRes.json();

  // ESPN abbreviation corrections — ESPN uses different codes than NBA CDN/BDL
  const ESPN_FIX = {
    // ESPN short codes → standard
    'NY':'NYK', 'SA':'SAS', 'GS':'GSW', 'NO':'NOP', 'UTAH':'UTA',
    'WSH':'WAS', 'PHO':'PHX',
    // BDL codes → standard  
    'NOH':'NOP', 'NOK':'NOP', 'SEA':'OKC',
  };

  function fixAbbr(a) { return ESPN_FIX[a] || a; }

  function parseESPN(entries) {
    return (entries || []).map(e => {
      const getStat    = n => e.stats.find(s => s.name === n)?.value ?? 0;
      const getStatStr = n => e.stats.find(s => s.name === n)?.displayValue ?? '';
      const abbr = fixAbbr(e.team.abbreviation);
      const w    = getStat('wins');
      const l    = getStat('losses');
      const diff = getStat('differential');
      const l10str = getStatStr('Last Ten Games') || '0-0';
      const l10w   = parseInt(l10str.split('-')[0]) || 0;
      const streak = getStatStr('streak');
      const ci     = getStatStr('clincher').toLowerCase();
      const clinched = ci.includes('x') ? 'auto' : ci.includes('p') ? 'pi' : false;
      return [e.team.displayName, abbr, w, l, 82-w-l, diff, l10w, streak,
        NBA_COLORS[abbr]||'#888', false, clinched,
        l10str, getStatStr('Home')||'0-0', getStatStr('Road')||'0-0', diff];
    });
  }

  const eastEntries = espnData.children?.find(c => c.name?.includes('East'))?.standings?.entries || espnData.children?.[0]?.standings?.entries || [];
  const westEntries = espnData.children?.find(c => c.name?.includes('West'))?.standings?.entries || espnData.children?.[1]?.standings?.entries || [];
  const nbaEast = parseESPN(eastEntries).sort((a,b) => b[2]-a[2] || a[3]-b[3]);
  const nbaWest = parseESPN(westEntries).sort((a,b) => b[2]-a[2] || a[3]-b[3]);
  console.log(`  East: ${nbaEast.length} teams, West: ${nbaWest.length} teams`);

  // 2. BallDontLie — H2H + B2B
  console.log('Fetching NBA games from BallDontLie...');
  const h2h = {};
  const playedYesterday = new Set();
  const playingToday = new Set();
  const today     = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    const url = `https://api.balldontlie.io/nba/v1/games?seasons[]=2025&per_page=100&postseason=false${cursor?'&cursor='+cursor:''}`;
    
    let data;
    let attempts = 0;
    while (attempts < 5) {
      attempts++;
      const res  = await fetch(url, { headers: { Authorization: BDL_KEY } });
      const text = await res.text();
      try { 
        data = JSON.parse(text);
        if (data.data) break; // success
        // Got JSON but no data array — could be rate limit in JSON form
        console.log(`  Attempt ${attempts} failed:`, JSON.stringify(data).slice(0,100));
      } catch(e) {
        console.log(`  Attempt ${attempts} rate limited, waiting 60s...`);
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }
      console.log(`  Attempt ${attempts} got bad response, waiting 60s...`);
      await new Promise(r => setTimeout(r, 60000));
    }
    
    if (!data?.data) { console.log('BDL failed after 5 attempts, skipping H2H'); break; }
    console.log(`  Page ${page}: ${data.data.length} games`);

    for (const g of data.data) {
      const home  = fixAbbr(g.home_team.abbreviation);
      const away  = fixAbbr(g.visitor_team.abbreviation);
      const gDate = g.date?.split('T')[0];
      if (gDate === yesterday) { playedYesterday.add(home); playedYesterday.add(away); }
      if (gDate === today)     { playingToday.add(home);    playingToday.add(away); }
      if (g.status !== 'Final') continue;
      const homeWon = g.home_team_score > g.visitor_team_score;
      if (!h2h[home]) h2h[home] = {};
      if (!h2h[away]) h2h[away] = {};
      if (!h2h[home][away]) h2h[home][away] = { wins:0, games:0 };
      if (!h2h[away][home]) h2h[away][home] = { wins:0, games:0 };
      h2h[home][away].games++; h2h[away][home].games++;
      if (homeWon) h2h[home][away].wins++; else h2h[away][home].wins++;
    }

    cursor = data.meta?.next_cursor;
    if (!cursor) break;
    await new Promise(r => setTimeout(r, 5000));
  }

  const b2b = [...playingToday].filter(a => playedYesterday.has(a));
  console.log(`  H2H built. B2B tonight: ${b2b.join(', ')||'none'}`);
  console.log(`  ORL vs MIA: ${JSON.stringify(h2h['ORL']?.['MIA'])}`);

  // 3. NBA Scoreboard + Schedule
  console.log('Fetching NBA scoreboard + schedule...');
  const [scoreRes, schedRes] = await Promise.all([
    fetch('https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json'),
    fetch('https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json'),
  ]);
  const [scoreData, schedData] = await Promise.all([scoreRes.json(), schedRes.json()]);

  const nbaToday = [];
  for (const d of schedData.leagueSchedule.gameDates) {
    const parts = d.gameDate.split(' ')[0].split('/');
    const gameDay = `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
    if (gameDay !== today) continue;
    for (const g of d.games) {
      const home = g.homeTeam?.teamTricode, away = g.awayTeam?.teamTricode;
      let time = '';
      // Try gameDateTimeEst first, then gameEt, then gameTimeEst
      const rawTime = g.gameDateTimeEst || g.gameEt || g.gameTimeEst || '';
      if (rawTime) {
        try {
          time = new Date(rawTime).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'});
          if (time === 'Invalid Date') time = '';
        } catch(e) { time = ''; }
      }
      if (home && away) nbaToday.push({ h: home, a: away, hw: 50, aw: 50, t: '' });
    }
    break;
  }

  const nbaRemaining = [];
  for (const d of schedData.leagueSchedule.gameDates) {
    // NBA CDN uses MM/DD/YYYY format — convert to YYYY-MM-DD for comparison
    const parts = d.gameDate.split(' ')[0].split('/');
    const gameDay = `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
    if (gameDay < today) continue;
    for (const g of d.games) {
      const home = g.homeTeam?.teamTricode, away = g.awayTeam?.teamTricode;
      if (home && away) nbaRemaining.push({ home, away, date: gameDay });
    }
  }
  console.log(`  ${nbaToday.length} games today, ${nbaRemaining.length} remaining`);

  // NBA yesterday results
  const nbaYesterday = [];
  try {
    const yRes = await fetch(`https://api.balldontlie.io/nba/v1/games?dates[]=${yesterday}&per_page=100`, { headers: { Authorization: BDL_KEY } });
    const yData = await yRes.json();
    for (const g of (yData.data||[])) {
      if (g.status !== 'Final') continue;
      const home = fixAbbr(g.home_team.abbreviation);
      const away = fixAbbr(g.visitor_team.abbreviation);
      const homeWon = g.home_team_score > g.visitor_team_score;
      nbaYesterday.push({ h: home, a: away, winner: homeWon ? home : away });
    }
    console.log(`  NBA yesterday: ${nbaYesterday.length} final games`);
  } catch(e) { console.log('  NBA yesterday fetch failed:', e.message); }

  // 4. NHL
  console.log('Fetching NHL data...');
  const [nhlStandRes, nhlScoreRes] = await Promise.all([
    fetch('https://api-web.nhle.com/v1/standings/now'),
    fetch('https://api-web.nhle.com/v1/scoreboard/now'),
  ]);
  const [nhlStandData, nhlScoreData] = await Promise.all([nhlStandRes.json(), nhlScoreRes.json()]);

  const makeNHLTeam = (t, i) => {
    const abbr     = t.teamAbbrev.default;
    const rem      = 82 - t.gamesPlayed;
    const ci       = t.clinchIndicator||'';
    const clinched = ci==='x'?'div':ci==='y'?'playoff':false;
    const streak   = t.streakCode&&t.streakCount?`${t.streakCode}${t.streakCount}`:'';
    const l10str   = `${t.l10Wins}-${t.l10Losses}-${t.l10OtLosses}`;
    const gdS      = t.gamesPlayed>0?(t.goalFor-t.goalAgainst)/t.gamesPlayed:0;
    const gdL10    = t.l10GamesPlayed>0?(t.l10GoalsFor-t.l10GoalsAgainst)/t.l10GamesPlayed:gdS;
    return [t.teamName.default,abbr,t.points,t.wins,t.losses,t.otLosses,rem,streak,
      NHL_COLORS[abbr]||'#888',false,clinched,i+1,t.divisionSequence,t.divisionName,l10str,
      Math.round(gdS*100)/100,Math.round(gdL10*100)/100];
  };

  const nhlEast = nhlStandData.standings.filter(t=>t.conferenceName==='Eastern').sort((a,b)=>b.points-a.points).map(makeNHLTeam);
  const nhlWest = nhlStandData.standings.filter(t=>t.conferenceName==='Western').sort((a,b)=>b.points-a.points).map(makeNHLTeam);

  const nhlToday = (nhlScoreData.gamesByDate?.[0]?.games||[]).map(g => ({
    h:g.homeTeam?.abbrev||'', a:g.awayTeam?.abbrev||'', hw:50, aw:50,
    t:g.startTimeUTC?new Date(g.startTimeUTC).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}):''
  }));

  // NHL H2H from season results
  console.log('Fetching NHL H2H...');
  const nhlH2H = {};
  let nhlSchedUrl = 'https://api-web.nhle.com/v1/schedule/2025-10-01';
  const nhlEndDate = today;
  while (nhlSchedUrl) {
    try {
      const nr = await fetch(nhlSchedUrl);
      const nd = await nr.json();
      for (const week of (nd.gameWeek||[])) {
        if (week.date > nhlEndDate) { nhlSchedUrl = null; break; }
        for (const g of (week.games||[])) {
          if (g.gameType !== 2) continue;
          if (g.gameState !== 'OFF' && g.gameState !== 'FINAL') continue;
          const home = g.homeTeam?.abbrev;
          const away = g.awayTeam?.abbrev;
          const homeScore = g.homeTeam?.score;
          const awayScore = g.awayTeam?.score;
          if (!home || !away || homeScore == null || awayScore == null) continue;
          const homeWon = homeScore > awayScore;
          if (!nhlH2H[home]) nhlH2H[home] = {};
          if (!nhlH2H[away]) nhlH2H[away] = {};
          if (!nhlH2H[home][away]) nhlH2H[home][away] = { wins:0, games:0 };
          if (!nhlH2H[away][home]) nhlH2H[away][home] = { wins:0, games:0 };
          nhlH2H[home][away].games++; nhlH2H[away][home].games++;
          if (homeWon) nhlH2H[home][away].wins++; else nhlH2H[away][home].wins++;
        }
      }
      const next = nd.nextStartDate;
      nhlSchedUrl = next && next <= nhlEndDate ? `https://api-web.nhle.com/v1/schedule/${next}` : null;
    } catch(e) { nhlSchedUrl = null; }
  }
  console.log(`  NHL H2H built for ${Object.keys(nhlH2H).length} teams`);


  const nhlRemaining = [];
  const nhlPlayedYest = new Set(), nhlPlayingToday = new Set();
  const end = '2026-04-17';
  let nhlUrl = 'https://api-web.nhle.com/v1/schedule/now';
  while (nhlUrl) {
    const r = await fetch(nhlUrl);
    const d = await r.json();
    for (const week of (d.gameWeek||[])) {
      if (week.date > end) break;
      for (const g of (week.games||[])) {
        const ha = g.homeTeam?.abbrev, aa = g.awayTeam?.abbrev;
        if (week.date === yesterday) { nhlPlayedYest.add(ha); nhlPlayedYest.add(aa); }
        if (week.date === today)     { nhlPlayingToday.add(ha); nhlPlayingToday.add(aa); }
        if (g.gameType===2&&g.gameState==='FUT') nhlRemaining.push({home:ha,away:aa,date:week.date});
      }
    }
    const next = d.nextStartDate;
    nhlUrl = next && next <= end ? `https://api-web.nhle.com/v1/schedule/${next}` : null;
  }
  const nhlB2B = [...nhlPlayingToday].filter(a => nhlPlayedYest.has(a));
  console.log(`  NHL: ${nhlEast.length+nhlWest.length} teams, ${nhlRemaining.length} remaining`);

  // NHL yesterday results
  const nhlYesterday = [];
  try {
    const nyRes = await fetch(`https://api-web.nhle.com/v1/schedule/${yesterday}`);
    const nyData = await nyRes.json();
    for (const week of (nyData.gameWeek||[])) {
      if (week.date !== yesterday) continue;
      for (const g of (week.games||[])) {
        if (g.gameType !== 2) continue;
        if (g.gameState !== 'OFF' && g.gameState !== 'FINAL') continue;
        const home = g.homeTeam?.abbrev;
        const away = g.awayTeam?.abbrev;
        const homeScore = g.homeTeam?.score;
        const awayScore = g.awayTeam?.score;
        if (!home || !away || homeScore == null) continue;
        const winner = homeScore > awayScore ? home : away;
        nhlYesterday.push({ h: home, a: away, winner });
      }
    }
    console.log(`  NHL yesterday: ${nhlYesterday.length} final games`);
  } catch(e) { console.log('  NHL yesterday fetch failed:', e.message); }

  // 5. The-Odds-API — real moneylines for today's NBA and NHL games
  console.log('Fetching odds from The-Odds-API...');
  const ODDS_KEY = 'dd3a99c81f025a04c8d85ad021d7fe78';
  const oddsMap = {}; // key: "HOME-AWAY", value: {hw, aw}

  function moneylineToProb(ml) {
    return ml < 0 ? (-ml) / (-ml + 100) : 100 / (ml + 100);
  }
  function noVig(homeML, awayML) {
    const h = moneylineToProb(homeML);
    const a = moneylineToProb(awayML);
    const total = h + a;
    return { hw: Math.round(h/total*100), aw: Math.round(a/total*100) };
  }

  for (const sport of ['basketball_nba', 'icehockey_nhl']) {
    try {
      const res = await fetch(`https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=us&markets=h2h&oddsFormat=american`);
      const games = await res.json();
      for (const g of (games||[])) {
        const book = g.bookmakers?.[0];
        if (!book) continue;
        const market = book.markets?.find(m=>m.key==='h2h');
        if (!market) continue;
        const home = market.outcomes.find(o=>o.name===g.home_team);
        const away = market.outcomes.find(o=>o.name===g.away_team);
        if (!home||!away) continue;
        const probs = noVig(home.price, away.price);
        // Store by team names — we'll match to abbr in the frontend
        oddsMap[g.id] = { homeTeam: g.home_team, awayTeam: g.away_team, hw: probs.hw, aw: probs.aw };
      }
      console.log(`  ${sport}: ${games?.length||0} games with odds`);
    } catch(e) { console.log(`  Odds fetch failed for ${sport}:`, e.message); }
  }

  // Match odds to today's games by team name fuzzy match
  function applyOdds(todayGames, abbrToName) {
    return todayGames.map(g => {
      const homeName = abbrToName[g.h] || g.h;
      const awayName = abbrToName[g.a] || g.a;
      const match = Object.values(oddsMap).find(o =>
        o.homeTeam.includes(homeName.split(' ').slice(-1)[0]) ||
        homeName.includes(o.homeTeam.split(' ').slice(-1)[0])
      );
      if (match) return { ...g, hw: match.hw, aw: match.aw };
      return g;
    });
  }

  // Build abbr->lastName maps
  const nbaNames = {}; [...nbaEast,...nbaWest].forEach(t => nbaNames[t[1]] = t[0]);
  const nhlNames = {}; [...nhlEast,...nhlWest].forEach(t => nhlNames[t[1]] = t[0]);

  const nbaOddsToday = applyOdds(nbaToday, nbaNames);
  const nhlOddsToday = applyOdds(nhlToday, nhlNames);

  // 6. Write data.json
  const payload = {
    updatedAt: new Date().toISOString(),
    nba: { east: nbaEast, west: nbaWest, today: nbaOddsToday, remaining: nbaRemaining, h2h, b2b, yesterday: nbaYesterday },
    nhl: { east: nhlEast, west: nhlWest, today: nhlOddsToday, remaining: nhlRemaining, b2b: nhlB2B, h2h: nhlH2H, yesterday: nhlYesterday }
  };

  fs.writeFileSync('data.json', JSON.stringify(payload));
  console.log('\n✅ data.json written!');
  console.log(`ORL vs MIA H2H: ${JSON.stringify(h2h['ORL']?.['MIA'])}`);
}

main().catch(err => { console.error(err); process.exit(1); });
