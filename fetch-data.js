// fetch-data.js
// Run this on your Mac: node fetch-data.js
// It fetches live NBA + NHL data and saves it as data.json
// Then you commit data.json to GitHub and Vercel serves it

import fetch from 'node-fetch';
import fs from 'fs';

const NBA_HEADERS = {
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

const BDL_KEY = 'cf0cd330-270e-4946-8088-3818a785f31b';
const BDL_HEADERS = { 'Authorization': BDL_KEY };

async function fetchNBAStandings() {
  console.log('Fetching NBA standings from ESPN...');
  const res  = await fetch('https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=2026');
  const data = await res.json();

  function parseEntries(entries) {
    return (entries || []).map(e => {
      const abbr       = e.team.abbreviation;
      const getStat    = n => e.stats.find(s => s.name === n)?.value ?? 0;
      const getStatStr = n => e.stats.find(s => s.name === n)?.displayValue ?? '';
      const w          = getStat('wins');
      const l          = getStat('losses');
      const diff       = getStat('differential');
      const l10str     = getStatStr('Last Ten Games') || '0-0';
      const l10w       = parseInt(l10str.split('-')[0]) || 0;
      const streak     = getStatStr('streak');
      const ci         = getStatStr('clincher').toLowerCase();
      const clinched   = ci.includes('x') ? 'auto' : ci.includes('p') ? 'pi' : false;
      const COLORS = {
        ATL:'#E03A3E',BOS:'#007A33',BKN:'#444444',CHA:'#00788C',CHI:'#CE1141',
        CLE:'#860038',DAL:'#0053BC',DEN:'#FEC524',DET:'#C8102E',GSW:'#1D428A',
        HOU:'#CE1141',IND:'#FDBB30',LAC:'#C8102E',LAL:'#552583',MEM:'#5D76A9',
        MIA:'#98002E',MIL:'#00471B',MIN:'#78BE20',NOP:'#B4975A',NYK:'#006BB6',
        OKC:'#007AC1',ORL:'#0077C0',PHI:'#006BB6',PHX:'#E56020',POR:'#E03A3E',
        SAC:'#5A2D81',SAS:'#C4CED4',TOR:'#CE1141',UTA:'#F9A01B',WAS:'#4A90D9',
      };
      return [
        e.team.displayName, abbr, w, l, 82-w-l,
        diff, l10w, streak,
        COLORS[abbr]||'#888', false, clinched,
        l10str,
        getStatStr('Home') || '0-0',
        getStatStr('Road') || '0-0',
        diff // index 14 = also diff (no L15)
      ];
    });
  }

  const eastConf = data.children?.find(c => c.name?.includes('East'));
  const westConf = data.children?.find(c => c.name?.includes('West'));
  const east = parseEntries(eastConf?.standings?.entries || data.children?.[0]?.standings?.entries).sort((a,b) => b[2]-a[2] || a[3]-b[3]);
  const west = parseEntries(westConf?.standings?.entries || data.children?.[1]?.standings?.entries).sort((a,b) => b[2]-a[2] || a[3]-b[3]);
  return { east, west };
}

async function fetchNBAGames() {
  console.log('Fetching NBA H2H + B2B from BallDontLie...');
  const h2h = {};
  let cursor = null;
  const playedYesterday = new Set();
  const playingToday    = new Set();
  const today     = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];

  let hasMore = true;
  let page = 0;
  while (hasMore) {
    page++;
    const url = `https://api.balldontlie.io/nba/v1/games?seasons[]=2025&per_page=100&postseason=false${cursor?'&cursor='+cursor:''}`;
    const res  = await fetch(url, { headers: BDL_HEADERS });
    const data = await res.json();
    if (!data.data) { console.log('BDL error:', JSON.stringify(data)); break; }
    console.log(`  Page ${page}: ${data.data.length} games`);

    for (const g of data.data) {
      const home  = g.home_team.abbreviation;
      const away  = g.visitor_team.abbreviation;
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

    cursor  = data.meta?.next_cursor;
    hasMore = !!cursor;
  }

  const b2b = [...playingToday].filter(a => playedYesterday.has(a));
  console.log(`  H2H built. B2B teams tonight: ${b2b.join(', ') || 'none'}`);
  console.log(`  ORL vs MIA: ${JSON.stringify(h2h['ORL']?.['MIA'])}`);
  return { h2h, b2b };
}

async function fetchNBAScoreboard() {
  console.log('Fetching NBA scoreboard...');
  const res  = await fetch('https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json');
  const data = await res.json();
  return (data.scoreboard?.games||[]).map(g => {
    const hw = g.homeTeam.teamWinProbability != null ? Math.round(g.homeTeam.teamWinProbability * 100) : 50;
    return {
      h: g.homeTeam.teamTricode, a: g.awayTeam.teamTricode,
      hw, aw: 100-hw,
      t: g.gameEt ? new Date(g.gameEt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}) : g.gameStatusText
    };
  });
}

async function fetchNBASchedule() {
  console.log('Fetching NBA remaining schedule...');
  const res  = await fetch('https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json');
  const data = await res.json();
  const today = new Date().toISOString().split('T')[0];
  const games = [];
  for (const d of data.leagueSchedule.gameDates) {
    if (d.gameDate <= today) continue;
    for (const g of d.games) {
      const home = g.homeTeam?.teamTricode, away = g.awayTeam?.teamTricode;
      if (home && away) games.push({ home, away, date: d.gameDate });
    }
  }
  console.log(`  ${games.length} games remaining`);
  return games;
}

