-- v1.7: أكواد التحقق OTP بالرسائل (آمن للتشغيل أكثر من مرة)
create table if not exists otp_codes(id bigint generated always as identity primary key, site_id uuid not null references sites(id) on delete cascade, phone9 text not null,
  code_hash text not null, expires_at timestamptz not null, attempts int not null default 0, token text, verified_at timestamptz, failed boolean not null default false, created_at timestamptz not null default now());
create index if not exists otp_codes_phone_idx on otp_codes(site_id, phone9, created_at desc);
alter table otp_codes enable row level security;
