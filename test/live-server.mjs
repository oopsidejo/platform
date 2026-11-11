// خادم تجريبي محلي: Postgres (PGlite) + schema.sql + موظف أدمن + موقع، ثم يشغّل التطبيق كاملاً
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import fs from 'fs';
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
 create table auth.users(id uuid primary key, email text);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
await db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const uid = '11111111-1111-4111-8111-111111111111';
await db.exec(`insert into auth.users values('${uid}','waled.alsaber123@gmail.com'); insert into staff(user_id,name,role) values('${uid}','صابر','admin');
 insert into sites(slug,name,whatsapp,config) values('mahamiho','محاميحو','962796893403','{"company":"صابر","freeShip":{"on":true,"min":30},"proof":{"on":true,"min":2},"leads":true}');
 insert into site_countries select id,'jo' from sites; insert into site_currencies select id,'JOD' from sites;`);
// موظف محدود لاختبار الصلاحيات: ادخل بالتوكن test:22222222-2222-4222-8222-222222222222
const uid2 = '22222222-2222-4222-8222-222222222222';
await db.exec(`insert into auth.users values('${uid2}','staff@example.com'); insert into staff(user_id,name,role,site_ids,perms) select '${uid2}','موظفة','staff',array[id],'{"orders":true}' from sites limit 1;`);
const srv = new PGLiteSocketServer({ db, port: 55433, host: '127.0.0.1' }); await srv.start();
Object.assign(process.env, { NODE_ENV: 'test', AUTH_TEST_UID: uid, DATABASE_URL: 'postgresql://postgres@127.0.0.1:55433/postgres', DATABASE_SSL: 'false', DB_POOL: '1', RL_WRITE: process.env.RL_WRITE || '500', SUPABASE_URL: process.env.SUPABASE_URL || 'http://x', SUPABASE_ANON_KEY: 'anon' });
const { build } = await import('../src/server.js');
const app = build(); await app.listen({ port: 3999, host: '127.0.0.1' }); console.log('READY');
