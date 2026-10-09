import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

// Scoring (from the spreadsheet Rules sheet)
const S = { played: 1, goals: 5, assists: 3, cs: 4, ps: 5, pm: -2, yc: -1, rc: -3, og: -2, win: 2, motm: 3 };
const STAT_KEYS = Object.keys(S);

// Hard-coded starting players (spreadsheet "Players" sheet). Copied into every new league; owner can add more.
const RAW = [["Neblo","FWD",[8.6,9,7,7,7]],["Reda","FWD",[8.7,10,9,7,9]],["Bahr","MID",[9.1,10,10,9,9]],["Omar Hamza","FWD",[8.6,10,8,6,7]],["Farghal","MID",[7,6,5,6.5,5]],["El7ares","GK",[9,6,7,8,4]],["Eyad","GK",[9,8,7,5,8]],["Abdelhameed","MID",[8.6,10,8,6,9]],["Khedr","DEF",[6.8,5,4,3,5]],["Belal","DEF",[5.1,4.5,4,3,3]],["Amgad","DEF",[5.9,5,3,3,5]],["Attay","DEF",[8.9,6.5,6,6.5,6]],["Khales","MID",[7,6,6,6,6]],["Awad","MID",[7.3,7,6,6,6]],["3esmat","MID",[8,8,6,7,7]],["Abasy","GK",[8,6,5,7,3]]];
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const AV = RAW.map(r => +mean(r[2]).toFixed(2)), MIN = Math.min(...AV), MAX = Math.max(...AV);
const priceOf = avg => Math.round(Math.min(15, Math.max(5, 5 + (avg - MIN) / (MAX - MIN) * 10)) * 10) / 10;

class E extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

let ready;
const ensure = () => ready ??= sql.transaction([
  sql`create table if not exists leagues(id serial primary key, code text unique not null, name text not null,
    budget real not null default 50, cap_mult int not null default 2, penalty int not null default 4,
    free_tr int not null default 1, round int not null default 1, open boolean not null default true)`,
  sql`create table if not exists members(id serial primary key, league_id int not null references leagues(id) on delete cascade,
    name text not null, pin text not null, token text unique not null, owner boolean not null default false,
    unique(league_id, name))`,
  sql`create table if not exists players(id serial primary key, league_id int not null references leagues(id) on delete cascade,
    name text not null, pos text not null check (pos in ('GK','DEF','MID','FWD')), ratings text not null default '',
    avg real not null, price real not null, active boolean not null default true, unique(league_id, name))`,
  sql`create table if not exists squads(member_id int not null references members(id) on delete cascade, round int not null,
    gk int not null, def int not null, m1 int not null, m2 int not null, fwd int not null, cap int not null,
    primary key(member_id, round))`,
  sql`create table if not exists stats(id serial primary key, league_id int not null references leagues(id) on delete cascade,
    round int not null, player_id int not null references players(id) on delete cascade,
    played int not null default 1, goals int not null default 0, assists int not null default 0, cs int not null default 0,
    ps int not null default 0, pm int not null default 0, yc int not null default 0, rc int not null default 0,
    og int not null default 0, win int not null default 0, motm int not null default 0, unique(round, player_id))`,
]).catch(e => { ready = null; throw e; });

const hash = (pin, salt = crypto.randomBytes(8).toString('hex')) => salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
const checkPin = (pin, stored) => { const [salt, h] = stored.split(':'); const x = hash(pin, salt).split(':')[1]; return crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)); };
const clean = (s, max = 40) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const needPin = p => { p = String(p ?? ''); if (!/^\d{4,8}$/.test(p)) throw new E('PIN must be 4 to 8 digits'); return p; };
const newCode = () => Array.from(crypto.randomBytes(6), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const int = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(+v) || 0));

async function auth(b, owner = false) {
  const [m] = b.token ? await sql`select * from members where token=${String(b.token)}` : [];
  if (!m) throw new E('Please sign in again', 401);
  if (owner && !m.owner) throw new E('Only the league owner can do that', 403);
  const [L] = await sql`select * from leagues where id=${m.league_id}`;
  return { m, L };
}

const playerRows = (id) => sql`select id,name,pos,ratings,avg,price,active from players where league_id=${id} order by pos, name`;