async function fetchNHLData() {
  console.log('Fetching NHL standings...');
  const NHL_COLORS = {
    ANA:'#FC4C02',BUF:'#00B2A9',CAR:'#CC0000',CBJ:'#CE1126',CGY:'#C8102E',
    COL:'#6F263D',DAL:'#006847',EDM:'#FF4C00',FLA:'#C8102E',LAK:'#A2AAAD',
    MIN:'#154734',MTL:'#AF1E2D',NJD:'#CE1126',NSH:'#FFB81C',NYI:'#00539B',
    NYR:'#0038A8',OTT:'#C52032',PHI:'#F74902',PIT:'#FCB514',SEA:'#99D9D9',
    SJS:'#006D75',STL:'#0038A8',TBL:'#0099CC',TOR:'#003E7E',VAN:'#008852',
    VGK:'#B4975A',WPG:'#55B7E4',WSH:'#C8102E',UTA:'#71AFE5',
  };

  const [standRes, scoreRes] = await Promise.all([
    fetch('https://api-web.nhle.com/v1/standings/now'),
    fetch('https://api-web.nhle.com/v1/scoreboard/now'),
  ]);
  const [standData, scoreData] = await Promise.all([standRes.json(), scoreRes.json()]);

  const makeTeam = (t, i) => {
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
      Math.round(gdS*100)/100, Math.round(gdL10*100)/100];
  };

  const east = standData.standings.filter(t=>t.conferenceName==='Eastern').sort((a,b)=>b.points-a.points).map(makeTeam);
  const west = standData.standings.filter(t=>t.conferenceName==='Western').sort((a,b)=>b.points-a.points).map(makeTeam);

  const todayGames = (scoreData.gamesByDate?.[0]?.games||[]).map(g => ({
    h:g.homeTeam?.abbrev||'', a:g.awayTeam?.abbrev||'', hw:50, aw:50,
    t:g.startTimeUTC?new Date(g.startTimeUTC).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}):''
  }));

  // Remaining schedule
  const end = '2026-04-17';
  const todayStr = new Date().toISOString().split('T')[0];
  const yesterdayStr = new Date(Date.now()-86400000).toISOString().split('T')[0];
  const nhlRemaining = [];
  const playedYest = new Set(), playingToday = new Set();
  let url = 'https://api-web.nhle.com/v1/schedule/now';
  while (url) {
    const r = await fetch(url);
    const d = await r.json();
    for (const week of (d.gameWeek||[])) {
      if (week.date > end) break;
      for (const g of (week.games||[])) {
        const ha = g.homeTeam?.abbrev, aa = g.awayTeam?.abbrev;
        if (week.date === yesterdayStr) { playedYest.add(ha); playedYest.add(aa); }
        if (week.date === todayStr)     { playingToday.add(ha); playingToday.add(aa); }
        if (g.gameType===2&&g.gameState==='FUT') nhlRemaining.push({home:ha,away:aa,date:week.date});
      }
    }
    const next = d.nextStartDate;
    url = next && next <= end ? `https://api-web.nhle.com/v1/schedule/${next}` : null;
  }
  const nhlB2B = [...playingToday].filter(a => playedYest.has(a));
  console.log(`  NHL: ${east.length + west.length} teams, ${nhlRemaining.length} games remaining, B2B: ${nhlB2B.join(', ')||'none'}`);

  return { east, west, todayGames, nhlRemaining, nhlB2B };
}

async function main() {
  console.log('\n=== ON THE BUBBLE DATA FETCH ===');
  console.log('Time:', new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }), 'ET\n');

  const [nbaStand, nbaGames, nbaToday, nbaSchedule, nhlData] = await Promise.all([
    fetchNBAStandings(),
    fetchNBAGames(),
    fetchNBAScoreboard(),
    fetchNBASchedule(),
    fetchNHLData(),
  ]);

  const payload = {
    updatedAt: new Date().toISOString(),
    nba: {
      east:      nbaStand.east,
      west:      nbaStand.west,
      today:     nbaToday,
      remaining: nbaSchedule,
      h2h:       nbaGames.h2h,
      b2b:       nbaGames.b2b,
    },
    nhl: {
      east:      nhlData.east,
      west:      nhlData.west,
      today:     nhlData.todayGames,
      remaining: nhlData.nhlRemaining,
      b2b:       nhlData.nhlB2B,
    }
  };

  fs.writeFileSync('data.json', JSON.stringify(payload));
  console.log('\n✅ data.json written successfully!');
  console.log(`   NBA East: ${nbaStand.east.length} teams`);
  console.log(`   NBA West: ${nbaStand.west.length} teams`);
  console.log(`   NHL East: ${nhlData.east.length} teams`);
  console.log(`   NHL West: ${nhlData.west.length} teams`);
  console.log(`   ORL vs MIA H2H: ${JSON.stringify(nbaGames.h2h['ORL']?.['MIA'])}`);
  console.log('\nNow commit and push data.json to GitHub!');
}

main().catch(console.error);
