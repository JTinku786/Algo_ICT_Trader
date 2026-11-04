require('@next/env').loadEnvConfig(process.cwd());
const {Client}=require('pg');const u=process.env.DATABASE_URL||process.env.POSTGRES_URL;
const c=u?new Client({connectionString:u,connectionTimeoutMillis:5000}):new Client({host:process.env.POSTGRES_HOST,port:process.env.POSTGRES_PORT||5432,database:process.env.POSTGRES_DATABASE,user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,connectionTimeoutMillis:5000});
(async()=>{try{await c.connect();console.log((await c.query("select current_database() db,count(*) n from historical_ict_orders_updated where strategy_id=$1",['IG_Goldhunter_ICT2022'])).rows)}finally{await c.end()}})().catch(e=>{console.log(e.message);process.exitCode=1});
