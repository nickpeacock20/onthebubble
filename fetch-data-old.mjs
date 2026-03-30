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

  const nbaToday = (scoreData.scoreboard?.games||[]).map(g => {
    const hw = g.homeTeam.teamWinProbability != null ? Math.round(g.homeTeam.teamWinProbability*100) : 50;
    return { h: g.homeTeam.teamTricode, a: g.awayTeam.teamTricode, hw, aw: 100-hw,
      t: g.gameEt ? new Date(g.gameEt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}) : g.gameStatusText };
  });

  const nbaRemaining = [];
  for (const d of schedData.leagueSchedule.gameDates) {
    if (d.gameDate < today) continue; // include today AND future games
    for (const g of d.games) {
      const home = g.homeTeam?.teamTricode, away = g.awayTeam?.teamTricode;
      if (home && away) nbaRemaining.push({ home, away, date: d.gameDate });
    }
  }
  console.log(`  ${nbaToday.length} games today, ${nbaRemaining.length} remaining`);

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

  // NHL remaining schedule
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

  // 5. Write data.json
  const payload = {
    updatedAt: new Date().toISOString(),
    nba: { east: nbaEast, west: nbaWest, today: nbaToday, remaining: nbaRemaining, h2h, b2b },
    nhl: { east: nhlEast, west: nhlWest, today: nhlToday, remaining: nhlRemaining, b2b: nhlB2B }
  };

  fs.writeFileSync('data.json', JSON.stringify(payload));
  console.log('\n✅ data.json written!');
  console.log(`ORL vs MIA H2H: ${JSON.stringify(h2h['ORL']?.['MIA'])}`);
}

main().catch(err => { console.error(err); process.exit(1); });
