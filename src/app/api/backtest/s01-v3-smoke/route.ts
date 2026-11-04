import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/db";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  try{
    const pool=getPostgresPool();
    const year=new URL(request.url).searchParams.get('year')??'ALL';
    if(year!=='ALL'&&!/^\d{4}$/.test(year))return NextResponse.json({success:false,error:'Invalid year'},{status:400});
    const from=year==='ALL'?'0001-01-01':`${year}-01-01`,to=year==='ALL'?'9999-12-31':`${year}-12-31`;
    const runs=await pool.query(`SELECT run_id,status,start_date::text,end_date::text,requested_end::text,universe,excluded,code_dirty,code_hash,spec_version FROM s01v3_runs WHERE published AND status='complete' AND start_date<=$2::date AND end_date>=$1::date ORDER BY start_date,end_date`,[from,to]);
    if(!runs.rows.length)return NextResponse.json({success:true,run:null});
    const universe=[...new Set<string>(runs.rows.flatMap(r=>r.universe))].sort();
    const excluded=Object.fromEntries(runs.rows.flatMap(r=>Object.entries(r.excluded??{})).filter(([symbol])=>!universe.includes(symbol)));
    const run={...runs.rows[0],run_id:runs.rows.map(r=>r.run_id).join(' · '),universe,excluded,start_date:runs.rows.map(r=>r.start_date).sort()[0],end_date:runs.rows.map(r=>r.end_date).sort().at(-1),requested_end:runs.rows.map(r=>r.requested_end).sort().at(-1),code_dirty:runs.rows.some(r=>r.code_dirty)};
    const args=[runs.rows.map(r=>r.run_id),from,to];
    const results=await Promise.all([
      pool.query(`WITH s AS (SELECT symbol,count(*)::int n_setups FROM s01v3_setups WHERE run_id=ANY($1::text[]) AND session_date BETWEEN $2::date AND $3::date GROUP BY symbol), o AS (SELECT symbol,count(*)::int n_orders FROM s01v3_orders WHERE run_id=ANY($1::text[]) AND coalesce((fill_ts AT TIME ZONE 'America/New_York')::date,run_date) BETWEEN $2::date AND $3::date GROUP BY symbol), t AS (SELECT o.symbol,count(*)::int n_outcomes FROM s01v3_outcomes t JOIN s01v3_orders o USING(run_id,setup_id) WHERE o.run_id=ANY($1::text[]) AND (o.fill_ts AT TIME ZONE 'America/New_York')::date BETWEEN $2::date AND $3::date GROUP BY o.symbol) SELECT p.symbol,coalesce(s.n_setups,0) n_setups,coalesce(o.n_orders,0) n_orders,coalesce(t.n_outcomes,0) n_outcomes,'complete' status FROM (SELECT DISTINCT symbol FROM s01v3_progress WHERE run_id=ANY($1::text[])) p LEFT JOIN s USING(symbol) LEFT JOIN o USING(symbol) LEFT JOIN t USING(symbol) ORDER BY p.symbol`,args),
      pool.query(`SELECT symbol,reason,count(*)::int AS n FROM s01v3_bias_sessions WHERE run_id=ANY($1::text[]) AND session_date BETWEEN $2::date AND $3::date GROUP BY symbol,reason ORDER BY symbol,n DESC`,args),
      pool.query(`SELECT symbol,state,reason,count(*)::int AS n FROM s01v3_setups WHERE run_id=ANY($1::text[]) AND session_date BETWEEN $2::date AND $3::date GROUP BY symbol,state,reason ORDER BY symbol,n DESC`,args),
      pool.query(`SELECT symbol,session_date::text,direction,reason,payload FROM s01v3_bias_sessions WHERE run_id=ANY($1::text[]) AND session_date BETWEEN $2::date AND $3::date ORDER BY session_date DESC,symbol LIMIT 500`,args),
      pool.query(`SELECT state,count(*)::int AS n FROM s01v3_orders WHERE run_id=ANY($1::text[]) AND coalesce((fill_ts AT TIME ZONE 'America/New_York')::date,run_date) BETWEEN $2::date AND $3::date GROUP BY state`,args),
      pool.query(`SELECT count(*)::int AS n FROM s01v3_orders o WHERE o.run_id=ANY($1::text[]) AND (o.fill_ts AT TIME ZONE 'America/New_York')::date BETWEEN $2::date AND $3::date AND o.state='FILLED' AND (SELECT count(*) FROM s01v3_outcomes t WHERE t.run_id=o.run_id AND t.setup_id=o.setup_id)<3`,args),
    ]);
    return NextResponse.json({success:true,run,progress:results[0].rows,bias_reasons:results[1].rows,setup_reasons:results[2].rows,decisions:results[3].rows,orders:results[4].rows,unresolved_fills:results[5].rows[0].n},{headers:{"Cache-Control":"no-store"}});
  }catch(error){return NextResponse.json({success:false,error:error instanceof Error?error.message:"Smoke results unavailable"},{status:500});}
}
