# PII and encrypted entity fields

System entity properties that can identify, contact, or profile a person are
marked `pii: true` in their `EntitySchema`. The entity layer encrypts those
literals before persistence and decrypts them when typed records are read.
The field cipher is mandatory for a write that includes a PII field: without a
configured cipher, the write fails rather than storing the clear value.

## Auth data

The auth schemas mark these fields for at-rest encryption:

- user email, display name, and avatar URL;
- OAuth provider subject, provider email, access token, and refresh token;
- session and login-attempt IP addresses;
- login-attempt user agent;
- device name and device user agent.

Password credentials and one-time auth tokens are one-way hashed. Session
bearer tokens are returned once and only their SHA-256 digest is persisted.
Encryption is not a substitute for hashing credentials.

## Query behavior

Encrypted equality and sorting cannot be performed on ciphertext in SQL.
`EntityQuery` narrows candidates using the other filters, hydrates and
decrypts those candidates, then applies PII filters, sorting, and pagination in
memory. Keep these queries tenant-scoped and add ordinary indexed filters
where a lookup can otherwise fan out across a large graph. The cipher uses
deterministic authenticated encryption so equal values produce equal encrypted
terms; application queries still use the typed entity API.

Raw `TripleStore` reads expose ciphertext envelopes. Code that needs a value
must use `EntityStore` or a typed repository. Do not log ciphertext, plaintext
PII, provider credentials, or session material.

## Key handling and migration

The active key id is stored with each encrypted value. Keep every old key
available for decryption during rotation; new writes use the active key.
Removing an old key before its data has been re-encrypted makes those fields
unreadable. The system does not transparently rewrite legacy cleartext values
when their schema is first marked PII. Before enabling a new PII flag on a
database with existing records, run a backfill that reads and rewrites those
records with the configured cipher. The current Tern deployment has no customer
users, so the initial auth-field rollout does not require a user-data backfill.