const A = {
  async createLeague(b) {
    const name = clean(b.leagueName, 50), me = clean(b.name), pin = needPin(b.pin);
    if (!name || !me) throw new E('Enter a league name and your name');
    const token = crypto.randomBytes(24).toString('hex');
    let L;
    for (let i = 0; i < 5 && !L; i++) {
      try { [L] = await sql`insert into leagues(code,name) values(${newCode()},${name}) returning id, code`; } catch (e) { if (i === 4) throw e; }
    }
    try {
      await sql.transaction([
        sql`insert into members(league_id,name,pin,token,owner) values(${L.id},${me},${hash(pin)},${token},true)`,
        sql`insert into players(league_id,name,pos,ratings,avg,price)
            select ${L.id}, n, p, r, a, pr from unnest(${RAW.map(r => r[0])}::text[], ${RAW.map(r => r[1])}::text[],
            ${RAW.map(r => r[2].join(','))}::text[], ${AV}::real[], ${AV.map(priceOf)}::real[]) as t(n,p,r,a,pr)`,
      ]);
    } catch (e) { await sql`delete from leagues where id=${L.id}`; throw e; }
    return { token, code: L.code };
  },

  async join(b) {
    const code = clean(b.code, 10).toUpperCase(), name = clean(b.name), pin = needPin(b.pin);
    const [L] = await sql`select id, code from leagues where code=${code}`;
    if (!L) throw new E('League code not found');
    if (!name) throw new E('Enter your name');
    const [ex] = await sql`select * from members where league_id=${L.id} and lower(name)=lower(${name})`;
    if (ex) { // same name = sign in on another device
      if (!checkPin(pin, ex.pin)) throw new E('That name is taken. Wrong PIN?');
      return { token: ex.token, code: L.code };
    }
    const token = crypto.randomBytes(24).toString('hex');
    await sql`insert into members(league_id,name,pin,token) values(${L.id},${name},${hash(pin)},${token})`;
    return { token, code: L.code };
  },

  async state(b) {
    const { m, L } = await auth(b);
    const [players, members, squads, stats] = await Promise.all([
      playerRows(L.id),
      sql`select id,name,owner from members where league_id=${L.id} order by id`,
      sql`select s.* from squads s join members m on m.id=s.member_id where m.league_id=${L.id}`,
      sql`select * from stats where league_id=${L.id} order by round, id`,
    ]);
    const pos = Object.fromEntries(players.map(p => [p.id, p.pos]));
    const ppts = {};
    const pts = e => { const g = pos[e.player_id] === 'GK' || pos[e.player_id] === 'DEF'; return STAT_KEYS.reduce((t, k) => t + (k === 'cs' && !g ? 0 : e[k] * S[k]), 0); };
    stats.forEach(e => { e.pts = pts(e); ppts[e.round + ':' + e.player_id] = e.pts; });
    const ids = q => [q.gk, q.def, q.m1, q.m2, q.fwd];
    const sq = {}; squads.forEach(q => sq[q.member_id + ':' + q.round] = q);
    const name = Object.fromEntries(players.map(p => [p.id, p.name]));
    const standings = members.map(mm => {
      const rounds = {};
      for (let r = 1; r <= L.round; r++) {
        const q = sq[mm.id + ':' + r], prev = sq[mm.id + ':' + (r - 1)];
        if (!q) { rounds[r] = { pts: 0, cap: 0, pen: 0 }; continue; }
        const sp = ids(q).reduce((a, i) => a + (ppts[r + ':' + i] || 0), 0);
        const changed = prev ? ids(q).filter(i => !ids(prev).includes(i)).length : 0;
        rounds[r] = { pts: sp, cap: (L.cap_mult - 1) * (ppts[r + ':' + q.cap] || 0), pen: Math.max(0, changed - L.free_tr) * L.penalty };
      }
      const cur = sq[mm.id + ':' + L.round];
      const show = cur && (mm.id === m.id || !L.open);
      return { id: mm.id, name: mm.name, rounds, joined: !!cur,
        picks: show ? ids(cur).map(i => name[i]).join(', ') + ' · C: ' + name[cur.cap] : (cur ? 'Hidden until squads lock' : '') };
    });
    const mine = sq[m.id + ':' + L.round] || null, prev = sq[m.id + ':' + (L.round - 1)] || null;
    const pick = q => q && { gk: q.gk, def: q.def, m1: q.m1, m2: q.m2, fwd: q.fwd, cap: q.cap };
    return { me: { id: m.id, name: m.name, owner: m.owner },
      league: { name: L.name, code: L.code, budget: L.budget, capMult: L.cap_mult, penalty: L.penalty, freeTr: L.free_tr, round: L.round, open: L.open },
      players, standings, stats, mine: pick(mine), prev: pick(prev), scoring: S };
  },

  async saveSquad(b) {
    const { m, L } = await auth(b);
    if (!L.open) throw new E('Squads are locked for this round');
    const q = Object.fromEntries(['gk', 'def', 'm1', 'm2', 'fwd', 'cap'].map(k => [k, +b[k]]));
    const ps = await playerRows(L.id), by = Object.fromEntries(ps.map(p => [p.id, p]));
    const want = { gk: 'GK', def: 'DEF', m1: 'MID', m2: 'MID', fwd: 'FWD' };
    for (const k in want) if (!by[q[k]] || !by[q[k]].active || by[q[k]].pos !== want[k]) throw new E('Invalid pick for ' + k.toUpperCase());
    const ids = [q.gk, q.def, q.m1, q.m2, q.fwd];
    if (q.m1 === q.m2) throw new E('Pick two different midfielders');
    if (!ids.includes(q.cap)) throw new E('Captain must be in your squad');
    const cost = Math.round(ids.reduce((a, i) => a + by[i].price, 0) * 10) / 10;
    if (cost > L.budget) throw new E(`Over budget (${cost} / ${L.budget})`);
    await sql`insert into squads(member_id,round,gk,def,m1,m2,fwd,cap) values(${m.id},${L.round},${q.gk},${q.def},${q.m1},${q.m2},${q.fwd},${q.cap})
      on conflict (member_id,round) do update set gk=excluded.gk, def=excluded.def, m1=excluded.m1, m2=excluded.m2, fwd=excluded.fwd, cap=excluded.cap`;
    return { ok: true };
  },

  async setOpen(b) { const { L } = await auth(b, true); await sql`update leagues set open=${!!b.open} where id=${L.id}`; return { ok: true }; },

  async nextRound(b) { // copies everyone's squad forward, reopens for transfers
    const { L } = await auth(b, true);
    await sql.transaction([
      sql`insert into squads(member_id,round,gk,def,m1,m2,fwd,cap)
          select s.member_id, s.round+1, s.gk, s.def, s.m1, s.m2, s.fwd, s.cap from squads s join members m on m.id=s.member_id
          where m.league_id=${L.id} and s.round=${L.round} on conflict do nothing`,
      sql`update leagues set round=round+1, open=true where id=${L.id} and round=${L.round}`,
    ]);
    return { ok: true };
  },

  async addPlayer(b) {
    const { L } = await auth(b, true);
    const name = clean(b.name), pos = String(b.pos);
    const rs = String(b.ratings ?? '').split(/[,\s]+/).filter(Boolean).map(Number);
    if (!name || !['GK', 'DEF', 'MID', 'FWD'].includes(pos)) throw new E('Enter a name and position');
    if (!rs.length || rs.some(x => !(x >= 0 && x <= 10))) throw new E('Ratings: numbers 0-10 separated by commas');
    const avg = +mean(rs).toFixed(2);
    const price = b.price !== '' && b.price != null ? Math.round(+b.price * 10) / 10 : priceOf(avg);
    if (!(price > 0 && price <= 50)) throw new E('Invalid price');
    try { await sql`insert into players(league_id,name,pos,ratings,avg,price) values(${L.id},${name},${pos},${rs.join(',')},${avg},${price})`; }
    catch (e) { if (/unique/i.test(e.message)) throw new E('A player with that name already exists'); throw e; }
    return { ok: true };
  },

  async editPlayer(b) {
    const { L } = await auth(b, true);
    const price = Math.round(+b.price * 10) / 10;
    if (!(price > 0 && price <= 50)) throw new E('Invalid price');
    await sql`update players set price=${price}, active=${b.active !== false} where id=${+b.id} and league_id=${L.id}`;
    return { ok: true };
  },

  async addStat(b) {
    const { L } = await auth(b, true);
    const round = int(b.round, 1, L.round), [p] = await sql`select id from players where id=${+b.player} and league_id=${L.id}`;
    if (!p) throw new E('Choose a player');
    const v = {}; STAT_KEYS.forEach(k => v[k] = ['played', 'cs', 'win', 'motm'].includes(k) ? int(b[k], 0, 1) : int(b[k], 0, 20));
    await sql`insert into stats(league_id,round,player_id,played,goals,assists,cs,ps,pm,yc,rc,og,win,motm)
      values(${L.id},${round},${p.id},${v.played},${v.goals},${v.assists},${v.cs},${v.ps},${v.pm},${v.yc},${v.rc},${v.og},${v.win},${v.motm})
      on conflict (round,player_id) do update set played=excluded.played, goals=excluded.goals, assists=excluded.assists, cs=excluded.cs,
      ps=excluded.ps, pm=excluded.pm, yc=excluded.yc, rc=excluded.rc, og=excluded.og, win=excluded.win, motm=excluded.motm`;
    return { ok: true };
  },

  async deleteStat(b) { const { L } = await auth(b, true); await sql`delete from stats where id=${+b.id} and league_id=${L.id}`; return { ok: true }; },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    await ensure();
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const fn = Object.hasOwn(A, b.action) && A[b.action];
    if (!fn) throw new E('Unknown action');
    res.status(200).json(await fn(b));
  } catch (e) {
    if (!(e instanceof E)) console.error(e);
    res.status(e instanceof E ? e.status : 500).json({ error: e instanceof E ? e.message : 'Server error' });
  }
}
