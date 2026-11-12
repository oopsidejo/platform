-- v1.8: تحليل الزيارات (بدون بيانات شخصية) — آمن للتشغيل أكثر من مرة
create table if not exists site_events(id bigint generated always as identity primary key, site_id uuid not null references sites(id) on delete cascade,
  at timestamptz not null default now(), sid text not null, t text not null, path text, pid uuid, src text, camp text, dev text);
create index if not exists site_events_site_at on site_events(site_id, at desc);
alter table site_events enable row level security;
