-- Forms 0.4: sessions, result links and prefill links are signed, and senders' addresses hashed, with keys derived from
-- Forms' own key in the vault (src/keys.rs). The workspace's key in forms_secret signs nothing any more: when it stopped,
-- so that what it signed before is checked (from the vault, where it moves sealed) for a year and a day after, and not
-- after. The build before this one still reads the table; its rows go in the release after this one.
alter table forms_secret add column if not exists retired_at timestamptz;
